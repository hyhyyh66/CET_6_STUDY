// Edge TTS generates each selected sentence or word through the local server.
let speechVoices = [], speechRun = 0, speechVoiceRequest = 0;
let speechAudio = null, speechController = null, speechObjectUrl = null;
let speechLabel = "";
let speechRepeatTimer = null, speechRepeatCurrent = 1, speechRepeatTotal = 1;
let speechGapRemaining = 0, speechGapStarted = 0, speechGapPaused = false;
const speechRepeat = document.querySelector("#speech-repeat");
const speechRepeatCount = document.querySelector("#speech-repeat-count");
const speechRepeatGap = document.querySelector("#speech-repeat-gap");
speechRepeat.checked = localStorage.getItem("speech-repeat") === "true";
document.body.classList.toggle("repeat-off", !speechRepeat.checked);
for (const control of [speechRepeatCount, speechRepeatGap]) {
  const saved = localStorage.getItem(control.id);
  if (Array.from(control.options).some(option => option.value === saved)) control.value = saved;
}

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
  let status = "点击句子或单词开始朗读";
  if (speechController) status = "正在生成语音…";
  if (speechAudio) status = (speechAudio.paused ? "已暂停 · " : "正在朗读 · ") + speechLabel;
  if (speechAudio && speechRepeatTotal > 1) status += ` · 第 ${speechRepeatCurrent}/${speechRepeatTotal} 遍`;
  if (speechRepeatTimer !== null || speechGapPaused) {
    status = `${speechGapPaused ? "间隔已暂停" : "跟读间隔中"} · 下一遍 ${speechRepeatCurrent + 1}/${speechRepeatTotal}`;
  }
  speechRepeatCount.disabled = speechRepeatGap.disabled = !speechToggle.checked || !speechRepeat.checked;
  speechStatus.textContent = speechToggle.checked ? message || status : "朗读已关闭";
  speechVoice.disabled = !speechToggle.checked || !speechVoices.length;
  speechRate.disabled = !speechToggle.checked;
  speechRefresh.disabled = !speechToggle.checked;
  speechPause.disabled = !speechAudio;
  speechStop.disabled = !speechAudio && !speechController;
  speechPause.textContent = speechGapPaused || (speechAudio?.paused && speechRepeatTimer === null) ? "继续" : "暂停";
}
function stopSpeech(message) {
  speechRun++;
  clearTimeout(speechRepeatTimer);
  speechRepeatTimer = null;
  speechGapPaused = false;
  speechController?.abort();
  speechController = null;
  if (speechAudio) {
    speechAudio.pause();
    speechAudio.removeAttribute("src");
    speechAudio.load();
    speechAudio = null;
  }
  if (speechObjectUrl) URL.revokeObjectURL(speechObjectUrl);
  speechObjectUrl = null;
  document.querySelectorAll(".speaking-sentence").forEach(node => node.classList.remove("speaking-sentence"));
  updateSpeechControls(message);
}
async function loadSpeechVoices() {
  const request = ++speechVoiceRequest;
  try {
    const response = await fetch("/api/voices");
    if (!response.ok) throw new Error("加载语音列表失败，请重启本地服务后点击「刷新语音」。");
    const voices = await response.json();
    if (request !== speechVoiceRequest) return;
    const selected = speechVoice.value || localStorage.getItem("edge-tts-voice");
    speechVoices = voices;
    speechVoice.replaceChildren(...voices.map(voice => new Option(voice.name, voice.id)));
    if (voices.some(voice => voice.id === selected)) speechVoice.value = selected;
    updateSpeechControls();
  } catch (error) {
    if (request === speechVoiceRequest && !speechAudio && !speechController) {
      updateSpeechControls(error.message || "无法连接本地服务，请确认服务已启动。");
    }
  }
}
function speechView(visible) {
  stopSpeech();
  speechBar.hidden = !visible;
  if (visible && !speechVoices.length) loadSpeechVoices();
}
function scheduleSpeechRepeat(run) {
  speechGapStarted = performance.now();
  speechGapPaused = false;
  speechRepeatTimer = setTimeout(async () => {
    speechRepeatTimer = null;
    if (run !== speechRun || !speechAudio) return;
    speechRepeatCurrent++;
    speechAudio.currentTime = 0;
    try {
      await speechAudio.play();
      if (run === speechRun) updateSpeechControls();
    } catch (error) {
      if (run === speechRun && error.name !== "AbortError") stopSpeech("循环播放失败，请重新点击句子。");
    }
  }, speechGapRemaining);
  updateSpeechControls();
}
async function readAloud(text, label, sentence, repeatable = false) {
  if (!speechToggle.checked) return;
  stopSpeech();
  const run = speechRun;
  if (!speechVoices.length) {
    updateSpeechControls("语音列表尚未就绪，请点击「刷新语音」后重试。");
    return;
  }
  speechController = new AbortController();
  const timer = setTimeout(() => {
    if (run === speechRun) stopSpeech("生成语音超时，请检查网络后重试。");
  }, 55000);
  speechLabel = label;
  speechRepeatCurrent = 1;
  speechRepeatTotal = repeatable && speechRepeat.checked ? Number(speechRepeatCount.value) : 1;
  sentence?.classList.add("speaking-sentence");
  updateSpeechControls();
  try {
    const response = await fetch("/api/speech", {
      method:"POST",
      headers:{"X-Notebook":"1", "Content-Type":"application/json"},
      body:JSON.stringify({text, voice:speechVoice.value, rate:speechRate.value}),
      signal:speechController.signal
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "生成语音失败，请稍后重试。");
    }
    const blob = await response.blob();
    if (run !== speechRun) return;
    clearTimeout(timer);
    speechController = null;
    speechObjectUrl = URL.createObjectURL(blob);
    const player = new Audio(speechObjectUrl);
    speechAudio = player;
    player.onended = () => {
      if (run !== speechRun) return;
      if (speechRepeatCurrent >= speechRepeatTotal) {
        stopSpeech("朗读完毕");
        return;
      }
      speechGapRemaining = Number(speechRepeatGap.value) * 1000;
      scheduleSpeechRepeat(run);
    };
    player.onerror = () => { if (run === speechRun) stopSpeech("音频播放失败，请重新点击句子。"); };
    player.onplay = player.onpause = () => { if (run === speechRun) updateSpeechControls(); };
    await player.play();
    if (run === speechRun) updateSpeechControls();
  } catch (error) {
    // Pausing while play() is still starting rejects that promise normally.
    if (error.name === "AbortError") return;
    if (run === speechRun) {
      const message = error.name === "NotAllowedError"
        ? "浏览器阻止了播放，请允许此页面播放声音后重试。"
        : error.message || "无法连接语音服务，请检查网络后重试。";
      stopSpeech(message);
    }
  } finally {
    clearTimeout(timer);
  }
}
speechPause.addEventListener("click", async () => {
  if (!speechAudio) return;
  const run = speechRun;
  if (speechRepeatTimer !== null) {
    clearTimeout(speechRepeatTimer);
    speechRepeatTimer = null;
    speechGapRemaining = Math.max(0, speechGapRemaining - (performance.now() - speechGapStarted));
    speechGapPaused = true;
    updateSpeechControls();
    return;
  }
  if (speechGapPaused) {
    scheduleSpeechRepeat(run);
    return;
  }
  try {
    if (speechAudio.paused) await speechAudio.play();
    else speechAudio.pause();
    if (run === speechRun) updateSpeechControls();
  } catch (error) {
    if (run === speechRun && error.name !== "AbortError") stopSpeech("恢复播放失败，请重新点击句子。");
  }
});
speechStop.addEventListener("click", () => stopSpeech("已停止"));
speechToggle.addEventListener("change", () => {
  localStorage.setItem("speech-enabled", String(speechToggle.checked));
  document.body.classList.toggle("speech-off", !speechToggle.checked);
  stopSpeech();
});
speechVoice.addEventListener("change", () => {
  localStorage.setItem("edge-tts-voice", speechVoice.value);
  stopSpeech("语音已更新，请重新点击朗读。");
});
speechRate.addEventListener("change", () => {
  localStorage.setItem("speech-rate", speechRate.value);
  stopSpeech("语速已更新，请重新点击朗读。");
});
const savedRate = localStorage.getItem("speech-rate");
if (Array.from(speechRate.options).some(option => option.value === savedRate)) speechRate.value = savedRate;
for (const control of [speechRepeat, speechRepeatCount, speechRepeatGap]) {
  control.addEventListener("change", () => {
    localStorage.setItem(control.id, control === speechRepeat ? String(control.checked) : control.value);
    document.body.classList.toggle("repeat-off", !speechRepeat.checked);
    stopSpeech("循环设置已更新，请重新点击句子。");
  });
}
speechRefresh.addEventListener("click", loadSpeechVoices);
window.addEventListener("pagehide", () => stopSpeech());
loadSpeechVoices();
