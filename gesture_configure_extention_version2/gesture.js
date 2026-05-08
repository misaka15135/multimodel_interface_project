// 动态加载外部 JS 库
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.crossOrigin = "anonymous";
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// 注入UI元素
function injectUI() {
    // 检查是否已经存在，避免重复注入
    if (document.getElementById('gesture-plugin-root')) return;

    const root = document.createElement('div');
    root.id = 'gesture-plugin-root';
    root.innerHTML = `
        <div id="gesture-left-panel">
            <div id="gesture-debug-window">
                <video id="gesture-video" playsinline></video>
                <canvas id="gesture-canvas"></canvas>
            </div>
            <button id="gesture-toggle-btn">开启手势控制</button>
        </div>
        <div id="gesture-right-panel">
            <div id="gesture-up-btn" class="gesture-indicator">↑</div>
            <div id="gesture-down-btn" class="gesture-indicator">↓</div>
        </div>
    `;
    document.body.appendChild(root);
}

// 主逻辑封装
async function initGestureControl() {
    injectUI();

    const videoElement = document.getElementById('gesture-video');
    const canvasElement = document.getElementById('gesture-canvas');
    const canvasCtx = canvasElement.getContext('2d');
    const toggleBtn = document.getElementById('gesture-toggle-btn');
    const debugWindow = document.getElementById('gesture-debug-window');
    const rightPanel = document.getElementById('gesture-right-panel');
    const upBtn = document.getElementById('gesture-up-btn');
    const downBtn = document.getElementById('gesture-down-btn');

    canvasElement.width = 320;
    canvasElement.height = 240;

    let isActive = false;
    let camera = null;
    let hands = null;

    // 滚动逻辑状态
    let activeGesture = null;
    let gestureStartTime = 0;
    const THRESHOLD_MS = 600; // 降低了一点阈值，0.6秒触发，手掌翻转动作更连贯
    const SCROLL_SPEED = 30;  // 滚动速度

    // --- 新增：计算两点之间距离的辅助函数 ---
    function getDistance(p1, p2) {
        return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
    }

    // --- 新增：判定是否为“张开手掌” ---
    // 原理：指尖到手腕的距离，大于指根到手腕的距离
    function isOpenPalm(landmarks) {
        // 0: 手腕; 5,9,13,17: 指根; 8,12,16,20: 指尖
        const isIndexExtended = getDistance(landmarks[8], landmarks[0]) > getDistance(landmarks[5], landmarks[0]) * 1.2;
        const isMiddleExtended = getDistance(landmarks[12], landmarks[0]) > getDistance(landmarks[9], landmarks[0]) * 1.2;
        const isRingExtended = getDistance(landmarks[16], landmarks[0]) > getDistance(landmarks[13], landmarks[0]) * 1.2;
        const isLittleExtended = getDistance(landmarks[20], landmarks[0]) > getDistance(landmarks[17], landmarks[0]) * 1.2;

        return isIndexExtended && isMiddleExtended && isRingExtended && isLittleExtended;
    }

    // --- 核心：识别手掌朝向 ---
    function getHandOrientation(landmarks) {
        // 必须先满足是“张开的手掌”才判定方向，防止握拳或乱动手时误触
        if (!isOpenPalm(landmarks)) return null;

        // 利用手腕(0)和中指指根(9)在Y轴上的相对位置来判断朝向
        // Web 坐标系中，Y轴越往下数值越大
        const dy = landmarks[9].y - landmarks[0].y;

        if (dy < -0.1) {
            return "UP";   // 指根在手腕上方 -> 手掌朝上
        } else if (dy > 0.1) {
            return "DOWN"; // 指根在手腕下方 -> 手掌朝下
        }
        
        return null;
    }

    // 滚动控制器
    function handleScrolling(orientation) {
        // 重置闪烁状态
        upBtn.classList.remove('flash');
        downBtn.classList.remove('flash');

        if (orientation === "UP") {
            upBtn.classList.add('flash'); 
            if (activeGesture !== "UP") {
                activeGesture = "UP";
                gestureStartTime = Date.now();
            } else if (Date.now() - gestureStartTime > THRESHOLD_MS) {
                // 向上滚动
                window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'instant' });
            }
        } else if (orientation === "DOWN") {
            downBtn.classList.add('flash'); 
            if (activeGesture !== "DOWN") {
                activeGesture = "DOWN";
                gestureStartTime = Date.now();
            } else if (Date.now() - gestureStartTime > THRESHOLD_MS) {
                // 向下滚动
                window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'instant' });
            }
        } else {
            // 没有识别到有效动作，重置状态
            activeGesture = null;
        }
    }

    function onResults(results) {
        if (!isActive) return;

        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
        
        let detectedOrientation = null;

        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            for (const landmarks of results.multiHandLandmarks) {
                window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, {color: '#ffffff33', lineWidth: 2});
                window.drawLandmarks(canvasCtx, landmarks, {color: '#00f2ff', lineWidth: 1, radius: 2});
                
                // 获取手掌朝向
                detectedOrientation = getHandOrientation(landmarks);
            }
        }
        
        canvasCtx.restore();
        handleScrolling(detectedOrientation);
    }

    async function startSystem() {
        try {
            toggleBtn.innerText = "正在加载模型...";
            toggleBtn.style.pointerEvents = "none";

            // 如果还没加载库，先加载
            if (!window.Hands) {
                console.log("加载 Mediapipe 库...");
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js");
            }

            if (!hands) {
                hands = new window.Hands({
                    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
                });
                hands.setOptions({
                    maxNumHands: 1,
                    modelComplexity: 1,
                    minDetectionConfidence: 0.7,
                    minTrackingConfidence: 0.7
                });
                hands.onResults(onResults);

                camera = new window.Camera(videoElement, {
                    onFrame: async () => { if(isActive) await hands.send({image: videoElement}); },
                    width: 320,
                    height: 240
                });
            }
            
            toggleBtn.innerText = "请求摄像头...";
            await camera.start(); 
            
            isActive = true;
            debugWindow.style.display = 'block';
            rightPanel.style.display = 'flex';
            toggleBtn.innerText = "关闭手势控制";
            toggleBtn.classList.add('active');
            toggleBtn.style.pointerEvents = "auto";

        } catch (error) {
            console.error("初始化失败:", error);
            toggleBtn.innerText = "加载失败(F12看控制台)";
            toggleBtn.style.backgroundColor = "#ff4444";
            toggleBtn.style.pointerEvents = "auto";
            isActive = false;
        }
    }

    function stopSystem() {
        isActive = false;
        debugWindow.style.display = 'none';
        rightPanel.style.display = 'none';
        toggleBtn.innerText = "开启手势控制";
        toggleBtn.classList.remove('active');
        toggleBtn.style.backgroundColor = ""; // 恢复默认颜色
        if (camera) {
            camera.stop();
        }
        activeGesture = null;
        upBtn.classList.remove('flash');
        downBtn.classList.remove('flash');
    }

    toggleBtn.addEventListener('click', () => {
        if (isActive) stopSystem();
        else startSystem();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGestureControl);
} else {
    initGestureControl();
}