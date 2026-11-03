// 大谷モードを実際の操作の順で最後まで通す。記録は写しを使い、Claude は偽物に差し替える。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 18821;
const FAKE = resolve("test/fixtures/owner-fake.mjs");

function setUp() {
  const root = mkdtempSync(join(tmpdir(), "owner-e2e-"));
  cpSync(resolve("data"), join(root, "data"), { recursive: true });
  // 試験で作る流れの名前が、本物の記録にもうあれば写しから外す。
  const flowsPath = join(root, "data/flows.json");
  writeFileSync(flowsPath, JSON.stringify(JSON.parse(readFileSync(flowsPath, "utf8")).filter((f) => f.id !== "winker"), null, 2));
  mkdirSync(join(root, "tools"), { recursive: true });
  cpSync(resolve("tools/check_cards.mjs"), join(root, "tools/check_cards.mjs"));
  mkdirSync(join(root, "private"), { recursive: true });
  const rows = ["ウインカーが点かない", "ウインカーがつかない", "ライトがつかない", "今日の天気は？"];
  writeFileSync(join(root, "private/questions.jsonl"), rows.map((message, i) => JSON.stringify({ at: `2026-11-03T0${i}:00:00Z`, message })).join("\n") + "\n");
  writeFileSync(join(root, "private/大谷さんの確認メモ.md"), "# 大谷さんの確認メモ（本人の発言そのまま）\n");
  return root;
}

async function start(root) {
  const server = spawn(process.execPath, [resolve("tools/owner/server.mjs")], {
    env: { ...process.env, ANTHROPIC_API_KEY: "", OWNER_ROOT: root, OWNER_FAKE: FAKE, OWNER_PORT: String(PORT), OWNER_TEST_COMMAND: "node tools/check_cards.mjs" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 50 && !log.includes("大谷モード"); i += 1) await new Promise((r) => setTimeout(r, 100));
  return { server, log: () => log };
}

async function post(path, body = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-owner": "1" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, 200, `${path}: ${data.error}`);
  return data;
}

// 一覧→1問→下書き→反映を2回続け、反映した相談と消した相談が一覧から消えることを確かめる。
async function answer(title, words) {
  const { groups } = await post("/api/questions", { refresh: false });
  const group = groups.find((g) => g.title === title);
  assert.ok(group, `一覧に「${title}」がない`);
  const { question } = await post("/api/ask", { groupId: group.id });
  const { draft, errors } = await post("/api/draft", { groupId: group.id, question, answer: words });
  assert.deepEqual(errors, []);
  const result = await post("/api/apply", { groupId: group.id, question, answer: words, draft });
  assert.equal(result.applied, true, JSON.stringify(result.check ?? result.errors));
  return draft;
}

test("大谷モードで2件続けて反映し、答えた相談と消した相談は一覧から消える", async () => {
  const root = setUp();
  const { server, log } = await start(root);
  try {
    await answer("ウインカーが点かない", "球切れかスイッチの不良");
    await answer("ライトがつかない", "カプラとヒューズ");
    let { groups } = await post("/api/questions", { refresh: false });
    assert.deepEqual(groups.map((g) => g.title), ["天気"]);
    await post("/api/dismiss", { groupId: groups[0].id });
    ({ groups } = await post("/api/questions", { refresh: true }));
    assert.deepEqual(groups, []);
    const flows = JSON.parse(readFileSync(join(root, "data/flows.json"), "utf8"));
    assert.ok(flows.some((f) => f.id === "winker" && f.human_check === "approved"));
    assert.ok(flows.find((f) => f.id === "light").steps.length >= 3);
    const memo = readFileSync(join(root, "private/大谷さんの確認メモ.md"), "utf8");
    assert.match(memo, /球切れかスイッチの不良/);
    assert.match(memo, /カプラとヒューズ/);
    assert.ok(existsSync(join(root, "private/owner_answered.json")));
  } catch (error) {
    error.message += `\n--- 大谷モードのログ ---\n${log()}`;
    throw error;
  } finally {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
