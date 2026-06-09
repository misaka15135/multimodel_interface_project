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

function injectUI() {
    if (document.getElementById('head-plugin-root')) return;
    const root = document.createElement('div');
    root.id = 'head-plugin-root';
    root.innerHTML = `
        <div id="head-left-panel">
            <div id="head-debug-window">
                <video id="head-video" playsinline></video>
                <canvas id="head-canvas"></canvas>
            </div>
            <button id="head-toggle-btn">开启头部追踪</button>
        </div>
        <div id="head-right-panel">
            <div id="pitch-status">
                <div class="pitch-label">头部俯仰</div>
                <div class="pitch-bar">
                    <div id="pitch-bound-up" class="pitch-bound"></div>
                    <div id="pitch-bound-down" class="pitch-bound"></div>
                    <div id="pitch-indicator"></div>
                </div>
            </div>
            <div class="head-action-box" id="box-scroll-up"><span class="head-icon">⬆️</span><span>上滚</span></div>
            <div class="head-action-box" id="box-scroll-down"><span class="head-icon">⬇️</span><span>下滚</span></div>
            <div class="head-action-box" id="box-center"><span class="head-icon">⏺️</span><span>居中</span></div>
        </div>
    `;
    document.body.appendChild(root);
}

async function initHeadControl() {
    injectUI();

    const videoElement = document.getElementById('head-video');
    const canvasElement = document.getElementById('head-canvas');
    const canvasCtx = canvasElement.getContext('2d');
    const toggleBtn = document.getElementById('head-toggle-btn');

    canvasElement.width = 320;
    canvasElement.height = 240;

    let isActive = false;
    let camera = null;
    let faceMesh = null;

    // 动作与控制参数
    const SCROLL_SPEED = 40;
    const CONTINUOUS_CONFIRM_TIME = 300;
    let activeGesture = null;
    let gestureStartTime = 0;

    // ----- 俯仰核心参数配置 -----
    // 原参数为 -0.05 与 0.08。现在将区间调大，降低灵敏度
    const EDGE_UP = -0.08;
    const EDGE_DOWN = 0.12;

    // UI 指示条映射的极端范围（用于计算百分比）
    const RATIO_MIN = -0.20;
    const RATIO_MAX = 0.24;
    const RATIO_RANGE = RATIO_MAX - RATIO_MIN;

    // 动态设置两条边界线的视觉位置，使其与代码逻辑绝对对齐
    document.getElementById('pitch-bound-up').style.top = `${((EDGE_UP - RATIO_MIN) / RATIO_RANGE) * 100}%`;
    document.getElementById('pitch-bound-down').style.top = `${((EDGE_DOWN - RATIO_MIN) / RATIO_RANGE) * 100}%`;

    // 面部特征点索引
    const HEAD = { nose: 1, forehead: 10, chin: 152, leftEyeOuter: 33, rightEyeOuter: 263 };

    function analyzeHeadPosture(landmarks) {
        const nose = landmarks[HEAD.nose];
        const forehead = landmarks[HEAD.forehead];
        const chin = landmarks[HEAD.chin];
        const leftEye = landmarks[HEAD.leftEyeOuter];
        const rightEye = landmarks[HEAD.rightEyeOuter];

        const faceHeight = Math.max(Math.abs(chin.y - forehead.y), 1e-5);
        const eyeCenterY = (leftEye.y + rightEye.y) / 2;

        // 计算俯仰比例
        const verticalRatio = (nose.y - eyeCenterY - faceHeight * 0.16) / faceHeight;

        // 更新 UI 指示器
        updatePitchIndicator(verticalRatio);

        // 判定姿态
        if (verticalRatio < EDGE_UP) return "LOOKING_UP";
        if (verticalRatio > EDGE_DOWN) return "LOOKING_DOWN";
        return "CENTERED";
    }

    function updatePitchIndicator(ratio) {
        const indicator = document.getElementById('pitch-indicator');
        if (!indicator) return;

        // 将 ratio 映射到 0% - 100% 范围
        let percent = ((ratio - RATIO_MIN) / RATIO_RANGE) * 100;
        percent = Math.max(0, Math.min(100, percent));

        indicator.style.top = percent + '%';

        // 如果超出了上下限（触发滚动状态）
        if (ratio < EDGE_UP || ratio > EDGE_DOWN) {
            indicator.style.background = '#00f2ff'; // 蓝色高亮
            indicator.style.height = '6px';
        } else {
            indicator.style.background = '#10b981'; // 居中盲区内呈现绿色
            indicator.style.height = '4px';
        }
    }

    // ================= UI 与 调度引擎 =================
    const GESTURE_MAP = {
        "LOOKING_UP": "box-scroll-up",
        "LOOKING_DOWN": "box-scroll-down",
        "CENTERED": "box-center"
    };

    function resetUIState() {
        document.querySelectorAll('.head-action-box').forEach(el => el.classList.remove('scaling', 'glowing'));
    }

    function handleContinuous(gesture, boxId, onConfirm) {
        const now = Date.now();
        const box = boxId ? document.getElementById(boxId) : null;

        if (activeGesture !== gesture) {
            resetUIState();
            activeGesture = gesture;
            gestureStartTime = now;
            if (box) box.classList.add('scaling');
        } else if (now - gestureStartTime > CONTINUOUS_CONFIRM_TIME) {
            if (box) {
                box.classList.remove('scaling');
                box.classList.add('glowing');
            }
            if (onConfirm) onConfirm();
        }
    }

    function executeAction(gesture) {
        if (gesture === "LOOKING_UP") {
            handleContinuous(gesture, GESTURE_MAP[gesture], () => window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'auto' }));
        } else if (gesture === "LOOKING_DOWN") {
            handleContinuous(gesture, GESTURE_MAP[gesture], () => window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'auto' }));
        } else {
            handleContinuous(gesture, GESTURE_MAP[gesture], null);
        }
    }

    function onResults(results) {
        if (!isActive) return;

        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        let detectedPosture = "CENTERED";
        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
            const landmarks = results.multiFaceLandmarks[0];

            // 绘制关键特征点以便调试
            window.drawConnectors(canvasCtx, landmarks, window.FACEMESH_TESSELATION, { color: 'rgba(255,255,255,0.1)', lineWidth: 1 });

            detectedPosture = analyzeHeadPosture(landmarks);
        }

        canvasCtx.restore();
        executeAction(detectedPosture);
    }

    async function startSystem() {
        try {
            toggleBtn.innerText = "模块注入中...";
            if (!window.FaceMesh) {
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js");
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js");
            }
            if (!faceMesh) {
                faceMesh = new window.FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
                faceMesh.setOptions({
                    maxNumFaces: 1,
                    refineLandmarks: true,
                    minDetectionConfidence: 0.5,
                    minTrackingConfidence: 0.5
                });
                faceMesh.onResults(onResults);
                camera = new window.Camera(videoElement, {
                    onFrame: async () => { if (isActive) await faceMesh.send({ image: videoElement }); },
                    width: 320,
                    height: 240
                });
            }
            toggleBtn.innerText = "请求硬件摄像头权限...";
            await camera.start();
            isActive = true;
            document.getElementById('head-debug-window').style.display = 'block';
            toggleBtn.innerText = "关闭头部追踪";
            toggleBtn.classList.add('active');
        } catch (error) {
            console.error(error);
            toggleBtn.innerText = "加载失败 (F12看控制台)";
            isActive = false;
        }
    }

    function stopSystem() {
        isActive = false;
        document.getElementById('head-debug-window').style.display = 'none';
        toggleBtn.innerText = "开启头部追踪";
        toggleBtn.classList.remove('active');
        if (camera) camera.stop();
        resetUIState();
        activeGesture = null;
        // 停止时将其归位到百分之50处，避免越界
        updatePitchIndicator((RATIO_MAX + RATIO_MIN) / 2);
    }

    toggleBtn.addEventListener('click', () => { isActive ? stopSystem() : startSystem(); });

    // 全局自启动挂载
    setTimeout(() => { if (!isActive) startSystem(); }, 800);
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initHeadControl); }
else { initHeadControl(); }