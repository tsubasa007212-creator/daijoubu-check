import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { questionDelivery, sendQuestion } from "../src/config.mjs";

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

test("429 なら相手の言う待ち時間だけ待って送り直し、2回目で届けば true", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  let calls = 0;
  const post = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, text: async () => JSON.stringify({ message: "You are being rate limited.", retry_after: 0.05, global: false }), headers: { get: () => null } };
    return { ok: true, status: 200 };
  };
  assert.equal(await sendQuestion(entry, { url: "https://example.test/q", token: "abc", post }), true);
  assert.equal(calls, 2);
  assert.ok(JSON.stringify(warn.mock.calls.map((c) => c.arguments)).includes("retry_after=50ms"));
});

test("429 の待ち時間が長すぎる時と、回数を超えた時は諦める", async (t) => {
  t.mock.method(console, "warn", () => {});
  let calls = 0;
  const limited = async () => { calls += 1; return { ok: false, status: 429, text: async () => "", headers: { get: (k) => (k === "retry-after" ? "1" : null) } }; };
  assert.equal(await sendQuestion(entry, { url: "https://example.test/q", token: "abc", post: limited, retryMaxMs: 500 }), false);
  assert.equal(calls, 1);
  calls = 0;
  const short = async () => { calls += 1; return { ok: false, status: 429, text: async () => JSON.stringify({ retry_after: 0.01 }), headers: { get: () => null } }; };
  assert.equal(await sendQuestion(entry, { url: "https://example.test/q", token: "abc", post: short, retries: 2 }), false);
  assert.equal(calls, 3);
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


const webhook = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL";

test("届け先の判定：Discord の webhook はトークン無しで届く。それ以外はトークンが要る", () => {
  assert.equal(questionDelivery("", ""), null);
  assert.equal(questionDelivery("https://example.test/q", ""), null);
  assert.equal(questionDelivery("https://example.test/q", "abc"), "bearer");
  assert.equal(questionDelivery(webhook, ""), "discord");
  assert.equal(questionDelivery("http://example.com/q", "abc"), null);
  assert.equal(questionDelivery("https://discord.com/api/webhooks/not-a-webhook", ""), null);
});

const issues = "https://api.github.com/repos/example-owner/daijoubu-inbox/issues";

test("GitHub の issues の URL なら、トークンを付けて題と本文の形で送る。トークン無しでは送らない", async () => {
  assert.equal(questionDelivery(issues, ""), null);
  assert.equal(questionDelivery(issues, "ghp_x"), "github");
  let sent;
  const post = async (url, options) => { sent = { url, ...options }; return { ok: true, status: 201 }; };
  assert.equal(await sendQuestion({ at: "2026-11-06T03:04:05.000Z", message: "ベルトって何キロで替えるの" }, { url: issues, token: "ghp_x", post }), true);
  assert.equal(sent.headers.authorization, "Bearer ghp_x");
  assert.equal(sent.headers.accept, "application/vnd.github+json");
  const body = JSON.parse(sent.body);
  assert.equal(body.title, "止まった相談（2026/11/6 12:04:05）");
  assert.equal(body.body, "> ベルトって何キロで替えるの");
});

test("Discord の webhook には、相談の文と日本時間を本文にして、トークン無しで送る", async () => {
  let sent;
  const post = async (url, options) => { sent = { url, ...options }; return { ok: true }; };
  assert.equal(await sendQuestion({ at: "2026-11-06T03:04:05.000Z", message: "ベルトって何キロで替えるの\n2行目" }, { url: webhook, token: "", post }), true);
  assert.equal(sent.url, webhook);
  assert.equal(sent.headers.authorization, undefined);
  const body = JSON.parse(sent.body);
  assert.equal(body.username, "二輪問診");
  assert.ok(body.content.includes("2026/11/6 12:04:05"));
  assert.ok(body.content.includes("> ベルトって何キロで替えるの\n> 2行目"));
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
    const turn = (await response.json()).turn;
    assert.equal(turn.no_evidence, true);
    assert.ok(turn.reply.includes("整備士の大谷に届けます"));
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

test("壊れたJSONの本文は400で返す", async () => {
  await withServer(() => {}, async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(response.status, 400);
  });
});

test("外の宛先へは https でしか送らない", async () => {
  let called = false;
  const post = async () => { called = true; return { ok: true }; };
  assert.equal(await sendQuestion({ message: "x" }, { url: "http://example.com/q", token: "t", post }), false);
  assert.equal(called, false);
  assert.equal(await sendQuestion({ message: "x" }, { url: "https://example.com/q", token: "t", post }), true);
});
