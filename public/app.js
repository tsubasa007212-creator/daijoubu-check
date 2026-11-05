// 相談画面。言葉は i18n.js に置き、台帳の判断はサーバーに任せる。
import { MESSAGES, pickLanguage } from "./i18n.js";

const ORIGINS = ["checked", "heard", "guess", "unknown"];
const STORE_KEY = "daijoubu-check";
const CHECK_MARKS = ["○", "△", "×", "？"];
// 挿絵（整備書風の線画。ChatGPTで作成、public/img）。バイクの種類と、見る場所が言葉だけでは分からない段に付ける。
const BIKE_PICS = ["01-gyro", "02-scooter50", "03-scooter125", "04-geared", "05-unsure"];
const STEP_PICS = {
  "start/s2": "06-battery",
  "start/s4": "10-oil", "oil/s3": "10-oil",
  "start/s7": "09-plug", "any_start/s3": "09-plug",
  "meter/s2": "07-meter-gear", "meter/s3": "07-meter-gear",
  "speed/s7": "08-drive-belt", "speed/s8": "08-drive-belt", "speed/s9": "08-drive-belt",
  "belt/s4": "08-drive-belt", "belt/s5": "08-drive-belt", "any_drive/s3": "08-drive-belt",
  "warning_lamp/s2": "11-fi-lamp", "idle/s1": "11-fi-lamp",
};
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
// 声の聞き取りはブラウザの仕組みを使う。使えないブラウザではボタンを出さない。
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;
// 待っている相談を「やめる」で止めるための手綱。
let aborter = null;
// 待ちの紙。言語を変えて描き直しても消えないよう、ここに持つ。
let pending = null;
let pendingEntry = null;
// 相談の台帳と流れを読み込み終えたか。
let loaded = false;
let loadFailed = false;
// 1列の幅では「次に確かめること」を最新の答えのすぐ下に移す。
const narrow = matchMedia("(max-width: 800px)");

function emptySession() {
  return {
    state: { statements: [], links: [] }, signature: null, comparisons: [], log: [], lastReply: "", quick: null,
    // 1枚の欄も会話と同じく保存する（読み込み直しで消えないように）。
    form: { when: "", what: "", trouble: "", bought: 0 }, sheetMade: false,
  };
}

// 保存できない環境でも相談は続ける。
function save() {
  try {
    // 送っている途中の発言は保存しない（やめた発言が読み込み直しで戻らないように）。
    const log = session.log.filter((entry) => entry !== pendingEntry);
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ ...session, log }));
  } catch { /* 保存なしで続ける */ }
}

function load() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORE_KEY));
    return stored ? { ...emptySession(), ...stored } : emptySession();
  } catch {
    return emptySession();
  }
}

// 動きを減らす設定の人には、紙の出現と画面の送りを動かさない。
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  // 左にその動画の絵（YouTube の縮小画像）と再生の印、下に時刻。
  const stamp = document.createElement("span");
  stamp.className = "t num";
  const pic = document.createElement("span");
  pic.className = "pic";
  const img = document.createElement("img");
  img.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  img.alt = "";
  img.loading = "lazy";
  img.width = 320;
  img.height = 180;
  pic.append(img);
  pic.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>');
  stamp.append(pic, time);
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
    p.append(...linked(text));
    return p;
  }
  const ask = el("span", "ask");
  ask.append(...linked(asked[1].trim()));
  p.append(...linked(text.slice(0, asked.index).trimEnd()), ask);
  return p;
}

// 自分たちの頁と動画の URL だけを押せるようにする。ほかの URL は文字のまま。
const LINKABLE = /https:\/\/(?:wing-canopy\.com|youtu\.be|www\.youtube\.com)\/[^\s）」、。]*/g;
function linked(text) {
  const nodes = [];
  let at = 0;
  for (const match of text.matchAll(LINKABLE)) {
    nodes.push(text.slice(at, match.index));
    const a = el("a", "", match[0]);
    a.href = match[0];
    a.target = "_blank";
    a.rel = "noopener";
    nodes.push(a);
    at = match.index + match[0].length;
  }
  nodes.push(text.slice(at));
  return nodes;
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
    // 置かれる動きは、答えを受けた直後の最新の紙だけ。
    if (view.fresh && index > view.lastYou) paper.classList.add("fresh");
    paper.append(...view.moves.map((text) => el("p", "move", text)));
    view.moves = [];
    paper.append(sayNode(entry.text));
    $("log").append(paper);
    view.paper = paper;
    return;
  }
  if (entry.kind === "source") {
    // 出所は画面の言語で出す（言語を切り替えても古い言葉が残らないよう、種類を持つ）。
    const source = el("p", "source", entry.key ? (entry.key === "owner" ? t.sourceOwner : t.sourceVideo) : entry.text);
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
    // 本人の確認がある記録は、その言葉を小さく添える（「：」より前の日付の書き出しは省く）。
    // 英語の画面では、本人の確認を訳した文（owner_note_en）を添える。
    const ownerNote = lang === "ja" ? card.owner_note : card.owner_note_en;
    if (ownerNote) {
      const at = lang === "ja" ? ownerNote.indexOf("：") : -1;
      button.append(el("small", "owner", t.ownerNote + (at >= 0 ? ownerNote.slice(at + 1) : ownerNote)));
    }
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
  // 待っている間は、描き直しても待ちの紙と「やめる」を残す。
  if (pending) {
    pending.cancel.textContent = t.cancel;
    $("log").append(pending.node);
  }
  $("topics").hidden = session.log.length > 0;
  $("examples").hidden = session.log.length > 0;
  $("log").lastElementChild?.scrollIntoView({ block: "nearest", behavior: fresh && !calm ? "smooth" : "auto" });
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

// 流れの本文は日本語だけ。他の言語では、その確認を訳した文（step_note）が届いた時はそれを出し、
// 届いていない時（日本語で聞いたあとに言語を変えた時など）は、日本語のまま出してそう添える（黙って消さない）。
function renderNext() {
  const step = stepOf(session.step);
  const note = lang === "ja" ? null : session.stepNote?.lang === lang && session.stepNote.how ? session.stepNote : null;
  $("next").hidden = !step;
  // 相談者がもう答えた段は「次に確かめること」ではなく、答えてもらった確認として出す（根拠と場面は残す）。
  // 保留はその返答の段にだけかける。「自分では確認できない」の印（cantCheck）は1枚への出口にだけ使い、別の確認まで止めない。
  const hold = Boolean(step) && Boolean(session.stepHold);
  $("next-title").textContent = hold ? t.stepHoldTitle : session.stepDone ? t.stepDoneTitle : t.nextTitle;
  $("next-lang").hidden = lang === "ja" || Boolean(note);
  $("next-lang").textContent = t.jaOnly ?? "";
  // 工具や分解が要る段、または自分では確かめられないと分かった後は、店に見せる1枚への出口を出す。
  const tool = Boolean(step?.needs) && step.needs !== "工具なし";
  $("exit").hidden = !(tool || session.cantCheck || session.cannotOpen);
  if (tool) {
    const head = step.needs === "分解が要る" ? t.shopExit : t.shopExitTool.replace("{needs}", step.needs.replace(/（.*?）/g, ""));
    $("exit-text").textContent = `${head}${t.shopExitTail}`;
  } else {
    $("exit-text").textContent = `${t.shopExitCant}${t.shopExitCantTail}`;
  }
  if (!step) return;
  const pic = STEP_PICS[`${session.step.flow_id}/${step.id}`];
  $("next-pic").hidden = !pic;
  if (pic) $("next-pic").src = `img/${pic}.webp`;
  const [how, limit, view] = note ? [note.how, note.cannot_tell, note.view] : explain([step.how, step.cannot_tell, step.view ?? ""]);
  // 今はしない確認は、やり方も見立ての作業も出さず、分からないことと出所だけ残す。
  $("next-how").replaceChildren(...linked(hold ? t.stepHold : how));
  $("next-pic").hidden = !pic || hold;
  // 整備士の見立てやすすめ（交換など）は、相談者が今する確認と分けて出す。必要なものは確認の方にだけかかる。
  $("next-view").hidden = !view || hold;
  $("next-view").replaceChildren(el("span", "label", `${t.viewLabel}${lang === "ja" ? "：" : ": "}`), ...linked(view ?? ""));
  $("next-source").textContent = step.source === "owner" ? t.sourceOwner : t.sourceVideo;
  // 動画に残っている確認は、その場面を開けるようにする（記録カードにない動画もあるため）。
  $("next-scene").replaceChildren(...(step.video_id && !hold
    ? [sceneButton(step.video_id, step.t, lang === "ja" ? step.line : t.stepVideo, lang === "ja" ? t.stepVideo : "")]
    : []));
  const needs = note ? note.needs : step.needs;
  // 訳に必要なものが無い時は、空の行を出さない。
  $("next-needs").hidden = !needs || hold;
  $("next-needs").textContent = `${t.needs}${lang === "ja" ? "：" : ": "}${needs}`;
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
  $("bike-list").replaceChildren(...t.bikes.map((text, index) => {
    const button = chip(text, () => {
      session.bike = index;
      save();
      renderAll();
    });
    button.classList.add("bike");
    const img = document.createElement("img");
    img.src = `img/${BIKE_PICS[index]}.webp`;
    img.alt = "";
    img.width = 640;
    img.height = 640;
    button.prepend(img);
    return button;
  }));
  $("bike-chosen").hidden = session.bike === undefined;
  if (session.bike !== undefined) $("bike-chosen").textContent = `${t.bikeLabel}：${t.bikes[session.bike].replace("\n", lang === "ja" ? "" : " ")}`;
  $("topics").hidden = !fresh || session.bike === undefined;
  $("check").hidden = session.bike === undefined && fresh;
  // 最初の画面は車種の選択だけ。右の欄は最初の相談を送ってから出す。
  document.querySelector(".ledger").hidden = fresh;
}

function renderChips() {
  $("topics").replaceChildren(...t.topics.map((text) => chip(text, () => send(text))));
  // 最初は話題だけを出す。例文は入力欄の見本に任せる。
  $("examples").replaceChildren();
  // 質問には、問いの形に合う答えをボタンで出す。はい・いいえで答える問いは4つ、
  // 選ぶ問いはその選択肢、言葉で答える問いは「分からない」と「自分では確認できない」だけ（あとは入力欄へ）。
  // 前の版で保存した "unsure" も同じに扱う。
  const asked = session.quick === "answers" || session.quick === "unsure";
  // 選択肢が別の言語の時は、その言語の文を出さず、言葉で答える形にする（ボタンの言語をそろえる）。
  const otherLang = session.choicesLang && session.choicesLang !== lang;
  const kind = session.answerKind === "choice" && otherLang ? "free" : session.answerKind ?? "yes_no";
  const quick = session.quick === "topics" ? t.topics
    : !asked ? []
    : kind === "choice" && session.choices?.length ? [...new Set([...session.choices, t.dontKnow, t.answers[3]])]
    : kind === "free" ? [t.dontKnow, t.answers[3]]
    : t.answers;
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
        if (sending) return;
        checks[index] = checks[index] === mark ? undefined : mark;
        row.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === checks[index])));
        $("check-send").disabled = sending || !ready() || !checks.some(Boolean);
      };
      row.append(button);
    }
    list.append(row);
  });
  lockChecks();
}

// 送っている間は印も変えられないようにする。成功した時に印を消すので、待ちの間に付けた印まで消えないように。
function lockChecks() {
  $("check-list").querySelectorAll("button").forEach((button) => { button.disabled = sending; });
  $("check-send").disabled = sending || !ready() || !checks.some(Boolean);
}

// 記録を読み終えるまでと、読めなかった時は相談を送らない（次に確かめることや根拠が出せないため）。
function ready() {
  return loaded && !loadFailed;
}

function renderTexts() {
  document.documentElement.lang = lang;
  document.title = t.title;
  document.querySelectorAll("[data-t]").forEach((node) => { node.textContent = t[node.dataset.t]; });
  // 記録を読み終えるまでは送れない。どの画面にいても分かるよう、入力欄の見本の所にも出す。
  $("input").placeholder = ready() ? t.placeholder : loadFailed ? t.loadFailed : t.loading;
  $("input").setAttribute("aria-label", t.inputLabel);
  setSend(sending ? t.sending : t.send);
  $("send").disabled = sending || !ready();
  $("mic").setAttribute("aria-label", listening ? t.micStop : t.mic);
  $("mic").title = listening ? t.micStop : t.mic;
  $("f-where").replaceChildren(...t.bought.map((text) => new Option(text)));
  // 買った所は番号で持ち、言語を変えても選んだものを保つ。
  $("f-where").selectedIndex = session.form.bought;
  $("f-when").value = session.form.when;
  $("f-what").value = session.form.what;
  $("f-trouble").value = session.form.trouble;
  $("loading").hidden = loaded;
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
  const notes = session.form.trouble.split("\n").map((line) => line.trim()).filter(Boolean);
  // 点検チェックの結果（○も）は台帳の発言として入っているので、言い直しもそのまま反映される。
  const values = [session.form.when, session.form.what, t.bought[session.form.bought], rows("checked"), rows("heard"), rows("unknown"), notes];
  // 店が最初に知りたい車種を先頭に置く。自分では部品を外せないことも、店の段取りに要るので添える。
  const bike = session.bike !== undefined ? [`${t.bikeLabel}: ${t.bikes[session.bike].replace("\n", lang === "ja" ? "" : " ")}`] : [];
  if (session.cannotOpen) bike.push(t.sheetCannotOpen);
  return [...bike, ...t.sheetLines.map((label, i) => (Array.isArray(values[i])
    ? [`${label}:`, ...values[i].map((v) => `・${v}`)].join("\n")
    : `${label}: ${values[i]}`))].join("\n");
}

// 同じ文を紙の作業票として描く。店でスマホをそのまま見せられるように、見出しは太字、・の行は箇条にする。
function renderSheetView(text) {
  const view = $("sheet-view");
  view.replaceChildren();
  let list = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("・")) {
      if (!list) view.append(list = el("ul", ""));
      list.append(el("li", "", line.slice(1)));
      continue;
    }
    list = null;
    const at = line.indexOf(": ");
    const p = el("p", "");
    if (at >= 0) p.append(el("b", "", line.slice(0, at + 1)), line.slice(at + 1));
    else p.append(el("b", "", line));
    view.append(p);
  }
  view.hidden = false;
}

// 1枚を作る。紙の表示と、写せる文の欄の両方に出す。作り直しの時は、文の欄の見せ方を変えない。
function makeSheet({ again = false } = {}) {
  const text = sheetText();
  const output = $("sheet-text");
  output.value = text;
  if (!again) output.hidden = false;
  renderSheetView(text);
  if (!session.sheetMade) {
    session.sheetMade = true;
    save();
  }
  return text;
}

// 作った1枚は、相談が進んだら作り直して古いまま残さない。
function refreshSheet(changed) {
  if (!session.sheetMade) return;
  makeSheet({ again: true });
  // 中身が変わったら、写したのは古い版なので「写しました」を戻す。
  $("copy").textContent = t.make;
  $("sheet-note").hidden = !changed;
  if (changed) $("sheet-note").textContent = t.sheetChanged;
}

// 入力欄は文に合わせて1〜4行まで伸ばす。
function fitInput() {
  const input = $("input");
  const style = getComputedStyle(input);
  const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const max = parseFloat(style.lineHeight) * 4 + pad;
  // 空の時は1行（見本の文が折り返して欄が伸びないように）。
  if (!input.value) {
    input.style.height = "";
    input.style.overflowY = "hidden";
    return;
  }
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, max)}px`;
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
}

// 1列の幅では最新の答えの直後（答えるボタンの上）へ、広い幅では右の欄の先頭へ戻す。
// 読む順は、答え→確かめ方→答えるボタン。
function placeNext() {
  if (narrow.matches) $("quick").before($("next"), $("exit"));
  else document.querySelector(".ledger").prepend($("next"), $("exit"));
}

// 送るボタンは印だけなので、文は読み上げ用の名前に置く。
function setSend(text) {
  $("send").setAttribute("aria-label", text);
  $("send").title = text;
}

// 相談も点検の結果も、ここだけから送る。待っている間は次を送らず、そう伝える（送ったつもりで落ちないように）。
// allGood は点検が全部○の時。台帳には○として残し、返答は決まった文にする。
async function send(message, { fromCheck = false, allGood = false } = {}) {
  if (sending) {
    $("announce").textContent = t.waitFirst;
    micStatus(t.waitFirst);
    return false;
  }
  if (!ready()) {
    const text = loadFailed ? t.loadFailed : t.loading;
    $("announce").textContent = text;
    micStatus(text);
    return false;
  }
  sending = true;
  turnId += 1;
  const current = turnId;
  const button = $("send");
  button.disabled = true;
  lockChecks();
  $("form").classList.add("sending");
  setSend(t.sending);
  const first = !session.signature;
  // 返答は送った時の言語で届くので、その言語を覚えておく（待ち中に言語を変えても取り違えない）。
  const askedLang = lang;
  // 全○の決まった文は、最初の点検の時だけ使う。相談の途中では、残っている不調や次の確認を上書きしない。
  const plainGood = allGood && first;
  const bike = first && session.bike !== undefined ? `（${MESSAGES.ja.bikeLabel}：${MESSAGES.ja.bikes[session.bike].replace("\n", "")}）` : "";
  // 失敗した時に消すのは、この送信の行だけ（末尾の別の行を消さない）。
  const mine = { kind: "you", text: message };
  session.log.push(mine);
  pendingEntry = mine;
  // 待ちの紙。秒の文は読み上げず、「やめる」ボタンだけ押せるようにする。
  const waiting = el("div", "waiting");
  const waitText = el("span", "");
  waitText.setAttribute("aria-hidden", "true");
  const controller = new AbortController();
  aborter = controller;
  const cancel = el("button", "plain", t.cancel);
  cancel.type = "button";
  cancel.onclick = () => controller.abort();
  waiting.append(waitText, cancel);
  pending = { node: waiting, cancel };
  const started = Date.now();
  // 秒は3秒を超えてから出す。「0秒」は目を引くだけで意味がない。
  const tick = () => {
    const s = Math.round((Date.now() - started) / 1000);
    waitText.textContent = s < 3 ? `${t.waiting}…` : `${t.waiting}… ${s}${t.seconds}`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  const quickBefore = session.quick;
  session.quick = null;
  renderLog();
  renderBike();
  renderChips();
  waiting.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
  // 聞き取りの途中で送った時は、送った後の欄に声の続きが入らないよう止める。
  stopListening();
  // 点検から送った時は、入力欄の書きかけを残す。
  if (!fromCheck) {
    $("input").value = "";
    fitInput();
  }
  // 送る前の状態へ戻す。書きかけがあれば上書きしない。
  const undo = () => {
    const at = session.log.lastIndexOf(mine);
    if (at >= 0) session.log.splice(at, 1);
    session.quick = quickBefore;
    pendingEntry = null;
    save();
    if (!fromCheck && !$("input").value.trim()) {
      $("input").value = message;
      fitInput();
    }
  };
  try {
    const response = await fetch("/api/turn", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: bike + message,
        state: session.signature ? session.state : undefined,
        signature: session.signature,
        previousReply: session.lastReply,
        cannotOpen: session.cannotOpen === true,
        lang: askedLang,
      }),
    });
    if (!response.ok) throw new Error(response.status === 429 ? "busy" : "failed");
    const data = await response.json();
    if (current !== turnId) return true;
    const turn = data.turn;
    const before = Object.fromEntries(session.state.statements.map((s) => [s.id, s.origin]));
    const beforeText = Object.fromEntries(session.state.statements.map((s) => [s.id, s.text]));
    const wasActive = new Set(session.comparisons.filter((c) => c.status === "active").map((c) => c.card_id));
    session.state = data.state;
    session.signature = data.signature;
    session.lastReply = plainGood ? t.checkAllGood : turn.reply;
    session.step = plainGood ? null : turn.step ?? null;
    session.comparisons = data.comparisons;
    // 英語などでは、次に確かめることの訳を、その言語の印と一緒に持つ。
    session.stepNote = turn.step_note?.how ? { ...turn.step_note, lang: askedLang } : null;
    session.stepDone = Boolean(turn.step_done) && !plainGood;
    // 今できない・してはいけない確認は、固定欄でも作業を出さない（本文と固定欄で同じ可否を守る）。
    session.stepHold = (Boolean(turn.step_hold) || session.cannotOpen === true) && !plainGood;
    // 「部品を外せない」は、相談者が言い直すまで持ち越す（返答に無い時は前の値を保つ）。
    if (typeof turn.cannot_open === "boolean") session.cannotOpen = turn.cannot_open;
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
    const noGuide = fromCheck && !plainGood && turn.no_evidence ? `\n${t.checkNoGuide}` : "";
    const reply = plainGood ? t.checkAllGood : turn.reply + noGuide;
    session.log.push({ kind: "me", text: reply });
    if (!plainGood) {
      const step = stepOf(session.step);
      // 出所は変わった時だけ出して、毎回同じ文が並ばないようにする。
      const sourceKey = step ? (step.source === "owner" ? "owner" : "video") : null;
      const last = session.log.findLast((entry) => entry.kind === "source");
      const lastKey = last?.key ?? (last?.text === MESSAGES.ja.sourceOwner || last?.text === MESSAGES.en.sourceOwner ? "owner" : last ? "video" : null);
      if (sourceKey && sourceKey !== lastKey) session.log.push({ kind: "source", key: sourceKey, text: sourceKey === "owner" ? t.sourceOwner : t.sourceVideo });
      turn.citations.forEach((cite) => session.log.push({ kind: "cite", ...cite }));
    }
    session.quick = plainGood || turn.no_evidence || turn.topics ? "topics" : turn.ask || turn.step ? "answers" : null;
    session.answerKind = turn.answer_kind ?? "yes_no";
    session.choices = Array.isArray(turn.choices) ? turn.choices.slice(0, 4) : [];
    // 選択肢の文は答えた時の言語なので、その言語を覚えておく（言語を変えたら古い言語のボタンを出さない）。
    session.choicesLang = askedLang;
    // 「自分では確認できない」と答えた後、または部品を外せないと分かった後は、店に見せる1枚への出口を残す。
    session.cantCheck = session.cantCheck || Object.values(MESSAGES).some((m) => m.answers[3] === message) || session.cannotOpen === true;
    pendingEntry = null;
    // 送った点検の印は消す。古い○を次の点検で送り直さないように。
    if (fromCheck) checks = [];
    save();
    renderCheck();
    $("announce").textContent = reply;
    pending = null;
    renderLog(true);
    renderLedger();
    renderRepair();
    renderNext();
    renderChips();
    renderBike();
    refreshSheet(true);
    return true;
  } catch (error) {
    if (current !== turnId) return false;
    pending = null;
    undo();
    // やめた時は、答えなしで送る前の状態に戻すだけ。
    if (controller.signal.aborted) {
      renderLog();
      renderChips();
      renderBike();
      $("input").focus();
      return false;
    }
    // 失敗の知らせは一度だけ見せ、残さない（もう一度送れば同じ所から続く）。
    session.log.push({ kind: "me", text: t[error.message] ?? t.failed });
    $("announce").textContent = t[error.message] ?? t.failed;
    renderLog();
    session.log.pop();
    renderChips();
    renderBike();
    return false;
  } finally {
    if (pendingEntry === mine) pendingEntry = null;
    clearInterval(timer);
    waiting.remove();
    if (pending?.node === waiting) pending = null;
    if (aborter === controller) aborter = null;
    // やり直しの後に古い応答が返っても、新しい相談の送り待ちを解かない。
    if (current === turnId) {
      sending = false;
      button.disabled = !ready();
      lockChecks();
      $("form").classList.remove("sending");
      setSend(t.send);
      micStatus("");
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
$("input").addEventListener("input", fitInput);

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
    fitInput();
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

// 項目の文に「、」があるので、結果は「／」でつなぐ。全部○の時も、何を○にしたかを台帳に残すため送る。
$("check-send").addEventListener("click", async () => {
  const results = t.checkItems.flatMap((item, index) => (checks[index] ? [`${item} ${checks[index]}`] : []));
  const message = `${t.checkResult}：${results.join("／")}`;
  const allGood = checks.every((mark) => !mark || mark === "○");
  $("check").open = false;
  // 送れなかった時は、点検の欄を開き直して、付けた印をそのまま残す。
  // 待ちの間に「最初からやり直す」を押した時は、新しい相談の点検を開かない。
  const asked = session;
  if (!(await send(message, { fromCheck: true, allGood })) && session === asked) $("check").open = true;
});

// 1枚の欄は打つたびに保存し、読み込み直しても消えないようにする。
$("f-where").addEventListener("change", (event) => { session.form.bought = event.target.selectedIndex; save(); refreshSheet(false); });
for (const [id, key] of [["f-when", "when"], ["f-what", "what"], ["f-trouble", "trouble"]]) {
  $(id).addEventListener("input", (event) => { session.form[key] = event.target.value; save(); refreshSheet(false); });
}

// 別の車の相談へ移った時に混ざらないよう、入力欄・1枚の欄・点検も空に戻す。
$("restart").addEventListener("click", () => {
  turnId += 1;
  sending = false;
  pending = null;
  aborter?.abort();
  stopListening();
  $("send").disabled = !ready();
  $("form").classList.remove("sending");
  setSend(t.send);
  session = emptySession();
  previous = {};
  checks = [];
  $("input").value = "";
  fitInput();
  $("sheet-text").value = "";
  $("sheet-text").hidden = true;
  $("sheet-view").hidden = true;
  $("sheet-view").replaceChildren();
  $("sheet-note").hidden = true;
  $("sheet").open = false;
  $("check").open = false;
  $("announce").textContent = "";
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
  // 作ってあった1枚も、見出しを新しい言語で作り直す。
  refreshSheet(false);
});

$("copy").addEventListener("click", async () => {
  const text = makeSheet();
  $("sheet-text").select();
  try {
    await navigator.clipboard.writeText(text);
    $("copy").textContent = t.copied;
    // 写せた時は紙の1枚だけを見せる。写せない時は文の欄を残して手で写せるようにする。
    $("sheet-text").hidden = true;
  } catch {
    $("copy").textContent = t.made;
  }
});

// 自分で開けない所の出口：1枚の欄を開いて、そこまでの内容で作る。
$("exit-make").addEventListener("click", () => {
  $("sheet").open = true;
  makeSheet();
  $("sheet-view").scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
});

// 「もう一度」は記録だけを取り直す。ページを読み込み直すと、入力中の相談文が消えるため。
$("retry").addEventListener("click", () => loadData());

// 記録の読み込みを待つ前に、車種の選択と入力欄を使えるようにしておく（待ちの間は「読み込んでいます」を出す）。
// 取れなかった時は、もう一度読み込む出口を出す。
session = load();
placeNext();
narrow.addEventListener("change", placeNext);
// 下の固定欄の実高（マイクの案内が出ると伸びる）に、本文の下の余白を合わせる。
new ResizeObserver(() => document.documentElement.style.setProperty("--dock", `${$("form").offsetHeight}px`)).observe($("form"));
renderAll();
async function loadData() {
  // 取り直している間は、送るボタン・話題の札・点検の送信のどれからも送れないようにする（ready() が false になる）。
  loaded = false;
  loadFailed = false;
  renderAll();
  $("load-failed").hidden = true;
  $("retry").disabled = true;
  let data = { cards: [], flows: [], draft: false };
  try {
    // 最初の起動は50秒ほどかかることがあるので、待つのは70秒まで。
    const response = await fetch("/api/cards", { signal: AbortSignal.timeout(70000) });
    if (!response.ok) throw new Error("failed");
    data = await response.json();
  } catch {
    loadFailed = true;
    $("load-failed").hidden = false;
  }
  $("retry").disabled = false;
  loaded = true;
  if (!loadFailed) {
    // 読み込み由来の通知だけ消す（マイクの案内など、別の通知は残す）。
    if ([t.loading, t.loadFailed].includes($("announce").textContent)) $("announce").textContent = "";
    if ([t.loading, t.loadFailed].includes($("mic-status").textContent)) micStatus("");
  }
  cards = data.cards ?? [];
  flows = data.flows ?? [];
  $("draft").hidden = !data.draft;
  renderAll();
  // 作ってあった1枚は、読み込み直した時も作り直して見せる。
  refreshSheet(false);
}
await loadData();
