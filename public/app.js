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
let troubleEdited = false;
let checks = [];

function emptySession() {
  return { state: { statements: [], links: [] }, signature: null, comparisons: [], log: [], lastReply: "" };
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
  $("examples").hidden = session.log.length > 0;
  $("log").lastElementChild?.scrollIntoView({ block: "nearest" });
}

// 流れの本文は日本語だけなので、他の言語では返答の質問に任せる。
function renderNext() {
  const step = stepOf(session.step);
  $("next").hidden = !step || lang !== "ja";
  if (!step) return;
  $("next-how").textContent = step.how;
  $("next-source").textContent = step.source === "owner" ? t.sourceOwner : t.sourceVideo;
  $("next-needs").textContent = `${t.needs}：${step.needs}`;
  $("next-limit").textContent = `${t.cannotTell}：${step.cannot_tell}`;
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
  if (!troubleEdited) $("f-trouble").value = statements.filter((s) => s.origin === "checked").map((s) => s.text).join("\n");
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

// 止まった時は、今答えられる相談を出して行き止まりにしない。
function renderChips(showUnsure, showTopics = false) {
  $("examples").replaceChildren(...t.examples.map((text) => chip(text, () => send(text))));
  const quick = showTopics ? t.topics : showUnsure ? [t.unsure] : [];
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
  $("f-where").replaceChildren(...t.bought.map((text) => new Option(text)));
  $("lang").value = lang;
}

function renderAll(showUnsure = false) {
  renderTexts();
  renderCheck();
  renderLog();
  renderLedger();
  renderRepair();
  renderNext();
  renderChips(showUnsure);
}

async function send(message) {
  if (sending) return;
  sending = true;
  turnId += 1;
  const current = turnId;
  const button = $("send");
  button.disabled = true;
  button.textContent = t.sending;
  session.log.push({ kind: "you", text: message });
  renderLog();
  $("quick").replaceChildren();
  $("input").value = "";
  try {
    const response = await fetch("/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
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
    for (const statement of data.state.statements) {
      if (before[statement.id] && before[statement.id] !== statement.origin) {
        session.log.push({ kind: "move", text: `「${statement.text}」${t.moved}：${t[statement.origin]}` });
      }
    }
    session.log.push({ kind: "me", text: data.turn.reply });
    const step = stepOf(session.step);
    if (step) session.log.push({ kind: "source", text: step.source === "owner" ? t.sourceOwner : t.sourceVideo });
    data.turn.citations.forEach((cite) => session.log.push({ kind: "cite", ...cite }));
    save();
    renderLog();
    renderLedger();
    renderRepair();
    renderNext();
    renderChips(Boolean(data.turn.ask || data.turn.step), Boolean(data.turn.no_evidence || data.turn.topics));
  } catch (error) {
    if (current !== turnId) return;
    session.log.pop();
    $("input").value = message;
    renderLog();
    session.log.push({ kind: "me", text: t[error.message] ?? t.failed });
    renderLog();
    session.log.pop();
  } finally {
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

$("check-send").addEventListener("click", () => {
  const results = t.checkItems.flatMap((item, index) => (checks[index] ? [`${item} ${checks[index]}`] : []));
  $("check").open = false;
  if (checks.every((mark) => !mark || mark === "○")) {
    session.log.push({ kind: "me", text: t.checkAllGood });
    save();
    renderLog();
    return;
  }
  send(`${t.checkResult}：${results.join("、")}`);
});

$("f-trouble").addEventListener("input", () => { troubleEdited = true; });

$("restart").addEventListener("click", () => {
  turnId += 1;
  sending = false;
  $("send").disabled = false;
  $("send").textContent = t.send;
  troubleEdited = false;
  session = emptySession();
  previous = {};
  checks = [];
  $("player").replaceChildren();
  save();
  renderAll();
});

$("lang").addEventListener("change", (event) => {
  lang = event.target.value;
  t = MESSAGES[lang];
  renderAll();
});

$("copy").addEventListener("click", async () => {
  const values = [$("f-when").value, $("f-what").value, $("f-where").value, $("f-trouble").value];
  const text = t.sheetLines.map((label, i) => `${label}: ${values[i]}`).join("\n");
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
