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
    let currentMode = "HAND"; // "HAND" 或 "HEAD"
    const SCROLL_SPEED = 45;
    let activeGesture = null;
    let gestureStartTime = 0;
    let uiClearTimeouts = {};
    const cooldowns = { LIKE: 0, REFRESH: 0, VIDEO_SEEK: 0, VIDEO_TOGGLE: 0, SPEED: 0 };

    // 自由模式参数 (仅限Hand)
    let isFreeMode = false;
    let cursorX = window.innerWidth / 2, cursorY = window.innerHeight / 2;
    let smoothedCursorX = cursorX, smoothedCursorY = cursorY;
    let lastDwellX = 0, lastDwellY = 0;
    let dwellStartTime = 0;

    // 头控与点头参数
    const EDGE_UP = -0.08, EDGE_DOWN = 0.12;
    const EDGE_YAW_LEFT = 0.12, EDGE_YAW_RIGHT = -0.12;
    const RATIO_P_MIN = -0.20, RATIO_P_MAX = 0.24, RATIO_P_RANGE = 0.44;
    const RATIO_Y_MIN = -0.25, RATIO_Y_MAX = 0.25, RATIO_Y_RANGE = 0.50;
    const EDGE_MOUTH_OPEN = 0.11; // 张嘴判定阈值比例（嘴唇间距/脸高，可根据舒适度微调）
    const RATIO_M_MAX = 0.22;      // 仪表盘映射的最大嘴张开比例

    let lastPitchState = "CENTERED";
    let nodTimes = [];

    let lastYawState = "CENTERED"; // 新增：记录上一次的偏航状态
    let shakeTimes = [];           // 新增：记录摇头的时间戳数组

    // 预设UI边界线
    document.getElementById('pitch-bound-up').style.top = `${((EDGE_UP - RATIO_P_MIN) / RATIO_P_RANGE) * 100}%`;
    document.getElementById('mouth-bound-open').style.left = `${(EDGE_MOUTH_OPEN / RATIO_M_MAX) * 100}%`;
    document.getElementById('pitch-bound-down').style.top = `${((EDGE_DOWN - RATIO_P_MIN) / RATIO_P_RANGE) * 100}%`;
    document.getElementById('yaw-bound-right').style.left = `${((EDGE_YAW_RIGHT - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100}%`;
    document.getElementById('yaw-bound-left').style.left = `${((EDGE_YAW_LEFT - RATIO_Y_MIN) / RATIO_Y_RANGE) * 100}%`;

    const FACE_MAP = { nose: 1, forehead: 10, chin: 152, leftEyeOuter: 33, rightEyeOuter: 263, upperLipInner: 13, lowerLipInner: 14 };

    // ================= DOM 核心控制 (全部恢复) =================
    function triggerPageLike() {
        const selectors = ['[aria-label*="赞"]', '[aria-label*="like"]', '[aria-label*="Like"]', '[data-testid*="like"]', '.like-btn', '.Like', '[title*="赞"]', 'svg[class*="like"]', '[class*="like"]', '[class*="zan"]', '.video-like'];
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
        if (el) {
            el.focus?.();
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        }
    }

    // ================= 严格的状态灰态隔离 UI =================
    function updateActionBoxStates() {
        const allBoxes = ['box-mode-toggle', 'box-free-mode', 'box-scroll-up', 'box-scroll-down', 'box-rewind', 'box-forward', 'box-play-pause', 'box-like', 'box-speed', 'box-refresh', 'box-stop'];
        let activeBoxes = [];

        if (!isActive) {
            activeBoxes = []; // 停止时全部变灰
        } else if (currentMode === "HEAD") {
            // 头控模式相关
            activeBoxes = ['box-mode-toggle', 'box-scroll-up', 'box-scroll-down', 'box-rewind', 'box-forward', 'box-like', 'box-play-pause'];
        } else if (isFreeMode) {
            // 自由模式相关
            activeBoxes = ['box-free-mode'];
        } else {
            // 常规手势模式
            activeBoxes = allBoxes;
        }

        allBoxes.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                if (activeBoxes.includes(id)) {
                    el.classList.remove('disabled');
                } else {
                    el.classList.add('disabled');
                    el.classList.remove('scaling', 'glowing', 'error-glow'); // 清除动画
                }
            }
        });
    }

    const GESTURE_BOX_MAP = {
        "V_SIGN": "box-mode-toggle",
        "PALM_UP": "box-scroll-up", "PALM_DOWN": "box-scroll-down",
        "POINT_LEFT": "box-rewind", "POINT_RIGHT": "box-forward",
        "MIDDLE": "box-play-pause", "FREE_MODE_TOGGLE": "box-free-mode", "PINKY_ONLY": "box-stop",
        "HEAD_UP": "box-scroll-up", "HEAD_DOWN": "box-scroll-down",
        "HEAD_YAW_LEFT": "box-rewind", "HEAD_YAW_RIGHT": "box-forward",
        "RINGS_UP": "box-like", "HORNS": "box-speed", "THREE_UP": "box-refresh"
    };

    function resetUIState() { document.querySelectorAll('.hybrid-action-box').forEach(el => el.classList.remove('scaling', 'glowing', 'error-glow')); }

    function triggerInstantUI(boxId, isSuccess) {
        const box = document.getElementById(boxId);
        if (!box || box.classList.contains('disabled')) return;
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

        // 【新增核心代码】物理清空画布残余，防止前一个模式的骨骼图死锁停留
        if (canvasCtx && canvasElement) {
             canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
        }

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
        updateActionBoxStates(); // 更新灰态隔离
    }

    // 允许传入自定义确认时间，用于实现头部的顺畅翻页
    function handleContinuous(gesture, boxId, isRepeatable, onConfirm, customDelay = 900) {
        const now = Date.now();
        const box = boxId ? document.getElementById(boxId) : null;

        if (activeGesture !== gesture) {
            resetUIState();
            activeGesture = gesture;
            gestureStartTime = now;
            if (box && !box.classList.contains('disabled')) box.classList.add('scaling');
        } else if (now - gestureStartTime > customDelay) {
            if (box && !box.classList.contains('disabled') && !isRepeatable) {
                box.classList.remove('scaling'); box.classList.add('glowing');
            }
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
        // 第一时间拦截：如果是头控模式，彻底屏蔽所有手势的输出，防止状态死锁
        if (currentMode === "HEAD") return "NONE";

        const thumbEx = isFingerExtended(landmarks, 4, 2);
        const indexEx = isFingerExtended(landmarks, 8, 5);
        const middleEx = isFingerExtended(landmarks, 12, 9);
        const ringEx = isFingerExtended(landmarks, 16, 13);
        const pinkyEx = isFingerExtended(landmarks, 20, 17);

        if (indexEx && middleEx && !ringEx && !pinkyEx) return "V_SIGN";

        if (!indexEx && !middleEx && !ringEx && pinkyEx) return "PINKY_ONLY";
        if (!indexEx && middleEx && ringEx && !pinkyEx) return "FREE_MODE_TOGGLE";

        if (!indexEx && !middleEx && ringEx && !pinkyEx) {
            if (landmarks[4].y < landmarks[3].y && landmarks[4].y < landmarks[2].y) return "RINGS_UP";
        }
        if (indexEx && !middleEx && !ringEx && pinkyEx) return "HORNS";
        if (thumbEx && !indexEx && !middleEx && !ringEx && !pinkyEx) return "THUMBS_UP";

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

    function handleFreeModeCursor(landmarks) {
        let rawX = (1 - landmarks[8].x) * window.innerWidth;
        let rawY = landmarks[8].y * window.innerHeight;
        smoothedCursorX += (rawX - smoothedCursorX) * 0.15;
        smoothedCursorY += (rawY - smoothedCursorY) * 0.15;
        cursorEl.style.left = smoothedCursorX + 'px';
        cursorEl.style.top = smoothedCursorY + 'px';

        const dist = Math.hypot(smoothedCursorX - lastDwellX, smoothedCursorY - lastDwellY);
        const now = Date.now();

        if (dist < 45) {
            let dwellTime = now - dwellStartTime;
            let progress = Math.min(1, dwellTime / 1200);
            cursorEl.style.transform = `translate(-50%, -50%) scale(${1 - progress * 0.5})`;
            cursorEl.style.backgroundColor = `rgba(239, 68, 68, ${0.8 + progress * 0.2})`;

            if (dwellTime > 1200) {
                cursorEl.style.transform = `translate(-50%, -50%) scale(2)`;
                cursorEl.style.backgroundColor = `rgba(0, 242, 255, 0.9)`;
                simulateClick(smoothedCursorX, smoothedCursorY);
                lastDwellX = smoothedCursorX; lastDwellY = smoothedCursorY;
                dwellStartTime = now + 1000;
            }
        } else {
            lastDwellX = smoothedCursorX; lastDwellY = smoothedCursorY;
            dwellStartTime = now;
            cursorEl.style.transform = `translate(-50%, -50%) scale(1)`;
            cursorEl.style.backgroundColor = `rgba(239, 68, 68, 0.8)`;
        }
    }

    // ================= 头部识别引擎与点头判定 =================
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

        const faceHeight = Math.max(Math.abs(chin.y - forehead.y), 1e-5);
        const eyeCenterY = (leftEye.y + rightEye.y) / 2;
        const pitchRatio = (nose.y - eyeCenterY - faceHeight * 0.16) / faceHeight;
        updatePitchIndicator(pitchRatio);

        const faceWidth = Math.max(Math.abs(rightEye.x - leftEye.x), 1e-5);
        const eyeCenterX = (leftEye.x + rightEye.x) / 2;
        const yawRatio = (nose.x - eyeCenterX) / faceWidth;
        updateYawIndicator(yawRatio);

        // === 核心新增：计算嘴巴张开度与更新 UI ===
        const upperLip = landmarks[FACE_MAP.upperLipInner];
        const lowerLip = landmarks[FACE_MAP.lowerLipInner];
        const mouthDistance = getDistance(upperLip, lowerLip); // 直接复用你原有的 getDistance 基础函数
        const mouthRatio = mouthDistance / faceHeight;

        const mouthInd = document.getElementById('mouth-indicator');
        if (mouthInd) {
            let mouthPct = Math.max(0, Math.min(100, (mouthRatio / RATIO_M_MAX) * 100));
            mouthInd.style.width = mouthPct + '%';
            mouthInd.style.background = (mouthRatio > EDGE_MOUTH_OPEN) ? '#00f2ff' : '#10b981';
        }

        // 判定高优姿态：如果张大嘴，立即中断普通头控倾斜，返回嘴部动作信号
        if (mouthRatio > EDGE_MOUTH_OPEN) return "MOUTH_OPEN";

        // 1. 判定俯仰状态（上下）
        let currentPitchState = "CENTERED";
        if (pitchRatio < EDGE_UP) currentPitchState = "HEAD_UP";
        else if (pitchRatio > EDGE_DOWN) currentPitchState = "HEAD_DOWN";

        // 点头判定
        if (lastPitchState !== "HEAD_DOWN" && currentPitchState === "HEAD_DOWN") {
            const now = Date.now();
            nodTimes.push(now);
            nodTimes = nodTimes.filter(t => now - t < 1000);
            if (nodTimes.length >= 2) {
                nodTimes = [];
                lastPitchState = currentPitchState;
                return "DOUBLE_NOD";
            }
        }
        lastPitchState = currentPitchState;

        // 2. 判定偏航状态（左右）
        let currentYawState = "CENTERED";
        if (yawRatio > EDGE_YAW_LEFT) currentYawState = "HEAD_YAW_LEFT";
        else if (yawRatio < EDGE_YAW_RIGHT) currentYawState = "HEAD_YAW_RIGHT";

        // === 核心新增：两次快速摇头判定（连续3次跨越边缘，如：左->右->左） ===
        if (lastYawState !== currentYawState && currentYawState !== "CENTERED") {
            const now = Date.now();
            shakeTimes.push(now);
            shakeTimes = shakeTimes.filter(t => now - t < 1200); // 1.2秒窗口期
            if (shakeTimes.length >= 3) {
                shakeTimes = [];
                lastYawState = currentYawState;
                return "DOUBLE_SHAKE"; // 发出独立摇头信号
            }
        }
        lastYawState = currentYawState;

        // 3. 常规优先级返回
        if (currentYawState !== "CENTERED") return currentYawState;
        return currentPitchState;
    }

    // ================= 动作执行路由器 =================
    function executeAction(gesture) {
        const now = Date.now();

        // === 新增：快速摇头退出头控模式 ===
        if (gesture === "DOUBLE_SHAKE" && currentMode === "HEAD") {
            switchMode("HAND");
            triggerInstantUI("box-mode-toggle", true); // 让右侧切模式盒子闪烁青光反馈
            return;
        }

        // 处理瞬发型的快速双击点头
        if (gesture === "DOUBLE_NOD") {
            if (now > cooldowns.LIKE) {
                const success = triggerPageLike();
                triggerInstantUI("box-like", success);
                cooldowns.LIKE = now + 2000;
            }
            return;
        }

        // 修改：V字手势现在只负责【进入】头控模式
        if (gesture === "V_SIGN") {
            handleContinuous(gesture, GESTURE_BOX_MAP[gesture], false, () => {
                if (currentMode === "HAND") {
                    switchMode("HEAD");
                }
            });
            return;
        }

        // 下方的打断列表同步加上 "DOUBLE_SHAKE" 避免死锁
        if (activeGesture && activeGesture !== gesture && ["PALM_UP", "PALM_DOWN", "HEAD_UP", "HEAD_DOWN", "V_SIGN", "FREE_MODE_TOGGLE", "THUMBS_UP", "DOUBLE_SHAKE", "MOUTH_OPEN"].includes(activeGesture)) {
            resetUIState(); activeGesture = null;
        }

        if (currentMode === "HAND") {
            if (isFreeMode) {
                if (gesture === "FREE_MODE_TOGGLE") { handleContinuous(gesture, "box-free-mode", false, () => { isFreeMode = false; cursorEl.style.display = 'none'; updateActionBoxStates(); triggerInstantUI("box-free-mode", true); }); }
                else if (activeGesture === "FREE_MODE_TOGGLE") { activeGesture = null; resetUIState(); }
                return;
            }
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
            if (gesture === "THREE_UP" && now > cooldowns.REFRESH) { triggerInstantUI(boxId, true); cooldowns.REFRESH = now + 5000; setTimeout(() => location.reload(), 600); }
            
        } else if (currentMode === "HEAD") {
            // 使用 behavior: 'instant' 和超短确认延迟(150ms)，实现和手势一样丝滑流畅的连续翻页
            if (gesture === "HEAD_UP") return handleContinuous(gesture, "box-scroll-up", true, () => window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'instant' }), 150);
            if (gesture === "HEAD_DOWN") return handleContinuous(gesture, "box-scroll-down", true, () => window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'instant' }), 150);

            const boxId = GESTURE_BOX_MAP[gesture];
            if (gesture === "HEAD_YAW_LEFT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(-5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "HEAD_YAW_RIGHT" && now > cooldowns.VIDEO_SEEK) { adjustVideoTime(5); triggerInstantUI(boxId, true); cooldowns.VIDEO_SEEK = now + 400; }
            if (gesture === "MOUTH_OPEN") {
                return handleContinuous(gesture, "box-play-pause", false, () => {
                    togglePlayPause();
                    triggerInstantUI("box-play-pause", true);
                }, 2000);
        }
    }

    // ================= 系统启动/流处理 =================
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
                    canvasCtx.save();
                    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

                    let handGesture = "NONE";
                    if (res.multiHandLandmarks?.length > 0) {
                        const lm = res.multiHandLandmarks[0];
                        window.drawConnectors(canvasCtx, lm, window.HAND_CONNECTIONS, { color: 'rgba(255,255,255,0.2)', lineWidth: 2 });
                        window.drawLandmarks(canvasCtx, lm, { color: '#00f2ff', lineWidth: 1, radius: 2.5 });
                        handGesture = recognizeGesture(lm);
                        if (currentMode === "HAND") {
                            updateFingerStatus(lm);
                            if (isFreeMode) handleFreeModeCursor(lm);
                        }
                    } else {
                        if (currentMode === "HAND") updateFingerStatus(null);
                    }
                    canvasCtx.restore();
                    if (handGesture !== "NONE") executeAction(handGesture);
                });
            }
            if (!faceMesh) {
                faceMesh = new window.FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
                faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
                faceMesh.onResults((res) => {
                    if (!isActive || currentMode !== "HEAD") return;
                    canvasCtx.save();

                    // 【新增核心代码】擦除上一帧人脸网格，防止多帧画面无限叠加全白
                    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

                    let headGesture = "CENTERED";
                    if (res.multiFaceLandmarks?.length > 0) {
                        const lm = res.multiFaceLandmarks[0];
                        window.drawConnectors(canvasCtx, lm, window.FACEMESH_TESSELATION, { color: 'rgba(255,255,255,0.1)', lineWidth: 1 });
                        headGesture = analyzeHeadPosture(lm);
                    } else {
                        // 丢失人脸时，不仅重置指示器，也要重置姿态状态变量
                        updatePitchIndicator(0); updateYawIndicator(0);
                        // 【新增代码】丢失人脸时顺便清空嘴巴条
                        const mouthInd = document.getElementById('mouth-indicator');
                        if (mouthInd) mouthInd.style.width = '0%';
                        lastPitchState = "CENTERED"; lastYawState = "CENTERED";
                    }
                    canvasCtx.restore();
                    // 解除封印：不再判断 activeGesture，只要头动了就直接发送动作
                    if (headGesture !== "CENTERED") executeAction(headGesture);
                });
            }
            camera = new window.Camera(videoElement, {
                onFrame: async () => {
                    if (isActive) {
                        // 物理隔离级别的优化：手控模式只送入手部模型，头控模式只送入头部模型
                        if (currentMode === "HAND") {
                            await hands.send({ image: videoElement });
                        } else if (currentMode === "HEAD") {
                            await faceMesh.send({ image: videoElement });
                        }
                    }
                }, width: 320, height: 240
            });

            toggleBtn.innerText = "请求硬件权限...";
            await camera.start();
            isActive = true;
            document.getElementById('hybrid-debug-window').style.display = 'block';
            toggleBtn.innerText = "关闭混合控制";
            toggleBtn.classList.add('active');
            switchMode("HAND");
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
        updateActionBoxStates(); // 触发全灰态
    }

    toggleBtn.addEventListener('click', () => { isActive ? stopSystem() : startSystem(); });
    setTimeout(() => { if (!isActive) startSystem(); }, 800);
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initHybridControl); }
else { initHybridControl(); }