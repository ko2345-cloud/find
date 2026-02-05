const video = document.getElementById('videoInput');
const canvas = document.getElementById('canvasOutput');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const captureBtn = document.getElementById('captureBtn');
const statusElem = document.getElementById('status');

let stream = null;
let isCvReady = false;

// Check if OpenCV is ready
function onOpenCvReady() {
    isCvReady = true;
    console.log('OpenCV.js is ready');
    updateStatus();
    checkEnableCapture();
}

function onOpenCvError() {
    statusElem.innerText = 'OpenCV 加載失敗。請檢查網絡連接或重新整理網頁。';
    alert('OpenCV 加載失敗。請檢查網絡連接。');
}

function updateStatus() {
    if (!isCvReady) {
        statusElem.innerText = '正在加載 OpenCV...';
    } else if (!stream) {
        statusElem.innerText = 'OpenCV 準備完成。請開啟鏡頭。';
        startBtn.innerText = '開啟鏡頭';
        startBtn.style.backgroundColor = '#34c759';
    } else {
        statusElem.innerText = '系統就緒。請對準畫面並點擊「分析畫面」。';
        startBtn.innerText = '關閉鏡頭';
        startBtn.style.backgroundColor = '#ff3b30';
    }
}

function checkEnableCapture() {
    if (isCvReady && stream) {
        captureBtn.disabled = false;
        captureBtn.style.backgroundColor = '#007aff';
    } else {
        captureBtn.disabled = true;
        captureBtn.style.backgroundColor = '#ccc';
    }
}

// Camera controls
startBtn.addEventListener('click', () => {
    if (stream) {
        stopCamera();
    } else {
        startCamera();
    }
});
captureBtn.addEventListener('click', processFrame);

async function startCamera() {
    const constraints = {
        video: {
            facingMode: 'environment', // Rear camera implementation
            width: { ideal: 1280 },
            height: { ideal: 720 }
        }
    };

    try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        video.play();

        // Wait for video to be ready
        video.onloadedmetadata = () => {
            adjustCanvasSize();
            updateStatus();
            checkEnableCapture();
        };
    } catch (err) {
        console.error('Error opening camera:', err);
        statusElem.innerText = '無法開啟鏡頭: ' + err.message;
        alert('無法開啟鏡頭: ' + err.message);
    }
}

function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
        video.srcObject = null;
        startBtn.innerText = '開啟鏡頭';
        startBtn.style.backgroundColor = '#34c759';

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        updateStatus();
        checkEnableCapture();

        // Reset sizes
        video.width = 0;
        video.height = 0;
    }
}

function adjustCanvasSize() {
    // CRITICAL: OpenCV.js VideoCapture reads from video.width/height attributes
    // These must match the intrinsic videoWidth/videoHeight
    const w = video.videoWidth;
    const h = video.videoHeight;

    video.width = w;
    video.height = h;
    canvas.width = w;
    canvas.height = h;
}

// This function will handle the core logic
// Image processing parameters
const MIN_AREA = 1000;
const MAX_AREA_RATIO = 0.9;
const SIMILARITY_THRESHOLD = 2000; // Pixel difference threshold

function processFrame() {
    if (!isCvReady || !stream) return;

    statusElem.innerText = '正在分析...';

    try {
        let src = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);
        let cap = new cv.VideoCapture(video);
        cap.read(src);

        // Preprocessing
        let gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

        // Blur to remove grid noise
        cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

        // Use OTSU Thresholding - automatically finds best split between light tiles and background
        // Assumes tiles are lighter than background (common in these games)
        let binary = new cv.Mat();
        cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

        // Dilate slightly to fill holes in icons
        let kernel = cv.Mat.ones(3, 3, cv.CV_8U);
        let dilated = new cv.Mat();
        cv.dilate(binary, dilated, kernel, new cv.Point(-1, -1), 1);

        // Find contours
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        console.log(`Found ${contours.size()} total contours`);

        let tiles = [];
        let totalPixels = src.cols * src.rows;
        let minTileArea = totalPixels * 0.005; // 0.5%
        let maxTileArea = totalPixels * 0.10;  // 10%

        // Filter contours
        for (let i = 0; i < contours.size(); ++i) {
            let cnt = contours.get(i);
            let rect = cv.boundingRect(cnt);
            let area = rect.width * rect.height;
            let aspectRatio = rect.width / rect.height;

            // Draw ALL contours in faint gray for debug
            let p1 = new cv.Point(rect.x, rect.y);
            let p2 = new cv.Point(rect.x + rect.width, rect.y + rect.height);
            cv.rectangle(src, p1, p2, new cv.Scalar(100, 100, 100, 255), 1);

            // Filter logic
            if (area > minTileArea && area < maxTileArea &&
                aspectRatio > 0.7 && aspectRatio < 1.3) {

                tiles.push(rect);
                // Draw ACCEPTED tiles in Green
                cv.rectangle(src, p1, p2, new cv.Scalar(0, 255, 0, 255), 2);
            }
        }

        console.log(`Filtered down to ${tiles.length} tiles`);

        // DEBUG: Show the binary view briefly to check what computer sees? 
        // useful for debugging but might confuse user. 
        // Let's stick to overlay on src.

        if (tiles.length < 2) {
            statusElem.innerText = `檢測數量不足 (${tiles.length})。嘗試調整光線或角度。`;
            cv.imshow('canvasOutput', src); // Show what we found so far

            src.delete(); gray.delete(); binary.delete(); dilated.delete();
            kernel.delete(); contours.delete(); hierarchy.delete();
            return;
        }

        // Logic to organize tiles into rows/cols and match them
        // 1. Sort tiles by Y then X to group (Rough grid sorting)
        tiles.sort((a, b) => {
            if (Math.abs(a.y - b.y) > a.height * 0.5) return a.y - b.y; // Different rows
            return a.x - b.x; // Same row
        });

        // Simplified Logic: Extract ROIs and Compare
        const rois = [];
        for (let i = 0; i < tiles.length; i++) {
            let rect = tiles[i];

            // Shrink ROI slightly to avoid border noise
            let margin = 4;
            let safeRect = new cv.Rect(
                Math.min(src.cols - 1, Math.max(0, rect.x + margin)),
                Math.min(src.rows - 1, Math.max(0, rect.y + margin)),
                Math.max(1, rect.width - margin * 2),
                Math.max(1, rect.height - margin * 2)
            );

            let roi = src.roi(safeRect);
            let resized = new cv.Mat();
            cv.resize(roi, resized, new cv.Size(32, 32));
            rois.push({
                id: i,
                rect: rect,
                mat: resized,
                center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
            });
            roi.delete();
        }

        // 2. Find Pairs
        let pairs = [];
        let visited = new Array(rois.length).fill(false);

        for (let i = 0; i < rois.length; i++) {
            if (visited[i]) continue;

            // Find BEST match, not just first match
            let bestMatchIndex = -1;
            let minDiff = Number.MAX_VALUE;

            for (let j = i + 1; j < rois.length; j++) {
                if (visited[j]) continue;

                let diffScore = getDifficultyScore(rois[i].mat, rois[j].mat);

                // Empirical threshold for 32x32 image
                if (diffScore < 1500 && diffScore < minDiff) {
                    minDiff = diffScore;
                    bestMatchIndex = j;
                }
            }

            if (bestMatchIndex !== -1) {
                pairs.push([rois[i], rois[bestMatchIndex]]);
                visited[i] = true;
                visited[bestMatchIndex] = true;
            }
        }

        // 3. Draw Results
        for (let pair of pairs) {
            let p1 = pair[0].center;
            let p2 = pair[1].center;
            // Draw matching dots
            cv.circle(src, new cv.Point(p1.x, p1.y), 15, new cv.Scalar(0, 0, 255, 255), -1); // Red dot
            cv.circle(src, new cv.Point(p2.x, p2.y), 15, new cv.Scalar(0, 0, 255, 255), -1);
            cv.line(src, new cv.Point(p1.x, p1.y), new cv.Point(p2.x, p2.y), new cv.Scalar(255, 255, 0, 255), 3); // Cyan line
        }

        statusElem.innerText = `找到 ${pairs.length} 對圖案 (共偵測到 ${tiles.length} 個區塊)`;
        cv.imshow('canvasOutput', src);

        // Cleanup
        src.delete(); gray.delete(); binary.delete(); dilated.delete();
        kernel.delete(); contours.delete(); hierarchy.delete();
        rois.forEach(r => r.mat.delete());

    } catch (err) {
        console.error(err);
        statusElem.innerText = '分析異常: ' + err.message;
    }
}

// Helper: Get difference score (lower is more similar)
function getDifficultyScore(mat1, mat2) {
    let diff = new cv.Mat();
    cv.absdiff(mat1, mat2, diff);

    let grayDiff = new cv.Mat();
    cv.cvtColor(diff, grayDiff, cv.COLOR_RGBA2GRAY);

    let binaryDiff = new cv.Mat();
    cv.threshold(grayDiff, binaryDiff, 50, 255, cv.THRESH_BINARY);

    let differentPixels = cv.countNonZero(binaryDiff);

    diff.delete(); grayDiff.delete(); binaryDiff.delete();

    return differentPixels;
}

// Helper: Check if line of sight is clear (1, 2, or 3 segments)
// Returns true if A and B can be connected by <= 3 segments without hitting other tiles
function checkPathConnectivity(cellA, cellB, allTiles) {
    // We treat all OTHER tiles as obstacles
    // Shrink obstacles slightly to be forgiving?
    // Or treating the center-to-center line as a "thin" ray is usually enough.
    const obstacles = allTiles.filter(t => t !== cellA.rect && t !== cellB.rect);

    const cA = cellA.center;
    const cB = cellB.center;

    // 1. Direct Line (0 turns, 1 segment)
    if (isPathClear(cA, cB, obstacles)) return true;

    // 2. One Turn (L-shape, 2 segments)
    // Possible turning points: (cA.x, cB.y) and (cB.x, cA.y)
    let c1 = { x: cA.x, y: cB.y };
    if (isPathClear(cA, c1, obstacles) && isPathClear(c1, cB, obstacles)) return true;

    let c2 = { x: cB.x, y: cA.y };
    if (isPathClear(cA, c2, obstacles) && isPathClear(c2, cB, obstacles)) return true;

    // 3. Two Turns (U or Z shape, 3 segments)
    // Strategy: Raycast from A and B in 4 cardinal directions.
    // If we find a common horizontal or vertical "bridge" line that connects them, valid.

    // Scan X coordinates from all tiles to find candidate vertical bridge lines
    // (gaps between columns) including boundaries.
    let xCandidates = [
        0, canvas.width,
        cA.x, cB.x
    ];
    // Also add left/right of all obstacles to find "lanes"
    for (let t of obstacles) {
        xCandidates.push(t.x - 5);  // Gap to left
        xCandidates.push(t.x + t.width + 5); // Gap to right
    }

    // Try Vertical Bridges (moving X)
    for (let x of xCandidates) {
        // Points on the bridge
        let pA = { x: x, y: cA.y }; // Bridge start (aligned with A)
        let pB = { x: x, y: cB.y }; // Bridge end (aligned with B)

        // Path: A -> pA -> pB -> B
        // Segments: A-pA (Horiz), pA-pB (Vert), pB-B (Horiz)
        if (isPathClear(cA, pA, obstacles) &&
            isPathClear(pA, pB, obstacles) &&
            isPathClear(pB, cB, obstacles)) {
            return true;
        }
    }

    // Try Horizontal Bridges (moving Y)
    let yCandidates = [
        0, canvas.height,
        cA.y, cB.y
    ];
    for (let t of obstacles) {
        yCandidates.push(t.y - 5);
        yCandidates.push(t.y + t.height + 5);
    }

    for (let y of yCandidates) {
        let pA = { x: cA.x, y: y };
        let pB = { x: cB.x, y: y };

        // Path: A -> pA -> pB -> B
        // Segments: A-pA (Vert), pA-pB (Horiz), pB-B (Vert)
        if (isPathClear(cA, pA, obstacles) &&
            isPathClear(pA, pB, obstacles) &&
            isPathClear(pB, cB, obstacles)) {
            return true;
        }
    }

    return false;
}

// Check if a single segment from pStart to pEnd intersects any obstacle
function isPathClear(pStart, pEnd, obstacles) {
    // 1. Define segment bounding box for quick rejection
    let minX = Math.min(pStart.x, pEnd.x);
    let maxX = Math.max(pStart.x, pEnd.x);
    let minY = Math.min(pStart.y, pEnd.y);
    let maxY = Math.max(pStart.y, pEnd.y);

    for (let rect of obstacles) {
        // Quick AABB check: Does obstacle overlap the segment's extent?
        if (rect.x > maxX || rect.x + rect.width < minX ||
            rect.y > maxY || rect.y + rect.height < minY) {
            continue;
        }

        // Detailed Line-Rect intersection
        // Since our paths are strictly Horizontal or Vertical, this simplifies.
        // We assume the "Point" has 0 width. But safely, we can check if the line center passes through the rect.

        // Shrink rect slightly for leniency?
        // Let's use strict arithmetic.

        if (pStart.x === pEnd.x) {
            // Vertical Line
            // Line X must be within Rect X range
            if (pStart.x >= rect.x && pStart.x <= rect.x + rect.width) {
                // And Y intervals must overlap
                // Interaction range: [max(segmentMin, rectMin), min(segmentMax, rectMax)]
                // If that range is valid, they overlap.
                let overlapStart = Math.max(minY, rect.y);
                let overlapEnd = Math.min(maxY, rect.y + rect.height);
                if (overlapStart < overlapEnd) return false;
            }
        } else if (pStart.y === pEnd.y) {
            // Horizontal Line
            if (pStart.y >= rect.y && pStart.y <= rect.y + rect.height) {
                let overlapStart = Math.max(minX, rect.x);
                let overlapEnd = Math.min(maxX, rect.x + rect.width);
                if (overlapStart < overlapEnd) return false;
            }
        } else {
            // Diagonal line (shouldn't happen in 1/2/3 turn logic normally, but safe fallback)
            // Simplified: check mid point
            let midX = (pStart.x + pEnd.x) / 2;
            let midY = (pStart.y + pEnd.y) / 2;
            if (midX > rect.x && midX < rect.x + rect.width &&
                midY > rect.y && midY < rect.y + rect.height) return false;
        }
    }
    return true;
}

// Handle window resize
window.addEventListener('resize', () => {
    if (stream) {
        adjustCanvasSize();
    }
});
