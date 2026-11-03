// 大谷モードの画面。文は textContent で入れ、相談文をそのまま HTML にしない。
const $ = (id) => document.getElementById(id);
const NEEDS = ["工具なし", "簡単な工具", "分解が要る"];
const FIELD_NAMES = { symptom: "症状", scope: "車種の範囲", stop_here: "最後の一言", limits: "注意書き", ask: "聞く文", how: "見方", needs: "要るもの", if_yes: "はいの時", if_no: "いいえの時", cannot_tell: "これでは分からないこと", source: "出所", video_id: "動画", t: "時刻", line: "字幕" };
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;

let group = null;
let question = "";
let draft = null;
let original = null;
let busy = false;

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

async function post(path, body = {}) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-owner": "1" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (typeof data.spent === "number") $("spent").textContent = `$${data.spent.toFixed(3)}`;
  if (!response.ok) throw new Error(data.error ?? `失敗しました（${response.status}）`);
  return data;
}

// 待っている間はボタンを押せなくし、何をしているかを出す。
async function work(button, label, task) {
  if (busy) return;
  busy = true;
  // 一覧のボタンは中に件数などを持つので、文字を書き換えずに状態の行で知らせる。
  const inList = button.classList.contains("group");
  const before = [...button.childNodes];
  const started = Date.now();
  const tick = () => {
    const text = `${label} ${Math.round((Date.now() - started) / 1000)}秒`;
    if (inList) $("list-status").textContent = text;
    else button.textContent = text;
  };
  tick();
  const timer = setInterval(tick, 1000);
  document.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  try {
    await task();
  } catch (error) {
    alert(error.message);
  } finally {
    busy = false;
    clearInterval(timer);
    button.replaceChildren(...before);
    if (inList) $("list-status").textContent = "";
    document.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    $("apply").disabled = !draft || $("errors").children.length > 0;
  }
}

function groupItem(g) {
  const li = el("li");
  const button = el("button", null, "group");
  button.type = "button";
  button.append(el("span", g.title, "title"), el("span", `${g.count}件`, "count"));
  const note = [g.last ? `最後：${g.last.slice(0, 10)}` : "", g.covered_by ? `今の流れ「${g.covered_by}」で答えられるかも` : ""].filter(Boolean).join("　");
  if (note) button.append(el("span", note, "sub"));
  button.addEventListener("click", () => choose(g, button));
  li.append(button);
  return li;
}

async function loadGroups(refresh) {
  $("list-status").textContent = "まとめています（Claude）…";
  try {
    const data = await post("/api/questions", { refresh });
    const bike = data.groups.filter((g) => g.kind === "bike" && !g.covered_by);
    const covered = data.groups.filter((g) => g.kind === "bike" && g.covered_by);
    const others = data.groups.filter((g) => g.kind !== "bike");
    $("groups").replaceChildren(...bike.map(groupItem));
    $("covered-groups").replaceChildren(...covered.map(groupItem));
    $("covered").hidden = covered.length === 0;
    $("other-groups").replaceChildren(...others.map(groupItem));
    $("others").hidden = others.length === 0;
    const total = data.groups.reduce((n, g) => n + g.count, 0);
    $("list-status").textContent = total ? `${total}件を${data.groups.length}つにまとめました。` : "止まった相談はありません。";
  } catch (error) {
    $("list-status").textContent = error.message;
  }
}

function choose(g, button) {
  work(button, "1問を作っています…", async () => {
    group = g;
    draft = null;
    $("draft-box").hidden = true;
    $("result-box").hidden = true;
    $("try-result").hidden = true;
    $("answer").value = "";
    $("ask-title").textContent = `${g.title}（${g.count}件）`;
    $("examples").replaceChildren(...g.examples.map((text) => el("li", `「${text}」`)));
    $("ask-box").hidden = false;
    $("question").textContent = "作っています…";
    const data = await post("/api/ask", { groupId: g.id });
    question = data.question;
    $("question").textContent = question + (data.related_flow_id ? `（近い流れ：${data.related_flow_id}）` : "");
    $("ask-box").scrollIntoView({ behavior: "smooth" });
  });
}

function showDraft(data) {
  draft = data.draft;
  const isNew = draft.decision === "new";
  $("decision").textContent = `${isNew ? "新しい流れ" : "今の流れに足す"}「${draft.flow.id}：${draft.flow.symptom}」（車種：${draft.flow.scope}）。${draft.reason}`;
  $("conflicts").replaceChildren(...(draft.conflicts.length ? [el("p", "今ある流れと食い違う所", "label warn"),
    ...draft.conflicts.map((c) => el("p", `${c.flow_id}/${c.step_id}　今：${c.now}　／　大谷さん：${c.owner_said}`, "conflict"))] : []));
  $("unsaid").replaceChildren(...(draft.unsaid.length ? [el("p", "まだ確かめていないこと（アプリは「専門家に見てもらうほうが良いです」と言います）", "label"),
    el("ul", null, "unsaid")] : []));
  if (draft.unsaid.length) $("unsaid").lastChild.append(...draft.unsaid.map((u) => el("li", u)));
  renderPlain(data.current);
  $("words").textContent = original;
  renderDiff(data.diff);
  renderEdit(data.current);
  renderErrors(data.errors);
  $("draft-box").hidden = false;
  $("draft-box").scrollIntoView({ behavior: "smooth" });
}

// 大谷さんが確かめるのは、アプリが実際に聞く文と伝える文だけにする。細かい形は「くわしく」に回す。
function renderPlain(current) {
  const known = new Set((current?.steps ?? []).map((s) => s.id));
  const added = draft.flow.steps.filter((s) => !known.has(s.id));
  $("plain").replaceChildren(...added.map((step) => {
    const box = el("div", null, "plain");
    box.append(el("p", "アプリが聞くこと", "label"), el("p", step.ask, "big"), el("p", "アプリが伝えること", "label"), el("p", step.how, "big"));
    return box;
  }));
}

function show(value) {
  if (value === null || value === undefined) return "（なし）";
  return typeof value === "string" ? value : JSON.stringify(value, null, 1);
}

function renderDiff(rows) {
  const items = rows.map((row) => {
    const box = el("div", null, `diff ${row.kind}`);
    const head = { added: "足す", changed: "変わる", removed: "消える" }[row.kind];
    box.append(el("p", `${head}：${row.where}${row.field ? ` の ${FIELD_NAMES[row.field] ?? row.field}` : ""}`, "label"));
    if (row.field) {
      box.append(el("p", `今：${show(row.before)}`, "before"), el("p", `下書き：${show(row.after)}`, "after"));
    } else {
      const step = row.after ?? row.before;
      box.append(el("p", `聞く文：${step.ask}`), el("p", `見方：${step.how}`), el("p", `分からないこと：${step.cannot_tell}`, "sub"),
        el("p", `はい→${step.if_yes}　いいえ→${step.if_no}　要るもの：${step.needs}`, "sub"));
    }
    return box;
  });
  $("diff").replaceChildren(...(items.length ? items : [el("p", "違いはありません。", "sub")]));
}

// 直せるのは新しく足す確認と、新しい流れの症状だけ。今ある確認は下書きでも変えない。
function renderEdit(current) {
  const known = new Set((current?.steps ?? []).map((s) => s.id));
  const parts = [];
  if (draft.decision === "new") parts.push(field("症状", draft.flow.symptom, (v) => { draft.flow.symptom = v; }, false));
  for (const step of draft.flow.steps.filter((s) => !known.has(s.id))) {
    const box = el("div", null, "edit-step");
    box.append(el("p", step.id, "label"),
      field("聞く文", step.ask, (v) => { step.ask = v; }),
      field("見方（大谷さんの言葉から離れない）", step.how, (v) => { step.how = v; }),
      field("これでは分からないこと", step.cannot_tell, (v) => { step.cannot_tell = v; }));
    const select = el("select");
    NEEDS.forEach((n) => select.append(Object.assign(el("option", n), { value: n, selected: n === step.needs })));
    select.addEventListener("change", () => { step.needs = select.value; });
    const label = el("label", "要るもの", "label");
    label.append(select);
    box.append(label);
    parts.push(box);
  }
  $("edit").replaceChildren(...(parts.length ? parts : [el("p", "直せる所はありません。", "sub")]));
}

function field(name, value, onInput, multi = true) {
  const label = el("label", name, "label");
  const input = el(multi ? "textarea" : "input");
  input.value = value;
  if (multi) input.rows = 3;
  input.addEventListener("input", () => onInput(input.value));
  label.append(input);
  return label;
}

function renderErrors(errors) {
  $("errors").replaceChildren(...errors.map((e) => el("li", e, "warn")));
  $("apply").disabled = errors.length > 0;
}

$("make-draft").addEventListener("click", () => work($("make-draft"), "下書きを作っています…", async () => {
  original = $("answer").value.trim();
  if (!original) throw new Error("答えを書いてください");
  $("result-box").hidden = true;
  showDraft(await post("/api/draft", { groupId: group.id, question, answer: original }));
}));

$("recheck").addEventListener("click", () => work($("recheck"), "見直しています…", async () => {
  const data = await post("/api/check", { draft });
  renderDiff(data.diff);
  renderErrors(data.errors);
}));

$("cancel").addEventListener("click", () => {
  draft = null;
  $("draft-box").hidden = true;
});

$("apply").addEventListener("click", () => {
  if (!confirm("data/flows.json に反映し、大谷さんの言葉を確認メモに残します。よろしいですか？")) return;
  work($("apply"), "反映して確かめています…", async () => {
    const data = await post("/api/apply", { groupId: group.id, question, answer: original, draft });
    if (data.errors) return renderErrors(data.errors);
    $("result-head").textContent = data.applied
      ? "反映しました。カードの確認とテストは通りました。"
      : "確認かテストが落ちたので、flows.json と確認メモを元に戻しました。";
    $("result-head").className = data.applied ? "ok" : "warn";
    $("check-out").textContent = data.check?.out ?? "";
    $("test-out").textContent = data.test?.out ?? "";
    $("result-box").hidden = false;
    if (data.applied) {
      // 答え終わった質問の画面は閉じ、次の質問を選べるようにする。
      $("ask-box").hidden = true;
      $("answer").value = "";
      loadGroups(false);
      draft = null;
      $("draft-box").hidden = true;
    }
    $("result-box").scrollIntoView({ behavior: "smooth" });
  });
});

$("try").addEventListener("click", () => work($("try"), "答えさせています…", async () => {
  const data = await post("/api/try", { groupId: group.id });
  const box = $("try-result");
  box.replaceChildren(
    el("p", `相談：「${data.message}」`, "label"),
    el("div", null, "cols"),
  );
  const cols = box.lastChild;
  const before = el("div");
  before.append(el("p", "記録された時（止まった）", "label"), el("p", data.before, "before"));
  const now = el("div");
  now.append(el("p", data.now.stopped ? "今（まだ止まる）" : "今（答えた）", "label"), el("p", data.now.reply, data.now.stopped ? "before" : "after"));
  if (data.now.step) now.append(el("p", `使った確認：${data.now.step.flow_id}/${data.now.step.step_id}`, "sub"));
  cols.append(before, now);
  box.append(el("p", data.now.stopped ? "答えは変わっていません。" : "答えが変わりました。", data.now.stopped ? "warn" : "ok"));
  box.hidden = false;
}));

$("refresh").addEventListener("click", () => loadGroups(true));

$("dismiss").addEventListener("click", () => work($("dismiss"), "消しています…", async () => {
  if (!confirm("この相談を、答えずに一覧から消します。よろしいですか？")) return;
  await post("/api/dismiss", { groupId: group.id });
  $("ask-box").hidden = true;
  $("draft-box").hidden = true;
  await loadGroups(false);
}));

// 声の入力。使えないブラウザではボタンを出さない。
if (Recognition) {
  const recognizer = new Recognition();
  recognizer.lang = "ja-JP";
  recognizer.interimResults = false;
  recognizer.continuous = true;
  let listening = false;
  recognizer.addEventListener("result", (event) => {
    const said = [...event.results].slice(event.resultIndex).filter((r) => r.isFinal).map((r) => r[0].transcript).join("");
    $("answer").value = `${$("answer").value}${$("answer").value && !/\n$/.test($("answer").value) ? "\n" : ""}${said}`;
  });
  recognizer.addEventListener("end", () => {
    listening = false;
    $("voice").textContent = "声で入力";
  });
  $("voice").hidden = false;
  $("voice").addEventListener("click", () => {
    if (listening) return recognizer.stop();
    listening = true;
    $("voice").textContent = "止める";
    recognizer.start();
  });
}

loadGroups(false);
