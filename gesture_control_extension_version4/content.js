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
                <div style="height:8px"></div>
            </div>
            <!-- 动作塔 -->
            <div class="gesture-action-box" id="box-scroll-up"><span class="gesture-icon">🖐️</span><span>上滚</span></div>
            <div class="gesture-action-box" id="box-scroll-down"><span class="gesture-icon">🖐️</span><span>下滚</span></div>
            <div class="gesture-action-box" id="box-like"><span class="gesture-icon">👍</span><span>点赞</span></div>
            <div class="gesture-action-box" id="box-next"><span class="gesture-icon">👎</span><span>下个</span></div>
            <div class="gesture-action-box" id="box-refresh"><span class="gesture-icon">✌️</span><span>刷新</span></div>
            <div class="gesture-action-box" id="box-rewind"><span class="gesture-icon">👈</span><span>后退</span></div>
            <div class="gesture-action-box" id="box-forward"><span class="gesture-icon">👉</span><span>前进</span></div>
            <div class="gesture-action-box" id="box-play-pause"><span class="gesture-icon">✊</span><span>启停</span></div>
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

    canvasElement.width = 320;
    canvasElement.height = 240;

    let isActive = false;
    let camera = null;
    let hands = null;

    // 动作状态控制
    const SCROLL_SPEED = 45;
    const CONTINUOUS_CONFIRM_TIME = 900; // 900ms缩放确认时间
    let activeGesture = null;
    let gestureStartTime = 0;
    let uiClearTimeouts = {};

    // 降低冷却时间
    const cooldowns = { LIKE: 0, REFRESH: 0, VIDEO_SEEK: 0, VIDEO_TOGGLE: 0, NEXT_VID: 0, SPEED: 0 };

    function getDistance(p1, p2) {
        return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
    }

    function isFingerExtended(landmarks, tipIdx, mcpIdx) {
        return getDistance(landmarks[tipIdx], landmarks[0]) > getDistance(landmarks[mcpIdx], landmarks[0]) * 1.25;
    }

    function recognizeGesture(landmarks) {
        const thumbEx = isFingerExtended(landmarks, 4, 2);
        const indexEx = isFingerExtended(landmarks, 8, 5);
        const middleEx = isFingerExtended(landmarks, 12, 9);
        const ringEx = isFingerExtended(landmarks, 16, 13);
        const pinkyEx = isFingerExtended(landmarks, 20, 17);

        // 1. 张开手掌 (滚动)
        if (thumbEx && indexEx && middleEx && ringEx && pinkyEx) {
            const dy = landmarks[9].y - landmarks[0].y;
            if (dy < -0.15) return "PALM_UP";
            if (dy > 0.15) return "PALM_DOWN";
        }
        // 2. 握拳 (播放/暂停)
        if (!thumbEx && !indexEx && !middleEx && !ringEx && !pinkyEx) return "FIST";
        // 3. V字手势 (刷新)
        if (indexEx && middleEx && !ringEx && !pinkyEx) return "V_SIGN";
        // 4. 金属礼/摇滚 (倍速)
        if (indexEx && !middleEx && !ringEx && pinkyEx) return "HORNS";

        // 5. 大拇指判定
        if (thumbEx && !indexEx && !middleEx && !ringEx && !pinkyEx) {
            if (landmarks[4].y < landmarks[3].y && landmarks[4].y < landmarks[2].y) return "THUMBS_UP";
            if (landmarks[4].y > landmarks[3].y && landmarks[4].y > landmarks[2].y) return "THUMBS_DOWN";
        }
        // 6. 食指指引 (快进快退)
        if (indexEx && !middleEx && !ringEx && !pinkyEx) {
            const dx = landmarks[8].x - landmarks[5].x;
            if (dx > 0.08) return "POINT_LEFT";
            if (dx < -0.08) return "POINT_RIGHT";
        }
        return "NONE";
    }

    // ================= DOM 核心控制 =================
    function triggerPageLike() {
        const selectors = ['[aria-label*="赞"]', '[data-testid*="like"]', '.like-btn', '.Like', 'svg[class*="like"]'];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && typeof el.click === 'function') { el.click(); return true; }
        }
        const buttons = document.querySelectorAll('button, [role="button"], span, div');
        for (const el of buttons) {
            const text = el.textContent?.trim() || '';
            if (/^赞$|^点赞$|^like$/i.test(text) && el.offsetParent !== null) { el.click(); return true; }
        }
        return false;
    }

    function getActiveVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (videos.length === 0) return null;
        let active = videos.find(v => !v.paused && v.offsetWidth > 0);
        if (!active) active = videos.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
        return active;
    }

    function adjustVideoTime(seconds) {
        const vid = getActiveVideo();
        if (vid) { vid.currentTime = Math.max(0, Math.min(vid.duration, vid.currentTime + seconds)); return true; }
        return false;
    }

    function togglePlayPause() {
        const vid = getActiveVideo();
        if (vid) { vid.paused ? vid.play() : vid.pause(); return true; }
        return false;
    }

    function toggleSpeed() {
        const vid = getActiveVideo();
        if (vid) { vid.playbackRate = vid.playbackRate === 1.0 ? 2.0 : 1.0; return true; }
        return false;
    }

    function triggerNextVideo() {
        // 模拟按下 ArrowDown，兼容TikTok, Youtube Shorts, B站竖屏等
        const event = new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true });
        document.dispatchEvent(event);
        return true;
    }

    // ================= UI 与 调度引擎 =================
    const GESTURE_MAP = {
        "PALM_UP": "box-scroll-up",
        "PALM_DOWN": "box-scroll-down",
        "THUMBS_UP": "box-like",
        "THUMBS_DOWN": "box-next",
        "V_SIGN": "box-refresh",
        "POINT_LEFT": "box-rewind",
        "POINT_RIGHT": "box-forward",
        "FIST": "box-play-pause",
        "HORNS": "box-speed"
    };

    function resetUIState() {
        document.querySelectorAll('.gesture-action-box').forEach(el => {
            el.classList.remove('scaling', 'glowing', 'error-glow');
        });
    }

    function triggerInstantUI(boxId, isSuccess) {
        const box = document.getElementById(boxId);
        if (!box) return;

        box.classList.remove('scaling', 'glowing', 'error-glow');
        // 强制重绘以重新触发动画
        void box.offsetWidth;

        box.classList.add(isSuccess ? 'glowing' : 'error-glow');

        if (uiClearTimeouts[boxId]) clearTimeout(uiClearTimeouts[boxId]);
        uiClearTimeouts[boxId] = setTimeout(() => {
            box.classList.remove('glowing', 'error-glow');
        }, 600);
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
        if (!landmarks) {
            setFingerFill('finger-thumb', 0);
            setFingerFill('finger-index', 0);
            setFingerFill('finger-middle', 0);
            setFingerFill('finger-ring', 0);
            setFingerFill('finger-pinky', 0);
            return;
        }
        const tips = [{ tip: 4, mcp: 2, id: 'finger-thumb' }, { tip: 8, mcp: 5, id: 'finger-index' }, { tip: 12, mcp: 9, id: 'finger-middle' }, { tip: 16, mcp: 13, id: 'finger-ring' }, { tip: 20, mcp: 17, id: 'finger-pinky' }];
        for (const t of tips) {
            const dTip = getDistance(landmarks[t.tip], landmarks[0]);
            const dMcp = getDistance(landmarks[t.mcp], landmarks[0]);
            let ratio = 0;
            if (dMcp > 0) ratio = Math.min(1, dTip / (dMcp * 1.6));
            setFingerFill(t.id, ratio);
        }
    }

    function isOnlyPinkyExtended(landmarks) {
        const thumbEx = isFingerExtended(landmarks, 4, 2);
        const indexEx = isFingerExtended(landmarks, 8, 5);
        const middleEx = isFingerExtended(landmarks, 12, 9);
        const ringEx = isFingerExtended(landmarks, 16, 13);
        const pinkyEx = isFingerExtended(landmarks, 20, 17);
        return pinkyEx && !thumbEx && !indexEx && !middleEx && !ringEx;
    }

    function executeAction(gesture) {
        const now = Date.now();

        // 处理持续动作 (滚动)
        if (gesture === "PALM_UP" || gesture === "PALM_DOWN") {
            const boxId = GESTURE_MAP[gesture];
            const box = document.getElementById(boxId);

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
                window.scrollBy({ top: gesture === "PALM_UP" ? -SCROLL_SPEED : SCROLL_SPEED, left: 0, behavior: 'instant' });
            }
            return;
        }

        // 处理需要确认的单次动作 (刷新)
        if (gesture === "V_SIGN") {
            const boxId = GESTURE_MAP[gesture];
            const box = document.getElementById(boxId);

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
                if (now > cooldowns.REFRESH) {
                    cooldowns.REFRESH = now + 5000;
                    setTimeout(() => location.reload(), 600);
                }
            }
            return;
        }

        // 打断确认/持续动作
        if (activeGesture && (activeGesture === "PALM_UP" || activeGesture === "PALM_DOWN" || activeGesture === "V_SIGN") && activeGesture !== gesture) {
            resetUIState();
            activeGesture = null;
        }

        // 处理即时触发动作
        const boxId = GESTURE_MAP[gesture];
        let success = false;

        switch (gesture) {
            case "THUMBS_UP":
                if (now > cooldowns.LIKE) {
                    success = triggerPageLike();
                    triggerInstantUI(boxId, success);
                    cooldowns.LIKE = now + 2000;
                }
                break;
            case "THUMBS_DOWN":
                if (now > cooldowns.NEXT_VID) {
                    success = triggerNextVideo();
                    triggerInstantUI(boxId, success);
                    cooldowns.NEXT_VID = now + 1500;
                }
                break;
            case "POINT_RIGHT":
                if (now > cooldowns.VIDEO_SEEK) {
                    success = adjustVideoTime(5);
                    triggerInstantUI(boxId, success);
                    cooldowns.VIDEO_SEEK = now + 400; // 快进快退冷却时间降至0.4秒
                }
                break;
            case "POINT_LEFT":
                if (now > cooldowns.VIDEO_SEEK) {
                    success = adjustVideoTime(-5);
                    triggerInstantUI(boxId, success);
                    cooldowns.VIDEO_SEEK = now + 400;
                }
                break;
            case "FIST":
                if (now > cooldowns.VIDEO_TOGGLE) {
                    success = togglePlayPause();
                    triggerInstantUI(boxId, success);
                    cooldowns.VIDEO_TOGGLE = now + 1000;
                }
                break;
            case "HORNS":
                if (now > cooldowns.SPEED) {
                    success = toggleSpeed();
                    triggerInstantUI(boxId, success);
                    cooldowns.SPEED = now + 1500;
                }
                break;
        }
    }

    function onResults(results) {
        if (!isActive) return;
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        let detectedGesture = "NONE";
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            for (const landmarks of results.multiHandLandmarks) {
                window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, { color: 'rgba(255,255,255,0.2)', lineWidth: 2 });
                window.drawLandmarks(canvasCtx, landmarks, { color: '#00f2ff', lineWidth: 1, radius: 2.5 });
                detectedGesture = recognizeGesture(landmarks);
            }
            // 更新手指状态栏，使用第一只手的关键点
            updateFingerStatus(results.multiHandLandmarks[0]);
        }
        canvasCtx.restore();
        if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) updateFingerStatus(null);
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
        activeGesture = null;
    }

    toggleBtn.addEventListener('click', () => { isActive ? stopSystem() : startSystem(); });
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', initGestureControl); }
else { initGestureControl(); }
