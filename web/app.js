"use strict";
const $ = selector => document.querySelector(selector);
const main = $("#main"), dialog = $("#dialog"), pop = $("#popover");
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const pattern = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;
let doc = null, review = [], marksBySentence = new Map(), generation = 0;
let changing = false, activeWord = null, toastTimer;
const empty = (title, description) => `<div class="empty"><h3>${title}</h3><p class="quiet">${description}</p></div>`;
const hint = "词典暂未收录，可手动填写释义。";
function notify(message) {
  const toast = $("#toast");
  toast.textContent = message; toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 3300);
}
async function api(path, body, binary = false) {
  const options = body === undefined ? {} : {method:"POST", headers:{"X-Notebook":"1","Content-Type":binary ? "application/octet-stream" : "application/json"}, body:binary ? body : JSON.stringify(body)};
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败，请重试。");
  return data;
}
function showDialog(title, body, foot = "") {
  dialog.innerHTML = `<div class="dialoghead"><h2>${esc(title)}</h2><button class="minor" data-action="close" aria-label="关闭窗口">✕</button></div><div class="dialogbody">${body}<p class="err" id="dialog-error" role="alert"></p></div>${foot ? `<div class="dialogfoot">${foot}</div>` : ""}`;
  if (!dialog.open) dialog.showModal();
}
function indexMarks() {
  marksBySentence = new Map();
  for (const m of doc.marks) {
    if (!marksBySentence.has(m.sentence)) marksBySentence.set(m.sentence, []);
    marksBySentence.get(m.sentence).push(m);
  }
}
function words(text, marks, interactive = false) {
  const byToken = new Set(marks.map(m => m.token));
  let html = "", end = 0, token = 0;
  for (const match of text.matchAll(pattern)) {
    html += esc(text.slice(end, match.index));
    const marked = byToken.has(token), tag = marked ? "mark" : "span";
    const attrs = interactive ? ` class="word${marked ? " marked" : ""}" data-token="${token}"${marked ? ' tabindex="0" role="button"' : ""}` : "";
    html += `<${tag}${attrs}>${esc(match[0])}</${tag}>`;
    end = match.index + match[0].length; token++;
  }
  return html + esc(text.slice(end));
}
function sentenceHtml(s) {
  return `<span class="sentence" id="s-${s.id}" data-sentence="${s.id}">${words(s.text, marksBySentence.get(s.id) || [], true)}</span>`;
}
function library(items) {
  main.innerHTML = `<section class="hero"><div><h1>我的阅读书桌</h1><p>从一篇英语阅读开始，把遇到的生词留在原句里。</p><button class="primary" data-action="import">＋ 导入阅读材料</button></div><div class="books" aria-hidden="true"><b></b><b></b><b></b><b></b></div></section>
  <div class="sectionhead"><h2>阅读材料</h2><span class="quiet">共 ${items.length} 篇</span></div>
  ${items.length ? '<div class="list">' + items.map(a => `<a class="article-row" href="#article/${a.id}"><span class="filetype">${esc(a.kind.toUpperCase())}</span><div><strong>${esc(a.title)}</strong><div class="meta">${esc(a.updated.slice(0,10))} 更新 · ${a.count} 处标记</div></div><span class="state">${a.state === "draft" ? "学习中" : "已提交"}</span><span class="arrow">→</span></a>`).join("") + "</div>" : empty("书桌上还没有文章","导入 TXT 或可复制文字的 PDF，即可开始阅读。")}`;
}
function reader() {
  const groups = new Map();
  for (const s of doc.sentences) {
    if (!groups.has(s.para)) groups.set(s.para, []);
    groups.get(s.para).push(sentenceHtml(s));
  }
  main.innerHTML = `<a class="back" href="#library">← 我的书桌</a><div class="reader-head"><div><h1>${esc(doc.title)}</h1><p class="meta">${esc(doc.kind.toUpperCase())}　/　${doc.state === "draft" ? "阅读草稿" : "已提交的文章笔记"}</p></div></div><div class="reader"><article class="sheet prose" aria-label="文章正文">${[...groups.values()].map(g => "<p>" + g.join(" ") + "</p>").join("")}</article><aside class="panel" id="notes"></aside></div>`;
  sidebar();
}
function sidebar() {
  const draft = doc.state === "draft";
  $("#notes").innerHTML = `<div class="row"><h2>${draft ? "划词笔记" : "文章笔记"}</h2><span class="state">${doc.marks.length} 处</span></div><p class="quiet">${draft ? "选中或双击英文单词查看释义。划词自动保存，可在提交前移除。" : "点击高亮单词，查看学习时保存的释义。"}</p><div class="sidewords">${doc.marks.map(m => `<button class="sideword" data-action="locate" data-sid="${m.sentence}" data-tok="${m.token}"><strong>${esc(m.word)}</strong><small>${esc(m.meaning || hint)}</small></button>`).join("")}</div>${draft ? '<button class="primary" data-action="preview">提交学习笔记</button>' : '<button class="primary" data-action="review">查看原句复习</button>'}`;
}
function reviewCard(s, list, preview = false) {
  return `<section class="reviewcard"><p class="example">${words(s.text, list)}</p><div class="defs">${list.map(m => `<div class="def"><strong>${esc(m.word)}</strong><span class="meaning">${esc(m.meaning || "暂未填写释义")}</span>${preview ? `<button class="link" data-action="drop" data-sid="${s.id}" data-tok="${m.token}">移除</button>` : ""}</div>`).join("")}</div>${preview ? "" : `<div class="cardfoot"><span>${esc(s.title)}</span><a href="#article/${s.article}/${s.id}">回到原文 ↗</a></div>`}</section>`;
}
function reviewPage(initial) {
  const articles = new Map(review.map(s => [s.article,s.title]));
  const filter = articles.has(initial) ? initial : 0;
  const filtered = review.filter(s => !filter || s.article === filter);
  main.innerHTML = `<div class="reviewhead"><div><h1>原句复习</h1><p class="quiet">${filtered.length} 个原句 · ${filtered.reduce((n,s) => n + s.marks.length, 0)} 处生词标记</p></div>${articles.size ? `<select aria-label="筛选文章来源" id="filter"><option value="0">全部文章</option>${[...articles].map(([id,title]) => `<option value="${id}" ${id === filter ? "selected" : ""}>${esc(title)}</option>`).join("")}</select>` : ""}</div>${filtered.length ? '<div class="cards">' + filtered.map(s => reviewCard(s,s.marks)).join("") + '</div>' : empty("还没有可复习的原句","在文章里划词并提交学习笔记后，带高亮的原句会出现在这里。")}`;
}
function closePop() { pop.hidden = true; activeWord = null; }
function tokenNode(sid, tok) { return $(`#s-${sid} [data-token="${tok}"]`); }
function displayWord(sid, tok) {
  const m = (marksBySentence.get(sid) || []).find(x => x.token === tok);
  const anchor = tokenNode(sid, tok);
  if (!m || !anchor) return;
  activeWord = {sid, tok};
  pop.innerHTML = `<div class="row"><strong>${esc(m.word)}</strong><button class="minor" data-action="hide" aria-label="收起释义">✕</button></div><div class="meta">${m.phonetic ? "/" + esc(m.phonetic) + "/ " : ""}${m.lemma.toLowerCase() !== m.word.toLowerCase() ? "原形 " + esc(m.lemma) : ""}</div><div class="definition">${esc(m.meaning || hint)}</div>${doc.state === "draft" ? '<div class="popactions"><button class="link" data-action="edit">编辑释义</button><button class="minor" data-action="remove">移除标记</button></div>' : ""}`;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(10, Math.min(r.left, innerWidth-pop.offsetWidth-10)) + "px";
  const below = r.bottom+8;
  pop.style.top = Math.max(8, below+pop.offsetHeight < innerHeight-8 ? below : r.top-pop.offsetHeight-8) + "px";
}
async function mutate(action, fields = {}) {
  if (changing || !doc) return false;
  changing = true;
  const current = doc;
  try {
    const data = await api(`/api/articles/${current.id}/${action}`, {version:current.version, ...fields});
    if (current !== doc) return false;
    current.version = data.version; current.marks = data.marks;
    indexMarks();
    if (fields.sentence) {
      const s = current.sentences.find(s => s.id === fields.sentence);
      const node = $("#s-" + s.id);
      if (node) node.outerHTML = sentenceHtml(s);
    }
    sidebar();
    return true;
  } finally { changing = false; }
}
async function choose(sid, tok) {
  if (!doc || changing) return;
  if (!(marksBySentence.get(sid) || []).some(m => m.token === tok)) {
    if (doc.state !== "draft") return;
    if (!await mutate("mark", {sentence:sid, token:tok})) return;
  }
  displayWord(sid, tok);
}
function preview() {
  closePop();
  const marked = doc.sentences.filter(s => marksBySentence.has(s.id));
  showDialog("提交学习笔记", `<p class="quiet">共 ${marked.length} 个原句，${doc.marks.length} 处标记。确认后将保存到文章笔记和原句复习。</p><div class="cards">${marked.map(s => reviewCard(s,marksBySentence.get(s.id),true)).join("")}</div>`,
    '<button class="soft" data-action="close">继续阅读</button><button class="primary" data-action="submit">确认提交</button>');
}
async function route() {
  const ticket = ++generation;
  doc = null; closePop(); if (dialog.open) dialog.close();
  const parts = location.hash.slice(1).split("/");
  const inReview = parts[0] === "review";
  $("#nav-library").classList.toggle("active", !inReview);
  $("#nav-review").classList.toggle("active", inReview);
  try {
    if (parts[0] === "article" && /^\d+$/.test(parts[1])) {
      const loaded = await api("/api/articles/" + parts[1]);
      if (ticket !== generation) return;
      doc = loaded; indexMarks(); reader();
      const target = /^\d+$/.test(parts[2]) && $("#s-"+parts[2]);
      if (target) { target.classList.add("focus-sentence"); target.scrollIntoView({block:"center"}); }
      else window.scrollTo(0, Number(localStorage.getItem("position-"+doc.id)) || 0);
    } else if (inReview) {
      const data = await api("/api/review");
      if (ticket !== generation) return;
      review = data; reviewPage(Number(parts[1])); window.scrollTo(0,0);
    } else {
      const data = await api("/api/articles");
      if (ticket !== generation) return;
      library(data); window.scrollTo(0,0);
    }
  } catch (e) {
    if (ticket === generation) main.innerHTML = empty("暂时无法打开",esc(e.message)) + '<button class="soft" data-action="reload">重新加载</button>';
  }
}
async function importFile(file) {
  const kind = file.name.split(".").pop().toLowerCase();
  if (!["txt","pdf"].includes(kind) || !file.size || file.size > 20*1024*1024) throw new Error("请选择 20 MB 以内的非空 TXT 或 PDF 文件。");
  const id = ++importFile.sequence;
  showDialog("导入阅读材料", '<p class="quiet">正在提取正文…</p>');
  const data = await api("/api/extract/" + kind, file, true);
  if (!dialog.open || id !== importFile.sequence) return;
  showDialog("检查阅读材料", `<p class="quiet">请确认段落和阅读顺序。可以在开始前直接修正正文。</p><label for="title">文章标题</label><input type="text" maxlength="300" id="title" value="${esc(file.name.replace(/\.[^.]+$/,""))}"><label for="text">正文</label><textarea rows="12" id="text" maxlength="1000000">${esc(data.text)}</textarea>`, `<button class="soft" data-action="close">取消</button><button class="primary" data-action="create" data-kind="${kind}">开始阅读</button>`);
}
importFile.sequence = 0;
function report(e) {
  if (dialog.open && $("#dialog-error")) $("#dialog-error").textContent = e.message;
  else notify(e.message);
}
$("#file").addEventListener("change", e => {
  const file = e.target.files[0]; e.target.value = "";
  if (file) importFile(file).catch(report);
});
document.addEventListener("pointerdown", e => { if (!pop.contains(e.target)) closePop(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closePop();
  if (["Enter"," "].includes(e.key) && e.target.matches(".word.marked")) {
    e.preventDefault(); displayWord(Number(e.target.closest(".sentence").dataset.sentence),Number(e.target.dataset.token));
  }
});
function selectedWord() {
  const selection = getSelection();
  if (!selection.rangeCount || selection.isCollapsed || !doc || dialog.open) return;
  const range = selection.getRangeAt(0);
  const parent = node => node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const sentence = parent(range.startContainer).closest(".sentence");
  if (!sentence || !sentence.contains(range.endContainer)) return;
  const selected = selection.toString();
  const word = selected.trim();
  if (!/^[A-Za-z]+(?:['’\-][A-Za-z]+)*$/.test(word)) return;
  const prefix = document.createRange();
  prefix.selectNodeContents(sentence);
  prefix.setEnd(range.startContainer, range.startOffset);
  const offset = prefix.toString().length + selected.indexOf(word);
  const tokens = [...sentence.textContent.matchAll(pattern)];
  const tok = tokens.findIndex(m => m.index === offset && m[0] === word);
  if (tok < 0) return;
  selection.removeAllRanges();
  choose(Number(sentence.dataset.sentence),tok).catch(report);
}
main.addEventListener("mouseup", selectedWord);
main.addEventListener("keyup", e => { if (e.key === "Shift") selectedWord(); });
document.addEventListener("dblclick", e => {
  const word = e.target.closest(".prose .word");
  if (word) { getSelection().removeAllRanges(); choose(Number(word.closest(".sentence").dataset.sentence),Number(word.dataset.token)).catch(report); }
});
window.addEventListener("scroll", () => {
  if (doc) localStorage.setItem("position-"+doc.id, String(scrollY));
  closePop();
}, {passive:true});
window.addEventListener("resize", closePop);
document.addEventListener("change", e => {
  if (e.target.id === "filter") location.hash = e.target.value === "0" ? "review" : "review/"+e.target.value;
});
document.addEventListener("click", async e => {
  const btn = e.target.closest("[data-action]");
  const marked = e.target.closest(".prose mark");
  if (!btn) {
    if (marked) displayWord(Number(marked.closest(".sentence").dataset.sentence),Number(marked.dataset.token));
    return;
  }
  const sid = Number(btn.dataset.sid), tok = Number(btn.dataset.tok);
  try {
    switch (btn.dataset.action) {
      case "reload": return route();
      case "import": return $("#file").click();
      case "close": return dialog.close();
      case "hide": return closePop();
      case "create": {
        btn.disabled = true;
        const a = await api("/api/articles",{title:$("#title").value,text:$("#text").value,kind:btn.dataset.kind});
        dialog.close(); location.hash = "article/" + a.id; break;
      }
      case "preview": return preview();
      case "drop":
        if (await mutate("remove",{sentence:sid,token:tok})) preview();
        break;
      case "submit":
        btn.disabled = true;
        if (await mutate("submit")) { dialog.close(); await route(); notify("学习笔记已提交"); }
        break;
      case "review": location.hash = "review/"+doc.id; break;
      case "locate":
        tokenNode(sid,tok).scrollIntoView({block:"center"});
        requestAnimationFrame(() => requestAnimationFrame(() => displayWord(sid,tok)));
        break;
      case "remove": {
        const {sid,tok} = activeWord;
        if (await mutate("remove",{sentence:sid,token:tok})) closePop();
        break;
      }
      case "edit": {
        const {sid,tok} = activeWord;
        const m = marksBySentence.get(sid).find(m => m.token === tok);
        closePop();
        showDialog("编辑释义", `<label for="meaning">${esc(m.word)}</label><textarea id="meaning" rows="6" maxlength="8000">${esc(m.meaning)}</textarea>`, `<button class="soft" data-action="close">取消</button><button class="primary" data-action="save" data-sid="${sid}" data-tok="${tok}">保存释义</button>`);
        break;
      }
      case "save":
        if (await mutate("edit",{sentence:sid,token:tok,meaning:$("#meaning").value})) { dialog.close(); displayWord(sid,tok); }
        break;
    }
  } catch (error) { report(error); } finally { btn.disabled = false; }
});
dialog.addEventListener("close", () => { if (!dialog.open) { importFile.sequence++; dialog.replaceChildren(); } });
window.addEventListener("hashchange", route);
route();
