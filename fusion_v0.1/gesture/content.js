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
    if (document.getElementById('gesture-plugin-root')) return;
    const root = document.createElement('div');
    root.id = 'gesture-plugin-root';
    root.innerHTML = `
        <div id="gesture-cursor"></div>
        <div id="gesture-left-panel">
            <div id="gesture-debug-window">
                <video id="gesture-video" playsinline></video>
                <canvas id="gesture-canvas"></canvas>
            </div>
            <button id="gesture-toggle-btn">开启增强手势</button>
        </div>
        <div id="gesture-right-panel">
            <div id="finger-status">
                <div class="finger-row"><div class="finger-label">拇指</div><div class="finger-bar"><div id="finger-thumb" class="finger-fill"></div></div></div>
                <div class="finger-row"><div class="finger-label">食指</div><div class="finger-bar"><div id="finger-index" class="finger-fill"></div></div></div>
                <div class="finger-row"><div class="finger-label">中指</div><div class="finger-bar"><div id="finger-middle" class="finger-fill"></div></div></div>
                <div class="finger-row"><div class="finger-label">无名指</div><div class="finger-bar"><div id="finger-ring" class="finger-fill"></div></div></div>
                <div class="finger-row"><div class="finger-label">小指</div><div class="finger-bar"><div id="finger-pinky" class="finger-fill"></div></div></div>
                <div style="height:4px"></div>
            </div>
            <div class="gesture-action-box" id="box-free-mode"><span class="gesture-icon">🖱️</span><span>自由交互</span></div>
            <div class="gesture-action-box" id="box-stop"><span class="gesture-icon">🤙</span><span>停止识别</span></div>
            <div class="gesture-action-box" id="box-scroll-up"><span class="gesture-icon">🖐️</span><span>上滚</span></div>
            <div class="gesture-action-box" id="box-scroll-down"><span class="gesture-icon">🖐️</span><span>下滚</span></div>
            <div class="gesture-action-box" id="box-like"><span class="gesture-icon">💍</span><span>点赞</span></div>
            <div class="gesture-action-box" id="box-next"><span class="gesture-icon">👎</span><span>下个</span></div>
            <div class="gesture-action-box" id="box-refresh"><span class="gesture-icon">✌️</span><span>刷新</span></div>
            <div class="gesture-action-box" id="box-rewind"><span class="gesture-icon">👈</span><span>后退</span></div>
            <div class="gesture-action-box" id="box-forward"><span class="gesture-icon">👉</span><span>前进</span></div>
            <div class="gesture-action-box" id="box-play-pause"><span class="gesture-icon">😡</span><span>启停</span></div>
            <div class="gesture-action-box" id="box-speed"><span class="gesture-icon">🤘</span><span>倍速</span></div>
        </div>
    `;
    document.body.appendChild(root);
}

async function initGestureControl() {
    injectUI();

    const videoElement = document.getElementById('gesture-video');
    const canvasElement = document.getElementById('gesture-canvas');
    const canvasCtx = canvasElement.getContext('2d');
    const toggleBtn = document.getElementById('gesture-toggle-btn');
    const cursorEl = document.getElementById('gesture-cursor');

    canvasElement.width = 320;
    canvasElement.height = 240;

    let isActive = false;
    let camera = null;
    let hands = null;

    // 动作与自由模式状态
    const SCROLL_SPEED = 45;
    const CONTINUOUS_CONFIRM_TIME = 900;
    let activeGesture = null;
    let gestureStartTime = 0;
    let uiClearTimeouts = {};

    let isFreeMode = false;
    let cursorX = window.innerWidth / 2, cursorY = window.innerHeight / 2;
    let smoothedCursorX = cursorX, smoothedCursorY = cursorY;
    let lastDwellX = 0, lastDwellY = 0;
    let dwellStartTime = 0;
    let lastFusionPointerTime = 0;
    let lastFusionGestureTime = 0;
    let lastFusionGesture = null;

    const cooldowns = { LIKE: 0, REFRESH: 0, VIDEO_SEEK: 0, VIDEO_TOGGLE: 0, NEXT_VID: 0, SPEED: 0 };

    function getDistance(p1, p2) { return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2)); }
    function isFingerExtended(landmarks, tipIdx, mcpIdx) {
        return getDistance(landmarks[tipIdx], landmarks[0]) > getDistance(landmarks[mcpIdx], landmarks[0]) * 1.25;
    }

    function recognizeGesture(landmarks) {
        const thumbEx = isFingerExtended(landmarks, 4, 2);
        const indexEx = isFingerExtended(landmarks, 8, 5);
        const middleEx = isFingerExtended(landmarks, 12, 9);
        const ringEx = isFingerExtended(landmarks, 16, 13);
        const pinkyEx = isFingerExtended(landmarks, 20, 17);

        // 新增：小拇指退出
        if (!indexEx && !middleEx && !ringEx && pinkyEx) return "PINKY_ONLY";
        // 新增：中指无名指触发自由模式
        if (!indexEx && middleEx && ringEx && !pinkyEx) return "FREE_MODE_TOGGLE";

        if (indexEx && middleEx && ringEx && pinkyEx) {
            const dy = landmarks[9].y - landmarks[0].y;
            if (dy < -0.15) return "PALM_UP";
            if (dy > 0.15) return "PALM_DOWN";
        }
        if (!indexEx && middleEx && !ringEx && !pinkyEx) return "MIDDLE";
        if (indexEx && middleEx && !ringEx && !pinkyEx) return "V_SIGN";
        if (indexEx && !middleEx && !ringEx && pinkyEx) return "HORNS";

        if (!indexEx && !middleEx && ringEx && !pinkyEx) {
            if (landmarks[4].y < landmarks[3].y && landmarks[4].y < landmarks[2].y) return "RINGS_UP";
            if (landmarks[4].y > landmarks[3].y && landmarks[4].y > landmarks[2].y) return "THUMBS_DOWN";
        }
        if (indexEx && !middleEx && !ringEx && !pinkyEx) {
            const dx = landmarks[8].x - landmarks[5].x;
            if (dx > 0.08) return "POINT_LEFT";
            if (dx < -0.08) return "POINT_RIGHT";
        }
        return "NONE";
    }

    // ================= DOM 核心控制 =================
    function triggerPageLike() { /* 精简复用逻辑 */
        const selectors = ['[aria-label*="赞"]', '[aria-label*="like"]', '[aria-label*="Like"]',
            '[data-testid*="like"]', '.like-btn', '.Like', '[title*="赞"]',
            'svg[class*="like"]', '[class*="like"]', '[class*="zan"]', '.video-like'];
        for (const sel of selectors) { const el = document.querySelector(sel); if (el && typeof el.click === 'function') { el.click(); return true; } }
        for (const el of document.querySelectorAll('button, [role="button"], span, div')) {
            if (/^赞$|^点赞$|^like$/i.test(el.textContent?.trim()) && el.offsetParent !== null) { el.click(); return true; }
        }
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
    function triggerNextVideo() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true })); return true; }

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

    // ================= UI 与 调度引擎 =================
    const GESTURE_MAP = {
        "PALM_UP": "box-scroll-up", "PALM_DOWN": "box-scroll-down", "RINGS_UP": "box-like",
        "THUMBS_DOWN": "box-next", "V_SIGN": "box-refresh", "POINT_LEFT": "box-rewind",
        "POINT_RIGHT": "box-forward", "MIDDLE": "box-play-pause", "HORNS": "box-speed",
        "FREE_MODE_TOGGLE": "box-free-mode", "PINKY_ONLY": "box-stop"
    };

    function resetUIState() { document.querySelectorAll('.gesture-action-box').forEach(el => el.classList.remove('scaling', 'glowing', 'error-glow')); }

    function triggerInstantUI(boxId, isSuccess) {
        const box = document.getElementById(boxId);
        if (!box) return;
        box.classList.remove('scaling', 'glowing', 'error-glow');
        void box.offsetWidth; // 触发重绘
        box.classList.add(isSuccess ? 'glowing' : 'error-glow');
        if (uiClearTimeouts[boxId]) clearTimeout(uiClearTimeouts[boxId]);
        uiClearTimeouts[boxId] = setTimeout(() => box.classList.remove('glowing', 'error-glow'), 600);
    }

    function setFingerFill(id, ratio) {
        const el = document.getElementById(id);
        if (!el) return;
        const pct = Math.max(0, Math.min(1, ratio));
        el.style.width = (pct * 100) + '%';
        if (pct > 0.66) el.style.background = '#00f2ff';
        else if (pct > 0.33) el.style.background = '#f59e0b';
        else el.style.background = '#374151';
    }

    function updateFingerStatus(landmarks) {
        if (!landmarks) { ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach(f => setFingerFill('finger-' + f, 0)); return; }
        const tips = [{ t: 4, m: 2, id: 'thumb' }, { t: 8, m: 5, id: 'index' }, { t: 12, m: 9, id: 'middle' }, { t: 16, m: 13, id: 'ring' }, { t: 20, m: 17, id: 'pinky' }];
        for (const f of tips) {
            const dTip = getDistance(landmarks[f.t], landmarks[0]), dMcp = getDistance(landmarks[f.m], landmarks[0]);
            setFingerFill('finger-' + f.id, dMcp > 0 ? Math.min(1, dTip / (dMcp * 1.6)) : 0);
        }
    }

    function publishFusionGesture(gesture) {
        if (typeof window.__mmPublishGesture !== 'function') return;
        const now = Date.now();
        if (gesture === lastFusionGesture && now - lastFusionGestureTime < 500) return;
        lastFusionGesture = gesture;
        lastFusionGestureTime = now;
        window.__mmPublishGesture(gesture, 0.9);
    }

    function publishFusionPointer(x, y) {
        if (typeof window.__mmPublishPointer !== 'function') return;
        const now = Date.now();
        if (now - lastFusionPointerTime < 100) return;
        lastFusionPointerTime = now;
        window.__mmPublishPointer(x, y);
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
            publishFusionGesture(gesture);
            onConfirm();
            if (!isRepeatable) {
                activeGesture = "COOLDOWN";
                setTimeout(() => { if (activeGesture === "COOLDOWN") activeGesture = null; if (box) box.classList.remove('glowing'); }, 1500);
            }
        }
    }

    function executeAction(gesture) {
        const now = Date.now();

        // 自由模式专属循环
        if (isFreeMode) {
            if (gesture === "FREE_MODE_TOGGLE") {
                handleContinuous(gesture, "box-free-mode", false, () => {
                    isFreeMode = false;
                    cursorEl.style.display = 'none';
                    triggerInstantUI("box-free-mode", true);
                });
            } else if (activeGesture === "FREE_MODE_TOGGLE") {
                activeGesture = null; resetUIState();
            }
            return; // 拦截其他动作
        }

        // 全局持续性动作分发
        if (gesture === "PALM_UP") return handleContinuous(gesture, "box-scroll-up", true, () => window.scrollBy({ top: -SCROLL_SPEED, left: 0, behavior: 'instant' }));
        if (gesture === "PALM_DOWN") return handleContinuous(gesture, "box-scroll-down", true, () => window.scrollBy({ top: SCROLL_SPEED, left: 0, behavior: 'instant' }));
        if (gesture === "V_SIGN") return handleContinuous(gesture, "box-refresh", false, () => { if (now > cooldowns.REFRESH) { cooldowns.REFRESH = now + 5000; setTimeout(() => location.reload(), 600); } });
        if (gesture === "PINKY_ONLY") return handleContinuous(gesture, "box-stop", false, stopSystem);
        if (gesture === "FREE_MODE_TOGGLE") return handleContinuous(gesture, "box-free-mode", false, () => { isFreeMode = true; cursorEl.style.display = 'block'; triggerInstantUI("box-free-mode", true); dwellStartTime = now; });

        // 打断未完成的持续动作
        if (activeGesture && ["PALM_UP", "PALM_DOWN", "V_SIGN", "PINKY_ONLY", "FREE_MODE_TOGGLE"].includes(activeGesture) && activeGesture !== gesture) {
            resetUIState(); activeGesture = null;
        }

        const boxId = GESTURE_MAP[gesture];
        let success = false;
        switch (gesture) {
            case "RINGS_UP": if (now > cooldowns.LIKE) { success = triggerPageLike(); triggerInstantUI(boxId, success); cooldowns.LIKE = now + 2000; } break;
            case "THUMBS_DOWN": if (now > cooldowns.NEXT_VID) { success = triggerNextVideo(); triggerInstantUI(boxId, success); cooldowns.NEXT_VID = now + 1500; } break;
            case "POINT_RIGHT": if (now > cooldowns.VIDEO_SEEK) { success = adjustVideoTime(5); triggerInstantUI(boxId, success); cooldowns.VIDEO_SEEK = now + 400; } break;
            case "POINT_LEFT": if (now > cooldowns.VIDEO_SEEK) { success = adjustVideoTime(-5); triggerInstantUI(boxId, success); cooldowns.VIDEO_SEEK = now + 400; } break;
            case "MIDDLE": if (now > cooldowns.VIDEO_TOGGLE) { success = togglePlayPause(); triggerInstantUI(boxId, success); cooldowns.VIDEO_TOGGLE = now + 1000; } break;
            case "HORNS": if (now > cooldowns.SPEED) { success = toggleSpeed(); triggerInstantUI(boxId, success); cooldowns.SPEED = now + 1500; } break;
        }
    }

    function handleFreeModeCursor(landmarks) {
        // 利用食指尖(8)控制光标。由于摄像头做了镜像(scaleX:-1)，需倒置坐标
        let rawX = (1 - landmarks[8].x) * window.innerWidth;
        let rawY = landmarks[8].y * window.innerHeight;

        // 平滑滤波，降低手抖造成的坐标飘逸
        smoothedCursorX += (rawX - smoothedCursorX) * 0.15;
        smoothedCursorY += (rawY - smoothedCursorY) * 0.15;

        cursorEl.style.left = smoothedCursorX + 'px';
        cursorEl.style.top = smoothedCursorY + 'px';
        publishFusionPointer(smoothedCursorX, smoothedCursorY);

        const dist = Math.hypot(smoothedCursorX - lastDwellX, smoothedCursorY - lastDwellY);
        const now = Date.now();

        // 判定是否停留在 45px 像素圈内
        if (dist < 45) {
            let dwellTime = now - dwellStartTime;
            let progress = Math.min(1, dwellTime / 1200); // 1.2秒触发时间

            // 悬停视觉反馈：红点缩放变色
            cursorEl.style.transform = `translate(-50%, -50%) scale(${1 - progress * 0.5})`;
            cursorEl.style.backgroundColor = `rgba(239, 68, 68, ${0.8 + progress * 0.2})`;

            if (dwellTime > 1200) {
                // 执行点击
                cursorEl.style.transform = `translate(-50%, -50%) scale(2)`;
                cursorEl.style.backgroundColor = `rgba(0, 242, 255, 0.9)`;
                simulateClick(smoothedCursorX, smoothedCursorY);

                // 重置锚点，进入下一次冷却
                lastDwellX = smoothedCursorX; lastDwellY = smoothedCursorY;
                dwellStartTime = now + 1000;
            }
        } else {
            // 位移过大，打断施法
            lastDwellX = smoothedCursorX; lastDwellY = smoothedCursorY;
            dwellStartTime = now;
            cursorEl.style.transform = `translate(-50%, -50%) scale(1)`;
            cursorEl.style.backgroundColor = `rgba(239, 68, 68, 0.8)`;
        }
    }

    function onResults(results) {
        if (!isActive) return;
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        let detectedGesture = "NONE";
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const landmarks = results.multiHandLandmarks[0];
            window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, { color: 'rgba(255,255,255,0.2)', lineWidth: 2 });
            window.drawLandmarks(canvasCtx, landmarks, { color: '#00f2ff', lineWidth: 1, radius: 2.5 });

            detectedGesture = recognizeGesture(landmarks);
            updateFingerStatus(landmarks);

            // 如果处于自由模式，接管食指点绘制与悬停逻辑
            if (isFreeMode) handleFreeModeCursor(landmarks);
        } else {
            updateFingerStatus(null);
        }
        canvasCtx.restore();
        executeAction(detectedGesture);
    }

    async function startSystem() {
        try {
            toggleBtn.innerText = "模块注入中...";
            if (!window.Hands) {
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
                await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js");
            }
            if (!hands) {
                hands = new window.Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
                hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.75, minTrackingConfidence: 0.75 });
                hands.onResults(onResults);
                camera = new window.Camera(videoElement, { onFrame: async () => { if (isActive) await hands.send({ image: videoElement }); }, width: 320, height: 240 });
            }
            toggleBtn.innerText = "请求硬件摄像头权限...";
            await camera.start();
            isActive = true;
            document.getElementById('gesture-debug-window').style.display = 'block';
            toggleBtn.innerText = "关闭增强手势";
            toggleBtn.classList.add('active');
        } catch (error) {
            console.error(error);
            toggleBtn.innerText = "加载失败 (F12看控制台)";
            isActive = false;
        }
    }

    function stopSystem() {
        isActive = false;
        document.getElementById('gesture-debug-window').style.display = 'none';
        toggleBtn.innerText = "开启增强手势";
        toggleBtn.classList.remove('active');
        if (camera) camera.stop();
        resetUIState();
        isFreeMode = false;
        cursorEl.style.display = 'none';
        activeGesture = null;
    }

    toggleBtn.addEventListener('click', () => { isActive ? stopSystem() : startSystem(); });

    // 全局自启动挂载
    setTimeout(() => { if (!isActive) startSystem(); }, 800);
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initGestureControl); }
else { initGestureControl(); }
