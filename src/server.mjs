// 相談画面のサーバー。APIキーはここだけが持つ。台帳は画面側が持ち、毎回送ってもらう。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { applyTurn, comparisons, newState, releasedCards } from "./engine.mjs";
import { askStepOnly, assertions, checkTurn, fixedTurn } from "./guard.mjs";
import { createClient, readTurn } from "./claude.mjs";
import { isPriceQuestion, pickPrices, priceTurn } from "./prices.mjs";
import { ALLOW_UNCHECKED, FIXED_REPLY, LIMIT_DAY, LIMIT_HOUR, MAX_BODY, MAX_MESSAGE, PORT, questionDelivery, sendQuestion, STOP_NOTICE, STOP_REPLY } from "./config.mjs";
import { createLimiter, isValidState, trimState } from "./limits.mjs";
import { isSealed, seal } from "./seal.mjs";

const allCards = JSON.parse(readFileSync("data/cards.json", "utf8"));
const cards = ALLOW_UNCHECKED ? allCards : allCards.filter((c) => c.human_check === "approved");
const allFlows = JSON.parse(readFileSync("data/flows.json", "utf8"));
const flows = ALLOW_UNCHECKED ? allFlows : allFlows.filter((f) => f.human_check === "approved");
const client = createClient();
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".webp": "image/webp" };
const allowed = createLimiter({ perHour: LIMIT_HOUR, perDay: LIMIT_DAY });

// 手元の控えに書き、外の保存先へも送る。送信は待たないので、相談の返答を遅らせない。
function logQuestion(message) {
  const entry = { at: new Date().toISOString(), message };
  try {
    mkdirSync("private", { recursive: true });
    appendFileSync("private/questions.jsonl", JSON.stringify(entry) + "\n");
  } catch (error) {
    console.warn("question log", error.message);
  }
  sendQuestion(entry);
}

// 止まった時の返事。整備士に届く設定なら、その一言を添える。
function stopReply(lang) {
  const base = STOP_REPLY[lang] ?? STOP_REPLY.ja;
  return questionDelivery() ? `${base}\n${STOP_NOTICE[lang] ?? STOP_NOTICE.ja}` : base;
}

// 検査に落ちたら理由を添えて1回だけやり直し、それでも駄目なら止める。止めても相談者の発言は台帳に残す。
async function answer(state, message, lang, previousReply, cannotOpen = false) {
  const stop = (next) => ({ state: next, turn: { reply: stopReply(lang), citations: [], ask: null, no_evidence: true } });
  let hint = null;
  let kept = state;
  let stepOnly = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { turn } = await readTurn(client, { cards, flows, state, message, previousReply, hint, lang, cannotOpen });
      const next = trimState(applyTurn(state, turn));
      const fixed = fixedTurn(turn, lang, FIXED_REPLY);
      if (fixed) return { state: trimState(applyTurn(state, { ...turn, links: [] })), turn: fixed };
      kept = trimState(applyTurn(state, { ...turn, links: [] }));
      const errors = checkTurn(turn, cards, {
        requireHumanCheck: !ALLOW_UNCHECKED,
        released: releasedCards(next),
        statementIds: next.statements.map((s) => s.id),
        flows,
      });
      if (errors.length === 0) return turn.no_evidence ? stop(next) : { state: next, turn };
      // どの言い方で止まったかだけを残す。相談の文は残さない。
      console.warn("guard", errors, assertions(turn.reply ?? "").map(String));
      hint = errors.join(", ");
      // 流れの問いは日本語なので、ほかの言語ではそのまま聞かない。
      const asked = lang === "en" ? null : askStepOnly(turn, flows, errors);
      stepOnly = asked ? { state: next, turn: asked } : null;
    } catch (error) {
      console.warn("turn", error.message);
      hint = "返答の形が正しくありませんでした";
    }
  }
  return stepOnly ?? stop(kept);
}

// 壊れたJSONは送り手の誤りなので、400で返す。
function readRequest(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { message, state, signature, lang, previousReply, cannotOpen } = parsed;
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) return null;
  if (state && (!isValidState(state) || !isSealed(state, signature))) return null;
  return { message: message.trim(), state: state ?? newState(), lang, previousReply: String(previousReply ?? "").slice(0, 800), cannotOpen: cannotOpen === true };
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

// 前段が付け足す右端の値を使う。先頭は送り手が書き換えられる。
function visitorOf(req) {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return forwarded.at(-1) ?? req.socket.remoteAddress;
}

function handleTurn(req, res) {
  if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, "{}");
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) return req.destroy();
    chunks.push(chunk);
  });
  req.on("end", async () => {
    try {
      const request = readRequest(Buffer.concat(chunks).toString("utf8"));
      if (!request) return send(res, 400, JSON.stringify({ error: "bad request" }));
      if (!allowed(visitorOf(req))) return send(res, 429, JSON.stringify({ error: "limit" }));
      let result = await answer(request.state, request.message, request.lang, request.previousReply, request.cannotOpen);
      // 値段の質問には、大谷の店の公開料金を決まった形で添える。値段だけで止まった時は、止めずに参考価格で返す。
      if (isPriceQuestion(request.message)) {
        result = result.turn.no_evidence
          ? { state: result.state, turn: priceTurn(request.message, result.state, request.lang) }
          : { state: result.state, turn: { ...result.turn, price: pickPrices(request.message, result.state, request.lang) } };
      }
      if (result.turn.no_evidence) logQuestion(request.message);
      send(res, 200, JSON.stringify({
        state: result.state,
        signature: seal(result.state),
        turn: result.turn,
        comparisons: comparisons(result.state),
      }));
    } catch (error) {
      console.error(error);
      send(res, 500, JSON.stringify({ error: "failed" }));
    }
  });
}

function handleFile(req, res) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const path = pathname === "/" ? "index.html" : pathname.slice(1);
  // 置けるのは public 直下と、挿絵の img/ だけ。
  if (!/^(img\/)?[a-z0-9.-]+$/.test(path) || !existsSync(join("public", path))) return send(res, 404, "not found", "text/plain");
  send(res, 200, readFileSync(join("public", path)), TYPES[extname(path)] ?? "text/plain");
}

createServer((req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/turn") return handleTurn(req, res);
    if (req.url === "/api/cards") return send(res, 200, JSON.stringify({ cards, flows, draft: ALLOW_UNCHECKED }));
    handleFile(req, res);
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
