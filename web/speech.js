// Shared controls for article, sentence and vocabulary playback.
const speech = window.speechSynthesis;
let speechVoices = [], speechRun = 0, speechQueue = [], speechIndex = 0;
let speechCurrent = null, speechPaused = false, speechLabel = "";
const speechBar = document.querySelector("#speech-bar");
const speechVoice = document.querySelector("#speech-voice");
const speechRate = document.querySelector("#speech-rate");
const speechStatus = document.querySelector("#speech-status");
const speechPause = document.querySelector("#speech-pause");
const speechStop = document.querySelector("#speech-stop");
const speechToggle = document.querySelector("#speech-enabled");
const speechRefresh = document.querySelector("#speech-refresh");
speechToggle.checked = localStorage.getItem("speech-enabled") !== "false";
document.body.classList.toggle("speech-off", !speechToggle.checked);

function updateSpeechControls(message) {
  speechStatus.textContent = speechToggle.checked
    ? message || (speechCurrent ? (speechPaused ? "已暂停 · " : "正在朗读 · ") + speechLabel : "选择朗读内容")
    : "朗读已关闭";
  speechVoice.disabled = !speechToggle.checked || !speechVoices.length;
  speechRate.disabled = !speechToggle.checked;
  speechRefresh.disabled = !speechToggle.checked;
  speechPause.disabled = !speechCurrent;
  speechStop.disabled = !speechCurrent;
  speechPause.textContent = speechPaused ? "继续" : "暂停";
}
function stopSpeech(message) {
  document.querySelectorAll(".speaking-sentence").forEach(node => node.classList.remove("speaking-sentence"));
  speechRun++;
  speechQueue = [];
  speechCurrent = null;
  speechPaused = false;
  speech?.cancel();
  updateSpeechControls(message);
}
function loadSpeechVoices() {
  if (!speech) {
    updateSpeechControls("当前浏览器不支持朗读，请使用 Edge 或 Chrome。");
    return;
  }
  const selected = speechVoice.value || localStorage.getItem("speech-voice");
  speechVoices = speech.getVoices().filter(voice => /^en(?:[-_]|$)/i.test(voice.lang) && voice.localService);
  speechVoice.replaceChildren(...speechVoices.map(voice => new Option(voice.name + " · " + voice.lang, voice.voiceURI)));
  speechVoice.disabled = !speechToggle.checked || !speechVoices.length;
  if (speechVoices.some(voice => voice.voiceURI === selected)) speechVoice.value = selected;
  if (!speechCurrent) updateSpeechControls(speechVoices.length ? "" : "浏览器尚未提供本机英语语音。若已安装，请完整退出浏览器（包括后台进程）后重开，再点击「刷新语音」；也可重启电脑。");
}
function speechView(visible) {
  stopSpeech();
  speechBar.hidden = !visible;
  loadSpeechVoices();
}
function playSpeechPart(run) {
  if (run !== speechRun) return;
  if (speechIndex >= speechQueue.length) {
    stopSpeech("朗读完毕");
    return;
  }
  const utterance = new SpeechSynthesisUtterance(speechQueue[speechIndex]);
  utterance.voice = speechVoices.find(voice => voice.voiceURI === speechVoice.value) || speechVoices[0];
  utterance.lang = utterance.voice.lang;
  utterance.rate = Number(speechRate.value);
  speechCurrent = utterance;
  utterance.onstart = () => {
    if (run === speechRun) updateSpeechControls();
  };
  utterance.onend = () => {
    if (run !== speechRun) return;
    speechIndex++;
    playSpeechPart(run);
  };
  utterance.onerror = event => {
    if (run === speechRun) stopSpeech("朗读失败，请重新选择语音后重试（" + event.error + "）。");
  };
  speech.speak(utterance);
  updateSpeechControls();
}
function readAloud(text, label, sentence) {
  if (!speechToggle.checked) return;
  stopSpeech();
  loadSpeechVoices();
  if (!speech || !speechVoices.length) return;
  // Short utterances also keep long imported passages within engine limits.
  speechQueue = text.trim().match(/[\s\S]{1,200}(?:\s+|$)|\S{1,200}/g) || [];
  sentence?.classList.add("speaking-sentence");
  speechIndex = 0;
  speechLabel = label;
  playSpeechPart(speechRun);
}
speechPause.addEventListener("click", () => {
  if (!speechCurrent) return;
  speechPaused = !speechPaused;
  if (speechPaused) speech.pause();
  else speech.resume();
  updateSpeechControls();
});
speechStop.addEventListener("click", () => stopSpeech("已停止"));
speechToggle.addEventListener("change", () => {
  localStorage.setItem("speech-enabled", String(speechToggle.checked));
  document.body.classList.toggle("speech-off", !speechToggle.checked);
  stopSpeech();
  loadSpeechVoices();
});
speechVoice.addEventListener("change", () => {
  localStorage.setItem("speech-voice", speechVoice.value);
  stopSpeech("语音已更新，请重新点击朗读。");
});
speechRate.addEventListener("change", () => {
  localStorage.setItem("speech-rate", speechRate.value);
  stopSpeech("语速已更新，请重新点击朗读。");
});
const savedRate = localStorage.getItem("speech-rate");
if (Array.from(speechRate.options).some(option => option.value === savedRate)) speechRate.value = savedRate;
speech?.addEventListener("voiceschanged", loadSpeechVoices);
document.querySelector("#speech-refresh").addEventListener("click", loadSpeechVoices);
window.addEventListener("focus", loadSpeechVoices);
window.addEventListener("pagehide", () => stopSpeech());
loadSpeechVoices();
