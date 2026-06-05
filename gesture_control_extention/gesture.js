// 1. 动态注入 UI 到当前网页
const uiHTML = `
    <div id="gesture-ext-pointer"></div>
    <div id="gesture-ext-zone-up" class="gesture-ext-zone"><span>向上滑动</span><div class="gesture-ext-progress"></div></div>
    <div id="gesture-ext-zone-down" class="gesture-ext-zone"><span>向下滑动</span><div class="gesture-ext-progress"></div></div>
    <div id="gesture-ext-preview"><video id="gesture-ext-video" autoplay playsinline></video></div>
    <canvas id="gesture-ext-buffer"></canvas>
    <button id="gesture-ext-toggle">开启手势控制</button>
`;
const wrapper = document.createElement('div');
wrapper.innerHTML = uiHTML;
document.body.appendChild(wrapper);

// 2. 核心逻辑提取
const video = document.getElementById('gesture-ext-video');
const buffer = document.getElementById('gesture-ext-buffer');
const bctx = buffer.getContext('2d', { willReadFrequently: true });
const pointer = document.getElementById('gesture-ext-pointer');
const zones = { 
    up: document.getElementById('gesture-ext-zone-up'), 
    down: document.getElementById('gesture-ext-zone-down') 
};
const toggleBtn = document.getElementById('gesture-ext-toggle');

let isVisionActive = false;
let prevFrame = null;
let currentXY = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let targetXY = { x: 0, y: 0 };
let hoverTime = { up: 0, down: 0 };
let rafId = null;

// 绑定按钮事件
toggleBtn.addEventListener('click', toggleVision);

async function toggleVision() {
    isVisionActive = !isVisionActive;
    toggleBtn.classList.toggle('active');
    toggleBtn.innerText = isVisionActive ? "手势模式: 已开启" : "开启手势控制";

    const display = isVisionActive ? 'flex' : 'none';
    zones.up.style.display = display;
    zones.down.style.display = display;
    pointer.style.display = isVisionActive ? 'block' : 'none';
    document.getElementById('gesture-ext-preview').style.display = isVisionActive ? 'block' : 'none';

    if (isVisionActive) {
        try {
            if (!video.srcObject) {
                // 请求摄像头权限
                const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
                video.srcObject = stream;
            }
            runVision();
        } catch (err) {
            alert("需要摄像头权限才能使用手势控制: " + err.message);
            toggleVision(); // 回退状态
        }
    } else {
        cancelAnimationFrame(rafId);
    }
}

function runVision() {
    if (!isVisionActive) return;

    buffer.width = 160; buffer.height = 120;
    bctx.save();
    bctx.scale(-1, 1);
    bctx.drawImage(video, -160, 0, 160, 120);
    bctx.restore();

    const frame = bctx.getImageData(0, 0, 160, 120);
    if (prevFrame) {
        let sumX = 0, sumY = 0, count = 0;
        for (let i = 0; i < frame.data.length; i += 4) {
            const diff = Math.abs(frame.data[i] - prevFrame.data[i]);
            if (diff > 45) { // 运动阈值
                sumX += (i / 4) % 160;
                sumY += Math.floor((i / 4) / 160);
                count++;
            }
        }
        if (count > 40) {
            targetXY.x = (sumX / count) * (window.innerWidth / 160);
            targetXY.y = (sumY / count) * (window.innerHeight / 120);
        }
    }
    prevFrame = frame;

    // 平滑移动粉色触点
    currentXY.x += (targetXY.x - currentXY.x) * 0.15;
    currentXY.y += (targetXY.y - currentXY.y) * 0.15;
    pointer.style.left = `${currentXY.x}px`;
    pointer.style.top = `${currentXY.y}px`;

    checkZones();
    rafId = requestAnimationFrame(runVision);
}

function checkZones() {
    ['up', 'down'].forEach(key => {
        const rect = zones[key].getBoundingClientRect();
        const bar = zones[key].querySelector('.gesture-ext-progress');
        
        if (currentXY.x > rect.left && currentXY.x < rect.right &&
            currentXY.y > rect.top && currentXY.y < rect.bottom) {
            
            zones[key].classList.add('active');
            hoverTime[key] += 16; 
            
            let progress = Math.min((hoverTime[key] / 600) * 100, 100);
            bar.style.width = progress + '%';

            if (hoverTime[key] > 600) { // 停留触发滚动
                window.scrollBy({ top: key === 'up' ? -25 : 25, behavior: 'instant' });
            }
        } else {
            zones[key].classList.remove('active');
            hoverTime[key] = 0;
            bar.style.width = '0%';
        }
    });
}
