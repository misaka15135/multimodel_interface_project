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
    if (document.getElementById('hybrid-plugin-root')) return;
    const root = document.createElement('div');
    root.id = 'hybrid-plugin-root';
    root.innerHTML = `
        <div id="hybrid-cursor"></div>
        <div id="hybrid-left-panel">
            <div id="hybrid-debug-window">
                <video id="hybrid-video" playsinline></video>
                <canvas id="hybrid-canvas"></canvas>
            </div>
            <button id="hybrid-toggle-btn">开启混合控制</button>
        </div>
        <div id="hybrid-right-panel">
            <div id="mode-badge">👐 手势模式</div>
            
            <div id="finger-status">
                <div class="finger-row"><div class="finger-label">拇指</div><div class="finger-bar"><div id="finger-thumb" class="finger-fill"></div></div></div>
                <div class="finger-row"><div class="finger-label">食指</div><div class="finger-bar"><div id="finger-index" class="finger-fill"></div></div></div>
                <div class="finger-row"><div class="finger-label">中指</div><div class="finger-bar"><div id="finger-middle" class="finger-fill"></div></div></div>
                <div class="finger-row"><div class="finger-label">无名指</div><div class="finger-bar"><div id="finger-ring" class="finger-fill"></div></div></div>
                <div class="finger-row"><div class="finger-label">小指</div><div class="finger-bar"><div id="finger-pinky" class="finger-fill"></div></div></div>
            </div>

            <div id="head-status">
                <div class="head-status-row">
                    <div class="head-label">俯仰 (页面滚动)</div>
                    <div class="pitch-bar">
                        <div id="pitch-bound-up" class="pitch-bound"></div>
                        <div id="pitch-bound-down" class="pitch-bound"></div>
                        <div id="pitch-indicator"></div>
                    </div>
                </div>
                <div class="head-status-row">
                    <div class="head-label">偏航 (视频进度)</div>
                    <div class="yaw-bar">
                        <div id="yaw-bound-left" class="yaw-bound"></div>
                        <div id="yaw-bound-right" class="yaw-bound"></div>
                        <div id="yaw-indicator"></div>
                    </div>
                </div>
            </div>

            <div id="hybrid-actions">
                <div class="hybrid-action-box" id="box-mode-toggle"><span class="hybrid-icon">✌️</span><span>切模式</span></div>
                <div class="hybrid-action-box" id="box-free-mode"><span class="hybrid-icon">🖱️</span><span>自由</span></div>
                <div class="hybrid-action-box" id="box-scroll-up"><span class="hybrid-icon">⬆️</span><span>上滚</span></div>
                <div class="hybrid-action-box" id="box-scroll-down"><span class="hybrid-icon">⬇️</span><span>下滚</span></div>
                <div class="hybrid-action-box" id="box-rewind"><span class="hybrid-icon">👈</span><span>后退</span></div>
                <div class="hybrid-action-box" id="box-forward"><span class="hybrid-icon">👉</span><span>前进</span></div>
                <div class="hybrid-action-box" id="box-play-pause"><span class="hybrid-icon">⏯️</span><span>启停</span></div>
                <div class="hybrid-action-box" id="box-stop"><span class="hybrid-icon">🤙</span><span>关闭</span></div>
            </div>
        </div>
    `;
    document.body.appendChild(root);
}

async function initHybridControl() {
    injectUI();

    const videoElement = document.getElementById('hybrid-video');
    const canvasElement = document.getElementById('hybrid-canvas');
    const canvasCtx = canvasElement.getContext('2d');
    const toggleBtn = document.getElementById('hybrid-toggle-btn');
    const cursorEl = document.getElementById('hybrid-cursor');

    canvasElement.width = 320;
    canvasElement.height = 240;

    let isActive = false;
    let camera = null;
    let hands = null;
    let faceMesh = null;

    // 系统状态
    let currentMode = "HAND"; // 可选: "HAND", "HEAD"
    const SCROLL_SPEED = 45;
    const CONTINUOUS_CONFIRM_TIME = 900;
    let activeGesture = null;
    let gestureStartTime = 0;
    let uiClearTimeouts = {};
    const cooldowns = { VIDEO_SEEK: 0, VIDEO_TOGGLE: 0 };

    // 自由模式参数 (仅限Hand)
    let isFreeMode = false;
    let cursorX = window.innerWidth / 2, cursorY = window.innerHeight / 2;
    let smoothedCursorX = cursorX, smoothedCursorY = cursorY;
    let lastDwellX = 0, lastDwellY = 0;
    let dwellStartTime = 0;

    // ----- 头控参数配置 -----
    const EDGE_UP = -0.08, EDGE_DOWN = 0.12;       // 俯仰滚动阈值
    const EDGE_YAW_LEFT = 0.12, EDGE_YAW_RIGHT = -0.12; // 偏航进度阈值

    const RATIO_P_MIN = -0.20, RATIO_P_MAX = 0.24, RATIO_P_RANGE = 0.44;
    const RATIO_Y_MIN = -0.25, RATIO_Y_MAX = 0.25, RATIO_Y_RANGE = 0.50;

    // 预设UI边界线
    document.getElementById('pitch-bound-up').style.top = `${((EDGE_UP - RATIO_P_MIN) / RATIO_P_RANGE) * 100}%`;
    document.getElementById('pitch-bound-down').style.top = `${((EDGE_DOWN - RATIO_P_MIN) / RATIO_P_RANGE) * 100}%`;
    document.getElementById('yaw-bound-right').style.left = `${((EDGE_YAW_RIGHT - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100}%`;
    document.getElementById('yaw-bound-left').style.left = `${((EDGE_YAW_LEFT - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100}%`;

    const FACE_MAP = { nose: 1, forehead: 10, chin: 152, leftEyeOuter: 33, rightEyeOuter: 263 };

    // ================= DOM 控制 =================
    function getActiveVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (!videos.length) return null;
        let active = videos.find(v => !v.paused && v.offsetWidth > 0);
        if (!active) active = videos.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
        return active;
    }
    function adjustVideoTime(s) { const v = getActiveVideo(); if (v) { v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + s)); return true; } return false; }
    function togglePlayPause() { const v = getActiveVideo(); if (v) { v.paused ? v.play() : v.pause(); return true; } return false; }

    // ================= UI 更新 =================
    const GESTURE_BOX_MAP = {
        "V_SIGN": "box-mode-toggle",
        "PALM_UP": "box-scroll-up", "PALM_DOWN": "box-scroll-down",
        "POINT_LEFT": "box-rewind", "POINT_RIGHT": "box-forward",
        "MIDDLE": "box-play-pause", "FREE_MODE_TOGGLE": "box-free-mode", "PINKY_ONLY": "box-stop",
        "HEAD_UP": "box-scroll-up", "HEAD_DOWN": "box-scroll-down",
        "HEAD_YAW_LEFT": "box-rewind", "HEAD_YAW_RIGHT": "box-forward"
    };

    function resetUIState() { document.querySelectorAll('.hybrid-action-box').forEach(el => el.classList.remove('scaling', 'glowing', 'error-glow')); }

    function triggerInstantUI(boxId, isSuccess) {
        const box = document.getElementById(boxId);
        if (!box) return;
        box.classList.remove('scaling', 'glowing', 'error-glow');
        void box.offsetWidth;
        box.classList.add(isSuccess ? 'glowing' : 'error-glow');
        if (uiClearTimeouts[boxId]) clearTimeout(uiClearTimeouts[boxId]);
        uiClearTimeouts[boxId] = setTimeout(() => box.classList.remove('glowing', 'error-glow'), 600);
    }

    function switchMode(newMode) {
        currentMode = newMode;
        const badge = document.getElementById('mode-badge');
        const fingerStatus = document.getElementById('finger-status');
        const headStatus = document.getElementById('head-status');

        if (newMode === "HEAD") {
            badge.innerText = "🗣️ 头控模式 (V字切回)";
            badge.className = "head-mode";
            fingerStatus.style.display = "none";
            headStatus.style.display = "flex";
            isFreeMode = false; cursorEl.style.display = 'none';
        } else {
            badge.innerText = "👐 手势模式 (V字切回)";
            badge.className = "";
            fingerStatus.style.display = "flex";
            headStatus.style.display = "none";
            updatePitchIndicator(0); updateYawIndicator(0);
        }
        resetUIState();
        activeGesture = null;
    }

    function handleContinuous(gesture, boxId, isRepeatable, onConfirm) {
        const now = Date.now();
        const box = boxId ? document.getElementById(boxId) : null;

        if (activeGesture !== gesture) {
            resetUIState();
            activeGesture = gesture;
            gestureStartTime = now;
            if (box) box.classList.add('scaling');
        } else if (now - gestureStartTime > CONTINUOUS_CONFIRM_TIME) {
            if (box && !isRepeatable) { box.classList.remove('scaling'); box.classList.add('glowing'); }
            onConfirm();
            if (!isRepeatable) {
                activeGesture = "COOLDOWN";
                setTimeout(() => { if (activeGesture === "COOLDOWN") activeGesture = null; if (box) box.classList.remove('glowing'); }, 1500);
            }
        }
    }

    // ================= 手部识别引擎 =================
    function getDistance(p1, p2) { return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2)); }
    function isFingerExtended(landmarks, tipIdx, mcpIdx) { return getDistance(landmarks[tipIdx], landmarks[0]) > getDistance(landmarks[mcpIdx], landmarks[0]) * 1.25; }

    function updateFingerStatus(landmarks) {
        if (!landmarks) { ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach(f => { const el = document.getElementById('finger-' + f); if (el) el.style.width = '0%'; }); return; }
        const tips = [{ t: 4, m: 2, id: 'thumb' }, { t: 8, m: 5, id: 'index' }, { t: 12, m: 9, id: 'middle' }, { t: 16, m: 13, id: 'ring' }, { t: 20, m: 17, id: 'pinky' }];
        for (const f of tips) {
            const dTip = getDistance(landmarks[f.t], landmarks[0]), dMcp = getDistance(landmarks[f.m], landmarks[0]);
            const el = document.getElementById('finger-' + f.id);
            if (el) {
                let pct = dMcp > 0 ? Math.min(1, dTip / (dMcp * 1.6)) : 0;
                el.style.width = (pct * 100) + '%';
                el.style.background = pct > 0.66 ? '#00f2ff' : (pct > 0.33 ? '#f59e0b' : '#374151');
            }
        }
    }

    function recognizeGesture(landmarks) {
        const indexEx = isFingerExtended(landmarks, 8, 5), middleEx = isFingerExtended(landmarks, 12, 9), ringEx = isFingerExtended(landmarks, 16, 13), pinkyEx = isFingerExtended(landmarks, 20, 17);
        // V_SIGN 作为全局切换键
        if (indexEx && middleEx && !ringEx && !pinkyEx) return "V_SIGN";

        // 如果是在头控模式，除了 V_SIGN 其它全部忽略
        if (currentMode === "HEAD") return "NONE";

        if (!indexEx && !middleEx && !ringEx && pinkyEx) return "PINKY_ONLY";
        if (!indexEx && middleEx && ringEx && !pinkyEx) return "FREE_MODE_TOGGLE";
        if (indexEx && middleEx && ringEx && pinkyEx) {
            const dy = landmarks[9].y - landmarks[0].y;
            if (dy < -0.15) return "PALM_UP";
            if (dy > 0.15) return "PALM_DOWN";
        }
        if (!indexEx && middleEx && !ringEx && !pinkyEx) return "MIDDLE";
        if (indexEx && !middleEx && !ringEx && !pinkyEx) {
            const dx = landmarks[8].x - landmarks[5].x;
            if (dx > 0.08) return "POINT_LEFT";
            if (dx < -0.08) return "POINT_RIGHT";
        }
        return "NONE";
    }

    // ================= 头部识别引擎 =================
    function updatePitchIndicator(ratio) {
        const ind = document.getElementById('pitch-indicator');
        if (!ind) return;
        let pct = Math.max(0, Math.min(100, ((ratio - RATIO_P_MIN) / RATIO_P_RANGE) * 100));
        ind.style.top = pct + '%';
        ind.style.background = (ratio < EDGE_UP || ratio > EDGE_DOWN) ? '#00f2ff' : '#10b981';
    }

    function updateYawIndicator(ratio) {
        const ind = document.getElementById('yaw-indicator');
        if (!ind) return;
        let pct = Math.max(0, Math.min(100, ((ratio - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100));
        ind.style.left = pct + '%';
        ind.style.background = (ratio > EDGE_YAW_LEFT || ratio < EDGE_YAW_RIGHT) ? '#00f2ff' : '#10b981';
    }

    function analyzeHeadPosture(landmarks) {
        const nose = landmarks[FACE_MAP.nose], forehead = landmarks[FACE_MAP.forehead], chin = landmarks[FACE_MAP.chin], leftEye = landmarks[FACE_MAP.leftEyeOuter], rightEye = landmarks[FACE_MAP.rightEyeOuter];

        // 俯仰计算
        const faceHeight = Math.max(Math.abs(chin.y - forehead.y), 1e-5);
        const eyeCenterY = (leftEye.y + rightEye.y) / 2;
        const pitchRatio = (nose.y - eyeCenterY - faceHeight * 0.16) / faceHeight;
        updatePitchIndicator(pitchRatio);

        // 偏航计算 (水平扭头)
        const faceWidth = Math.max(Math.abs(rightEye.x - leftEye.x), 1e-5);
        const eyeCenterX = (leftEye.x + rightEye.x) / 2;
        const yawRatio = (nose.x - eyeCenterX) / faceWidth;
        updateYawIndicator(yawRatio);

        // 判定 (Yaw 优先级高于 Pitch)
        // 镜像逻辑：物理向左转 = 图像向右 = nose.x 变大 = yawRatio 正值
        if (yawRatio > EDGE_YAW_LEFT) return "HEAD_YAW_LEFT";
        if (yawRatio < EDGE_YAW_RIGHT) return "HEAD_YAW_RIGHT";

        if (pitchRatio < EDGE_UP) return "HEAD_UP";
        if (pitchRatio > EDGE_DOWN) return "HEAD_DOWN";

        return "CENTERED";
    }

    // ================= 动作执行路由器 =================
    function executeAction(gesture) {
        const now = Date.now();

        // 1. 全局模式切换
        if (gesture === "V_SIGN") {
            handleContinuous(gesture, GESTURE_BOX_MAP[gesture], false, () => {
                switchMode(currentMode === "HAND" ? "HEAD" : "HAND");
            });
            return;
        }

        // 打断未完成的持续动作
        if (activeGesture && activeGesture !== gesture && ["PALM_UP", "PALM_DOWN", "HEAD_UP", "HEAD_DOWN", "V_SIGN", "FREE_MODE_TOGGLE"].includes(activeGesture)) {
            resetUIState(); activeGesture = null;
        }

        if (currentMode === "HAND") {
            if (isFreeMode) {
                if (gesture === "FREE_MODE_TOGGLE") { handleContinuous(gesture, "box-free-mode", false, () => { isFreeMode = false; cursorEl.style.display = 'none'; triggerInstantUI("box-free-mode", true); }); }
                else if (activeGesture === "FREE_MODE_TOGGLE") { activeGesture = null; resetUIState(); }
                return;
            }
            if (gesture === "PALM_UP") return handleContinuous(gesture, "box-scroll-up", true, () => window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'instant' }));
            if (gesture === "PALM_DOWN") return handleContinuous(gesture, "box-scroll-down", true, () => window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'instant' }));
            if (gesture === "PINKY_ONLY") return handleContinuous(gesture, "box-stop", false, stopSystem);
            if (gesture === "FREE_MODE_TOGGLE") return handleContinuous(gesture, "box-free-mode", false, () => { isFreeMode = true; cursorEl.style.display = 'block'; triggerInstantUI("box-free-mode", true); dwellStartTime = now; });

            const boxId = GESTURE_BOX_MAP[gesture];
            if (gesture === "POINT_RIGHT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "POINT_LEFT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(-5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "MIDDLE" && now > cooldowns.VIDEO_TOGGLE) { togglePlayPause(); triggerInstantUI(boxId, true); cooldowns.VIDEO_TOGGLE = now + 1000; }

        } else if (currentMode === "HEAD") {
            if (gesture === "HEAD_UP") return handleContinuous(gesture, "box-scroll-up", true, () => window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'auto' }));
            if (gesture === "HEAD_DOWN") return handleContinuous(gesture, "box-scroll-down", true, () => window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'auto' }));

            const boxId = GESTURE_BOX_MAP[gesture];
            if (gesture === "HEAD_YAW_LEFT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(-5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "HEAD_YAW_RIGHT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
        }
    }

    // ================= 媒体流与模型处理 =================
    async function startSystem() {
        try {
            toggleBtn.innerText = "模块注入中...";
            // 加载所需所有MediaPipe组件
            if (!window.Hands || !window.FaceMesh) {
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js");
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js");
            }
            if (!hands) {
                hands = new window.Hands({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
                hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.7 });
                hands.onResults((res) => {
                    if (!isActive) return;
                    canvasCtx.save();
                    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

                    let handGesture = "NONE";
                    if (res.multiHandLandmarks?.length > 0) {
                        const lm = res.multiHandLandmarks[0];
                        window.drawConnectors(canvasCtx, lm, window.HAND_CONNECTIONS, { color: 'rgba(255,255,255,0.2)', lineWidth: 2 });
                        window.drawLandmarks(canvasCtx, lm, { color: '#00f2ff', lineWidth: 1, radius: 2.5 });
                        handGesture = recognizeGesture(lm);
                        if (currentMode === "HAND") updateFingerStatus(lm);
                    } else {
                        if (currentMode === "HAND") updateFingerStatus(null);
                    }
                    canvasCtx.restore();
                    // 如果手部识别出了动作，优先执行（例如V_SIGN切模式）
                    if (handGesture !== "NONE") executeAction(handGesture);
                });
            }
            if (!faceMesh) {
                faceMesh = new window.FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
                faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
                faceMesh.onResults((res) => {
                    if (!isActive || currentMode !== "HEAD") return;
                    canvasCtx.save();
                    let headGesture = "CENTERED";
                    if (res.multiFaceLandmarks?.length > 0) {
                        const lm = res.multiFaceLandmarks[0];
                        window.drawConnectors(canvasCtx, lm, window.FACEMESH_TESSELATION, { color: 'rgba(255,255,255,0.1)', lineWidth: 1 });
                        headGesture = analyzeHeadPosture(lm);
                    } else {
                        updatePitchIndicator(0); updateYawIndicator(0);
                    }
                    canvasCtx.restore();
                    // 只有在手部没有动作霸占（比如没在做V字手势时），执行头控动作
                    if (activeGesture !== "V_SIGN") executeAction(headGesture);
                });
            }

            camera = new window.Camera(videoElement, {
                onFrame: async () => {
                    if (isActive) {
                        await hands.send({ image: videoElement });
                        if (currentMode === "HEAD") {
                            await faceMesh.send({ image: videoElement });
                        }
                    }
                },
                width: 320, height: 240
            });

            toggleBtn.innerText = "请求硬件权限...";
            await camera.start();
            isActive = true;
            document.getElementById('hybrid-debug-window').style.display = 'block';
            toggleBtn.innerText = "关闭混合控制";
            toggleBtn.classList.add('active');
            switchMode("HAND"); // 默认手控
        } catch (error) {
            console.error(error);
            toggleBtn.innerText = "加载失败 (F12看控制台)";
            isActive = false;
        }
    }

    function stopSystem() {
        isActive = false;
        document.getElementById('hybrid-debug-window').style.display = 'none';
        toggleBtn.innerText = "开启混合控制";
        toggleBtn.classList.remove('active');
        if (camera) camera.stop();
        resetUIState();
        isFreeMode = false; cursorEl.style.display = 'none'; activeGesture = null;
    }

    toggleBtn.addEventListener('click', () => { isActive ? stopSystem() : startSystem(); });
    setTimeout(() => { if (!isActive) startSystem(); }, 800);
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initHybridControl); }
else { initHybridControl(); }