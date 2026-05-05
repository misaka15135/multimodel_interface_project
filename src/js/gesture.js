// gesture.js - MediaPipe Hands 简易手势实现（用于示例）
// 说明：在生产中可替换为已有手势实现。此模块检测 pinch(拇指与食指靠近) 和 swipe 手势。
console.log('gesture module loaded');

let videoElement, canvasElement, canvasCtx, camera, lastCenter = null, lastTime = 0;

function onResults(results) {
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    const landmarks = results.multiHandLandmarks[0];
    // draw landmarks (simple)
    canvasCtx.fillStyle = 'rgba(0,255,0,0.6)';
    for (const lm of landmarks) {
      const x = lm.x * canvasElement.width;
      const y = lm.y * canvasElement.height;
      canvasCtx.beginPath();
      canvasCtx.arc(x, y, 4, 0, 2 * Math.PI);
      canvasCtx.fill();
    }

    // pinch: thumb_tip (4) and index_finger_tip (8)
    const t = landmarks[4], i = landmarks[8];
    const dx = (t.x - i.x) * canvasElement.width;
    const dy = (t.y - i.y) * canvasElement.height;
    const dist = Math.hypot(dx, dy);
    if (dist < 40) {
      dispatchGesture('pinch', {distance: dist});
    }

    // centroid for swipe detection
    let cx = 0, cy = 0;
    for (const lm of landmarks) { cx += lm.x; cy += lm.y; }
    cx = (cx / landmarks.length) * canvasElement.width;
    cy = (cy / landmarks.length) * canvasElement.height;
    const now = performance.now();
    if (lastCenter) {
      const vx = cx - lastCenter.x;
      const vy = cy - lastCenter.y;
      const dt = Math.max(1, now - lastTime);
      const speed = Math.hypot(vx, vy) / dt * 1000; // px/sec
      if (speed > 800) {
        const dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'swipe-right' : 'swipe-left') : (vy > 0 ? 'swipe-down' : 'swipe-up');
        dispatchGesture('swipe', {direction: dir, speed});
      }
    }
    lastCenter = {x: cx, y: cy};
    lastTime = now;
  }
  canvasCtx.restore();
}

function dispatchGesture(type, detail = {}) {
  detail.type = type;
  const ev = new CustomEvent('gesture', {detail});
  window.dispatchEvent(ev);
}

async function initGesture(opts = {}) {
  // create video/canvas if not present
  if (!videoElement) {
    videoElement = document.createElement('video');
    videoElement.style.display = 'none';
    videoElement.setAttribute('playsinline','');
    document.body.appendChild(videoElement);
  }
  if (!canvasElement) {
    canvasElement = document.createElement('canvas');
    canvasElement.style.position = 'fixed';
    canvasElement.style.right = '10px';
    canvasElement.style.bottom = '10px';
    canvasElement.style.width = '240px';
    canvasElement.style.height = '180px';
    canvasElement.width = 640; canvasElement.height = 480;
    document.body.appendChild(canvasElement);
    canvasCtx = canvasElement.getContext('2d');
  }

  // load MediaPipe Hands
  if (typeof Hands === 'undefined' || typeof Camera === 'undefined') {
    // inject scripts
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js');
    await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
  }

  const hands = new Hands({locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
  hands.setOptions({maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5});
  hands.onResults(onResults);

  camera = new Camera(videoElement, {
    onFrame: async () => { await hands.send({image: videoElement}); },
    width: 640,
    height: 480
  });
  camera.start();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
  });
}

window.initGesture = initGesture;
