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
    const oldRoot = document.getElementById('hybrid-plugin-root');
    if (oldRoot) oldRoot.remove(); // 热重载清理

    const root = document.createElement('div');
    root.id = 'hybrid-plugin-root';
    root.innerHTML = `
        <div id="voice-panel">
            <div class="voice-header">
                <div id="voice-dot" class="voice-dot sleeping"></div>
                <span id="voice-status-text" style="color: #9ca3af;">语音待机中</span>
            </div>
            <div id="voice-message" class="voice-message">请呼叫“小助手”激活语音控制</div>
        </div>

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
                <div class="head-status-row">
                    <div class="head-label">张嘴 (视频启停)</div>
                    <div class="mouth-bar">
                        <div id="mouth-bound-open" class="mouth-bound"></div>
                        <div id="mouth-indicator"></div>
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
                <div class="hybrid-action-box" id="box-like"><span class="hybrid-icon">💍</span><span>点赞</span></div>
                <div class="hybrid-action-box" id="box-speed"><span class="hybrid-icon">🤘</span><span>倍速</span></div>
                <div class="hybrid-action-box" id="box-refresh"><span class="hybrid-icon">🔄</span><span>刷新</span></div>
                <div class="hybrid-action-box" id="box-stop"><span class="hybrid-icon">🤙</span><span>关闭</span></div>
            </div>
        </div>
    `;
    document.body.appendChild(root);
}

// ⚠️ 注意这里：将原本放在外面的 VoiceControl 核心变量全部收回闭包内
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

    // === 语音控制相关全局变量与 API 配置 ===
    let voiceRecognition = null;
    let isVoiceAwake = false;
    let voiceTimeoutTimer = null;

    const LLM_API_CONFIG = {
        url: "https://api.deepseek.com/v1/chat/completions",
        key: "sk-f539f9161309446d953c3357c6f92750", 
        model: "deepseek-v4-flash" 
    };

    let currentMode = "HAND"; 
    const SCROLL_SPEED = 45;
    let activeGesture = null;
    let gestureStartTime = 0;
    let uiClearTimeouts = {};
    const cooldowns = { LIKE: 0, REFRESH: 0, VIDEO_SEEK: 0, VIDEO_TOGGLE: 0, SPEED: 0 };

    let isFreeMode = false;
    let cursorX = window.innerWidth / 2, cursorY = window.innerHeight / 2;
    let smoothedCursorX = cursorX, smoothedCursorY = cursorY;
    let lastDwellX = 0, lastDwellY = 0;
    let dwellStartTime = 0;

    const EDGE_UP = -0.08, EDGE_DOWN = 0.12;
    const EDGE_YAW_LEFT = 0.12, EDGE_YAW_RIGHT = -0.12;
    const RATIO_P_MIN = -0.20, RATIO_P_MAX = 0.24, RATIO_P_RANGE = 0.44;
    const RATIO_Y_MIN = -0.25, RATIO_Y_MAX = 0.25, RATIO_Y_RANGE = 0.50;
    const EDGE_MOUTH_OPEN = 0.11;
    const RATIO_M_MAX = 0.22;

    let lastPitchState = "CENTERED";
    let nodTimes = [];
    let lastYawState = "CENTERED";
    let shakeTimes = [];

    document.getElementById('pitch-bound-up').style.top = `${((EDGE_UP - RATIO_P_MIN) / RATIO_P_RANGE) * 100}%`;
    document.getElementById('pitch-bound-down').style.top = `${((EDGE_DOWN - RATIO_P_MIN) / RATIO_P_RANGE) * 100}%`;
    document.getElementById('yaw-bound-right').style.left = `${((EDGE_YAW_RIGHT - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100}%`;
    document.getElementById('yaw-bound-left').style.left = `${((EDGE_YAW_LEFT - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100}%`;
    document.getElementById('mouth-bound-open').style.left = `${(EDGE_MOUTH_OPEN / RATIO_M_MAX) * 100}%`;

    const FACE_MAP = {
        nose: 1, forehead: 10, chin: 152,
        leftEyeOuter: 33, rightEyeOuter: 263,
        upperLipInner: 13, lowerLipInner: 14
    };

    // --- DOM 控制函数 ---
    function triggerPageLike() {
        const selectors = ['[aria-label*="赞"]', '[aria-label*="like"]', '.like-btn', 'svg[class*="like"]', '[class*="zan"]'];
        for (const sel of selectors) { const el = document.querySelector(sel); if (el && typeof el.click === 'function') { el.click(); return true; } }
        for (const el of document.querySelectorAll('button, [role="button"], span, div')) { if (/^赞$|^点赞$|^like$/i.test(el.textContent?.trim()) && el.offsetParent !== null) { el.click(); return true; } }
        return false;
    }
    function getActiveVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (!videos.length) return null;
        let active = videos.find(v => !v.paused && v.offsetWidth > 0);
        if (!active) active = videos.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
        return active;
    }
    function adjustVideoTime(s) { const v = getActiveVideo(); if (v) { v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + s)); return true; } return false; }
    function togglePlayPause() { const v = getActiveVideo(); if (v) { v.paused ? v.play() : v.pause(); return true; } return false; }
    function toggleSpeed() { const v = getActiveVideo(); if (v) { v.playbackRate = v.playbackRate === 1.0 ? 2.0 : 1.0; return true; } return false; }
    function simulateClick(x, y) {
        cursorEl.style.display = 'none';
        const el = document.elementFromPoint(x, y);
        cursorEl.style.display = 'block';
        if (el) { el.focus?.(); ['mousedown', 'mouseup', 'click'].forEach(e => el.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, clientX: x, clientY: y }))); }
    }

    function updateActionBoxStates() {
        const allBoxes = ['box-mode-toggle', 'box-free-mode', 'box-scroll-up', 'box-scroll-down', 'box-rewind', 'box-forward', 'box-play-pause', 'box-like', 'box-speed', 'box-refresh', 'box-stop'];
        let activeBoxes = !isActive ? [] : (currentMode === "HEAD" ? ['box-mode-toggle', 'box-scroll-up', 'box-scroll-down', 'box-rewind', 'box-forward', 'box-like', 'box-play-pause'] : (isFreeMode ? ['box-free-mode'] : allBoxes));
        allBoxes.forEach(id => {
            const el = document.getElementById(id);
            if (el) { activeBoxes.includes(id) ? el.classList.remove('disabled') : (el.classList.add('disabled'), el.classList.remove('scaling', 'glowing', 'error-glow')); }
        });
    }

    const GESTURE_BOX_MAP = {
        "V_SIGN": "box-mode-toggle", "PALM_UP": "box-scroll-up", "PALM_DOWN": "box-scroll-down", "POINT_LEFT": "box-rewind", "POINT_RIGHT": "box-forward",
        "MIDDLE": "box-play-pause", "FREE_MODE_TOGGLE": "box-free-mode", "PINKY_ONLY": "box-stop", "HEAD_UP": "box-scroll-up", "HEAD_DOWN": "box-scroll-down",
        "HEAD_YAW_LEFT": "box-rewind", "HEAD_YAW_RIGHT": "box-forward", "RINGS_UP": "box-like", "HORNS": "box-speed", "THREE_UP": "box-refresh", "MOUTH_OPEN": "box-play-pause"
    };

    function resetUIState() { document.querySelectorAll('.hybrid-action-box').forEach(el => el.classList.remove('scaling', 'glowing', 'error-glow')); }
    function triggerInstantUI(boxId, isSuccess) {
        const box = document.getElementById(boxId);
        if (!box || box.classList.contains('disabled')) return;
        box.classList.remove('scaling', 'glowing', 'error-glow'); void box.offsetWidth;
        box.classList.add(isSuccess ? 'glowing' : 'error-glow');
        if (uiClearTimeouts[boxId]) clearTimeout(uiClearTimeouts[boxId]);
        uiClearTimeouts[boxId] = setTimeout(() => box.classList.remove('glowing', 'error-glow'), 600);
    }

    function switchMode(newMode) {
        currentMode = newMode;
        const badge = document.getElementById('mode-badge');
        const fingerStatus = document.getElementById('finger-status');
        const headStatus = document.getElementById('head-status');
        if (canvasCtx && canvasElement) canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        if (newMode === "HEAD") {
            badge.innerText = "🗣️ 头控模式 (双摇切回)"; badge.className = "head-mode";
            fingerStatus.style.display = "none"; headStatus.style.display = "flex";
            isFreeMode = false; cursorEl.style.display = 'none';
        } else {
            badge.innerText = "👐 手势模式 (V字切回)"; badge.className = "";
            fingerStatus.style.display = "flex"; headStatus.style.display = "none";
            updatePitchIndicator(0); updateYawIndicator(0);
            const mouthInd = document.getElementById('mouth-indicator'); if (mouthInd) mouthInd.style.width = '0%';
        }
        resetUIState(); activeGesture = null; updateActionBoxStates();
    }

    function handleContinuous(gesture, boxId, isRepeatable, onConfirm, customDelay = 900) {
        const now = Date.now();
        const box = boxId ? document.getElementById(boxId) : null;
        if (activeGesture !== gesture) {
            resetUIState(); activeGesture = gesture; gestureStartTime = now;
            if (box && !box.classList.contains('disabled')) box.classList.add('scaling');
        } else if (now - gestureStartTime > customDelay) {
            if (box && !box.classList.contains('disabled') && !isRepeatable) { box.classList.remove('scaling'); box.classList.add('glowing'); }
            onConfirm();
            if (!isRepeatable) { activeGesture = "COOLDOWN"; setTimeout(() => { if (activeGesture === "COOLDOWN") activeGesture = null; if (box) box.classList.remove('glowing'); }, 1500); }
        }
    }

    function getDistance(p1, p2) { return Math.hypot(p1.x - p2.x, p1.y - p2.y); }
    function isFingerExtended(landmarks, tipIdx, mcpIdx) { return getDistance(landmarks[tipIdx], landmarks[0]) > getDistance(landmarks[mcpIdx], landmarks[0]) * 1.25; }

    function updateFingerStatus(landmarks) {
        if (!landmarks) { ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach(f => { const el = document.getElementById('finger-' + f); if (el) el.style.width = '0%'; }); return; }
        const tips = [{ t: 4, m: 2, id: 'thumb' }, { t: 8, m: 5, id: 'index' }, { t: 12, m: 9, id: 'middle' }, { t: 16, m: 13, id: 'ring' }, { t: 20, m: 17, id: 'pinky' }];
        for (const f of tips) {
            const dTip = getDistance(landmarks[f.t], landmarks[0]), dMcp = getDistance(landmarks[f.m], landmarks[0]);
            const el = document.getElementById('finger-' + f.id);
            if (el) { let pct = dMcp > 0 ? Math.min(1, dTip / (dMcp * 1.6)) : 0; el.style.width = (pct * 100) + '%'; el.style.background = pct > 0.66 ? '#00f2ff' : (pct > 0.33 ? '#f59e0b' : '#374151'); }
        }
    }

    function recognizeGesture(landmarks) {
        if (currentMode === "HEAD") return "NONE";
        const thumbEx = isFingerExtended(landmarks, 4, 2), indexEx = isFingerExtended(landmarks, 8, 5), middleEx = isFingerExtended(landmarks, 12, 9), ringEx = isFingerExtended(landmarks, 16, 13), pinkyEx = isFingerExtended(landmarks, 20, 17);
        if (indexEx && middleEx && !ringEx && !pinkyEx) return "V_SIGN";
        if (!indexEx && !middleEx && !ringEx && pinkyEx) return "PINKY_ONLY";
        if (!indexEx && middleEx && ringEx && !pinkyEx) return "FREE_MODE_TOGGLE";
        if (!indexEx && !middleEx && ringEx && !pinkyEx) { if (landmarks[4].y < landmarks[3].y && landmarks[4].y < landmarks[2].y) return "RINGS_UP"; }
        if (indexEx && !middleEx && !ringEx && pinkyEx) return "HORNS";
        if (thumbEx && !indexEx && !middleEx && !ringEx && !pinkyEx) return "THUMBS_UP";
        if (indexEx && middleEx && ringEx && pinkyEx) { const dy = landmarks[9].y - landmarks[0].y; if (dy < -0.15) return "PALM_UP"; if (dy > 0.15) return "PALM_DOWN"; }
        if (!indexEx && middleEx && !ringEx && !pinkyEx) return "MIDDLE";
        if (indexEx && !middleEx && !ringEx && !pinkyEx) { const dx = landmarks[8].x - landmarks[5].x; if (dx > 0.08) return "POINT_LEFT"; if (dx < -0.08) return "POINT_RIGHT"; }
        return "NONE";
    }

    function handleFreeModeCursor(landmarks) {
        let rawX = (1 - landmarks[8].x) * window.innerWidth; let rawY = landmarks[8].y * window.innerHeight;
        smoothedCursorX += (rawX - smoothedCursorX) * 0.15; smoothedCursorY += (rawY - smoothedCursorY) * 0.15;
        cursorEl.style.left = smoothedCursorX + 'px'; cursorEl.style.top = smoothedCursorY + 'px';
        const dist = Math.hypot(smoothedCursorX - lastDwellX, smoothedCursorY - lastDwellY), now = Date.now();
        if (dist < 45) {
            let dwellTime = now - dwellStartTime, progress = Math.min(1, dwellTime / 1200);
            cursorEl.style.transform = `translate(-50%, -50%) scale(${1 - progress * 0.5})`; cursorEl.style.backgroundColor = `rgba(239, 68, 68, ${0.8 + progress * 0.2})`;
            if (dwellTime > 1200) { cursorEl.style.transform = `translate(-50%, -50%) scale(2)`; cursorEl.style.backgroundColor = `rgba(0, 242, 255, 0.9)`; simulateClick(smoothedCursorX, smoothedCursorY); lastDwellX = smoothedCursorX; lastDwellY = smoothedCursorY; dwellStartTime = now + 1000; }
        } else { lastDwellX = smoothedCursorX; lastDwellY = smoothedCursorY; dwellStartTime = now; cursorEl.style.transform = `translate(-50%, -50%) scale(1)`; cursorEl.style.backgroundColor = `rgba(239, 68, 68, 0.8)`; }
    }

    function updatePitchIndicator(ratio) { const ind = document.getElementById('pitch-indicator'); if (!ind) return; let pct = Math.max(0, Math.min(100, ((ratio - RATIO_P_MIN) / RATIO_P_RANGE) * 100)); ind.style.top = pct + '%'; ind.style.background = (ratio < EDGE_UP || ratio > EDGE_DOWN) ? '#00f2ff' : '#10b981'; }
    function updateYawIndicator(ratio) { const ind = document.getElementById('yaw-indicator'); if (!ind) return; let pct = Math.max(0, Math.min(100, ((ratio - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100)); ind.style.left = pct + '%'; ind.style.background = (ratio > EDGE_YAW_LEFT || ratio < EDGE_YAW_RIGHT) ? '#00f2ff' : '#10b981'; }

    function analyzeHeadPosture(landmarks) {
        const nose = landmarks[FACE_MAP.nose], forehead = landmarks[FACE_MAP.forehead], chin = landmarks[FACE_MAP.chin], leftEye = landmarks[FACE_MAP.leftEyeOuter], rightEye = landmarks[FACE_MAP.rightEyeOuter];
        const faceHeight = Math.max(Math.abs(chin.y - forehead.y), 1e-5), eyeCenterY = (leftEye.y + rightEye.y) / 2;
        const pitchRatio = (nose.y - eyeCenterY - faceHeight * 0.16) / faceHeight; updatePitchIndicator(pitchRatio);
        const faceWidth = Math.max(Math.abs(rightEye.x - leftEye.x), 1e-5), eyeCenterX = (leftEye.x + rightEye.x) / 2;
        const yawRatio = (nose.x - eyeCenterX) / faceWidth; updateYawIndicator(yawRatio);
        const mouthRatio = getDistance(landmarks[FACE_MAP.upperLipInner], landmarks[FACE_MAP.lowerLipInner]) / faceHeight;
        const mouthInd = document.getElementById('mouth-indicator');
        if (mouthInd) { mouthInd.style.width = Math.max(0, Math.min(100, (mouthRatio / RATIO_M_MAX) * 100)) + '%'; mouthInd.style.background = (mouthRatio > EDGE_MOUTH_OPEN) ? '#00f2ff' : '#10b981'; }
        if (mouthRatio > EDGE_MOUTH_OPEN) return "MOUTH_OPEN";

        let currentPitchState = pitchRatio < EDGE_UP ? "HEAD_UP" : (pitchRatio > EDGE_DOWN ? "HEAD_DOWN" : "CENTERED");
        if (lastPitchState !== "HEAD_DOWN" && currentPitchState === "HEAD_DOWN") {
            const now = Date.now(); nodTimes.push(now); nodTimes = nodTimes.filter(t => now - t < 1000);
            if (nodTimes.length >= 2) { nodTimes = []; lastPitchState = currentPitchState; return "DOUBLE_NOD"; }
        }
        lastPitchState = currentPitchState;

        let currentYawState = yawRatio > EDGE_YAW_LEFT ? "HEAD_YAW_LEFT" : (yawRatio < EDGE_YAW_RIGHT ? "HEAD_YAW_RIGHT" : "CENTERED");
        if (lastYawState !== currentYawState && currentYawState !== "CENTERED") {
            const now = Date.now(); shakeTimes.push(now); shakeTimes = shakeTimes.filter(t => now - t < 1200);
            if (shakeTimes.length >= 3) { shakeTimes = []; lastYawState = currentYawState; return "DOUBLE_SHAKE"; }
        }
        lastYawState = currentYawState;
        return currentYawState !== "CENTERED" ? currentYawState : currentPitchState;
    }

    function executeAction(gesture) {
        const now = Date.now();
        if (gesture === "DOUBLE_SHAKE" && currentMode === "HEAD") { switchMode("HAND"); triggerInstantUI("box-mode-toggle", true); return; }
        if (gesture === "DOUBLE_NOD") { if (now > cooldowns.LIKE) { triggerPageLike(); triggerInstantUI("box-like", true); cooldowns.LIKE = now + 2000; } return; }
        if (gesture === "V_SIGN") { handleContinuous(gesture, GESTURE_BOX_MAP[gesture], false, () => { if (currentMode === "HAND") switchMode("HEAD"); }); return; }
        if (activeGesture && activeGesture !== gesture && ["PALM_UP", "PALM_DOWN", "HEAD_UP", "HEAD_DOWN", "V_SIGN", "FREE_MODE_TOGGLE", "THUMBS_UP", "DOUBLE_SHAKE", "MOUTH_OPEN"].includes(activeGesture)) { resetUIState(); activeGesture = null; }

        if (currentMode === "HAND") {
            if (isFreeMode) { if (gesture === "FREE_MODE_TOGGLE") { handleContinuous(gesture, "box-free-mode", false, () => { isFreeMode = false; cursorEl.style.display = 'none'; updateActionBoxStates(); triggerInstantUI("box-free-mode", true); }); } else if (activeGesture === "FREE_MODE_TOGGLE") { activeGesture = null; resetUIState(); } return; }
            if (gesture === "PALM_UP") return handleContinuous(gesture, "box-scroll-up", true, () => window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'instant' }));
            if (gesture === "PALM_DOWN") return handleContinuous(gesture, "box-scroll-down", true, () => window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'instant' }));
            if (gesture === "PINKY_ONLY") return handleContinuous(gesture, "box-stop", false, stopSystem);
            if (gesture === "FREE_MODE_TOGGLE") return handleContinuous(gesture, "box-free-mode", false, () => { isFreeMode = true; cursorEl.style.display = 'block'; updateActionBoxStates(); triggerInstantUI("box-free-mode", true); dwellStartTime = now; });
            if (gesture === "THREE_UP") return handleContinuous(gesture, "box-refresh", false, () => { location.reload(); });

            const boxId = GESTURE_BOX_MAP[gesture];
            if (gesture === "POINT_RIGHT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "POINT_LEFT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(-5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "MIDDLE" && now > cooldowns.VIDEO_TOGGLE) { togglePlayPause(); triggerInstantUI(boxId, true); cooldowns.VIDEO_TOGGLE = now + 1000; }
            if (gesture === "RINGS_UP" && now > cooldowns.LIKE) { triggerPageLike(); triggerInstantUI(boxId, true); cooldowns.LIKE = now + 2000; }
            if (gesture === "HORNS" && now > cooldowns.SPEED) { toggleSpeed(); triggerInstantUI(boxId, true); cooldowns.SPEED = now + 1500; }
        } else if (currentMode === "HEAD") {
            if (gesture === "MOUTH_OPEN") return handleContinuous(gesture, "box-play-pause", false, () => { togglePlayPause(); triggerInstantUI("box-play-pause", true); }, 2000);
            if (gesture === "HEAD_UP") return handleContinuous(gesture, "box-scroll-up", true, () => window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'instant' }), 150);
            if (gesture === "HEAD_DOWN") return handleContinuous(gesture, "box-scroll-down", true, () => window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'instant' }), 150);

            const boxId = GESTURE_BOX_MAP[gesture];
            if (gesture === "HEAD_YAW_LEFT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(-5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "HEAD_YAW_RIGHT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
        }
    }

    async function startSystem() {
        try {
            toggleBtn.innerText = "模块注入中...";
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
                    canvasCtx.save(); canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
                    let handGesture = "NONE";
                    if (res.multiHandLandmarks?.length > 0) {
                        const lm = res.multiHandLandmarks[0];
                        window.drawConnectors(canvasCtx, lm, window.HAND_CONNECTIONS, { color: 'rgba(255,255,255,0.2)', lineWidth: 2 });
                        window.drawLandmarks(canvasCtx, lm, { color: '#00f2ff', lineWidth: 1, radius: 2.5 });
                        handGesture = recognizeGesture(lm);
                        if (currentMode === "HAND") { updateFingerStatus(lm); if (isFreeMode) handleFreeModeCursor(lm); }
                    } else { if (currentMode === "HAND") updateFingerStatus(null); }
                    canvasCtx.restore();
                    if (handGesture !== "NONE") executeAction(handGesture);
                });
            }
            if (!faceMesh) {
                faceMesh = new window.FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
                faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
                faceMesh.onResults((res) => {
                    if (!isActive || currentMode !== "HEAD") return;
                    canvasCtx.save(); canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
                    let headGesture = "CENTERED";
                    if (res.multiFaceLandmarks?.length > 0) {
                        const lm = res.multiFaceLandmarks[0];
                        window.drawConnectors(canvasCtx, lm, window.FACEMESH_TESSELATION, { color: 'rgba(255,255,255,0.1)', lineWidth: 1 });
                        headGesture = analyzeHeadPosture(lm);
                    } else {
                        updatePitchIndicator(0); updateYawIndicator(0);
                        const mouthInd = document.getElementById('mouth-indicator'); if (mouthInd) mouthInd.style.width = '0%';
                        lastPitchState = "CENTERED"; lastYawState = "CENTERED";
                    }
                    canvasCtx.restore();
                    if (headGesture !== "CENTERED") executeAction(headGesture);
                });
            }
            camera = new window.Camera(videoElement, { onFrame: async () => { if (isActive) { if (currentMode === "HAND") await hands.send({ image: videoElement }); else if (currentMode === "HEAD") await faceMesh.send({ image: videoElement }); } }, width: 320, height: 240 });
            toggleBtn.innerText = "请求硬件权限...";
            await camera.start();
            isActive = true; document.getElementById('hybrid-debug-window').style.display = 'block';
            toggleBtn.innerText = "关闭混合控制"; toggleBtn.classList.add('active');
            switchMode("HAND");
        } catch (error) { console.error(error); toggleBtn.innerText = "加载失败 (F12看控制台)"; isActive = false; }
    }

    function stopSystem() {
        isActive = false; document.getElementById('hybrid-debug-window').style.display = 'none';
        toggleBtn.innerText = "开启混合控制"; toggleBtn.classList.remove('active');
        if (camera) camera.stop();
        resetUIState(); isFreeMode = false; cursorEl.style.display = 'none'; activeGesture = null; updateActionBoxStates();
    }


    // ============================================================================
    // ======================== 🌟 核心修复：语音控制引擎迁入内部 🌟 =================
    // ============================================================================

    // 1. 刷新语音UI面板
    function updateVoiceUI(status, message, transcript = "") {
        const dot = document.getElementById('voice-dot');
        const statusText = document.getElementById('voice-status-text');
        const msgEl = document.getElementById('voice-message');
        if (!dot || !statusText || !msgEl) return;

        if (status === "SLEEP") {
            dot.className = "voice-dot sleeping";
            statusText.innerText = "语音待机中";
            statusText.style.color = "#9ca3af";
        } else if (status === "AWAKE") {
            dot.className = "voice-dot awake";
            statusText.innerText = "正在聆听";
            statusText.style.color = "#10b981";
        }

        let finalHtml = message;
        if (transcript) finalHtml = `<div class="voice-transcript">“${transcript}”</div>` + message;
        msgEl.innerHTML = finalHtml;
    }

    // 2. 唤醒与休眠控制
    function wakeUpAssistant() {
        isVoiceAwake = true; // 👉 修复：现在这里可以访问到 initHybridControl 中的 isVoiceAwake 变量了！
        updateVoiceUI("AWAKE", "小助手已就绪，请下达指令。");
        resetVoiceTimeout();
    }

    function sleepAssistant(reason) {
        isVoiceAwake = false;
        if (voiceTimeoutTimer) clearTimeout(voiceTimeoutTimer);
        updateVoiceUI("SLEEP", reason === "timeout" ? "超过1分钟未使用已休眠，呼叫“小助手”唤醒" : "请呼叫“小助手”激活语音控制");
    }

    function resetVoiceTimeout() {
        if (voiceTimeoutTimer) clearTimeout(voiceTimeoutTimer);
        voiceTimeoutTimer = setTimeout(() => { sleepAssistant("timeout"); }, 60000);
    }

    // 3. 处理语音指令（参考 voice_content.js 的强逻辑去噪）
    async function handleVoiceCommand(rawText) {
        // [吸收 voice_content.js 优点]：过滤干扰前缀和后缀
        let cleanText = rawText
            .replace(/^(请|帮我|麻烦你?|小助手|助手|我想要?|我要|给我|能不能|帮)/, '')
            .replace(/(谢谢|吧|呢|啊|嘛|哦|喔)$/, '')
            .trim();

        if (!cleanText) return;
        updateVoiceUI("AWAKE", "处理中...", cleanText);

        if (cleanText.includes("停止当前识别") || cleanText.includes("停止识别") || cleanText.includes("关闭识别")) {
            let currentState = isActive ? (currentMode === "HEAD" ? "头部" : "手部") : "未开启任何";
            if (isActive) { stopSystem(); updateVoiceUI("AWAKE", `已关闭${currentState}识别状态`, cleanText); } 
            else { updateVoiceUI("AWAKE", "当前并未开启任何识别", cleanText); }
            return;
        }

        if (cleanText.includes("开启头") || cleanText.includes("切换到头")) {
            if (!isActive) { await startSystem(); switchMode("HEAD"); updateVoiceUI("AWAKE", "已开启头部识别状态", cleanText); } 
            else if (currentMode === "HEAD") { updateVoiceUI("AWAKE", "已处于对应状态 (头部控制)", cleanText); } 
            else { switchMode("HEAD"); updateVoiceUI("AWAKE", "已转至头部识别状态", cleanText); }
            return;
        }

        if (cleanText.includes("开启手") || cleanText.includes("切换到手")) {
            if (!isActive) { await startSystem(); switchMode("HAND"); updateVoiceUI("AWAKE", "已开启手部识别状态", cleanText); } 
            else if (currentMode === "HAND") { updateVoiceUI("AWAKE", "已处于对应状态 (手部控制)", cleanText); } 
            else { switchMode("HAND"); updateVoiceUI("AWAKE", "已转至手部识别状态", cleanText); }
            return;
        }

        callLLMIntentEngine(cleanText);
    }

    // 4. LLM 大模型 API 兜底调用
    async function callLLMIntentEngine(text) {
        updateVoiceUI("AWAKE", "正在思考指令意图...", text);
        try {
            const response = await fetch(LLM_API_CONFIG.url, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LLM_API_CONFIG.key}` },
                body: JSON.stringify({
                    model: LLM_API_CONFIG.model,
                    messages: [
                        { "role": "system", "content": "你是一个网页控制助手。根据指令返回严格的JSON: {\"action\": \"scroll_down\"}。支持: scroll_up, scroll_down, like, go_back, go_forward。听不懂返回 {\"action\": \"unknown\"}。" },
                        { "role": "user", "content": text }
                    ],
                    response_format: { "type": "json_object" }
                })
            });

            const data = await response.json();
            const result = JSON.parse(data.choices[0].message.content);

            if (result.action && result.action !== "unknown") {
                updateVoiceUI("AWAKE", `执行: ${result.action}`, text);
                if (result.action === "scroll_down") window.scrollBy({ top: window.innerHeight * 0.5, behavior: 'smooth' });
                if (result.action === "scroll_up") window.scrollBy({ top: -window.innerHeight * 0.5, behavior: 'smooth' });
            } else {
                updateVoiceUI("AWAKE", "未能理解该指令，请换个说法。", text);
            }
        } catch (e) { console.error("LLM API 失败:", e); updateVoiceUI("AWAKE", "API 请求失败", text); }
    }

    // 5. 语音识别引擎初始化
    function initVoiceControl() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return console.error("浏览器不支持 Web Speech API");

        voiceRecognition = new SpeechRecognition();
        voiceRecognition.continuous = true;
        voiceRecognition.interimResults = false;
        voiceRecognition.lang = 'zh-CN';

        voiceRecognition.onresult = (event) => {
            const lastResult = event.results[event.results.length - 1];
            if (lastResult.isFinal) {
                // [吸收 voice_content.js 优点]：无死角符号清理
                let text = lastResult[0].transcript.trim().replace(/[。，？！,.?! ]/g, '');
                if (!text) return;
                console.log("🎤 识别结果:", text);

                if (!isVoiceAwake) {
                    if (text.includes("小助手") || text.includes("助手")) {
                        wakeUpAssistant();
                        // 连读切分逻辑
                        const commandText = text.replace(/.*(小助手|助手)/, '').trim();
                        if (commandText) handleVoiceCommand(commandText);
                    }
                } else {
                    resetVoiceTimeout();
                    handleVoiceCommand(text);
                }
            }
        };

        voiceRecognition.onend = () => { setTimeout(() => { try { voiceRecognition.start(); } catch (e) {} }, 500); };
        try { voiceRecognition.start(); console.log("🎙️ 语音引擎已启动"); } catch (e) { }
    }


    // ================== 事件监听绑定区域 ==================
    toggleBtn.addEventListener('click', () => { isActive ? stopSystem() : startSystem(); });
    setTimeout(() => { if (!isActive) startSystem(); }, 800);
    setTimeout(() => { initVoiceControl(); }, 2000); // 确保在核心机制注入后初始化语音

} // 👈 完美收口！至此，所有的内部函数都在 initHybridControl 大圈内了

// 启动判定
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initHybridControl); }
else { initHybridControl(); } function loadScript(src) {
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
    const oldRoot = document.getElementById('hybrid-plugin-root');
    if (oldRoot) oldRoot.remove(); // 热重载清理

    const root = document.createElement('div');
    root.id = 'hybrid-plugin-root';
    root.innerHTML = `
        <div id="voice-panel">
            <div class="voice-header">
                <div id="voice-dot" class="voice-dot sleeping"></div>
                <span id="voice-status-text" style="color: #9ca3af;">语音待机中</span>
            </div>
            <div id="voice-message" class="voice-message">请呼叫“小助手”激活语音控制</div>
        </div>

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
                <div class="head-status-row">
                    <div class="head-label">张嘴 (视频启停)</div>
                    <div class="mouth-bar">
                        <div id="mouth-bound-open" class="mouth-bound"></div>
                        <div id="mouth-indicator"></div>
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
                <div class="hybrid-action-box" id="box-like"><span class="hybrid-icon">💍</span><span>点赞</span></div>
                <div class="hybrid-action-box" id="box-speed"><span class="hybrid-icon">🤘</span><span>倍速</span></div>
                <div class="hybrid-action-box" id="box-refresh"><span class="hybrid-icon">🔄</span><span>刷新</span></div>
                <div class="hybrid-action-box" id="box-stop"><span class="hybrid-icon">🤙</span><span>关闭</span></div>
            </div>
        </div>
    `;
    document.body.appendChild(root);
}

// ⚠️ 注意这里：将原本放在外面的 VoiceControl 核心变量全部收回闭包内
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

    // === 语音控制相关全局变量与 API 配置 ===
    let voiceRecognition = null;
    let isVoiceAwake = false;
    let voiceTimeoutTimer = null;

    const LLM_API_CONFIG = {
        url: "https://api.deepseek.com/v1/chat/completions",
        key: "sk-f539f9161309446d953c3357c6f92750",
        model: "deepseek-v4-flash"
    };

    let currentMode = "HAND";
    const SCROLL_SPEED = 45;
    let activeGesture = null;
    let gestureStartTime = 0;
    let uiClearTimeouts = {};
    const cooldowns = { LIKE: 0, REFRESH: 0, VIDEO_SEEK: 0, VIDEO_TOGGLE: 0, SPEED: 0 };

    let isFreeMode = false;
    let cursorX = window.innerWidth / 2, cursorY = window.innerHeight / 2;
    let smoothedCursorX = cursorX, smoothedCursorY = cursorY;
    let lastDwellX = 0, lastDwellY = 0;
    let dwellStartTime = 0;

    const EDGE_UP = -0.08, EDGE_DOWN = 0.12;
    const EDGE_YAW_LEFT = 0.12, EDGE_YAW_RIGHT = -0.12;
    const RATIO_P_MIN = -0.20, RATIO_P_MAX = 0.24, RATIO_P_RANGE = 0.44;
    const RATIO_Y_MIN = -0.25, RATIO_Y_MAX = 0.25, RATIO_Y_RANGE = 0.50;
    const EDGE_MOUTH_OPEN = 0.11;
    const RATIO_M_MAX = 0.22;

    let lastPitchState = "CENTERED";
    let nodTimes = [];
    let lastYawState = "CENTERED";
    let shakeTimes = [];

    document.getElementById('pitch-bound-up').style.top = `${((EDGE_UP - RATIO_P_MIN) / RATIO_P_RANGE) * 100}%`;
    document.getElementById('pitch-bound-down').style.top = `${((EDGE_DOWN - RATIO_P_MIN) / RATIO_P_RANGE) * 100}%`;
    document.getElementById('yaw-bound-right').style.left = `${((EDGE_YAW_RIGHT - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100}%`;
    document.getElementById('yaw-bound-left').style.left = `${((EDGE_YAW_LEFT - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100}%`;
    document.getElementById('mouth-bound-open').style.left = `${(EDGE_MOUTH_OPEN / RATIO_M_MAX) * 100}%`;

    const FACE_MAP = {
        nose: 1, forehead: 10, chin: 152,
        leftEyeOuter: 33, rightEyeOuter: 263,
        upperLipInner: 13, lowerLipInner: 14
    };

    // --- DOM 控制函数 ---
    function triggerPageLike() {
        const selectors = ['[aria-label*="赞"]', '[aria-label*="like"]', '.like-btn', 'svg[class*="like"]', '[class*="zan"]'];
        for (const sel of selectors) { const el = document.querySelector(sel); if (el && typeof el.click === 'function') { el.click(); return true; } }
        for (const el of document.querySelectorAll('button, [role="button"], span, div')) { if (/^赞$|^点赞$|^like$/i.test(el.textContent?.trim()) && el.offsetParent !== null) { el.click(); return true; } }
        return false;
    }
    function getActiveVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (!videos.length) return null;
        let active = videos.find(v => !v.paused && v.offsetWidth > 0);
        if (!active) active = videos.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
        return active;
    }
    function adjustVideoTime(s) { const v = getActiveVideo(); if (v) { v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + s)); return true; } return false; }
    function togglePlayPause() { const v = getActiveVideo(); if (v) { v.paused ? v.play() : v.pause(); return true; } return false; }
    function toggleSpeed() { const v = getActiveVideo(); if (v) { v.playbackRate = v.playbackRate === 1.0 ? 2.0 : 1.0; return true; } return false; }
    function simulateClick(x, y) {
        cursorEl.style.display = 'none';
        const el = document.elementFromPoint(x, y);
        cursorEl.style.display = 'block';
        if (el) { el.focus?.();['mousedown', 'mouseup', 'click'].forEach(e => el.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, clientX: x, clientY: y }))); }
    }

    function updateActionBoxStates() {
        const allBoxes = ['box-mode-toggle', 'box-free-mode', 'box-scroll-up', 'box-scroll-down', 'box-rewind', 'box-forward', 'box-play-pause', 'box-like', 'box-speed', 'box-refresh', 'box-stop'];
        let activeBoxes = !isActive ? [] : (currentMode === "HEAD" ? ['box-mode-toggle', 'box-scroll-up', 'box-scroll-down', 'box-rewind', 'box-forward', 'box-like', 'box-play-pause'] : (isFreeMode ? ['box-free-mode'] : allBoxes));
        allBoxes.forEach(id => {
            const el = document.getElementById(id);
            if (el) { activeBoxes.includes(id) ? el.classList.remove('disabled') : (el.classList.add('disabled'), el.classList.remove('scaling', 'glowing', 'error-glow')); }
        });
    }

    const GESTURE_BOX_MAP = {
        "V_SIGN": "box-mode-toggle", "PALM_UP": "box-scroll-up", "PALM_DOWN": "box-scroll-down", "POINT_LEFT": "box-rewind", "POINT_RIGHT": "box-forward",
        "MIDDLE": "box-play-pause", "FREE_MODE_TOGGLE": "box-free-mode", "PINKY_ONLY": "box-stop", "HEAD_UP": "box-scroll-up", "HEAD_DOWN": "box-scroll-down",
        "HEAD_YAW_LEFT": "box-rewind", "HEAD_YAW_RIGHT": "box-forward", "RINGS_UP": "box-like", "HORNS": "box-speed", "THREE_UP": "box-refresh", "MOUTH_OPEN": "box-play-pause"
    };

    function resetUIState() { document.querySelectorAll('.hybrid-action-box').forEach(el => el.classList.remove('scaling', 'glowing', 'error-glow')); }
    function triggerInstantUI(boxId, isSuccess) {
        const box = document.getElementById(boxId);
        if (!box || box.classList.contains('disabled')) return;
        box.classList.remove('scaling', 'glowing', 'error-glow'); void box.offsetWidth;
        box.classList.add(isSuccess ? 'glowing' : 'error-glow');
        if (uiClearTimeouts[boxId]) clearTimeout(uiClearTimeouts[boxId]);
        uiClearTimeouts[boxId] = setTimeout(() => box.classList.remove('glowing', 'error-glow'), 600);
    }

    function switchMode(newMode) {
        currentMode = newMode;
        const badge = document.getElementById('mode-badge');
        const fingerStatus = document.getElementById('finger-status');
        const headStatus = document.getElementById('head-status');
        if (canvasCtx && canvasElement) canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        if (newMode === "HEAD") {
            badge.innerText = "🗣️ 头控模式 (双摇切回)"; badge.className = "head-mode";
            fingerStatus.style.display = "none"; headStatus.style.display = "flex";
            isFreeMode = false; cursorEl.style.display = 'none';
        } else {
            badge.innerText = "👐 手势模式 (V字切回)"; badge.className = "";
            fingerStatus.style.display = "flex"; headStatus.style.display = "none";
            updatePitchIndicator(0); updateYawIndicator(0);
            const mouthInd = document.getElementById('mouth-indicator'); if (mouthInd) mouthInd.style.width = '0%';
        }
        resetUIState(); activeGesture = null; updateActionBoxStates();
    }

    function handleContinuous(gesture, boxId, isRepeatable, onConfirm, customDelay = 900) {
        const now = Date.now();
        const box = boxId ? document.getElementById(boxId) : null;
        if (activeGesture !== gesture) {
            resetUIState(); activeGesture = gesture; gestureStartTime = now;
            if (box && !box.classList.contains('disabled')) box.classList.add('scaling');
        } else if (now - gestureStartTime > customDelay) {
            if (box && !box.classList.contains('disabled') && !isRepeatable) { box.classList.remove('scaling'); box.classList.add('glowing'); }
            onConfirm();
            if (!isRepeatable) { activeGesture = "COOLDOWN"; setTimeout(() => { if (activeGesture === "COOLDOWN") activeGesture = null; if (box) box.classList.remove('glowing'); }, 1500); }
        }
    }

    function getDistance(p1, p2) { return Math.hypot(p1.x - p2.x, p1.y - p2.y); }
    function isFingerExtended(landmarks, tipIdx, mcpIdx) { return getDistance(landmarks[tipIdx], landmarks[0]) > getDistance(landmarks[mcpIdx], landmarks[0]) * 1.25; }

    function updateFingerStatus(landmarks) {
        if (!landmarks) { ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach(f => { const el = document.getElementById('finger-' + f); if (el) el.style.width = '0%'; }); return; }
        const tips = [{ t: 4, m: 2, id: 'thumb' }, { t: 8, m: 5, id: 'index' }, { t: 12, m: 9, id: 'middle' }, { t: 16, m: 13, id: 'ring' }, { t: 20, m: 17, id: 'pinky' }];
        for (const f of tips) {
            const dTip = getDistance(landmarks[f.t], landmarks[0]), dMcp = getDistance(landmarks[f.m], landmarks[0]);
            const el = document.getElementById('finger-' + f.id);
            if (el) { let pct = dMcp > 0 ? Math.min(1, dTip / (dMcp * 1.6)) : 0; el.style.width = (pct * 100) + '%'; el.style.background = pct > 0.66 ? '#00f2ff' : (pct > 0.33 ? '#f59e0b' : '#374151'); }
        }
    }

    function recognizeGesture(landmarks) {
        if (currentMode === "HEAD") return "NONE";
        const thumbEx = isFingerExtended(landmarks, 4, 2), indexEx = isFingerExtended(landmarks, 8, 5), middleEx = isFingerExtended(landmarks, 12, 9), ringEx = isFingerExtended(landmarks, 16, 13), pinkyEx = isFingerExtended(landmarks, 20, 17);
        if (indexEx && middleEx && !ringEx && !pinkyEx) return "V_SIGN";
        if (!indexEx && !middleEx && !ringEx && pinkyEx) return "PINKY_ONLY";
        if (!indexEx && middleEx && ringEx && !pinkyEx) return "FREE_MODE_TOGGLE";
        if (!indexEx && !middleEx && ringEx && !pinkyEx) { if (landmarks[4].y < landmarks[3].y && landmarks[4].y < landmarks[2].y) return "RINGS_UP"; }
        if (indexEx && !middleEx && !ringEx && pinkyEx) return "HORNS";
        if (thumbEx && !indexEx && !middleEx && !ringEx && !pinkyEx) return "THUMBS_UP";
        if (indexEx && middleEx && ringEx && pinkyEx) { const dy = landmarks[9].y - landmarks[0].y; if (dy < -0.15) return "PALM_UP"; if (dy > 0.15) return "PALM_DOWN"; }
        if (!indexEx && middleEx && !ringEx && !pinkyEx) return "MIDDLE";
        if (indexEx && !middleEx && !ringEx && !pinkyEx) { const dx = landmarks[8].x - landmarks[5].x; if (dx > 0.08) return "POINT_LEFT"; if (dx < -0.08) return "POINT_RIGHT"; }
        return "NONE";
    }

    function handleFreeModeCursor(landmarks) {
        let rawX = (1 - landmarks[8].x) * window.innerWidth; let rawY = landmarks[8].y * window.innerHeight;
        smoothedCursorX += (rawX - smoothedCursorX) * 0.15; smoothedCursorY += (rawY - smoothedCursorY) * 0.15;
        cursorEl.style.left = smoothedCursorX + 'px'; cursorEl.style.top = smoothedCursorY + 'px';
        const dist = Math.hypot(smoothedCursorX - lastDwellX, smoothedCursorY - lastDwellY), now = Date.now();
        if (dist < 45) {
            let dwellTime = now - dwellStartTime, progress = Math.min(1, dwellTime / 1200);
            cursorEl.style.transform = `translate(-50%, -50%) scale(${1 - progress * 0.5})`; cursorEl.style.backgroundColor = `rgba(239, 68, 68, ${0.8 + progress * 0.2})`;
            if (dwellTime > 1200) { cursorEl.style.transform = `translate(-50%, -50%) scale(2)`; cursorEl.style.backgroundColor = `rgba(0, 242, 255, 0.9)`; simulateClick(smoothedCursorX, smoothedCursorY); lastDwellX = smoothedCursorX; lastDwellY = smoothedCursorY; dwellStartTime = now + 1000; }
        } else { lastDwellX = smoothedCursorX; lastDwellY = smoothedCursorY; dwellStartTime = now; cursorEl.style.transform = `translate(-50%, -50%) scale(1)`; cursorEl.style.backgroundColor = `rgba(239, 68, 68, 0.8)`; }
    }

    function updatePitchIndicator(ratio) { const ind = document.getElementById('pitch-indicator'); if (!ind) return; let pct = Math.max(0, Math.min(100, ((ratio - RATIO_P_MIN) / RATIO_P_RANGE) * 100)); ind.style.top = pct + '%'; ind.style.background = (ratio < EDGE_UP || ratio > EDGE_DOWN) ? '#00f2ff' : '#10b981'; }
    function updateYawIndicator(ratio) { const ind = document.getElementById('yaw-indicator'); if (!ind) return; let pct = Math.max(0, Math.min(100, ((ratio - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100)); ind.style.left = pct + '%'; ind.style.background = (ratio > EDGE_YAW_LEFT || ratio < EDGE_YAW_RIGHT) ? '#00f2ff' : '#10b981'; }

    function analyzeHeadPosture(landmarks) {
        const nose = landmarks[FACE_MAP.nose], forehead = landmarks[FACE_MAP.forehead], chin = landmarks[FACE_MAP.chin], leftEye = landmarks[FACE_MAP.leftEyeOuter], rightEye = landmarks[FACE_MAP.rightEyeOuter];
        const faceHeight = Math.max(Math.abs(chin.y - forehead.y), 1e-5), eyeCenterY = (leftEye.y + rightEye.y) / 2;
        const pitchRatio = (nose.y - eyeCenterY - faceHeight * 0.16) / faceHeight; updatePitchIndicator(pitchRatio);
        const faceWidth = Math.max(Math.abs(rightEye.x - leftEye.x), 1e-5), eyeCenterX = (leftEye.x + rightEye.x) / 2;
        const yawRatio = (nose.x - eyeCenterX) / faceWidth; updateYawIndicator(yawRatio);
        const mouthRatio = getDistance(landmarks[FACE_MAP.upperLipInner], landmarks[FACE_MAP.lowerLipInner]) / faceHeight;
        const mouthInd = document.getElementById('mouth-indicator');
        if (mouthInd) { mouthInd.style.width = Math.max(0, Math.min(100, (mouthRatio / RATIO_M_MAX) * 100)) + '%'; mouthInd.style.background = (mouthRatio > EDGE_MOUTH_OPEN) ? '#00f2ff' : '#10b981'; }
        if (mouthRatio > EDGE_MOUTH_OPEN) return "MOUTH_OPEN";

        let currentPitchState = pitchRatio < EDGE_UP ? "HEAD_UP" : (pitchRatio > EDGE_DOWN ? "HEAD_DOWN" : "CENTERED");
        if (lastPitchState !== "HEAD_DOWN" && currentPitchState === "HEAD_DOWN") {
            const now = Date.now(); nodTimes.push(now); nodTimes = nodTimes.filter(t => now - t < 1000);
            if (nodTimes.length >= 2) { nodTimes = []; lastPitchState = currentPitchState; return "DOUBLE_NOD"; }
        }
        lastPitchState = currentPitchState;

        let currentYawState = yawRatio > EDGE_YAW_LEFT ? "HEAD_YAW_LEFT" : (yawRatio < EDGE_YAW_RIGHT ? "HEAD_YAW_RIGHT" : "CENTERED");
        if (lastYawState !== currentYawState && currentYawState !== "CENTERED") {
            const now = Date.now(); shakeTimes.push(now); shakeTimes = shakeTimes.filter(t => now - t < 1200);
            if (shakeTimes.length >= 3) { shakeTimes = []; lastYawState = currentYawState; return "DOUBLE_SHAKE"; }
        }
        lastYawState = currentYawState;
        return currentYawState !== "CENTERED" ? currentYawState : currentPitchState;
    }

    function executeAction(gesture) {
        const now = Date.now();
        if (gesture === "DOUBLE_SHAKE" && currentMode === "HEAD") { switchMode("HAND"); triggerInstantUI("box-mode-toggle", true); return; }
        if (gesture === "DOUBLE_NOD") { if (now > cooldowns.LIKE) { triggerPageLike(); triggerInstantUI("box-like", true); cooldowns.LIKE = now + 2000; } return; }
        if (gesture === "V_SIGN") { handleContinuous(gesture, GESTURE_BOX_MAP[gesture], false, () => { if (currentMode === "HAND") switchMode("HEAD"); }); return; }
        if (activeGesture && activeGesture !== gesture && ["PALM_UP", "PALM_DOWN", "HEAD_UP", "HEAD_DOWN", "V_SIGN", "FREE_MODE_TOGGLE", "THUMBS_UP", "DOUBLE_SHAKE", "MOUTH_OPEN"].includes(activeGesture)) { resetUIState(); activeGesture = null; }

        if (currentMode === "HAND") {
            if (isFreeMode) { if (gesture === "FREE_MODE_TOGGLE") { handleContinuous(gesture, "box-free-mode", false, () => { isFreeMode = false; cursorEl.style.display = 'none'; updateActionBoxStates(); triggerInstantUI("box-free-mode", true); }); } else if (activeGesture === "FREE_MODE_TOGGLE") { activeGesture = null; resetUIState(); } return; }
            if (gesture === "PALM_UP") return handleContinuous(gesture, "box-scroll-up", true, () => window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'instant' }));
            if (gesture === "PALM_DOWN") return handleContinuous(gesture, "box-scroll-down", true, () => window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'instant' }));
            if (gesture === "PINKY_ONLY") return handleContinuous(gesture, "box-stop", false, stopSystem);
            if (gesture === "FREE_MODE_TOGGLE") return handleContinuous(gesture, "box-free-mode", false, () => { isFreeMode = true; cursorEl.style.display = 'block'; updateActionBoxStates(); triggerInstantUI("box-free-mode", true); dwellStartTime = now; });
            if (gesture === "THREE_UP") return handleContinuous(gesture, "box-refresh", false, () => { location.reload(); });

            const boxId = GESTURE_BOX_MAP[gesture];
            if (gesture === "POINT_RIGHT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "POINT_LEFT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(-5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "MIDDLE" && now > cooldowns.VIDEO_TOGGLE) { togglePlayPause(); triggerInstantUI(boxId, true); cooldowns.VIDEO_TOGGLE = now + 1000; }
            if (gesture === "RINGS_UP" && now > cooldowns.LIKE) { triggerPageLike(); triggerInstantUI(boxId, true); cooldowns.LIKE = now + 2000; }
            if (gesture === "HORNS" && now > cooldowns.SPEED) { toggleSpeed(); triggerInstantUI(boxId, true); cooldowns.SPEED = now + 1500; }
        } else if (currentMode === "HEAD") {
            if (gesture === "MOUTH_OPEN") return handleContinuous(gesture, "box-play-pause", false, () => { togglePlayPause(); triggerInstantUI("box-play-pause", true); }, 2000);
            if (gesture === "HEAD_UP") return handleContinuous(gesture, "box-scroll-up", true, () => window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'instant' }), 150);
            if (gesture === "HEAD_DOWN") return handleContinuous(gesture, "box-scroll-down", true, () => window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'instant' }), 150);

            const boxId = GESTURE_BOX_MAP[gesture];
            if (gesture === "HEAD_YAW_LEFT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(-5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "HEAD_YAW_RIGHT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
        }
    }

    async function startSystem() {
        try {
            toggleBtn.innerText = "模块注入中...";
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
                    canvasCtx.save(); canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
                    let handGesture = "NONE";
                    if (res.multiHandLandmarks?.length > 0) {
                        const lm = res.multiHandLandmarks[0];
                        window.drawConnectors(canvasCtx, lm, window.HAND_CONNECTIONS, { color: 'rgba(255,255,255,0.2)', lineWidth: 2 });
                        window.drawLandmarks(canvasCtx, lm, { color: '#00f2ff', lineWidth: 1, radius: 2.5 });
                        handGesture = recognizeGesture(lm);
                        if (currentMode === "HAND") { updateFingerStatus(lm); if (isFreeMode) handleFreeModeCursor(lm); }
                    } else { if (currentMode === "HAND") updateFingerStatus(null); }
                    canvasCtx.restore();
                    if (handGesture !== "NONE") executeAction(handGesture);
                });
            }
            if (!faceMesh) {
                faceMesh = new window.FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
                faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
                faceMesh.onResults((res) => {
                    if (!isActive || currentMode !== "HEAD") return;
                    canvasCtx.save(); canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
                    let headGesture = "CENTERED";
                    if (res.multiFaceLandmarks?.length > 0) {
                        const lm = res.multiFaceLandmarks[0];
                        window.drawConnectors(canvasCtx, lm, window.FACEMESH_TESSELATION, { color: 'rgba(255,255,255,0.1)', lineWidth: 1 });
                        headGesture = analyzeHeadPosture(lm);
                    } else {
                        updatePitchIndicator(0); updateYawIndicator(0);
                        const mouthInd = document.getElementById('mouth-indicator'); if (mouthInd) mouthInd.style.width = '0%';
                        lastPitchState = "CENTERED"; lastYawState = "CENTERED";
                    }
                    canvasCtx.restore();
                    if (headGesture !== "CENTERED") executeAction(headGesture);
                });
            }
            camera = new window.Camera(videoElement, { onFrame: async () => { if (isActive) { if (currentMode === "HAND") await hands.send({ image: videoElement }); else if (currentMode === "HEAD") await faceMesh.send({ image: videoElement }); } }, width: 320, height: 240 });
            toggleBtn.innerText = "请求硬件权限...";
            await camera.start();
            isActive = true; document.getElementById('hybrid-debug-window').style.display = 'block';
            toggleBtn.innerText = "关闭混合控制"; toggleBtn.classList.add('active');
            switchMode("HAND");
        } catch (error) { console.error(error); toggleBtn.innerText = "加载失败 (F12看控制台)"; isActive = false; }
    }

    function stopSystem() {
        isActive = false; document.getElementById('hybrid-debug-window').style.display = 'none';
        toggleBtn.innerText = "开启混合控制"; toggleBtn.classList.remove('active');
        if (camera) camera.stop();
        resetUIState(); isFreeMode = false; cursorEl.style.display = 'none'; activeGesture = null; updateActionBoxStates();
    }


    // ============================================================================
    // ======================== 🌟 核心修复：语音控制引擎迁入内部 🌟 =================
    // ============================================================================

    // 1. 刷新语音UI面板
    function updateVoiceUI(status, message, transcript = "") {
        const dot = document.getElementById('voice-dot');
        const statusText = document.getElementById('voice-status-text');
        const msgEl = document.getElementById('voice-message');
        if (!dot || !statusText || !msgEl) return;

        if (status === "SLEEP") {
            dot.className = "voice-dot sleeping";
            statusText.innerText = "语音待机中";
            statusText.style.color = "#9ca3af";
        } else if (status === "AWAKE") {
            dot.className = "voice-dot awake";
            statusText.innerText = "正在聆听";
            statusText.style.color = "#10b981";
        }

        let finalHtml = message;
        if (transcript) finalHtml = `<div class="voice-transcript">“${transcript}”</div>` + message;
        msgEl.innerHTML = finalHtml;
    }

    // 2. 唤醒与休眠控制
    function wakeUpAssistant() {
        isVoiceAwake = true; // 👉 修复：现在这里可以访问到 initHybridControl 中的 isVoiceAwake 变量了！
        updateVoiceUI("AWAKE", "小助手已就绪，请下达指令。");
        resetVoiceTimeout();
    }

    function sleepAssistant(reason) {
        isVoiceAwake = false;
        if (voiceTimeoutTimer) clearTimeout(voiceTimeoutTimer);
        updateVoiceUI("SLEEP", reason === "timeout" ? "超过1分钟未使用已休眠，呼叫“小助手”唤醒" : "请呼叫“小助手”激活语音控制");
    }

    function resetVoiceTimeout() {
        if (voiceTimeoutTimer) clearTimeout(voiceTimeoutTimer);
        voiceTimeoutTimer = setTimeout(() => { sleepAssistant("timeout"); }, 60000);
    }

    // 3. 处理语音指令（参考 voice_content.js 的强逻辑去噪）
    async function handleVoiceCommand(rawText) {
        // [吸收 voice_content.js 优点]：过滤干扰前缀和后缀
        let cleanText = rawText
            .replace(/^(请|帮我|麻烦你?|小助手|助手|我想要?|我要|给我|能不能|帮)/, '')
            .replace(/(谢谢|吧|呢|啊|嘛|哦|喔)$/, '')
            .trim();

        if (!cleanText) return;
        updateVoiceUI("AWAKE", "处理中...", cleanText);

        if (cleanText.includes("停止当前识别") || cleanText.includes("停止识别") || cleanText.includes("关闭识别")) {
            let currentState = isActive ? (currentMode === "HEAD" ? "头部" : "手部") : "未开启任何";
            if (isActive) { stopSystem(); updateVoiceUI("AWAKE", `已关闭${currentState}识别状态`, cleanText); }
            else { updateVoiceUI("AWAKE", "当前并未开启任何识别", cleanText); }
            return;
        }

        if (cleanText.includes("开启头") || cleanText.includes("切换到头")) {
            if (!isActive) { await startSystem(); switchMode("HEAD"); updateVoiceUI("AWAKE", "已开启头部识别状态", cleanText); }
            else if (currentMode === "HEAD") { updateVoiceUI("AWAKE", "已处于对应状态 (头部控制)", cleanText); }
            else { switchMode("HEAD"); updateVoiceUI("AWAKE", "已转至头部识别状态", cleanText); }
            return;
        }

        if (cleanText.includes("开启手") || cleanText.includes("切换到手")) {
            if (!isActive) { await startSystem(); switchMode("HAND"); updateVoiceUI("AWAKE", "已开启手部识别状态", cleanText); }
            else if (currentMode === "HAND") { updateVoiceUI("AWAKE", "已处于对应状态 (手部控制)", cleanText); }
            else { switchMode("HAND"); updateVoiceUI("AWAKE", "已转至手部识别状态", cleanText); }
            return;
        }

        callLLMIntentEngine(cleanText);
    }

    // 4. LLM 大模型 API 兜底调用
    async function callLLMIntentEngine(text) {
        updateVoiceUI("AWAKE", "正在思考指令意图...", text);
        try {
            const response = await fetch(LLM_API_CONFIG.url, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LLM_API_CONFIG.key}` },
                body: JSON.stringify({
                    model: LLM_API_CONFIG.model,
                    messages: [
                        { "role": "system", "content": "你是一个网页控制助手。根据指令返回严格的JSON: {\"action\": \"scroll_down\"}。支持: scroll_up, scroll_down, like, go_back, go_forward。听不懂返回 {\"action\": \"unknown\"}。" },
                        { "role": "user", "content": text }
                    ],
                    response_format: { "type": "json_object" }
                })
            });

            const data = await response.json();
            const result = JSON.parse(data.choices[0].message.content);

            if (result.action && result.action !== "unknown") {
                updateVoiceUI("AWAKE", `执行: ${result.action}`, text);
                if (result.action === "scroll_down") window.scrollBy({ top: window.innerHeight * 0.5, behavior: 'smooth' });
                if (result.action === "scroll_up") window.scrollBy({ top: -window.innerHeight * 0.5, behavior: 'smooth' });
            } else {
                updateVoiceUI("AWAKE", "未能理解该指令，请换个说法。", text);
            }
        } catch (e) { console.error("LLM API 失败:", e); updateVoiceUI("AWAKE", "API 请求失败", text); }
    }

    // 5. 语音识别引擎初始化
    function initVoiceControl() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return console.error("浏览器不支持 Web Speech API");

        voiceRecognition = new SpeechRecognition();
        voiceRecognition.continuous = true;
        voiceRecognition.interimResults = false;
        voiceRecognition.lang = 'zh-CN';

        voiceRecognition.onresult = (event) => {
            const lastResult = event.results[event.results.length - 1];
            if (lastResult.isFinal) {
                // [吸收 voice_content.js 优点]：无死角符号清理
                let text = lastResult[0].transcript.trim().replace(/[。，？！,.?! ]/g, '');
                if (!text) return;
                console.log("🎤 识别结果:", text);

                if (!isVoiceAwake) {
                    if (text.includes("小助手") || text.includes("助手")) {
                        wakeUpAssistant();
                        // 连读切分逻辑
                        const commandText = text.replace(/.*(小助手|助手)/, '').trim();
                        if (commandText) handleVoiceCommand(commandText);
                    }
                } else {
                    resetVoiceTimeout();
                    handleVoiceCommand(text);
                }
            }
        };

        voiceRecognition.onend = () => { setTimeout(() => { try { voiceRecognition.start(); } catch (e) { } }, 500); };
        try { voiceRecognition.start(); console.log("🎙️ 语音引擎已启动"); } catch (e) { }
    }


    // ================== 事件监听绑定区域 ==================
    toggleBtn.addEventListener('click', () => { isActive ? stopSystem() : startSystem(); });
    setTimeout(() => { if (!isActive) startSystem(); }, 800);
    setTimeout(() => { initVoiceControl(); }, 2000); // 确保在核心机制注入后初始化语音

} // 👈 完美收口！至此，所有的内部函数都在 initHybridControl 大圈内了

// 启动判定
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initHybridControl); }
else { initHybridControl(); }