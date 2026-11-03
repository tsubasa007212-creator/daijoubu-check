// 大谷モードのサーバー。手元専用なので 127.0.0.1 だけで待ち受ける。git の操作はしない。
import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, readTurn } from "../../src/claude.mjs";
import { STOP_REPLY } from "../../src/config.mjs";
import { answerOnce, checkDraft, checkGroups, costOf, diffFlow, mask, memoEntry, mergeFlows } from "./core.mjs";
import { groupQuestions, makeDraft, makeQuestion } from "./prompt.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HERE = fileURLToPath(new URL("./", import.meta.url));
const PORT = 8820;
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const FILES = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/style.css": ["style.css", "text/css; charset=utf-8"] };
const FLOWS = join(ROOT, "data/flows.json");
const CARDS = join(ROOT, "data/cards.json");
const QUESTIONS = join(ROOT, "private/questions.jsonl");
const MEMO = join(ROOT, "private/大谷さんの確認メモ.md");
const client = createClient();
let spent = 0;
const CACHE = join(ROOT, "private/owner_groups.json");
let cached = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : { key: null, groups: [] };
let applying = false;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeLf = (path, text) => writeFileSync(path, text.replace(/\r\n/g, "\n"));
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

function track(usage) {
  const cost = costOf(usage);
  spent += cost;
  return cost;
}

// 止まった相談を読み、伏せ字にしてから使う。壊れた行は飛ばす。
function readQuestions() {
  if (!existsSync(QUESTIONS)) return { raw: "", entries: [] };
  const raw = readFileSync(QUESTIONS, "utf8");
  const entries = raw.split("\n").flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return typeof row.message === "string" && row.message.trim() ? [{ at: row.at ?? null, text: mask(row.message.trim()) }] : [];
    } catch {
      return [];
    }
  });
  return { raw, entries };
}

async function listGroups(refresh) {
  const { raw, entries } = readQuestions();
  const key = createHash("sha1").update(raw).digest("hex");
  if (!refresh && cached.key === key) return { groups: cached.groups, cost: 0 };
  if (entries.length === 0) return { groups: [], cost: 0 };
  const flows = readJson(FLOWS);
  const { result, usage } = await groupQuestions(client, { messages: entries.map((e) => e.text), flows });
  cached = { key, groups: checkGroups(result, entries, flows.map((f) => f.id)) };
  writeLf(CACHE, JSON.stringify(cached));
  return { groups: cached.groups, cost: track(usage) };
}

function groupOf(id) {
  const group = cached.groups.find((g) => g.id === id);
  if (!group) throw Object.assign(new Error("一覧を読み直してください"), { status: 409 });
  return group;
}

// 書き戻しに使う控えを private/owner_backup に残してから書く。
function backup(name, text) {
  const dir = join(ROOT, "private/owner_backup");
  mkdirSync(dir, { recursive: true });
  writeLf(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name}`), text);
}

function run(command) {
  return new Promise((resolve) => {
    exec(command, { cwd: ROOT, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: `${stdout}${stderr}`.slice(-6000) });
    });
  });
}

// 反映：メモに追記し、流れを書き、確かめる。どちらかが落ちたら両方を元に戻す。
async function apply({ groupId, question, answer, draft }) {
  if (applying) throw Object.assign(new Error("反映の途中です"), { status: 409 });
  const group = groupOf(groupId);
  const flowsText = readFileSync(FLOWS, "utf8");
  const flows = JSON.parse(flowsText);
  const errors = checkDraft(draft, flows, readJson(CARDS));
  if (errors.length > 0) return { applied: false, errors };
  applying = true;
  const memoText = existsSync(MEMO) ? readFileSync(MEMO, "utf8") : "# 大谷さんの確認メモ（本人の発言そのまま）\n";
  try {
    backup("flows.json", flowsText);
    backup("確認メモ.md", memoText);
    writeLf(MEMO, memoText.replace(/\n*$/, "\n") + memoEntry(today(), { ...group, question, answer }));
    writeLf(FLOWS, JSON.stringify(mergeFlows(flows, draft), null, 2) + "\n");
    const check = await run("node tools/check_cards.mjs");
    const test = check.ok ? await run("npm test") : { ok: false, out: "カードの確認が落ちたので、テストは回していません。" };
    if (check.ok && test.ok) {
      // 答えた相談は、一覧で「もう答えられるかもしれない」側へ移す。
      const done = cached.groups.find((g) => g.id === body.groupId);
      if (done) {
        done.covered_by = body.draft?.flow?.id ?? "answered";
        writeLf(CACHE, JSON.stringify(cached));
      }
      return { applied: true, check, test };
    }
    writeLf(FLOWS, flowsText);
    writeLf(MEMO, memoText);
    return { applied: false, rolledBack: true, check, test };
  } catch (error) {
    writeLf(FLOWS, flowsText);
    writeLf(MEMO, memoText);
    throw error;
  } finally {
    applying = false;
  }
}

async function route(path, body) {
  if (path === "/api/questions") return listGroups(Boolean(body.refresh));
  if (path === "/api/ask") {
    const group = groupOf(body.groupId);
    if (group.question) return { question: group.question, related_flow_id: group.covered_by, cost: 0, spent };
    const { result, usage } = await makeQuestion(client, { group, flows: readJson(FLOWS) });
    return { ...result, cost: track(usage), spent };
  }
  if (path === "/api/draft") {
    const group = groupOf(body.groupId);
    const answer = String(body.answer ?? "").trim();
    if (!answer) throw Object.assign(new Error("答えが空です"), { status: 400 });
    const flows = readJson(FLOWS);
    const { result, usage } = await makeDraft(client, { group, question: String(body.question ?? ""), answer, flows });
    const current = flows.find((f) => f.id === result.flow.id) ?? null;
    return { draft: result, current, diff: diffFlow(current, result.flow), errors: checkDraft(result, flows, readJson(CARDS)), cost: track(usage), spent };
  }
  if (path === "/api/check") {
    const flows = readJson(FLOWS);
    const current = flows.find((f) => f.id === body.draft?.flow?.id) ?? null;
    return { current, diff: diffFlow(current, body.draft?.flow), errors: checkDraft(body.draft, flows, readJson(CARDS)) };
  }
  if (path === "/api/apply") return apply(body);
  if (path === "/api/try") {
    const group = groupOf(body.groupId);
    let cost = 0;
    const read = async (input) => {
      const out = await readTurn(client, input);
      cost += track(out.usage);
      return out;
    };
    const message = group.examples[0];
    const now = await answerOnce(read, { cards: readJson(CARDS), flows: readJson(FLOWS), message });
    return { message, before: STOP_REPLY.ja, now, cost, spent };
  }
  throw Object.assign(new Error("not found"), { status: 404 });
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

// 別のサイトから手元のサーバーを叩かれないよう、宛先の名前と専用の印を確かめる。
createServer((req, res) => {
  if (!HOSTS.has(req.headers.host)) return send(res, 403, "{}");
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (req.method === "GET" && FILES[path]) return send(res, 200, readFileSync(join(HERE, FILES[path][0])), FILES[path][1]);
  if (req.method !== "POST" || req.headers["x-owner"] !== "1") return send(res, 404, "{}");
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const result = await route(path, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      send(res, 200, JSON.stringify({ ...result, spent }));
    } catch (error) {
      console.warn("owner", error.message);
      send(res, error.status ?? 500, JSON.stringify({ error: error.status ? error.message : "失敗しました。もう一度試してください。" }));
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`大谷モード http://127.0.0.1:${PORT}`));
