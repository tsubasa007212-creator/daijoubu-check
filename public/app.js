// 相談画面。台帳の分け方はサーバーの engine と同じ区分を使う。
const LABELS = { checked: "自分で確かめたこと", heard: "聞いた話", guess: "推測", unknown: "まだ分からないこと" };
const $ = (id) => document.getElementById(id);
let state = { statements: [], links: [] };
let comparisons = [];
let cards = [];
let previous = {};

const seconds = (t) => t.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
const cardOf = (id) => cards.find((c) => c.id === id);

function addText(kind, text) {
  const p = document.createElement("p");
  p.className = kind;
  p.textContent = text;
  $("log").append(p);
  p.scrollIntoView({ block: "nearest" });
}

function play(videoId, t) {
  const frame = document.createElement("iframe");
  frame.src = `https://www.youtube-nocookie.com/embed/${videoId}?start=${seconds(t)}&autoplay=1`;
  frame.allow = "autoplay; encrypted-media";
  frame.title = "整備の動画";
  $("player").replaceChildren(frame);
}

function addScene(cite) {
  const card = cardOf(cite.card_id);
  const scene = card?.scenes.find((s) => s.id === cite.scene_id);
  if (!scene) return;
  const button = document.createElement("button");
  button.className = "scene";
  button.type = "button";
  const time = document.createElement("b");
  time.textContent = scene.t;
  const note = document.createElement("small");
  note.textContent = `別の車の記録：${card.vehicle}`;
  button.append(time, scene.line, note);
  button.onclick = () => play(card.video_id, scene.t);
  $("log").append(button);
}

// 今も比べている記録の作業場面だけを出す。動画の中の注意はそのまま添え、足さない。
function renderRepair() {
  const active = [...new Set(comparisons.filter((c) => c.status === "active").map((c) => c.card_id))];
  const list = $("repair-list");
  list.replaceChildren();
  for (const card of active.map(cardOf).filter((c) => c?.repair)) {
    const button = document.createElement("button");
    button.className = "scene";
    button.type = "button";
    const time = document.createElement("b");
    time.textContent = card.repair.t;
    const note = document.createElement("small");
    note.textContent = `${card.title}（別の車の記録）`;
    button.append(time, card.repair.line, note);
    button.onclick = () => play(card.video_id, card.repair.t);
    list.append(button);
    if (card.repair.warning) {
      const warning = document.createElement("p");
      warning.className = "hint";
      warning.textContent = `大谷の言葉（${card.repair.warning.t}）：${card.repair.warning.line}`;
      list.append(warning);
    }
  }
  $("repair").hidden = list.childElementCount === 0;
}

function renderLedger() {
  const root = $("ledger");
  root.replaceChildren();
  for (const [origin, label] of Object.entries(LABELS)) {
    const rows = state.statements.filter((s) => s.origin === origin);
    if (rows.length === 0) continue;
    const group = document.createElement("div");
    group.className = "group";
    const title = document.createElement("h3");
    title.textContent = label;
    group.append(title);
    for (const statement of rows) {
      const row = document.createElement("div");
      row.className = "row";
      if (previous[statement.id] && previous[statement.id] !== origin) row.classList.add("moved");
      row.textContent = statement.text;
      for (const link of comparisons.filter((c) => c.statement_id === statement.id)) {
        const note = document.createElement("small");
        note.textContent = `${cardOf(link.card_id)?.title ?? link.card_id} と比べている`;
        if (link.status === "released") note.className = "off";
        row.append(note);
      }
      group.append(row);
    }
    root.append(group);
  }
  previous = Object.fromEntries(state.statements.map((s) => [s.id, s.origin]));
  $("f-trouble").value = state.statements.filter((s) => s.origin === "checked").map((s) => s.text).join("\n");
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("input").value.trim();
  if (!message) return;
  addText("you", message);
  $("input").value = "";
  const send = event.target.querySelector("button");
  send.disabled = true;
  send.textContent = "確かめています";
  try {
    const response = await fetch("/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, state }),
    });
    if (!response.ok) throw new Error("failed");
    const data = await response.json();
    state = data.state;
    comparisons = data.comparisons;
    addText("me", data.turn.reply);
    data.turn.citations.forEach(addScene);
    renderLedger();
    renderRepair();
  } catch {
    addText("me", "うまく受け取れませんでした。もう一度送ってください。");
  } finally {
    send.disabled = false;
    send.textContent = "送る";
  }
});

$("copy").addEventListener("click", async () => {
  const text = [
    `最後の整備：${$("f-when").value}`,
    `整備の内容：${$("f-what").value}`,
    `買った所：${$("f-where").value}`,
    `不調の様子：${$("f-trouble").value}`,
  ].join("\n");
  await navigator.clipboard.writeText(text);
  $("copy").textContent = "写しました";
});

const data = await (await fetch("/api/cards")).json();
cards = data.cards;
$("draft").hidden = !data.draft;
