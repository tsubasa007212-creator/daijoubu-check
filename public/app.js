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
}

function sceneButton(videoId, time, line, note) {
  const button = document.createElement("button");
  button.className = "scene";
  button.type = "button";
  const stamp = document.createElement("b");
  stamp.textContent = time;
  const small = document.createElement("small");
  small.textContent = note;
  button.append(stamp, line, small);
  button.onclick = () => play(videoId, time);
  return button;
}

function renderEntry(entry) {
  if (entry.kind === "tags") {
    const list = document.createElement("div");
    list.className = "tags";
    for (const tag of entry.tags) {
      const item = document.createElement("span");
      item.className = `tag ${tag.origin}`;
      const label = document.createElement("b");
      label.textContent = tag.from ? `${t[tag.from]} → ${t[tag.origin]}` : t[tag.origin];
      item.append(label, tag.text);
      list.append(item);
    }
    $("log").append(list);
    return;
  }
  if (entry.kind === "cite") {
    const card = cardOf(entry.card_id);
    const scene = card?.scenes.find((s) => s.id === entry.scene_id);
    if (!scene) return;
    const line = entry.gloss || scene.line;
    const note = entry.gloss ? `${t.otherBike} / ${t.original}: ${scene.line}` : `${t.otherBike}：${card.vehicle}`;
    $("log").append(sceneButton(card.video_id, scene.t, line, note));
    return;
  }
  const p = document.createElement("p");
  p.className = entry.kind;
  p.textContent = entry.text;
  $("log").append(p);
}

function renderLog() {
  $("log").replaceChildren();
  session.log.forEach(renderEntry);
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
    group.className = "group";
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
        note.textContent = recordName(cardOf(link.card_id)) + t.comparing;
        if (link.status === "released") note.className = "off";
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
      button.setAttribute("aria-label", `${item} ${mark}`);
      button.setAttribute("aria-pressed", String(checks[index] === mark));
      button.onclick = () => {
        checks[index] = checks[index] === mark ? undefined : mark;
        renderCheck();
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

async function send(message, { fromCheck = false } = {}) {
  if (sending) return;
  sending = true;
  turnId += 1;
  const current = turnId;
  const button = $("send");
  button.disabled = true;
  button.textContent = t.sending;
  const first = !session.log.some((entry) => entry.kind === "you");
  const bike = first && session.bike !== undefined ? `（${MESSAGES.ja.bikeLabel}：${MESSAGES.ja.bikes[session.bike]}）` : "";
  session.log.push({ kind: "you", text: message });
  renderLog();
  renderBike();
  const waiting = document.createElement("p");
  waiting.className = "waiting";
  const started = Date.now();
  const tick = () => { waiting.textContent = `${t.waiting}… ${Math.round((Date.now() - started) / 1000)}${t.seconds}`; };
  tick();
  const timer = setInterval(tick, 1000);
  $("log").append(waiting);
  waiting.scrollIntoView({ block: "nearest" });
  session.quick = null;
  renderChips();
  // 聞き取りの途中で送った時は、送った後の欄に声の続きが入らないよう止める。
  stopListening();
  $("input").value = "";
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
    session.state = data.state;
    session.signature = data.signature;
    session.lastReply = data.turn.reply;
    session.step = data.turn.step ?? null;
    session.comparisons = data.comparisons;
    // 読み取った発言は、その相談のすぐ下に札で並べる。言い直しで移った札は、移る前の分け方も見せる。
    const tags = data.state.statements
      .filter((s) => !before[s.id] || before[s.id] !== s.origin)
      .map((s) => ({ text: s.text, origin: s.origin, from: before[s.id] ?? null }));
    if (tags.length > 0) session.log.push({ kind: "tags", tags });
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
    renderLog();
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
    renderLog();
    session.log.pop();
  } finally {
    clearInterval(timer);
    waiting.remove();
    sending = false;
    button.disabled = false;
    button.textContent = t.send;
  }
}

$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const message = $("input").value.trim();
  if (message) send(message);
});

$("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) $("form").requestSubmit();
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
  $("send").textContent = t.send;
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

const data = await (await fetch("/api/cards")).json();
cards = data.cards;
flows = data.flows;
$("draft").hidden = !data.draft;
session = load();
renderAll();
