// 动态加载外部 MediaPipe 计算库
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

// 注入UI元素 (移除内联样式，采用全外部content.css控制)
function injectUI() {
    if (document.getElementById('gesture-plugin-root')) return;

    const root = document.createElement('div');
    root.id = 'gesture-plugin-root';
    root.innerHTML = `
        <div id="gesture-left-panel">
            <div id="gesture-debug-window">
                <video id="gesture-video" playsinline></video>
                <canvas id="gesture-canvas"></canvas>
                <div id="gesture-status-toast">等待系统初始化...</div>
            </div>
            <button id="gesture-toggle-btn">开启增强手势控制</button>
        </div>
        <div id="gesture-feedback-banner" class="gesture-screen-feedback"></div>
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
    const statusToast = document.getElementById('gesture-status-toast');
    const feedbackBanner = document.getElementById('gesture-feedback-banner');

    canvasElement.width = 320;
    canvasElement.height = 240;

    let isActive = false;
    let camera = null;
    let hands = null;

    // 动作阈值与节流状态控制
    const SCROLL_SPEED = 40;
    let activeGesture = null;
    let gestureStartTime = 0;
    
    // 动作独立冷却时间池（防止高频帧图像导致的误触、重触）
    const cooldowns = {
        LIKE: 0,
        REFRESH: 0,
        VIDEO_SEEK: 0
    };

    // ==========================================
    // 数学辅助函数与手势几何特征提取
    // ==========================================
    function getDistance(p1, p2) {
        return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
    }

    // 判断单根手指是否处于伸展状态 (通过指尖到掌心的绝对距离对比指根到掌心的距离)
    function isFingerExtended(landmarks, tipIdx, mcpIdx) {
        return getDistance(landmarks[tipIdx], landmarks[0]) > getDistance(landmarks[mcpIdx], landmarks[0]) * 1.25;
    }

    // ==========================================
    // 视觉意图识别字典 (从空间连续坐标收敛至离散动作)
    // ==========================================
    function recognizeGesture(landmarks) {
        const thumbEx = isFingerExtended(landmarks, 4, 2);
        const indexEx = isFingerExtended(landmarks, 8, 5);
        const middleEx = isFingerExtended(landmarks, 12, 9);
        const ringEx = isFingerExtended(landmarks, 16, 13);
        const pinkyEx = isFingerExtended(landmarks, 20, 17);

        // 1. 全掌张开 (五指皆伸展)：用于页面平滑滚动
        if (thumbEx && indexEx && middleEx && ringEx && pinkyEx) {
            // 通过手掌中心（9号节点）与手腕（0号节点）的纵向相对差计算朝向
            const dy = landmarks[9].y - landmarks[0].y;
            if (dy < -0.15) return "PALM_UP";
            if (dy > 0.15) return "PALM_DOWN";
        }

        // 2. 经典V字手势 (仅食指与中指伸展，其余闭合)：用于刷新页面
        if (!thumbEx && indexEx && middleEx && !ringEx && !pinkyEx) {
            return "V_SIGN";
        }

        // 3. 点赞大拇指 (仅大拇指伸展、指尖高过所有指根，其余全闭合)
        const isThumbPointingUp = landmarks[4].y < landmarks[3].y && landmarks[4].y < landmarks[2].y;
        if (thumbEx && !indexEx && !middleEx && !ringEx && !pinkyEx && isThumbPointingUp) {
            return "THUMBS_UP";
        }

        // 4. 单食指控速 (仅食指横向延展，其余全闭合)：用于流媒体进度控制
        if (!thumbEx && indexEx && !middleEx && !ringEx && !pinkyEx) {
            const dx = landmarks[8].x - landmarks[5].x;
            if (dx > 0.08) return "POINT_LEFT";   // 镜像转换：物理指向左
            if (dx < -0.08) return "POINT_RIGHT"; // 镜像转换：物理指向右
        }

        return "NONE";
    }

    // ==========================================
    // 精细化 DOM 执行控制层 (吸收合并 voice-contest 精准捕获逻辑)
    // ==========================================
    function triggerPageLike() {
        // 多维度权重选择器矩阵
        const selectors = [
            '[aria-label*="赞"]', '[aria-label*="like"]', '[aria-label*="Like"]',
            '[data-testid*="like"]', '.like-btn', '.Like', '[title*="赞"]',
            'svg[class*="like"]', '[class*="like"]', '[class*="zan"]', '.video-like'
        ];
        
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && typeof el.click === 'function') { 
                el.click(); 
                return true; 
            }
        }
        
        // 兜底策略：模糊文本匹配精准遍历
        const actionableElements = document.querySelectorAll('button, [role="button"], span, div');
        for (const el of actionableElements) {
            const text = el.textContent?.trim() || '';
            if (/^赞$|^点赞$|^like$/i.test(text) && el.offsetParent !== null) {
                el.click();
                return true;
            }
        }
        return false;
    }

    function adjustVideoTime(seconds) {
        const videos = document.querySelectorAll('video');
        if (videos.length === 0) return false;
        
        let activeVideo = null;
        // 权重优先：正在播放的视频 > 视图内可视面积最大的视频
        for (const vid of videos) {
            if (!vid.paused) { activeVideo = vid; break; }
            if (!activeVideo || vid.offsetWidth > activeVideo.offsetWidth) {
                activeVideo = vid;
            }
        }

        if (activeVideo) {
            activeVideo.currentTime = Math.max(0, Math.min(activeVideo.duration, activeVideo.currentTime + seconds));
            return true;
        }
        return false;
    }

    // 触发屏幕中心动态视觉反馈栏
    function triggerFeedback(message) {
        feedbackBanner.innerText = message;
        feedbackBanner.classList.add('show');
        setTimeout(() => feedbackBanner.classList.remove('show'), 1500);
    }

    function updateStatus(msg) {
        statusToast.innerText = msg;
    }

    // ==========================================
    // 动作分发调度器 (核心节流阀机制)
    // ==========================================
    function executeAction(gesture) {
        const now = Date.now();

        // 持续滚动行为管理：要求连续400ms锁定手势方可产生平滑位移，防止快速划过误滚动
        if (gesture === "PALM_UP" || gesture === "PALM_DOWN") {
            if (activeGesture !== gesture) {
                activeGesture = gesture;
                gestureStartTime = now;
            } else if (now - gestureStartTime > 400) {
                updateStatus(gesture === "PALM_UP" ? "⬆️ 持续往上滚动" : "⬇️ 持续往下滚动");
                window.scrollBy({ 
                    top: gesture === "PALM_UP" ? -SCROLL_SPEED : SCROLL_SPEED, 
                    left: 0, 
                    behavior: 'instant' 
                });
            }
            return;
        }

        // 打断非持续滚动的计时链
        activeGesture = null;

        // 离散触发动作池：使用严格的时间戳差异实现防抖与降频
        switch (gesture) {
            case "THUMBS_UP":
                if (now > cooldowns.LIKE) {
                    cooldowns.LIKE = now + 2500; // 2.5秒高频隔离
                    const success = triggerPageLike();
                    triggerFeedback(success ? "👍 点赞操作成功！" : "❓ 未捕捉到点赞组件");
                }
                break;

            case "V_SIGN":
                if (now > cooldowns.REFRESH) {
                    cooldowns.REFRESH = now + 5000; // 5秒高频隔离
                    triggerFeedback("🔄 正在执行页面刷新...");
                    setTimeout(() => location.reload(), 800);
                }
                break;

            case "POINT_RIGHT":
                if (now > cooldowns.VIDEO_SEEK) {
                    cooldowns.VIDEO_SEEK = now + 1200; // 1.2秒步进间隔
                    const targeted = adjustVideoTime(5);
                    triggerFeedback(targeted ? "⏩ 快进 5 秒" : "🎬 视图未检测到活跃视频");
                }
                break;

            case "POINT_LEFT":
                if (now > cooldowns.VIDEO_SEEK) {
                    cooldowns.VIDEO_SEEK = now + 1200;
                    const targeted = adjustVideoTime(-5);
                    triggerFeedback(targeted ? "⏪ 快退 5 秒" : "🎬 视图未检测到活跃视频");
                }
                break;

            default:
                updateStatus("实时捕获中... 等待手势输入");
                break;
        }
    }

    // ==========================================
    // 图像帧采样回调运算
    // ==========================================
    function onResults(results) {
        if (!isActive) return;

        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
        
        let detectedGesture = "NONE";

        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            for (const landmarks of results.multiHandLandmarks) {
                // 渲染手部连线拓扑图
                window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, {color: 'rgba(255,255,255,0.2)', lineWidth: 2});
                window.drawLandmarks(canvasCtx, landmarks, {color: '#00f2ff', lineWidth: 1, radius: 2.5});
                
                detectedGesture = recognizeGesture(landmarks);
            }
        }
        
        canvasCtx.restore();
        executeAction(detectedGesture);
    }

    // ==========================================
    // 系统核心生命周期管理器
    // ==========================================
    async function startSystem() {
        try {
            toggleBtn.innerText = "模块注入中...";
            toggleBtn.style.pointerEvents = "none";

            // 动态安全加载 MediaPipe 管道依赖
            if (!window.Hands) {
                updateStatus("网络侧下载依赖资源中...");
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
                    minDetectionConfidence: 0.75,
                    minTrackingConfidence: 0.75
                });
                hands.onResults(onResults);

                camera = new window.Camera(videoElement, {
                    onFrame: async () => { if(isActive) await hands.send({image: videoElement}); },
                    width: 320,
                    height: 240
                });
            }
            
            toggleBtn.innerText = "请求硬件摄像头权限...";
            await camera.start(); 
            
            isActive = true;
            debugWindow.style.display = 'block';
            toggleBtn.innerText = "关闭增强手势控制";
            toggleBtn.classList.add('active');
            toggleBtn.style.pointerEvents = "auto";
            updateStatus("手势引擎就绪");

        } catch (error) {
            console.error("手势控制插件运行时引发异常:", error);
            toggleBtn.innerText = "加载失败 (查看控制台异常)";
            toggleBtn.style.backgroundColor = "#ef4444";
            toggleBtn.style.pointerEvents = "auto";
            isActive = false;
        }
    }

    function stopSystem() {
        isActive = false;
        debugWindow.style.display = 'none';
        toggleBtn.innerText = "开启增强手势控制";
        toggleBtn.classList.remove('active');
        toggleBtn.style.backgroundColor = ""; 
        if (camera) camera.stop();
        activeGesture = null;
    }

    toggleBtn.addEventListener('click', () => {
        if (isActive) stopSystem();
        else startSystem();
    });
}

// 确保DOM生命周期加载完毕后唤醒
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGestureControl);
} else {
    initGestureControl();
}
