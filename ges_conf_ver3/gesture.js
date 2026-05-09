// 注入UI元素
function injectUI() {
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

    let activeGesture = null;
    let gestureStartTime = 0;
    const THRESHOLD_MS = 600;
    const SCROLL_SPEED = 30;

    function getDistance(p1, p2) {
        return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
    }

    function isOpenPalm(landmarks) {
        const isIndexExtended = getDistance(landmarks[8], landmarks[0]) > getDistance(landmarks[5], landmarks[0]) * 1.2;
        const isMiddleExtended = getDistance(landmarks[12], landmarks[0]) > getDistance(landmarks[9], landmarks[0]) * 1.2;
        const isRingExtended = getDistance(landmarks[16], landmarks[0]) > getDistance(landmarks[13], landmarks[0]) * 1.2;
        const isLittleExtended = getDistance(landmarks[20], landmarks[0]) > getDistance(landmarks[17], landmarks[0]) * 1.2;
        return isIndexExtended && isMiddleExtended && isRingExtended && isLittleExtended;
    }

    function getHandOrientation(landmarks) {
        if (!isOpenPalm(landmarks)) return null;
        const dy = landmarks[9].y - landmarks[0].y;
        if (dy < -0.1) return "UP";
        if (dy > 0.1) return "DOWN";
        return null;
    }

    function handleScrolling(orientation) {
        upBtn.classList.remove('flash');
        downBtn.classList.remove('flash');

        if (orientation === "UP") {
            upBtn.classList.add('flash'); 
            if (activeGesture !== "UP") {
                activeGesture = "UP";
                gestureStartTime = Date.now();
            } else if (Date.now() - gestureStartTime > THRESHOLD_MS) {
                window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'instant' });
            }
        } else if (orientation === "DOWN") {
            downBtn.classList.add('flash'); 
            if (activeGesture !== "DOWN") {
                activeGesture = "DOWN";
                gestureStartTime = Date.now();
            } else if (Date.now() - gestureStartTime > THRESHOLD_MS) {
                window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'instant' });
            }
        } else {
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
                detectedOrientation = getHandOrientation(landmarks);
            }
        }
        
        canvasCtx.restore();
        handleScrolling(detectedOrientation);
    }

    async function startSystem() {
        try {
            toggleBtn.innerText = "模型初始化中...";
            toggleBtn.style.pointerEvents = "none";

            if (!hands) {
                const locateFile = (file) => {
                    // 支持 chrome.runtime 和 browser.runtime
                    try {
                        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                            return chrome.runtime.getURL('libs/' + file);
                        }
                        if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) {
                            return browser.runtime.getURL('libs/' + file);
                        }
                    } catch (e) {}
                    if (document.currentScript && document.currentScript.src) {
                        return document.currentScript.src.replace('gesture.js', '') + 'libs/' + file;
                    }
                    return 'libs/' + file;
                };

                // 先确保底层 wasm/js loader 已经从扩展 libs/ 加载成功
                async function loadExternalScript(url) {
                    return new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        s.src = url;
                        s.crossOrigin = 'anonymous';
                        s.onload = () => resolve();
                        s.onerror = () => reject(new Error('Failed to load ' + url));
                        document.head.appendChild(s);
                    });
                }

                // 加载 wasm loader 与 packed assets loader，若加载失败则抛错（避免后续 n is not a function）
                await loadExternalScript(locateFile('hands_solution_simd_wasm_bin.js'));
                await loadExternalScript(locateFile('hands_solution_packed_assets_loader.js'));

                hands = new window.Hands({
                    // 指向插件内部的 libs 文件夹（优先使用 chrome.runtime.getURL）
                    locateFile: locateFile
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
        toggleBtn.style.backgroundColor = "";
        if (camera) camera.stop();
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