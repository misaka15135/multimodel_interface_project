// 动态加载外部 JS 库（因为 Content Script 不能直接 import 外部 CDN 的 module）
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

    // 加载依赖
    console.log("正在加载 Mediapipe 模型...");
    await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
    await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
    await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js");

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
    const THRESHOLD_MS = 800; // 识别阈值时间：持续比出动作0.8秒后开始滚动
    const SCROLL_SPEED = 25;  // 滚动速度

    // 原有数字识别逻辑
    function getNumber(landmarks) {
        const isIndexUp = landmarks[8].y < landmarks[6].y;
        const isMiddleUp = landmarks[12].y < landmarks[10].y;
        const isRingUp = landmarks[16].y < landmarks[14].y;
        const isLittleUp = landmarks[20].y < landmarks[18].y;
        const isThumbUp = Math.abs(landmarks[4].x - landmarks[2].x) > 0.1;

        const fingersUp = [isIndexUp, isMiddleUp, isRingUp, isLittleUp].filter(Boolean).length;

        if (isThumbUp && fingersUp === 4) return "5";
        if (!isThumbUp && fingersUp === 4) return "4";
        if (!isThumbUp && isIndexUp && isMiddleUp && isRingUp && !isLittleUp) return "3";
        if (!isThumbUp && isIndexUp && isMiddleUp && !isRingUp && !isLittleUp) return "2";
        if (!isThumbUp && isIndexUp && !isMiddleUp && !isRingUp && !isLittleUp) return "1";
        if (isThumbUp && fingersUp === 0) return "6";
        
        return (fingersUp + (isThumbUp ? 1 : 0)).toString();
    }

    // 滚动控制器
    function handleScrolling(num) {
        // 重置闪烁状态
        upBtn.classList.remove('flash');
        downBtn.classList.remove('flash');

        if (num === "2") {
            upBtn.classList.add('flash'); // 识别到 2 时上面按钮闪烁
            if (activeGesture !== "2") {
                activeGesture = "2";
                gestureStartTime = Date.now();
            } else if (Date.now() - gestureStartTime > THRESHOLD_MS) {
                // 超过阈值，执行向上滚动
                window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'instant' });
            }
        } else if (num === "3") {
            downBtn.classList.add('flash'); // 识别到 3 时下面按钮闪烁
            if (activeGesture !== "3") {
                activeGesture = "3";
                gestureStartTime = Date.now();
            } else if (Date.now() - gestureStartTime > THRESHOLD_MS) {
                // 超过阈值，执行向下滚动
                window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'instant' });
            }
        } else {
            // 没有识别到 2 或 3，重置状态
            activeGesture = null;
        }
    }

    function onResults(results) {
        if (!isActive) return;

        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
        
        let detectedNum = "-";

        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            for (const landmarks of results.multiHandLandmarks) {
                window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, {color: '#ffffff33', lineWidth: 2});
                window.drawLandmarks(canvasCtx, landmarks, {color: '#00f2ff', lineWidth: 1, radius: 2});
                
                detectedNum = getNumber(landmarks);
            }
        }
        
        canvasCtx.restore();
        handleScrolling(detectedNum);
    }

    async function startSystem() {
        try {
            toggleBtn.innerText = "正在加载模型 (需科学上网)...";
            toggleBtn.style.pointerEvents = "none"; // 防止重复点击

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
            
            toggleBtn.innerText = "请求摄像头权限...";
            await camera.start(); // 这里如果没给权限会抛出异常
            
            isActive = true;
            debugWindow.style.display = 'block';
            rightPanel.style.display = 'flex';
            toggleBtn.innerText = "关闭手势控制";
            toggleBtn.classList.add('active');
            toggleBtn.style.pointerEvents = "auto";

        } catch (error) {
            console.error("手势控制初始化失败:", error);
            toggleBtn.innerText = "加载失败 (请按F12看控制台)";
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
        if (camera) {
            camera.stop();
        }
        // 清除状态
        activeGesture = null;
        upBtn.classList.remove('flash');
        downBtn.classList.remove('flash');
    }

    // 绑定按钮事件
    toggleBtn.addEventListener('click', () => {
        if (isActive) {
            stopSystem();
        } else {
            startSystem();
        }
    });
}

// 页面加载完成后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGestureControl);
} else {
    initGestureControl();
}