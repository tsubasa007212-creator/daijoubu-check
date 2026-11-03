import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerOnce, checkDraft, checkGroups, costOf, diffFlow, mask, memoEntry, mergeFlows } from "../tools/owner/core.mjs";
import { GROUP_SCHEMA, groupQuestions, makeDraft } from "../tools/owner/prompt.mjs";

const cards = JSON.parse(readFileSync("data/cards.json", "utf8"));
// 本物の記録は大谷モードで増えるので、試験は決まった形の流れを使う。
const fixedStep = (id, extra = {}) => ({
  id, ask: "電球が切れていませんか", how: "最初に玉切れを見る。", needs: "工具なし", video_id: null, t: null, line: null,
  if_yes: "stop", if_no: "stop", cannot_tell: "見方は、まだ確かめていない。", source: "owner", ...extra,
});
const flows = [
  { id: "light", symptom: "ライトがつかない", human_check: "approved", scope: "all",
    steps: [fixedStep("s1", { if_no: "s2" }), fixedStep("s2")], stop_here: "ここから先は、専門家に見てもらうほうが良いです。", limits: [] },
  { id: "start", symptom: "エンジンがかからない", human_check: "pending", scope: "gyro",
    steps: [fixedStep("s1")], stop_here: "", limits: [] },
];

const ownerStep = (id, extra = {}) => ({
  id, ask: "どのライトですか", how: "最初に玉切れを見る。", needs: "工具なし", video_id: null, t: null, line: null,
  if_yes: "stop", if_no: "stop", cannot_tell: "見方は、まだ確かめていない。", source: "owner", ...extra,
});
const newDraft = (steps) => ({
  decision: "new", reason: "合う流れがない",
  flow: { id: "winker", symptom: "ウインカーが点かない", scope: "all", steps, stop_here: "ここから先は、専門家に見てもらうほうが良いです。", limits: [] },
  conflicts: [], unsaid: [],
});

test("電話・ナンバー・名前を伏せ、走行距離や年式は残す", () => {
  assert.equal(mask("090-1234-5678に電話ください"), "［電話］に電話ください");
  assert.equal(mask("品川 300 あ 12-34 のジャイロ"), "［ナンバー］ のジャイロ");
  assert.equal(mask("ナンバーは足立あ1234です"), "ナンバーは［ナンバー］です");
  assert.equal(mask("名前は山田太郎です"), "名前は［名前］です");
  assert.equal(mask("田中と申します。ライトがつかない"), "［名前］と申します。ライトがつかない");
  assert.equal(mask("走行は30000キロ、2015年式"), "走行は30000キロ、2015年式");
  assert.equal(mask("ナンバー灯がつかない"), "ナンバー灯がつかない");
});

test("まとめは番号を1回ずつだけ使い、漏れは1件ずつ足し、多い順に並べる", () => {
  const entries = ["a", "b", "c", "d"].map((text, i) => ({ at: `2026-11-0${i + 1}`, text }));
  const raw = { groups: [
    { title: "天気", kind: "not_bike", members: [3], covered_by: null },
    { title: "少ない", kind: "bike", members: [0, 0, 9], covered_by: "nothing" },
    { title: "多い", kind: "bike", members: [0, 1, 2], covered_by: "light" },
  ] };
  const groups = checkGroups(raw, entries, ["light"]);
  assert.deepEqual(groups.map((g) => [g.title, g.count]), [["多い", 2], ["少ない", 1], ["天気", 1]]);
  assert.equal(groups[0].covered_by, "light");
  assert.equal(groups.find((g) => g.title === "少ない").covered_by, null);
  assert.equal(groups.at(-1).kind, "not_bike");
  assert.equal(groups.reduce((n, g) => n + g.count, 0), 4);
  assert.equal(groups[0].last, "2026-11-03");
});

test("新しい流れの下書きは、大谷さんの話の形なら通る", () => {
  assert.deepEqual(checkDraft(newDraft([ownerStep("s1", { if_no: "s2" }), ownerStep("s2")]), flows, cards), []);
});

test("新しい確認に動画の欄や行き先のない所があれば止める", () => {
  const errors = checkDraft(newDraft([ownerStep("s1", { video_id: "abc", if_no: "s9" })]), flows, cards);
  assert.ok(errors.some((e) => e.includes("動画の欄")));
  assert.ok(errors.some((e) => e.includes("行き先がありません: s9")));
});

test("どこからもつながっていない確認を止める", () => {
  const errors = checkDraft(newDraft([ownerStep("s1"), ownerStep("s2")]), flows, cards);
  assert.ok(errors.some((e) => e.includes("つながっていない確認があります: s2")));
});

test("確認前の流れには足せず、今の確認の中身は変えられない", () => {
  const pending = flows.find((f) => f.human_check !== "approved");
  assert.ok(checkDraft({ decision: "add_to", flow: structuredClone(pending) }, flows, cards).some((e) => e.startsWith("確認前の流れには足せません")));
  const light = structuredClone(flows.find((f) => f.id === "light"));
  light.steps[0].how = "別の話";
  assert.ok(checkDraft({ decision: "add_to", flow: light }, flows, cards).some((e) => e.includes("中身が変わっています: s1")));
});

test("今の流れに足す時は、つなぎ先だけ変えてよい", () => {
  const light = structuredClone(flows.find((f) => f.id === "light"));
  light.steps[1].if_no = "s3";
  light.steps.push(ownerStep("s3"));
  assert.deepEqual(checkDraft({ decision: "add_to", flow: light }, flows, cards), []);
  const rows = diffFlow(flows.find((f) => f.id === "light"), light);
  assert.deepEqual(rows.map((r) => [r.kind, r.where, r.field]), [["changed", "s2", "if_no"], ["added", "s3", null]]);
});

test("差分は消えた確認も出す", () => {
  const light = flows.find((f) => f.id === "light");
  const rows = diffFlow(light, { ...light, steps: light.steps.slice(0, 1) });
  assert.deepEqual(rows.map((r) => [r.kind, r.where]), [["removed", "s2"]]);
  assert.ok(diffFlow(null, light).every((r) => r.kind === "added"));
});

test("反映後の流れは確認済みになり、他の流れの並びは変えない", () => {
  const merged = mergeFlows(flows, newDraft([ownerStep("s1")]));
  assert.equal(merged.length, flows.length + 1);
  assert.equal(merged.at(-1).human_check, "approved");
  assert.deepEqual(merged.slice(0, -1), flows);
});

test("確認メモには大谷さんの言葉をそのまま残す", () => {
  const text = memoEntry("2026-11-03", { title: "ライト", count: 2, examples: ["ライトがつかない"], question: "最初に何を見ますか？", answer: "玉切れ。\nそれから配線" });
  assert.match(text, /## 2026-11-03 大谷モード：ライト/);
  assert.match(text, /  玉切れ。\n  それから配線/);
});

test("Claudeへの頼み方は structured outputs で、偽物の答えを読める", async () => {
  let sent = null;
  const client = { beta: { messages: { create: async (params) => {
    sent = params;
    return { stop_reason: "end_turn", content: [{ type: "text", text: '{"groups":[]}' }], usage: { input_tokens: 1000, output_tokens: 100 } };
  } } } };
  const { result, usage } = await groupQuestions(client, { messages: ["ライトがつかない"], flows });
  assert.deepEqual(result, { groups: [] });
  assert.equal(sent.output_config.format.schema, GROUP_SCHEMA);
  assert.match(sent.messages[0].content, /ライトがつかない/);
  assert.equal(costOf(usage), 0.006);
});

test("Claudeが途中で止まったら下書きにしない", async () => {
  const client = { beta: { messages: { create: async () => ({ stop_reason: "max_tokens", content: [] }) } } };
  await assert.rejects(makeDraft(client, { group: { title: "x", examples: [] }, question: "q", answer: "a", flows }), /max_tokens/);
});

test("試す時は確認済みの流れだけで答え、根拠がなければ止まる", async () => {
  const seen = [];
  const read = async (input) => {
    seen.push(input);
    return { turn: { kind: "symptom", added: [], changed: [], links: [], citations: [], ask: null, step: { flow_id: "light", step_id: "s1" }, reply: "どのライトがつきませんか。", no_evidence: false } };
  };
  const now = await answerOnce(read, { cards, flows, message: "ライトがつかない" });
  assert.equal(now.stopped, false);
  assert.ok(seen[0].flows.every((f) => f.human_check === "approved"));
  assert.ok(seen[0].cards.every((c) => c.human_check === "approved"));
  const stopped = await answerOnce(async () => ({ turn: { kind: "symptom", added: [], changed: [], links: [], citations: [], ask: null, step: null, reply: "まだ確かめていない話です。", no_evidence: true } }), { cards, flows, message: "x" });
  assert.equal(stopped.stopped, true);
});
