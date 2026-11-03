// 大谷モードの中身。ファイルもClaudeも触らない関数だけを置き、テストで確かめる。
import { applyTurn, newState, releasedCards } from "../../src/engine.mjs";
import { askStepOnly, checkTurn, fixedTurn } from "../../src/guard.mjs";
import { FIXED_REPLY, STOP_REPLY } from "../../src/config.mjs";
import { trimState } from "../../src/limits.mjs";

const NAME = "[一-龥々ァ-ヶー]{1,6}(?:[ 　][一-龥々ァ-ヶー]{1,6})?";
const MASKS = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, () => "［メール］"],
  // 0で始まる9桁以上の番号。走行距離や年式は0で始まらないので残る。
  [/(?:\+81[-\s]?|0)\d{1,4}[-\s(（]?\d{1,4}[-\s)）]?\d{3,4}/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "［電話］" : m)],
  [/[一-龥ぁ-んァ-ヶ]{1,4}\s*\d{1,3}\s*[ぁ-ん]\s*\d{1,2}[-‐－ー・]?\d{2}/g, () => "［ナンバー］"],
  [/(ナンバー(?:は|:|：)\s*)[^\s、。]*\d/g, (m, head) => `${head}［ナンバー］`],
  [new RegExp(`((?:名前は|氏名は?[:：]?)\\s*)${NAME}`, "g"), (m, head) => `${head}［名前］`],
  [new RegExp(`${NAME}(?=と申します|といいます|って言います)`, "g"), () => "［名前］"],
];

// 名前・電話・ナンバーらしきものを伏せる。画面とClaudeには伏せた後の文だけを渡す。
export function mask(text) {
  return MASKS.reduce((s, [pattern, replace]) => s.replace(pattern, replace), String(text));
}

// Claudeのまとめを確かめる。番号は1回ずつ、範囲内だけ。漏れた相談は1件ずつのまとまりにする。
export function checkGroups(raw, entries, flowIds = []) {
  const seen = new Set();
  const kinds = new Set(["bike", "not_bike", "attack"]);
  const groups = [];
  for (const g of raw?.groups ?? []) {
    const members = [];
    for (const n of g.members ?? []) {
      if (!Number.isInteger(n) || n < 0 || n >= entries.length || seen.has(n)) continue;
      seen.add(n);
      members.push(n);
    }
    if (members.length === 0 || typeof g.title !== "string" || !g.title.trim()) continue;
    groups.push({ title: g.title.trim(), kind: kinds.has(g.kind) ? g.kind : "bike", members, covered_by: flowIds.includes(g.covered_by) ? g.covered_by : null });
  }
  entries.forEach((e, n) => {
    if (!seen.has(n)) groups.push({ title: e.text.slice(0, 40), kind: "bike", members: [n], covered_by: null });
  });
  const order = { bike: 0, not_bike: 1, attack: 2 };
  return groups
    .map((g, i) => ({
      ...g,
      id: `g${i + 1}`,
      count: g.members.length,
      examples: [...new Set(g.members.map((n) => entries[n].text))].slice(0, 5),
      last: g.members.map((n) => entries[n].at).sort().at(-1) ?? null,
    }))
    .sort((a, b) => order[a.kind] - order[b.kind] || b.count - a.count);
}

const NEEDS = ["工具なし", "簡単な工具", "分解が要る"];
const SAME_STEP_FIELDS = ["ask", "how", "needs", "video_id", "t", "line", "cannot_tell", "source"];

// 下書きの形を確かめる。今ある確認の中身は変えさせず、新しい確認は大谷の話の形だけ通す。
export function checkDraft(draft, flows, cards = []) {
  const errors = [];
  const flow = draft?.flow;
  if (!flow || !Array.isArray(flow.steps) || flow.steps.length === 0) return ["流れに確認がありません"];
  const current = flows.find((f) => f.id === flow.id) ?? null;
  if (draft.decision === "add_to") {
    if (!current) errors.push(`足す先の流れがありません: ${flow.id}`);
    else if (current.human_check !== "approved") errors.push(`確認前の流れには足せません（反映すると全体が確認済みになるため）: ${flow.id}`);
  } else if (draft.decision === "new") {
    if (current) errors.push(`同じ id の流れがもうあります: ${flow.id}`);
    if (!/^[a-z][a-z0-9_]*$/.test(flow.id ?? "")) errors.push(`id は英小文字にしてください: ${flow.id}`);
  } else errors.push("足すか新しく作るかが決まっていません");
  if (!String(flow.symptom ?? "").trim()) errors.push("症状が空です");
  if (!["all", "gyro", "scooter"].includes(flow.scope)) errors.push(`車種の範囲が不正です: ${flow.scope}`);

  const ids = flow.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) errors.push("確認の id が重なっています");
  const before = current && draft.decision === "add_to" ? current.steps : [];
  for (const old of before) {
    const now = flow.steps.find((s) => s.id === old.id);
    if (!now) errors.push(`今の確認が消えています: ${old.id}`);
    else if (SAME_STEP_FIELDS.some((k) => (now[k] ?? null) !== (old[k] ?? null))) errors.push(`今の確認の中身が変わっています: ${old.id}`);
  }
  const oldTargets = new Set(before.flatMap((s) => [s.if_yes, s.if_no]));
  const reached = new Set([ids[0]]);
  for (const step of flow.steps) {
    for (const target of [step.if_yes, step.if_no]) {
      reached.add(target);
      if (target === "stop" || ids.includes(target)) continue;
      const card = String(target).startsWith("cards:") && cards.some((c) => c.id === target.slice(6));
      if (!card || !oldTargets.has(target)) errors.push(`${step.id} の行き先がありません: ${target}`);
    }
    if (before.some((s) => s.id === step.id)) continue;
    if (!/^s\d+$/.test(step.id ?? "")) errors.push(`確認の id は s1 の形にしてください: ${step.id}`);
    if (step.source !== "owner") errors.push(`${step.id}: 新しい確認は大谷さんの話（owner）だけです`);
    if (step.video_id !== null || step.t !== null || step.line !== null) errors.push(`${step.id}: 動画の欄は空にしてください`);
    for (const key of ["ask", "how", "cannot_tell"]) if (!String(step[key] ?? "").trim()) errors.push(`${step.id}: ${key} が空です`);
    if (!NEEDS.includes(step.needs)) errors.push(`${step.id}: 要るものは ${NEEDS.join("・")} のどれかです`);
  }
  for (const id of ids) if (!reached.has(id)) errors.push(`どこからもつながっていない確認があります: ${id}`);
  return errors;
}

const FLOW_FIELDS = ["symptom", "scope", "stop_here", "limits"];
const STEP_FIELDS = ["ask", "how", "needs", "if_yes", "if_no", "cannot_tell", "source", "video_id", "t", "line"];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// 今の流れと下書きの違い。画面はこの行をそのまま並べる。
export function diffFlow(before, after) {
  const rows = [];
  for (const field of FLOW_FIELDS) {
    if (!same(before?.[field], after?.[field])) rows.push({ kind: before ? "changed" : "added", where: "流れ", field, before: before?.[field] ?? null, after: after?.[field] ?? null });
  }
  const oldSteps = before?.steps ?? [];
  const newSteps = after?.steps ?? [];
  for (const step of newSteps) {
    const old = oldSteps.find((s) => s.id === step.id);
    if (!old) {
      rows.push({ kind: "added", where: step.id, field: null, before: null, after: step });
      continue;
    }
    for (const field of STEP_FIELDS) {
      if (!same(old[field], step[field])) rows.push({ kind: "changed", where: step.id, field, before: old[field] ?? null, after: step[field] ?? null });
    }
  }
  for (const old of oldSteps) {
    if (!newSteps.some((s) => s.id === old.id)) rows.push({ kind: "removed", where: old.id, field: null, before: old, after: null });
  }
  return rows;
}

// 反映後の flows.json の中身。確認済みにし、今の並びを保つ。
export function mergeFlows(flows, draft) {
  const f = draft.flow;
  const next = { id: f.id, symptom: f.symptom, human_check: "approved", scope: f.scope, steps: f.steps, stop_here: f.stop_here, limits: f.limits };
  const at = flows.findIndex((x) => x.id === f.id);
  return at >= 0 ? flows.map((x, i) => (i === at ? next : x)) : [...flows, next];
}

// 確認メモに足す文。大谷さんの答えは直さずにそのまま残す。
export function memoEntry(date, { title, count, examples, question, answer }) {
  const quoted = String(answer).split(/\r?\n/).map((line) => `  ${line}`).join("\n");
  return `\n## ${date} 大谷モード：${title}\n\n- 止まった相談：${count}件（例：「${examples[0] ?? ""}」）\n- 聞いたこと：${question}\n- 答え（本人の言葉のまま）：\n${quoted}\n`;
}

// 1回分の費用の目安（ドル）。claude-opus-5-5 の入力 $4、書き込み $5、読み出し $0.2、出力 $20（100万トークンあたり）。
export function costOf(usage) {
  if (!usage) return 0;
  return ((usage.input_tokens ?? 0) * 4 + (usage.cache_creation_input_tokens ?? 0) * 5 + (usage.cache_read_input_tokens ?? 0) * 0.2 + (usage.output_tokens ?? 0) * 20) / 1e6;
}

// 公開版の answer と同じ順番で1回答える。確認済みのカードと流れだけを使う。
export async function answerOnce(read, { cards, flows, message, lang = "ja" }) {
  const usable = { cards: cards.filter((c) => c.human_check === "approved"), flows: flows.filter((f) => f.human_check === "approved") };
  const state = newState();
  const stop = () => ({ reply: STOP_REPLY[lang] ?? STOP_REPLY.ja, no_evidence: true, step: null, stopped: true });
  let hint = null;
  let stepOnly = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { turn } = await read({ ...usable, state, message, previousReply: "", hint });
      const next = trimState(applyTurn(state, turn));
      const fixed = fixedTurn(turn, lang, FIXED_REPLY);
      if (fixed) return { reply: fixed.reply, no_evidence: false, step: null, stopped: false };
      const errors = checkTurn(turn, usable.cards, { requireHumanCheck: true, released: releasedCards(next), statementIds: next.statements.map((s) => s.id), flows: usable.flows });
      if (errors.length === 0) return turn.no_evidence ? stop() : { reply: turn.reply, no_evidence: false, step: turn.step, stopped: false };
      hint = errors.join(", ");
      stepOnly = askStepOnly(turn, usable.flows, errors);
    } catch {
      hint = "返答の形が正しくありませんでした";
    }
  }
  return stepOnly ? { reply: stepOnly.reply, no_evidence: false, step: stepOnly.step, stopped: false } : stop();
}
