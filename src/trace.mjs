// 返答のたびに「中で起きたこと」を数える。画面に1行で出す。
// Claudeの文ではなく、プログラムが数えた事実だけ（分けた発言・使った記録・検査の結果・外した比較・回数・秒）。
import { comparisons } from "./engine.mjs";
import { MODEL } from "./config.mjs";

// 検査の理由を、画面で言える短い印にする。
const CODES = [
  ["assertion in reply", "assertion"],
  ["money in reply", "money"],
  ["reply has no evidence", "no_evidence"],
  ["card released", "released"],
  ["not approved", "unapproved"],
  ["no_evidence with citations", "contradiction"],
  ["reply too long", "long"],
  ["not found", "unknown_ref"],
  ["not on card", "unknown_ref"],
];

export function traceCode(error) {
  for (const [match, code] of CODES) if (String(error).includes(match)) return code;
  return "shape";
}

export function traceCodes(errors) {
  return [...new Set(errors.map(traceCode))];
}

export function traceOf({ before, after, turn, flows = [], calls = 0, retried = null, outcome, ms = 0, price = false }) {
  const was = new Map(before.statements.map((s) => [s.id, s]));
  const added = after.statements.filter((s) => !was.has(s.id));
  const changed = after.statements.filter((s) => was.has(s.id) && (was.get(s.id).origin !== s.origin || was.get(s.id).text !== s.text)).length;
  const origins = {};
  for (const s of added) origins[s.origin] = (origins[s.origin] ?? 0) + 1;
  const active = (state) => new Set(comparisons(state).filter((c) => c.status === "active").map((c) => c.card_id));
  const activeAfter = active(after);
  const released = [...active(before)].filter((id) => !activeAfter.has(id)).length;
  const flow = turn.step ? flows.find((f) => f.id === turn.step.flow_id) : null;
  const stepIndex = flow ? flow.steps.findIndex((s) => s.id === turn.step.step_id) + 1 : 0;
  return {
    model: MODEL,
    calls,
    ms,
    outcome,
    retried,
    read: { added: added.length, changed, origins },
    evidence: {
      citations: (turn.citations ?? []).length,
      links: (turn.links ?? []).length,
      flow: flow ? { symptom: flow.symptom, step: stepIndex, of: flow.steps.length } : null,
    },
    released,
    price,
  };
}
