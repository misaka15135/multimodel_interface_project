// voice.js - Web Speech API 简易实现
console.log('voice module loaded');
let recognizer = null;
function initVoice({lang='zh-CN', continuous=false} = {}) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { console.warn('SpeechRecognition not supported in this browser'); return; }
  recognizer = new SpeechRecognition();
  recognizer.lang = lang; recognizer.interimResults = false; recognizer.continuous = continuous;
  recognizer.onresult = (evt) => {
    const t = evt.results[evt.results.length-1][0];
    const ev = new CustomEvent('voice', {detail: {transcript: t.transcript, confidence: t.confidence}});
    window.dispatchEvent(ev);
  };
  recognizer.onerror = (e) => { console.warn('voice error', e); };
  recognizer.onend = () => { if (continuous) recognizer.start(); };
}
function startVoice() { if (recognizer) recognizer.start(); }
function stopVoice() { if (recognizer) recognizer.stop(); }
window.initVoice = initVoice; window.startVoice = startVoice; window.stopVoice = stopVoice;
