import test from "node:test";
import assert from "node:assert/strict";
import { isPriceQuestion, pickPrices, PRICES } from "../src/prices.mjs";
import { checkTurn } from "../src/guard.mjs";

test("値段の質問だけを見分ける", () => {
  assert.equal(isPriceQuestion("いくらで直りますか"), true);
  assert.equal(isPriceQuestion("修理の費用はどのくらい？"), true);
  assert.equal(isPriceQuestion("How much does it cost?"), true);
  assert.equal(isPriceQuestion("スピードが出ない"), false);
  // 「高い」「安い」だけでは値段の質問にしない。
  assert.equal(isPriceQuestion("タイヤの空気圧が高い"), false);
});

test("関係のない料金を選ばない（電球が切れた、はベルト切れではない）", () => {
  const bulb = pickPrices("ヘッドライトの電球が切れた。修理代はいくら？");
  assert.deepEqual(bulb.items.map((i) => i.id), ["inspect"]);
  assert.equal(pickPrices("ベルト切れかも。いくら？").items[0].id, "belt-break");
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

test("Claudeの文に金額が入っていたら止める", () => {
  const base = { citations: [], no_evidence: false, step: { flow_id: "f", step_id: "s" } };
  const flows = [{ id: "f", human_check: "approved", steps: [{ id: "s" }] }];
  assert.ok(checkTurn({ ...base, reply: "目安は¥44,000です" }, [], { flows }).includes("money in reply"));
  assert.ok(checkTurn({ ...base, reply: "約62,000円でした" }, [], { flows }).includes("money in reply"));
  assert.ok(!checkTurn({ ...base, reply: "参考の料金は下に出します。" }, [], { flows }).includes("money in reply"));
});

test("金額の言い方を変えても止める（漢数字・全角・万円・ドル）", () => {
  const base = { citations: [], no_evidence: false, step: { flow_id: "f", step_id: "s" } };
  const flows = [{ id: "f", human_check: "approved", steps: [{ id: "s" }] }];
  for (const reply of ["修理代は一万円です。", "目安は１０，０００円です。", "修理代は1.5万円です。", "It costs $100."]) {
    assert.ok(checkTurn({ ...base, reply }, [], { flows }).includes("money in reply"), reply);
  }
  assert.ok(!checkTurn({ ...base, reply: "2回目の確認です。10分ほど置いてから見てください。" }, [], { flows }).includes("money in reply"));
});

test("否定のあとの「でも」の言い切りと、英語の走行依頼も止める", () => {
  const base = { citations: [], no_evidence: false, step: { flow_id: "f", step_id: "s" } };
  const flows = [{ id: "f", human_check: "approved", steps: [{ id: "s" }] }];
  assert.ok(checkTurn({ ...base, reply: "安全とは言えません、でも問題ありません。" }, [], { flows }).includes("assertion in reply"));
  assert.ok(checkTurn({ ...base, reply: "Please ride and check whether the noise changes." }, [], { flows }).includes("assertion in reply"));
  assert.ok(!checkTurn({ ...base, reply: "安全とは言えません。次は音を思い出してください。" }, [], { flows }).includes("assertion in reply"));
});
