import test from "node:test";
import assert from "node:assert/strict";
import { traceCode, traceCodes, traceOf } from "../src/trace.mjs";
import { applyTurn, newState } from "../src/engine.mjs";

const flows = [{ id: "speed", symptom: "スピードが出ない", human_check: "approved", steps: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] }];

test("検査の理由を短い印にする", () => {
  assert.equal(traceCode("assertion in reply"), "assertion");
  assert.equal(traceCode("money in reply"), "money");
  assert.equal(traceCode("scene not found: a/b"), "unknown_ref");
  assert.equal(traceCode("card not approved: a"), "unapproved");
  assert.deepEqual(traceCodes(["assertion in reply", "assertion in reply", "reply too long"]), ["assertion", "long"]);
});

test("分けた発言・使った記録・流れの位置・回数を数える", () => {
  const before = newState();
  const turn = {
    added: [{ id: "a1", text: "スピードが出ない", origin: "checked" }, { id: "a2", text: "兄がプラグを替えた", origin: "heard" }],
    citations: [{ card_id: "c", scene_id: "s" }],
    step: { flow_id: "speed", step_id: "s2" },
  };
  const after = applyTurn(before, turn);
  const trace = traceOf({ before, after, turn, flows, calls: 1, outcome: "answered", ms: 7200 });
  assert.equal(trace.calls, 1);
  assert.equal(trace.ms, 7200);
  assert.deepEqual(trace.read, { added: 2, changed: 0, origins: { checked: 1, heard: 1 } });
  assert.equal(trace.evidence.citations, 1);
  assert.deepEqual(trace.evidence.flow, { symptom: "スピードが出ない", step: 2, of: 3 });
  assert.equal(trace.released, 0);
  assert.equal(trace.retried, null);
});

test("言い直しで移した発言と、外した比較を数える", () => {
  const first = applyTurn(newState(), {
    added: [{ id: "a1", text: "プラグを見た", origin: "checked" }],
    links: [{ statement_id: "a1", card_id: "c1", observation_id: "o1" }],
  });
  const turn = { changed: [{ id: "a1", origin: "heard", reason: "見たのは兄" }], citations: [], no_evidence: false };
  const after = applyTurn(first, turn);
  const trace = traceOf({ before: first, after, turn, flows, calls: 2, retried: ["assertion"], outcome: "answered", ms: 9000 });
  assert.deepEqual(trace.read, { added: 0, changed: 1, origins: {} });
  assert.equal(trace.released, 1);
  assert.deepEqual(trace.retried, ["assertion"]);
  assert.equal(trace.evidence.flow, null);
});
