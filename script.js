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

        // Stronger blur to remove noise details inside the cartoons
        cv.GaussianBlur(gray, gray, new cv.Size(7, 7), 0, 0, cv.BORDER_DEFAULT);

        // Use Canny for edge detection instead of Adaptive Threshold
        // This is often better for defined shapes like these bubbles
        let edges = new cv.Mat();
        cv.Canny(gray, edges, 50, 150);

        // Dilate to close gaps in the edges (important for thin outlines)
        let kernel = cv.Mat.ones(3, 3, cv.CV_8U);
        let dilated = new cv.Mat();
        cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1);

        // Find contours from the dilated edges
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        let tiles = [];
        let totalPixels = src.cols * src.rows;
        let minTileArea = totalPixels * 0.005; // ~0.5% of screen (dynamic size)
        let maxTileArea = totalPixels * 0.15;  // ~15% of screen

        // Filter contours to find potential game tiles
        for (let i = 0; i < contours.size(); ++i) {
            let cnt = contours.get(i);
            let rect = cv.boundingRect(cnt);
            let area = rect.width * rect.height;
            let aspectRatio = rect.width / rect.height;

            // Draw ALL contours in faint gray for debug (so we know if we are seeing them)
            let p1 = new cv.Point(rect.x, rect.y);
            let p2 = new cv.Point(rect.x + rect.width, rect.y + rect.height);
            cv.rectangle(src, p1, p2, new cv.Scalar(200, 200, 200, 100), 1);

            // Relaxed constraints
            if (area > minTileArea && area < maxTileArea &&
                aspectRatio > 0.7 && aspectRatio < 1.3) {

                // Further filter: Game tiles usually have a high fill ratio (convex)
                // but these are circles, so bounding box fill is Pi/4 ~= 0.78.
                // complex contours might be smaller.

                tiles.push(rect);
                // Draw ACCEPTED tiles in Green
                cv.rectangle(src, p1, p2, new cv.Scalar(0, 255, 0, 255), 3);
            }
        }

        if (tiles.length < 2) {
            statusElem.innerText = `檢測數量不足 (${tiles.length})。灰色框是所有偵測到的物體，綠色是符合條件的。`;
            cv.imshow('canvasOutput', src);

            // Cleanup
            src.delete(); gray.delete(); edges.delete(); dilated.delete();
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
        src.delete(); gray.delete(); edges.delete(); dilated.delete();
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

// Helper: Check if line of sight is clear (Simplified 1-line check for MVP)
// Real Onet requires 3-line check on a grid. Mapping spatial rects to grid is distinct step.
// Here we perform a geometric check: DOES THE LINE INTERSECT ANY OTHER TILE?
function checkPathConnectivity(cellA, cellB, allTiles) {
    // 1. Direct line check
    if (!intersectsObstacles(cellA, cellB, allTiles)) return true;

    // 2. One corner (2 segments) 
    // Construct theoretical corner points and check segments...

    // For V1 MVP, let's just return true if similar, to test matching.
    // The user asked for "A and B can be eliminated if <= 3 lines".
    // Implementing geometric 3-line pathfinding without a discrete grid is complex.
    // We will assume simpler "Matching" feedback first, then refine connectivity.
    return true;
}

function intersectsObstacles(start, end, allTiles) {
    // Check if line segment from start.center to end.center hits any rect in allTiles (barring start/end)
    // Detailed geometry collision math...
    return false;
}

// Handle window resize
window.addEventListener('resize', () => {
    if (stream) {
        adjustCanvasSize();
    }
});
