// eye.js - 简易 WebGazer.js 集成示例
console.log('eye module loaded');
let webgazerLoaded = false;
async function initEye() {
  if (!webgazerLoaded) {
    await loadScript('https://webgazer.cs.brown.edu/webgazer.js');
    webgazerLoaded = true;
  }
  if (!window.webgazer) { console.warn('webgazer not available'); return; }
  webgazer.setRegression('ridge')
    .setGazeListener(function(data, elapsedTime) {
      if (data == null) return;
      const ev = new CustomEvent('gaze', {detail: {x: data.x, y: data.y, elapsedTime}});
      window.dispatchEvent(ev);
    }).begin();

  // optional: hide prediction points UI
  try { webgazer.showVideo(false); webgazer.showPredictionPoints(false); } catch(e){}
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
  });
}

window.initEye = initEye;
