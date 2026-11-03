// 相談画面。言葉は i18n.js に置き、台帳の判断はサーバーに任せる。
import { MESSAGES, pickLanguage } from "./i18n.js";

const ORIGINS = ["checked", "heard", "guess", "unknown"];
const STORE_KEY = "daijoubu-check";
const CHECK_MARKS = ["○", "△", "×", "？"];
const $ = (id) => document.getElementById(id);

let lang = pickLanguage(location.search, navigator.language);
let t = MESSAGES[lang];
let cards = [];
let flows = [];
let session = emptySession();
let previous = {};
let sending = false;
let turnId = 0;
let checks = [];
// 買った所は番号で持ち、言語を変えても選んだものを保つ。
let bought = 0;
// 声の聞き取りはブラウザの仕組みを使う。使えないブラウザではボタンを出さない。
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;

function emptySession() {
  return { state: { statements: [], links: [] }, signature: null, comparisons: [], log: [], lastReply: "", quick: null };
}

// 保存できない環境でも相談は続ける。
function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(session));
  } catch { /* 保存なしで続ける */ }
}

function load() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY)) ?? emptySession();
  } catch {
    return emptySession();
  }
}

const seconds = (time) => time.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
const cardOf = (id) => cards.find((c) => c.id === id);
const stepOf = (ref) => flows.find((f) => f.id === ref?.flow_id)?.steps.find((s) => s.id === ref?.step_id);
// カードの題名は日本語だけなので、他の言語では共通の呼び名にする。
const recordName = (card) => (lang === "ja" ? card?.title ?? "" : t.otherBike);

function play(videoId, time) {
  const frame = document.createElement("iframe");
  frame.src = `https://www.youtube-nocookie.com/embed/${videoId}?start=${seconds(time)}&autoplay=1`;
  frame.allow = "autoplay; encrypted-media";
  frame.title = t.videoTitle;
  $("player").replaceChildren(frame);
  // 1列の幅では再生欄が会話の下にあるので、見える所まで送る。
  if (matchMedia("(max-width: 800px)").matches) $("player").scrollIntoView({ block: "start", behavior: "smooth" });
}

// 動画の場面。左に再生の印と時刻、右に言葉と車の記録。
function sceneButton(videoId, time, line, note) {
  const button = document.createElement("button");
  button.className = "scene";
  button.type = "button";
  const stamp = document.createElement("span");
  stamp.className = "t num";
  stamp.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>';
  stamp.append(time);
  const text = document.createElement("span");
  text.className = "line";
  text.textContent = line;
  const small = document.createElement("small");
  small.textContent = note;
  button.append(stamp, text, small);
  button.onclick = () => play(videoId, time);
  return button;
}

function el(tagName, className, text) {
  const node = document.createElement(tagName);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 答えの文。末尾の問いだけを太字にする。
function sayNode(text) {
  const p = el("p", "say");
  const asked = text.match(/((?:[^。？?\n]+(?:か。|[？?])\s*)+)$/);
  if (!asked || asked.index === 0) {
    p.textContent = text;
    return p;
  }
  p.append(text.slice(0, asked.index).trimEnd(), el("span", "ask", asked[1].trim()));
  return p;
}

// 相談の節の見出し。言い直しが起きた往復（札が移った、または文が変わった）は「言い直し」と出す。
function stepNode(index, count) {
  let redo = false;
  for (let i = index + 1; i < session.log.length && session.log[i].kind !== "you"; i += 1) {
    const entry = session.log[i];
    if (entry.kind === "tags" && entry.tags.some((tag) => (tag.from && tag.from !== tag.origin) || tag.old)) redo = true;
  }
  const step = el("p", "step");
  step.append(el("span", "num", String(count).padStart(2, "0")), redo ? t.redo : t.consult);
  return step;
}

function tagNode(tag) {
  const moved = tag.from && tag.from !== tag.origin;
  const item = el("span", `tag ${tag.origin}${moved ? ` from-${tag.from} swap` : ""}`);
  const label = document.createElement("b");
  if (moved) {
    label.append(t[tag.from], el("span", "arrow", "→"), t[tag.origin]);
  } else {
    label.textContent = tag.old ? `${t[tag.origin]}・${t.corrected}` : t[tag.origin];
  }
  if (tag.old) {
    item.append(label, el("s", "", tag.old), tag.text);
  } else {
    item.append(label, tag.text);
  }
  // 移った札は、前の色の札を上に重ねて剥がして見せる。
  if (moved) {
    const was = el("span", "was");
    was.setAttribute("aria-hidden", "true");
    was.append(el("b", "", t[tag.from]), tag.old ?? tag.text);
    item.append(was);
  }
  return item;
}

// 作業票（紙）の中に足す。出所の行があれば、その前に入れる。
function addToPaper(paper, node) {
  paper.insertBefore(node, paper.querySelector(".source"));
}

// view は組み立て中の作業票と、外した知らせ、相談の通し番号を持つ。
function renderEntry(entry, index, view) {
  if (entry.kind === "you") {
    view.paper = null;
    view.count += 1;
    $("log").append(stepNode(index, view.count), el("p", "you", entry.text));
    return;
  }
  if (entry.kind === "tags") {
    view.paper = null;
    // 動く（出てくる・剥がれる）のは、答えを受けた直後の最新の札だけ。描き直しでは動かさない。
    const list = el("div", view.fresh && index > view.lastYou ? "tags" : "tags settled");
    list.append(...entry.tags.map(tagNode));
    $("log").append(list);
    return;
  }
  // 外した知らせは、次の作業票の先頭に入れる。
  if (entry.kind === "move") {
    view.moves.push(entry.text);
    return;
  }
  if (entry.kind === "me") {
    const paper = el("div", "me");
    paper.append(...view.moves.map((text) => el("p", "move", text)));
    view.moves = [];
    paper.append(sayNode(entry.text));
    $("log").append(paper);
    view.paper = paper;
    return;
  }
  if (entry.kind === "source") {
    const source = el("p", "source", entry.text);
    if (view.paper) view.paper.append(source);
    else $("log").append(source);
    return;
  }
  if (entry.kind === "cite") {
    const card = cardOf(entry.card_id);
    const scene = card?.scenes.find((s) => s.id === entry.scene_id);
    if (!scene) return;
    const line = entry.gloss || scene.line;
    const note = entry.gloss ? `${t.otherBike} / ${t.original}: ${scene.line}` : `${t.otherBike}${lang === "ja" ? "：" : ": "}${card.vehicle}`;
    const button = sceneButton(card.video_id, scene.t, line, note);
    // 言い直しで支えを失った比較の場面は、取り下げたと見せる。
    const links = session.comparisons.filter((c) => c.card_id === entry.card_id);
    if (links.length > 0 && links.every((c) => c.status === "released")) button.classList.add("off");
    if (!view.paper) {
      $("log").append(button);
      return;
    }
    if (!view.paper.querySelector(".ev")) addToPaper(view.paper, el("p", "ev", t.evidence));
    addToPaper(view.paper, button);
    return;
  }
  $("log").append(el("p", entry.kind, entry.text));
}

function renderLog(fresh = false) {
  $("log").replaceChildren();
  const view = { paper: null, moves: [], count: 0, fresh, lastYou: session.log.findLastIndex((entry) => entry.kind === "you") };
  session.log.forEach((entry, index) => renderEntry(entry, index, view));
  $("topics").hidden = session.log.length > 0;
  $("examples").hidden = session.log.length > 0;
  $("log").lastElementChild?.scrollIntoView({ block: "nearest" });
}

// 難しい言葉は、この欄の中で最初の1回だけ「語（説明）」にする。「」の中は動画の言葉なので触らない。
// カタカナ語の途中には当てない（アクセルの「セル」など）。
function explain(texts) {
  const glossary = t.glossary ?? {};
  const terms = Object.keys(glossary).sort((a, b) => b.length - a.length);
  if (terms.length === 0) return texts;
  const words = terms.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`「[^」]*」|(?<![ァ-ヶー])(?:${words})(?![ァ-ヶー])`, "g");
  const used = new Set();
  return texts.map((text) => text.replace(pattern, (word) => {
    if (word.startsWith("「") || used.has(word)) return word;
    used.add(word);
    return `${word}（${glossary[word]}）`;
  }));
}

// 流れの本文は日本語だけなので、他の言語では返答の質問に任せる。
function renderNext() {
  const step = stepOf(session.step);
  $("next").hidden = !step || lang !== "ja";
  if (!step) return;
  const [how, limit] = explain([step.how, step.cannot_tell]);
  $("next-how").textContent = how;
  $("next-source").textContent = step.source === "owner" ? t.sourceOwner : t.sourceVideo;
  $("next-needs").textContent = `${t.needs}：${step.needs}`;
  $("next-limit").textContent = limit;
}

function renderLedger() {
  const root = $("ledger");
  root.replaceChildren();
  const { statements } = session.state;
  if (statements.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = t.ledgerEmpty;
    root.append(empty);
  }
  for (const origin of ORIGINS) {
    const rows = statements.filter((s) => s.origin === origin);
    if (rows.length === 0) continue;
    const group = document.createElement("div");
    group.className = `group ${origin}`;
    const title = document.createElement("h3");
    title.textContent = t[origin];
    group.append(title);
    for (const statement of rows) {
      const row = document.createElement("div");
      row.className = "row";
      if (previous[statement.id] && previous[statement.id] !== origin) row.classList.add("moved");
      row.textContent = statement.text;
      for (const link of session.comparisons.filter((c) => c.statement_id === statement.id)) {
        const note = document.createElement("small");
        const released = link.status === "released";
        note.textContent = recordName(cardOf(link.card_id)) + (released ? t.notComparing : t.comparing);
        if (released) note.className = "off";
        row.append(note);
      }
      group.append(row);
    }
    root.append(group);
  }
  previous = Object.fromEntries(statements.map((s) => [s.id, s.origin]));
}

// 今も比べている記録の作業場面だけを出す。動画の中の注意はそのまま添え、足さない。
function renderRepair() {
  const active = [...new Set(session.comparisons.filter((c) => c.status === "active").map((c) => c.card_id))];
  const list = $("repair-list");
  list.replaceChildren();
  for (const card of active.map(cardOf).filter((c) => c?.repair)) {
    list.append(sceneButton(card.video_id, card.repair.t, t.workScene || card.repair.line, recordName(card)));
    if (card.repair.warning) {
      const warning = document.createElement("p");
      warning.className = "hint";
      warning.textContent = `${t.ownerWords}（${card.repair.warning.t}）：${card.repair.warning.line}`;
      list.append(warning);
    }
  }
  $("repair").hidden = list.childElementCount === 0;
}

function chip(text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = text;
  button.onclick = onClick;
  return button;
}

// 最初は話題と例を出す。止まった時は、今答えられる相談を出して行き止まりにしない。
// 答えの多くは車種で変わるので、最初に種類を選んでもらう。分からないも選べる。
function renderBike() {
  const fresh = session.log.length === 0;
  // 説明は最初の画面にだけ出す。
  $("lead-block").hidden = !fresh;
  $("bike").hidden = !fresh || session.bike !== undefined;
  $("bike-list").replaceChildren(...t.bikes.map((text, index) => chip(text, () => {
    session.bike = index;
    save();
    renderAll();
  })));
  $("bike-chosen").hidden = session.bike === undefined;
  if (session.bike !== undefined) $("bike-chosen").textContent = `${t.bikeLabel}：${t.bikes[session.bike]}`;
  $("topics").hidden = !fresh || session.bike === undefined;
  $("check").hidden = session.bike === undefined && fresh;
}

function renderChips() {
  $("topics").replaceChildren(...t.topics.map((text) => chip(text, () => send(text))));
  // 最初は話題だけを出す。例文は入力欄の見本に任せる。
  $("examples").replaceChildren();
  const quick = session.quick === "topics" ? t.topics : session.quick === "unsure" ? [t.unsure] : [];
  $("quick").replaceChildren(...quick.map((text) => chip(text, () => send(text))));
}

// 点検の答えは画面だけで持ち、相談する時に普段の発言と同じ形で送る。
function renderCheck() {
  const list = $("check-list");
  list.replaceChildren();
  t.checkItems.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "check-row";
    const name = document.createElement("span");
    name.textContent = item;
    row.append(name);
    for (const mark of CHECK_MARKS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = mark;
      const meaning = t.marks[CHECK_MARKS.indexOf(mark)];
      button.title = meaning;
      button.setAttribute("aria-label", `${item} ${meaning}`);
      button.setAttribute("aria-pressed", String(checks[index] === mark));
      // 押した行だけ更新する。作り直すとキーボードの焦点が外れて次の項目へ進めない。
      button.onclick = () => {
        checks[index] = checks[index] === mark ? undefined : mark;
        row.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === checks[index])));
        $("check-send").disabled = !checks.some(Boolean);
      };
      row.append(button);
    }
    list.append(row);
  });
  $("check-send").disabled = !checks.some(Boolean);
}

function renderTexts() {
  document.documentElement.lang = lang;
  document.title = t.title;
  document.querySelectorAll("[data-t]").forEach((node) => { node.textContent = t[node.dataset.t]; });
  $("input").placeholder = t.placeholder;
  setSend(sending ? t.sending : t.send);
  $("mic").setAttribute("aria-label", listening ? t.micStop : t.mic);
  $("mic").title = listening ? t.micStop : t.mic;
  $("f-where").replaceChildren(...t.bought.map((text) => new Option(text)));
  $("f-where").selectedIndex = bought;
  $("lang").value = lang;
}

function renderAll() {
  renderTexts();
  renderCheck();
  renderLog();
  renderLedger();
  renderRepair();
  renderNext();
  renderChips();
  renderBike();
}

// 店に見せる1枚は、作る時の台帳から組み直す。推測は入れず、本人の書き足しは未確認として分ける。
function sheetText() {
  const rows = (origin) => session.state.statements.filter((s) => s.origin === origin).map((s) => s.text);
  const notes = $("f-trouble").value.split("\n").map((line) => line.trim()).filter(Boolean);
  const values = [$("f-when").value, $("f-what").value, t.bought[bought], rows("checked"), rows("heard"), notes];
  return t.sheetLines.map((label, i) => (Array.isArray(values[i])
    ? [`${label}:`, ...values[i].map((v) => `・${v}`)].join("\n")
    : `${label}: ${values[i]}`)).join("\n");
}

// 送るボタンは印だけなので、文は読み上げ用の名前に置く。
function setSend(text) {
  $("send").setAttribute("aria-label", text);
  $("send").title = text;
}

async function send(message, { fromCheck = false } = {}) {
  if (sending) return;
  sending = true;
  turnId += 1;
  const current = turnId;
  const button = $("send");
  button.disabled = true;
  setSend(t.sending);
  // 点検チェックの全部○はサーバーを通らないので、「まだ話していない」は署名の有無で見る。
  const first = !session.signature;
  const bike = first && session.bike !== undefined ? `（${MESSAGES.ja.bikeLabel}：${MESSAGES.ja.bikes[session.bike]}）` : "";
  session.log.push({ kind: "you", text: message });
  renderLog();
  renderBike();
  const waiting = document.createElement("p");
  waiting.className = "waiting";
  const started = Date.now();
  waiting.setAttribute("aria-hidden", "true");
  // 秒は3秒を超えてから出す。「0秒」は目を引くだけで意味がない。
  const tick = () => {
    const s = Math.round((Date.now() - started) / 1000);
    waiting.textContent = s < 3 ? `${t.waiting}…` : `${t.waiting}… ${s}${t.seconds}`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  $("log").append(waiting);
  waiting.scrollIntoView({ block: "nearest" });
  session.quick = null;
  renderChips();
  // 聞き取りの途中で送った時は、送った後の欄に声の続きが入らないよう止める。
  stopListening();
  $("input").value = "";
  // 1行の欄は横に流れるので、空にした時に左端へ戻す。
  $("input").scrollLeft = 0;
  try {
    const response = await fetch("/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: bike + message,
        state: session.signature ? session.state : undefined,
        signature: session.signature,
        previousReply: session.lastReply,
        lang,
      }),
    });
    if (!response.ok) throw new Error(response.status === 429 ? "busy" : "failed");
    const data = await response.json();
    if (current !== turnId) return;
    const before = Object.fromEntries(session.state.statements.map((s) => [s.id, s.origin]));
    const beforeText = Object.fromEntries(session.state.statements.map((s) => [s.id, s.text]));
    const wasActive = new Set(session.comparisons.filter((c) => c.status === "active").map((c) => c.card_id));
    session.state = data.state;
    session.signature = data.signature;
    session.lastReply = data.turn.reply;
    session.step = data.turn.step ?? null;
    session.comparisons = data.comparisons;
    // 読み取った発言は、その相談のすぐ下に札で並べる。言い直しで移った札は、移る前の分け方も見せる。
    const tags = data.state.statements
      .filter((s) => !before[s.id] || before[s.id] !== s.origin || beforeText[s.id] !== s.text)
      .map((s) => ({ text: s.text, origin: s.origin, from: before[s.id] ?? null, old: before[s.id] && beforeText[s.id] !== s.text ? beforeText[s.id] : null }));
    if (tags.length > 0) session.log.push({ kind: "tags", tags });
    // 言い直しで支えを失った比較は、会話の中でも外したと見せる。
    const stillActive = new Set(data.comparisons.filter((c) => c.status === "active").map((c) => c.card_id));
    for (const id of wasActive) {
      if (!stillActive.has(id)) session.log.push({ kind: "move", text: lang === "ja" ? `${t.released}「${recordName(cardOf(id))}」` : t.released });
    }
    // 点検の結果で止まった時は、結果を残せる先を添える。
    const noGuide = fromCheck && data.turn.no_evidence ? `\n${t.checkNoGuide}` : "";
    session.log.push({ kind: "me", text: data.turn.reply + noGuide });
    const step = stepOf(session.step);
    // 出所は変わった時だけ出して、毎回同じ文が並ばないようにする。
    const source = step ? (step.source === "owner" ? t.sourceOwner : t.sourceVideo) : null;
    const lastSource = session.log.findLast((entry) => entry.kind === "source")?.text;
    if (source && source !== lastSource) session.log.push({ kind: "source", text: source });
    data.turn.citations.forEach((cite) => session.log.push({ kind: "cite", ...cite }));
    session.quick = data.turn.no_evidence || data.turn.topics ? "topics" : data.turn.ask || data.turn.step ? "unsure" : null;
    save();
    $("announce").textContent = data.turn.reply;
    renderLog(true);
    renderLedger();
    renderRepair();
    renderNext();
    renderChips();
  } catch (error) {
    if (current !== turnId) return;
    session.log.pop();
    $("input").value = message;
    renderLog();
    session.log.push({ kind: "me", text: t[error.message] ?? t.failed });
    $("announce").textContent = t[error.message] ?? t.failed;
    renderLog();
    session.log.pop();
  } finally {
    clearInterval(timer);
    waiting.remove();
    // やり直しの後に古い応答が返っても、新しい相談の送り待ちを解かない。
    if (current === turnId) {
      sending = false;
      button.disabled = false;
      setSend(t.send);
    }
  }
}

$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const message = $("input").value.trim();
  if (message) send(message);
});

// Enter で送る。変換中の Enter は拾わない。Shift+Enter は改行。
$("input").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.shiftKey) return;
  event.preventDefault();
  $("form").requestSubmit();
});

function micStatus(text, on = false) {
  $("mic-status").textContent = text;
  $("mic-status").classList.toggle("on", on);
  $("mic-status").hidden = !text;
}

function setListening(on) {
  listening = on;
  $("mic").setAttribute("aria-pressed", String(on));
  $("mic").setAttribute("aria-label", on ? t.micStop : t.mic);
  $("mic").title = on ? t.micStop : t.mic;
}

function stopListening() {
  recognizer?.abort();
  recognizer = null;
  setListening(false);
  micStatus("");
}

// 聞き取った文は入力欄に足すだけで、送らない。本人が確かめてから送る。
function startListening() {
  const base = $("input").value.trim();
  const heard = { final: "", interim: "" };
  const rec = new Recognition();
  rec.lang = lang === "ja" ? "ja-JP" : "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (event) => {
    heard.interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) heard.final += text;
      else heard.interim += text;
    }
    const spoken = (heard.final + heard.interim).trim();
    $("input").value = [base, spoken].filter(Boolean).join(lang === "ja" ? "" : " ").slice(0, 1000);
  };
  rec.onerror = (event) => {
    if (recognizer !== rec) return;
    heard.error = event.error === "not-allowed" || event.error === "service-not-allowed" ? t.micDenied
      : event.error === "no-speech" ? t.micNone : t.failed;
  };
  rec.onend = () => {
    if (recognizer !== rec) return;
    recognizer = null;
    setListening(false);
    micStatus(heard.error ?? (heard.final || heard.interim ? t.micCheck : t.micNone));
    $("input").focus();
  };
  recognizer = rec;
  try {
    rec.start();
  } catch {
    recognizer = null;
    micStatus(t.micDenied);
    return;
  }
  setListening(true);
  micStatus(t.listening, true);
}

if (Recognition) {
  $("mic").hidden = false;
  // もう一度押すと止まる。止めた所までの文は入力欄に残る。
  $("mic").addEventListener("click", () => {
    if (listening) recognizer?.stop();
    else startListening();
  });
}

// 項目の文に「、」があるので、結果は「／」でつなぐ。全部○の時も、何を○にしたかを残す。
$("check-send").addEventListener("click", () => {
  const results = t.checkItems.flatMap((item, index) => (checks[index] ? [`${item} ${checks[index]}`] : []));
  const message = `${t.checkResult}：${results.join("／")}`;
  $("check").open = false;
  if (checks.every((mark) => !mark || mark === "○")) {
    session.log.push({ kind: "you", text: message }, { kind: "me", text: t.checkAllGood });
    save();
    renderLog();
    return;
  }
  send(message, { fromCheck: true });
});

$("f-where").addEventListener("change", (event) => { bought = event.target.selectedIndex; });

// 別の車の相談へ移った時に混ざらないよう、1枚の欄も空に戻す。
$("restart").addEventListener("click", () => {
  turnId += 1;
  sending = false;
  stopListening();
  $("send").disabled = false;
  setSend(t.send);
  session = emptySession();
  previous = {};
  checks = [];
  bought = 0;
  for (const id of ["f-when", "f-what", "f-trouble", "sheet-text"]) $(id).value = "";
  $("sheet-text").hidden = true;
  $("copy").textContent = t.make;
  $("player").replaceChildren();
  save();
  renderAll();
});

$("lang").addEventListener("change", (event) => {
  lang = event.target.value;
  t = MESSAGES[lang];
  // 聞き取りの言語は始めた時に決まるので、言語を変えたら止める。
  stopListening();
  renderAll();
});

$("copy").addEventListener("click", async () => {
  const text = sheetText();
  const output = $("sheet-text");
  output.value = text;
  output.hidden = false;
  output.select();
  try {
    await navigator.clipboard.writeText(text);
    $("copy").textContent = t.copied;
  } catch {
    $("copy").textContent = t.made;
  }
});

// 台帳が取れなくても画面の言葉は出す。送ると「うまくいきませんでした」が出る。
let data = { cards: [], flows: [], draft: false };
try {
  data = await (await fetch("/api/cards")).json();
} catch { /* 台帳なしで続ける */ }
cards = data.cards ?? [];
flows = data.flows ?? [];
$("draft").hidden = !data.draft;
session = load();
// 下の固定欄の実高（マイクの案内が出ると伸びる）に、本文の下の余白を合わせる。
new ResizeObserver(() => document.documentElement.style.setProperty("--dock", `${$("form").offsetHeight}px`)).observe($("form"));
renderAll();
