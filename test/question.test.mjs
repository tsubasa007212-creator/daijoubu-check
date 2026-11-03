import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sendQuestion } from "../src/config.mjs";

const entry = { at: "2026-11-03T00:00:00.000Z", message: "止まった質問" };

test("URLかトークンが無ければ、何も送らない", async () => {
  let called = 0;
  const post = async () => { called += 1; return { ok: true }; };
  assert.equal(await sendQuestion(entry, { url: "", token: "t", post }), false);
  assert.equal(await sendQuestion(entry, { url: "https://example.test/q", token: "", post }), false);
  assert.equal(called, 0);
});

test("設定があれば、トークンを付けて at と message を送る", async () => {
  let sent;
  const post = async (url, options) => { sent = { url, ...options }; return { ok: true }; };
  assert.equal(await sendQuestion(entry, { url: "https://example.test/q", token: "abc", post }), true);
  assert.equal(sent.url, "https://example.test/q");
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers.authorization, "Bearer abc");
  assert.deepEqual(JSON.parse(sent.body), entry);
  assert.ok(sent.signal instanceof AbortSignal);
});

test("送れなくても例外を出さず、相談文をログに出さない", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const options = { url: "https://example.test/q", token: "abc" };
  assert.equal(await sendQuestion(entry, { ...options, post: async () => { throw new Error(entry.message); } }), false);
  assert.equal(await sendQuestion(entry, { ...options, post: async () => ({ ok: false, status: 500 }) }), false);
  assert.ok(!JSON.stringify(warn.mock.calls.map((c) => c.arguments)).includes(entry.message));
});

test("相手が返事をしなければ、短い時間で切る", async (t) => {
  t.mock.method(console, "warn", () => {});
  const hang = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });
  const started = Date.now();
  assert.equal(await sendQuestion(entry, { url: "https://example.test/q", token: "abc", timeoutMs: 50, post: hang }), false);
  assert.ok(Date.now() - started < 2000);
});

// 本物のサーバーを動かして確かめる。Claude役も受け側も手元の偽物で、外へは出ない。
function listen(handler) {
  const server = createServer(handler);
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port })));
}

const fakeClaude = (req, res) => {
  req.resume();
  req.on("end", () => {
    const turn = { reply: "", citations: [], ask: null, no_evidence: true, added: [], changed: [], links: [] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "test", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify(turn) }], usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
};

async function withServer(receiver, run) {
  const claude = await listen(fakeClaude);
  const inbox = await listen(receiver);
  const free = await listen(() => {});
  const port = free.port;
  await new Promise((done) => free.server.close(done));
  const dir = mkdtempSync(join(tmpdir(), "daijoubu-question-"));
  cpSync("data", join(dir, "data"), { recursive: true });
  const child = spawn(process.execPath, [resolve("src/server.mjs")], {
    cwd: dir,
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PORT: String(port),
      ALLOW_UNCHECKED: "0",
      ANTHROPIC_API_KEY: "test",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${claude.port}`,
      QUESTION_URL: `http://127.0.0.1:${inbox.port}/q`,
      QUESTION_TOKEN: "test-token",
    },
  });
  try {
    await new Promise((done, fail) => {
      child.stdout.once("data", done);
      child.once("exit", () => fail(new Error("server stopped")));
    });
    await run({ port, dir });
  } finally {
    child.removeAllListeners("exit");
    const stopped = new Promise((done) => child.once("exit", done));
    child.kill();
    await stopped;
    inbox.server.closeAllConnections();
    claude.server.closeAllConnections();
    await Promise.all([inbox.server, claude.server].map((s) => new Promise((done) => s.close(done))));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const ask = (port) => fetch(`http://127.0.0.1:${port}/api/turn`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "カードに無い話", lang: "ja" }),
  signal: AbortSignal.timeout(8000),
});

test("止まった質問は受け側に届き、手元の控えにも残る", async () => {
  let got;
  const arrived = new Promise((done) => { got = done; });
  const receiver = (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200);
      res.end("{}");
      got({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    });
  };
  await withServer(receiver, async ({ port, dir }) => {
    const response = await ask(port);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).turn.no_evidence, true);
    const { auth, body } = await Promise.race([arrived, new Promise((_, fail) => setTimeout(() => fail(new Error("届かない")), 8000).unref())]);
    assert.equal(auth, "Bearer test-token");
    assert.equal(body.message, "カードに無い話");
    assert.ok(body.at);
    assert.equal(JSON.parse(readFileSync(join(dir, "private/questions.jsonl"), "utf8")).message, "カードに無い話");
  });
});

test("受け側が返事をしなくても、相談の返答は待たずに返る", async () => {
  await withServer(() => {}, async ({ port }) => {
    const started = Date.now();
    const response = await ask(port);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).turn.no_evidence, true);
    assert.ok(Date.now() - started < 2500);
  });
});

test("外の宛先へは https でしか送らない", async () => {
  let called = false;
  const post = async () => { called = true; return { ok: true }; };
  assert.equal(await sendQuestion({ message: "x" }, { url: "http://example.com/q", token: "t", post }), false);
  assert.equal(called, false);
  assert.equal(await sendQuestion({ message: "x" }, { url: "https://example.com/q", token: "t", post }), true);
});
