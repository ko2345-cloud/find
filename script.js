let video, canvas, ctx, startBtn, captureBtn, statusElem;
let stream = null;
let isCvReady = false;

// v1.6: Capture Mode state
window.isCaptured = false;

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

    captureBtn.addEventListener('click', () => {
        if (!window.isCaptured) {
            // State: Capture
            if (!stream) return;
            video.pause(); // Freeze frame
            processFrame(); // Run analysis ONCE on frozen frame
            captureBtn.innerText = "🔄 重置 / 繼續";
            captureBtn.style.backgroundColor = "#ff9500"; // Orange
            window.isCaptured = true;
        } else {
            // State: Reset
            video.play(); // Resume live view
            ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear drawings
            statusElem.innerText = "請對準後點擊 [鎖定分析]";
            captureBtn.innerText = "📷 鎖定畫面 & 分析";
            captureBtn.style.backgroundColor = "#007aff"; // Blue
            window.isCaptured = false;
        }
    });

    // Check if OpenCV loaded before DOM
    if (window.isOpenCvLoaded) {
        initApp();
    }

    checkEnableCapture();
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
        if (!window.isCaptured) {
            statusElem.innerText = '系統就緒。請對準畫面並點擊「鎖定分析」。';
        }
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

    // v1.5.2 CRITICAL FIX:
    // 1. Set attributes so OpenCV.js knows the resolution (Fixes "Bad size" error)
    video.width = w;
    video.height = h;

    // 2. Set CSS styles to ensure it fits the screen and ISN'T squashed (Fixes Distortion)
    video.style.width = "100%";
    video.style.height = "auto";

    // Canvas must match the intrinsic video resolution for correct coordinate mapping
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

            // Draw ALL contours - DISABLED to reduce clutter
            // let p1 = new cv.Point(rect.x, rect.y);
            // let p2 = new cv.Point(rect.x + rect.width, rect.y + rect.height);
            // cv.rectangle(src, p1, p2, new cv.Scalar(100, 100, 100, 255), 1);

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

            // v1.5: Pre-calculate HSV Histogram for color matching
            let hsv = new cv.Mat();
            cv.cvtColor(resized, hsv, cv.COLOR_RGBA2RGB);
            cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

            let hist = new cv.Mat();
            let mask = new cv.Mat();
            let histVec = new cv.MatVector();
            histVec.push_back(hsv);

            // Calculate histogram (Hue and Saturation only to be brightness invariant-ish)
            cv.calcHist(histVec, [0, 1], mask, hist, [50, 60], [0, 180, 0, 256]);
            cv.normalize(hist, hist, 0, 1, cv.NORM_MINMAX);

            rois.push({
                id: i,
                rect: rect,
                mat: resized,
                hist: hist, // Store histogram
                center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
            });
            roi.delete(); hsv.delete(); mask.delete(); histVec.delete();
        }

        // 2. Find Pairs
        let pairs = [];
        let visited = new Array(rois.length).fill(false);

        for (let i = 0; i < rois.length; i++) {
            if (visited[i]) continue;

            // Find ALL potential matches first
            let candidates = [];

            for (let j = i + 1; j < rois.length; j++) {
                if (visited[j]) continue;

                // v1.6: Dual Check
                // 1. Zonal Structure Check (Quad Diff): Finds local shape diffs (e.g. beak vs no beak)
                // 2. Histogram Color Check: Finds global color diffs (e.g. Yellow vs Blue)

                let zonalDiff = getZonalScore(rois[i].mat, rois[j].mat);
                let histScore = cv.compareHist(rois[i].hist, rois[j].hist, cv.HISTCMP_CORREL);

                // Validation Thresholds (v1.6)
                // Zonal Diff: Must be < 1800 (for 16x16 quadrant). This is strict!
                // Hist Score: Must be > 0.70
                if (zonalDiff < 1800 && histScore > 0.70) {

                    // Score formula: Lower is better
                    // ZonalDiff is roughly 0-4000
                    // HistPenalty is (1 - 0.9) * 10000 = 1000
                    let totalScore = zonalDiff + (1 - histScore) * 5000;
                    candidates.push({ index: j, score: totalScore, debugDiff: zonalDiff, debugHist: histScore });
                }
            }

            // Sort candidates by score (best visual match first)
            candidates.sort((a, b) => a.score - b.score);

            // Find the best VALID match (one that can be connected)
            let bestMatchIndex = -1;

            for (let candidate of candidates) {
                let targetRoi = rois[candidate.index];

                // Check if a path exists between source (rois[i]) and target (targetRoi)
                // v1.2: Use strict Manhattan pathfinding
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
                    score: candidates[0].score, // Best candidate is at index 0 after sort
                    histMatch: candidates[0].debugHist.toFixed(2) // Save for display
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

            // v1.5: Draw Score text for verification
            // Show Histogram Score (H:0.99) - near 1.0 is good
            let text = `H:${pair.histMatch}`;
            cv.putText(src, text, new cv.Point((p1.x + p2.x) / 2, (p1.y + p2.y) / 2), cv.FONT_HERSHEY_SIMPLEX, 0.5, new cv.Scalar(255, 255, 255, 255), 2);
            cv.putText(src, text, new cv.Point((p1.x + p2.x) / 2, (p1.y + p2.y) / 2), cv.FONT_HERSHEY_SIMPLEX, 0.5, new cv.Scalar(0, 0, 0, 255), 1);

            // Draw center dots
            cv.circle(src, new cv.Point(p1.x, p1.y), 5, color, -1);
            cv.circle(src, new cv.Point(p2.x, p2.y), 5, color, -1);
        }

        statusElem.innerText = `找到 ${pairs.length} 對圖案 (顯示最佳 ${displayCount} 組) v1.5.2`;
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
// v1.6: Zonal Matching (Divide into 4 quadrants)
// Returns the MAXIMUM difference found in any quadrant.
// If two images differ significantly in just ONE corner (e.g. beak), this score will shoot up.
function getZonalScore(mat1, mat2) {
    let w = mat1.cols;
    let h = mat1.rows;
    let hw = Math.floor(w / 2);
    let hh = Math.floor(h / 2);

    // Define 4 quadrants
    let rects = [
        new cv.Rect(0, 0, hw, hh),      // TL
        new cv.Rect(hw, 0, hw, hh),     // TR
        new cv.Rect(0, hh, hw, hh),     // BL
        new cv.Rect(hw, hh, hw, hh)     // BR
    ];

    let maxDiff = 0;

    for (let r of rects) {
        let roi1 = mat1.roi(r);
        let roi2 = mat2.roi(r);
        let diff = getDifficultyScore(roi1, roi2); // Standard absdiff on sub-region

        if (diff > maxDiff) maxDiff = diff;

        roi1.delete();
        roi2.delete();
    }
    return maxDiff;
}

// v1.0: Basic Structural Difference (Absolute Pixel Diff) used by ZonalScore
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

// v1.4: Color Distance (Mean RGB difference)
function getColorDistance(mat1, mat2) {
    let mean1 = cv.mean(mat1);
    let mean2 = cv.mean(mat2);
    // Euclidean distance in RGB
    let dist = Math.sqrt(
        Math.pow(mean1[0] - mean2[0], 2) +
        Math.pow(mean1[1] - mean2[1], 2) +
        Math.pow(mean1[2] - mean2[2], 2)
    );
    return dist;
}

// v1.2: Strict Onet Pathfinding (Orthogonal Only)
function checkPathConnectivity(cellA, cellB, allTiles) {
    const obstacles = allTiles.filter(t => t !== cellA.rect && t !== cellB.rect);
    const cA = cellA.center;
    const cB = cellB.center;

    // Safety buffer: Assume path needs 5px width to be valid
    const pathWidth = 5;

    // Helper: Check if a strict horizontal segment is clear
    function isHClear(y, x1, x2) {
        let minX = Math.min(x1, x2);
        let maxX = Math.max(x1, x2);
        // Check intersection with all obstacles
        for (let rect of obstacles) {
            // Check vertical overlap with path line (y +/- width/2)
            if (y + pathWidth / 2 < rect.y || y - pathWidth / 2 > rect.y + rect.height) continue;
            // Check horizontal overlap
            if (maxX > rect.x && minX < rect.x + rect.width) return false;
        }
        return true;
    }

    // Helper: Check if a strict vertical segment is clear
    function isVClear(x, y1, y2) {
        let minY = Math.min(y1, y2);
        let maxY = Math.max(y1, y2);
        for (let rect of obstacles) {
            // Check horizontal overlap with path line (x +/- width/2)
            if (x + pathWidth / 2 < rect.x || x - pathWidth / 2 > rect.x + rect.width) continue;
            // Check vertical overlap
            if (maxY > rect.y && minY < rect.y + rect.height) return false;
        }
        return true;
    }

    // 1. Zero Turns (Same Row/Col)
    if (Math.abs(cA.x - cB.x) < pathWidth) { // Same Col
        if (isVClear(cA.x, cA.y, cB.y)) return true;
    }
    if (Math.abs(cA.y - cB.y) < pathWidth) { // Same Row
        if (isHClear(cA.y, cA.x, cB.x)) return true;
    }

    // 2. One Turn (Corner)
    // Corner 1: (cB.x, cA.y) -> Horizontal then Vertical matches
    if (isHClear(cA.y, cA.x, cB.x) && isVClear(cB.x, cA.y, cB.y)) return true;
    // Corner 2: (cA.x, cB.y) -> Vertical then Horizontal matches
    if (isVClear(cA.x, cA.y, cB.y) && isHClear(cB.y, cA.x, cB.x)) return true;

    // 3. Two Turns (Bridge)
    // Horizontal Scanning (find vertical bridge)
    let xCandidates = [0 - pathWidth, canvas.width + pathWidth, cA.x, cB.x];
    for (let t of obstacles) {
        xCandidates.push(t.x - pathWidth * 2);
        xCandidates.push(t.x + t.width + pathWidth * 2);
    }
    for (let x of xCandidates) {
        // Path: cA -> (x, cA.y) -> (x, cB.y) -> cB
        if (isHClear(cA.y, cA.x, x) &&
            isVClear(x, cA.y, cB.y) &&
            isHClear(cB.y, x, cB.x)) return true;
    }

    // Vertical Scanning (find horizontal bridge)
    let yCandidates = [0 - pathWidth, canvas.height + pathWidth, cA.y, cB.y];
    for (let t of obstacles) {
        yCandidates.push(t.y - pathWidth * 2);
        yCandidates.push(t.y + t.height + pathWidth * 2);
    }
    for (let y of yCandidates) {
        // Path: cA -> (cA.x, y) -> (cB.x, y) -> cB
        if (isVClear(cA.x, cA.y, y) &&
            isHClear(y, cA.x, cB.x) &&
            isVClear(cB.x, y, cB.y)) return true;
    }

    return false;
}

// Handle window resize
window.addEventListener('resize', () => {
    if (stream) {
        adjustCanvasSize();
    }
});
