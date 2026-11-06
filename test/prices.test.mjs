import test from "node:test";
import assert from "node:assert/strict";
import { isPriceQuestion, pickPrices, priceTurn, PRICES } from "../src/prices.mjs";
import { checkTurn } from "../src/guard.mjs";

test("値段の質問だけを見分ける", () => {
  assert.equal(isPriceQuestion("いくらで直りますか"), true);
  assert.equal(isPriceQuestion("修理の費用はどのくらい？"), true);
  assert.equal(isPriceQuestion("How much does it cost?"), true);
  assert.equal(isPriceQuestion("スピードが出ない"), false);
});

test("相談の文とこれまでの発言から、関係する公開料金を3つまで選ぶ", () => {
  const belt = pickPrices("ベルトが切れたんだけど、いくらかかる？");
  assert.equal(belt.items[0].id, "belt-break");
  assert.ok(belt.items.length <= 3);
  const speed = pickPrices("いくらで直る？", { statements: [{ text: "スピードが出ない" }] });
  assert.ok(speed.items.some((i) => i.id === "drive"));
  const none = pickPrices("値段は？");
  assert.deepEqual(none.items.map((i) => i.id), ["inspect"]);
  assert.equal(none.source, PRICES.source);
});

test("英語の画面では英語の文で出す", () => {
  const en = pickPrices("How much for a battery?", null, "en");
  assert.equal(en.items[0].label, "Battery replacement");
  assert.match(en.note, /Otani's shop/);
});

test("値段だけの相談は止めず、大谷への止まった相談にもしない", () => {
  const turn = priceTurn("いくら？", null, "ja");
  assert.equal(turn.no_evidence, false);
  assert.equal(turn.topics, true);
  assert.match(turn.reply, /見積もりで決まります/);
  assert.equal(turn.price.items[0].id, "inspect");
});

test("Claudeの文に金額が入っていたら止める", () => {
  const base = { citations: [], no_evidence: false, step: { flow_id: "f", step_id: "s" } };
  const flows = [{ id: "f", human_check: "approved", steps: [{ id: "s" }] }];
  assert.ok(checkTurn({ ...base, reply: "目安は¥44,000です" }, [], { flows }).includes("money in reply"));
  assert.ok(checkTurn({ ...base, reply: "約62,000円でした" }, [], { flows }).includes("money in reply"));
  assert.ok(!checkTurn({ ...base, reply: "参考の料金は下に出します。" }, [], { flows }).includes("money in reply"));
});
