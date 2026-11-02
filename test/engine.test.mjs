import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyTurn, comparisons, ledger, newState } from "../src/engine.mjs";
import { checkTurn } from "../src/guard.mjs";

const cards = JSON.parse(readFileSync("data/cards.json", "utf8"));

test("回したのが友達と分かると、頼っていた比較だけ外れる", () => {
  let state = applyTurn(newState(), {
    added: [
      { id: "s1", text: "後ろを手で回しても普通", origin: "checked" },
      { id: "s2", text: "40キロくらいから音がする", origin: "checked" },
    ],
    links: [
      { statement_id: "s1", card_id: "lov-feel", observation_id: "feel" },
      { statement_id: "s2", card_id: "o49-speed", observation_id: "speed" },
    ],
  });
  state = applyTurn(state, { changed: [{ id: "s1", origin: "heard", reason: "回したのは友達" }] });
  const byCard = Object.fromEntries(comparisons(state).map((c) => [c.card_id, c.status]));
  assert.equal(byCard["lov-feel"], "released");
  assert.equal(byCard["o49-speed"], "active");
  assert.equal(ledger(state).heard[0].history[0].from, "checked");
});

test("元の状態は書き換えない", () => {
  const before = applyTurn(newState(), { added: [{ id: "s1", text: "x", origin: "checked" }] });
  applyTurn(before, { changed: [{ id: "s1", origin: "guess", reason: "y" }] });
  assert.equal(before.statements[0].origin, "checked");
});

test("カードに実在する場面だけ引ける", () => {
  const turn = { reply: "記録があります。", citations: [{ card_id: "lov-feel", scene_id: "nothing" }] };
  assert.ok(checkTurn(turn, cards, { requireHumanCheck: false }).some((e) => e.startsWith("scene not found")));
});

test("本人確認前のカードは出さない", () => {
  const turn = { reply: "記録があります。", citations: [{ card_id: "o49-speed", scene_id: "noise" }] };
  assert.ok(checkTurn(turn, cards).some((e) => e.startsWith("card not approved")));
});

test("大丈夫と言い切る返答を止める", () => {
  const turn = { reply: "それなら大丈夫です。", citations: [{ card_id: "lov-feel", scene_id: "feel" }] };
  assert.ok(checkTurn(turn, cards, { requireHumanCheck: false }).some((e) => e.startsWith("assertion")));
});

test("該当動画なしは根拠なしで通す", () => {
  assert.deepEqual(checkTurn({ reply: "該当動画なし", no_evidence: true }, cards), []);
});

test("比較が外れたカードは引かない", () => {
  const turn = { reply: "記録があります。", citations: [{ card_id: "lov-feel", scene_id: "feel" }] };
  const errors = checkTurn(turn, cards, { requireHumanCheck: false, released: ["lov-feel"] });
  assert.ok(errors.some((e) => e.startsWith("card released")));
});
