import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyTurn, comparisons, ledger, newState, releasedCards } from "../src/engine.mjs";
import { askStepOnly, checkTurn } from "../src/guard.mjs";
import { createLimiter, isValidState, trimState } from "../src/limits.mjs";
import { isSealed, seal } from "../src/seal.mjs";

const cards = JSON.parse(readFileSync("data/cards.json", "utf8"));
const flows = JSON.parse(readFileSync("data/flows.json", "utf8"));

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

test("1時間の回数を超えると止まり、時間が過ぎると戻る", () => {
  let t = 0;
  const allowed = createLimiter({ perHour: 2, perDay: 10, now: () => t });
  assert.equal(allowed("a"), true);
  assert.equal(allowed("a"), true);
  assert.equal(allowed("a"), false);
  assert.equal(allowed("b"), true);
  t = 60 * 60 * 1000;
  assert.equal(allowed("a"), true);
});

test("1日の上限は全員の合計で止まる", () => {
  const allowed = createLimiter({ perHour: 10, perDay: 2, now: () => 0 });
  allowed("a");
  allowed("b");
  assert.equal(allowed("c"), false);
});

test("形の崩れた台帳を受け取らない", () => {
  assert.equal(isValidState({ statements: [], links: [] }), true);
  assert.equal(isValidState({ statements: [{ id: "s1", text: "x", origin: "owner", history: [] }], links: [] }), false);
  assert.equal(isValidState({ statements: "x", links: [] }), false);
});

test("英語の言い切りも止める", () => {
  const turn = { reply: "Your bike is fine.", citations: [{ card_id: "lov-feel", scene_id: "feel" }] };
  assert.ok(checkTurn(turn, cards, { requireHumanCheck: false }).some((e) => e.startsWith("assertion")));
});

test("訂正で文も直り、元の文は履歴に残る", () => {
  let state = applyTurn(newState(), { added: [{ id: "s1", text: "40キロで音", origin: "checked" }] });
  state = applyTurn(state, { changed: [{ id: "s1", origin: "checked", text: "25キロくらいで音", reason: "メモを見た" }] });
  assert.equal(state.statements[0].text, "25キロくらいで音");
  assert.equal(state.statements[0].history[0].text, "40キロで音");
});

test("店へ行くようすすめる返答を止める", () => {
  const turn = { reply: "お店で見てもらいましょう。", citations: [{ card_id: "lov-feel", scene_id: "feel" }] };
  assert.ok(checkTurn(turn, cards, { requireHumanCheck: false }).some((e) => e.startsWith("assertion")));
});

test("言い切りでない否定の文は止めない", () => {
  const turn = { reply: "「大丈夫です」とは言えません。", citations: [{ card_id: "lov-feel", scene_id: "feel" }] };
  assert.deepEqual(checkTurn(turn, cards, { requireHumanCheck: false }), []);
});

test("言い換えと文中の断定を止める", () => {
  for (const reply of ["原因はベルトです。別の車の記録ではそうでした。", "走っても平気そうです。", "It\u2019s fine.", "You should take it to a shop."]) {
    const turn = { reply, citations: [{ card_id: "lov-feel", scene_id: "feel" }] };
    assert.ok(checkTurn(turn, cards, { requireHumanCheck: false }).includes("assertion in reply"), reply);
  }
});

test("最初から聞いた話の比較は外れない", () => {
  const state = applyTurn(newState(), {
    added: [{ id: "s1", text: "知人が音がすると言った", origin: "heard" }],
    links: [{ statement_id: "s1", card_id: "o49-speed", observation_id: "speed" }],
  });
  assert.equal(comparisons(state)[0].status, "active");
  assert.deepEqual(releasedCards(state), []);
});

test("長い台帳は収めて、次の送信で弾かれない", () => {
  const long = { id: "s1", text: "あ".repeat(500), origin: "checked", history: Array(9).fill({ from: "guess", text: "x", reason: "y" }) };
  assert.equal(isValidState(trimState({ statements: [long], links: [] })), true);
});

test("署名のない台帳を受け取らない", () => {
  const state = { statements: [], links: [] };
  assert.equal(isSealed(state, seal(state)), true);
  assert.equal(isSealed({ statements: [{}], links: [] }, seal(state)), false);
  assert.equal(isSealed(state, "x"), false);
});

test("該当動画なしと引用は同時に出せない", () => {
  const turn = { reply: "該当動画なし", no_evidence: true, citations: [{ card_id: "lov-feel", scene_id: "feel" }] };
  assert.ok(checkTurn(turn, cards, { requireHumanCheck: false }).includes("no_evidence with citations"));
});

test("本人確認前の流れは出さない", () => {
  const turn = { reply: "確かめましょう。", step: { flow_id: "start", step_id: "s1" } };
  assert.ok(checkTurn(turn, cards, { flows }).some((e) => e.startsWith("flow not approved")));
  assert.deepEqual(checkTurn(turn, cards, { flows, requireHumanCheck: false }), []);
});

test("流れにない確認は出さない", () => {
  const turn = { reply: "確かめましょう。", step: { flow_id: "start", step_id: "none" } };
  assert.ok(checkTurn(turn, cards, { flows, requireHumanCheck: false }).some((e) => e.startsWith("step not found")));
});

test("数字が訂正されたら、その発言の比較も外れる", () => {
  let state = applyTurn(newState(), {
    added: [{ id: "s1", text: "40キロで音", origin: "checked" }],
    links: [{ statement_id: "s1", card_id: "o49-speed", observation_id: "speed" }],
  });
  state = applyTurn(state, { changed: [{ id: "s1", origin: "checked", text: "25キロで音", reason: "メモ" }] });
  assert.equal(comparisons(state)[0].status, "released");
});

test("訂正の後に同じ比較を結び直せる", () => {
  let state = applyTurn(newState(), {
    added: [{ id: "s1", text: "40キロで音", origin: "checked" }],
    links: [{ statement_id: "s1", card_id: "o49-speed", observation_id: "speed" }],
  });
  state = applyTurn(state, {
    changed: [{ id: "s1", origin: "checked", text: "45キロで音", reason: "メモ" }],
    links: [{ statement_id: "s1", card_id: "o49-speed", observation_id: "speed" }],
  });
  assert.equal(comparisons(state)[0].status, "active");
});

test("言い切りで止まった時は、流れの問いだけを聞く", () => {
  const flows = [{ id: "speed", steps: [{ id: "s2", ask: "走行距離はどのくらいですか" }] }];
  const turn = { reply: "原因はベルトです", step: { flow_id: "speed", step_id: "s2" }, citations: [{ card_id: "a", scene_id: "b" }] };
  assert.equal(askStepOnly(turn, flows, ["assertion in reply"]).reply, "走行距離はどのくらいですか");
  assert.equal(askStepOnly(turn, flows, ["card released: a"]), null);
  assert.equal(askStepOnly({ ...turn, step: null }, flows, ["assertion in reply"]), null);
});
