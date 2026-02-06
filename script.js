let video, canvas, ctx, startBtn, captureBtn, statusElem;
let stream = null;
let isCvReady = false;

// Main entry point
document.addEventListener('DOMContentLoaded', () => {
    video = document.getElementById('videoInput');
    canvas = document.getElementById('canvasOutput');
    ctx = canvas.getContext('2d');
    startBtn = document.getElementById('startBtn');
    captureBtn = document.getElementById('captureBtn');
    statusElem = document.getElementById('status');

    // Setup listeners
    startBtn.addEventListener('click', () => {
        if (stream) {
            stopCamera();
        } else {
            startCamera();
        }
    });
    captureBtn.addEventListener('click', processFrame);

    // Check if OpenCV loaded before DOM
    if (window.isOpenCvLoaded) {
        initApp();
    }
});

// Called by OpenCV onload (via HTML shim) or DOMContentLoaded
window.initApp = function () {
    isCvReady = true;
    console.log('OpenCV.js is ready');
    updateStatus();
    checkEnableCapture();
}

function updateStatus() {
    if (!statusElem) return; // Guard in case DOM isn't ready

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
                // Draw ACCEPTED tiles in Green - DISABLED for cleaner view v1.1
                // cv.rectangle(src, p1, p2, new cv.Scalar(0, 255, 0, 255), 2);
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
        // 2. Find Pairs
        let pairs = [];
        let visited = new Array(rois.length).fill(false);

        for (let i = 0; i < rois.length; i++) {
            if (visited[i]) continue;

            // Find ALL potential matches first
            let candidates = [];

            for (let j = i + 1; j < rois.length; j++) {
                if (visited[j]) continue;

                let diffScore = getDifficultyScore(rois[i].mat, rois[j].mat);

                // Empirical threshold for 32x32 image
                if (diffScore < 1500) {
                    candidates.push({ index: j, score: diffScore });
                }
            }

            // Sort candidates by score (best visual match first)
            candidates.sort((a, b) => a.score - b.score);

            // Find the best VALID match (one that can be connected)
            let bestMatchIndex = -1;

            for (let candidate of candidates) {
                let targetRoi = rois[candidate.index];

                // Check if a path exists between source (rois[i]) and target (targetRoi)
                // We pass 'tiles' as the list of all obstacles
                if (checkPathConnectivity(rois[i], targetRoi, tiles)) {
                    bestMatchIndex = candidate.index;
                    break; // Use the first valid match found
                }
            }

            if (bestMatchIndex !== -1) {
                // Store match with score
                pairs.push({
                    p1: rois[i],
                    p2: rois[bestMatchIndex],
                    score: candidates[0].score // Best candidate is at index 0 after sort
                });
                visited[i] = true;
                visited[bestMatchIndex] = true;
            }
        }

        // 3. Draw Results
        // Sort pairs by score (best visual match first)
        pairs.sort((a, b) => a.score - b.score);

        // Define distinct colors for the hints
        const colors = [
            new cv.Scalar(255, 0, 0, 255),   // Red
            new cv.Scalar(0, 255, 0, 255),   // Green
            new cv.Scalar(0, 0, 255, 255),   // Blue
            new cv.Scalar(255, 255, 0, 255), // Cyan
            new cv.Scalar(255, 0, 255, 255)  // Magenta
        ];

        let displayCount = Math.min(pairs.length, 5); // Show up to 5 best pairs

        for (let k = 0; k < displayCount; k++) {
            let pair = pairs[k];
            let p1 = pair.p1.center;
            let p2 = pair.p2.center;
            let p1Rect = pair.p1.rect;
            let p2Rect = pair.p2.rect;
            let color = colors[k % colors.length];

            // Draw bounding boxes
            let pt1_tl = new cv.Point(p1Rect.x, p1Rect.y);
            let pt1_br = new cv.Point(p1Rect.x + p1Rect.width, p1Rect.y + p1Rect.height);
            cv.rectangle(src, pt1_tl, pt1_br, color, 3);

            let pt2_tl = new cv.Point(p2Rect.x, p2Rect.y);
            let pt2_br = new cv.Point(p2Rect.x + p2Rect.width, p2Rect.y + p2Rect.height);
            cv.rectangle(src, pt2_tl, pt2_br, color, 3);

            // Draw connecting line
            cv.line(src, new cv.Point(p1.x, p1.y), new cv.Point(p2.x, p2.y), color, 2);

            // Draw center dots
            cv.circle(src, new cv.Point(p1.x, p1.y), 5, color, -1);
            cv.circle(src, new cv.Point(p2.x, p2.y), 5, color, -1);
        }

        statusElem.innerText = `找到 ${pairs.length} 對圖案 (顯示最佳 ${displayCount} 組) v1.1`;
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
// v1.1: Added strict width check (thick line)
function checkPathConnectivity(cellA, cellB, allTiles) {
    const obstacles = allTiles.filter(t => t !== cellA.rect && t !== cellB.rect);

    const cA = cellA.center;
    const cB = cellB.center;

    // v1.1 Strictness: Define a path thickness
    // We check 3 parallel lines: center, left-offset, right-offset
    // Offset is half the smaller dimension of the tile * 0.5 (conservative 50% width)
    const thickness = Math.min(cellA.rect.width, cellA.rect.height) * 0.5;
    const offset = thickness / 2;

    function isThickPathClear(pStart, pEnd) {
        // 1. Center line
        if (!isPathClear(pStart, pEnd, obstacles)) return false;

        // 2. Offsets
        let oX = 0, oY = 0;
        if (Math.abs(pStart.x - pEnd.x) < 1) {
            // Vertical Line -> Offset X
            oX = offset;
        } else {
            // Horizontal Line -> Offset Y
            oY = offset;
        }

        let p1 = { x: pStart.x - oX, y: pStart.y - oY };
        let p2 = { x: pEnd.x - oX, y: pEnd.y - oY };

        let p3 = { x: pStart.x + oX, y: pStart.y + oY };
        let p4 = { x: pEnd.x + oX, y: pEnd.y + oY };

        if (!isPathClear(p1, p2, obstacles)) return false;
        if (!isPathClear(p3, p4, obstacles)) return false;

        return true;
    }

    // 1. Direct Line (0 turns, 1 segment)
    if (isThickPathClear(cA, cB)) return true;

    // 2. One Turn (L-shape, 2 segments)
    let c1 = { x: cA.x, y: cB.y };
    if (isThickPathClear(cA, c1) && isThickPathClear(c1, cB)) return true;

    let c2 = { x: cB.x, y: cA.y };
    if (isThickPathClear(cA, c2) && isThickPathClear(c2, cB)) return true;

    // 3. Two Turns (U or Z shape, 3 segments)
    // Scan X coordinates
    let xCandidates = [
        0, canvas.width,
        cA.x, cB.x
    ];
    for (let t of obstacles) {
        xCandidates.push(t.x - thickness);  // Gap to left (adjusted for thickness)
        xCandidates.push(t.x + t.width + thickness); // Gap to right
    }

    // Try Vertical Bridges (moving X)
    for (let x of xCandidates) {
        let pA = { x: x, y: cA.y };
        let pB = { x: x, y: cB.y };

        if (isThickPathClear(cA, pA) &&
            isThickPathClear(pA, pB) &&
            isThickPathClear(pB, cB)) {
            return true;
        }
    }

    // Try Horizontal Bridges (moving Y)
    let yCandidates = [
        0, canvas.height,
        cA.y, cB.y
    ];
    for (let t of obstacles) {
        yCandidates.push(t.y - thickness);
        yCandidates.push(t.y + t.height + thickness);
    }

    for (let y of yCandidates) {
        let pA = { x: cA.x, y: y };
        let pB = { x: cB.x, y: y };

        if (isThickPathClear(cA, pA) &&
            isThickPathClear(pA, pB) &&
            isThickPathClear(pB, cB)) {
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
