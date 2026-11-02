// 相談画面のサーバー。APIキーはここだけが持つ。台帳は画面側が持ち、毎回送ってもらう。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { applyTurn, comparisons, newState, releasedCards } from "./engine.mjs";
import { checkTurn } from "./guard.mjs";
import { createClient, readTurn } from "./claude.mjs";
import { ALLOW_UNCHECKED, LIMIT_DAY, LIMIT_HOUR, MAX_BODY, MAX_MESSAGE, PORT, STOP_REPLY } from "./config.mjs";
import { createLimiter, isValidState } from "./limits.mjs";

const allCards = JSON.parse(readFileSync("data/cards.json", "utf8"));
const cards = ALLOW_UNCHECKED ? allCards : allCards.filter((c) => c.human_check === "approved");
const client = createClient();
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const allowed = createLimiter({ perHour: LIMIT_HOUR, perDay: LIMIT_DAY });

function logQuestion(message) {
  mkdirSync("private", { recursive: true });
  appendFileSync("private/questions.jsonl", JSON.stringify({ at: new Date().toISOString(), message }) + "\n");
}

// 検査に落ちたら1回だけやり直し、それでも駄目なら止める。
async function answer(state, message, lang) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { turn } = await readTurn(client, { cards, state, message });
    try {
      const next = applyTurn(state, turn);
      const errors = checkTurn(turn, cards, { requireHumanCheck: !ALLOW_UNCHECKED, released: releasedCards(next) });
      if (errors.length === 0) return { state: next, turn };
      console.warn("guard", errors);
    } catch (error) {
      console.warn("apply", error.message);
    }
  }
  return { state, turn: { reply: STOP_REPLY[lang] ?? STOP_REPLY.ja, citations: [], ask: null, no_evidence: true } };
}

async function handleTurn(body) {
  const { message, state, lang } = JSON.parse(body);
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) throw new Error("bad message");
  if (state && !isValidState(state)) throw new Error("bad state");
  const current = state ?? newState();
  const result = await answer(current, message.trim(), lang);
  if (result.turn.no_evidence) logQuestion(message.trim());
  return { state: result.state, turn: result.turn, comparisons: comparisons(result.state) };
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/turn") {
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress).split(",")[0].trim();
    if (!allowed(ip)) return send(res, 429, JSON.stringify({ error: "limit" }));
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on("end", async () => {
      try {
        send(res, 200, JSON.stringify(await handleTurn(body)));
      } catch (error) {
        console.error(error);
        send(res, 500, JSON.stringify({ error: "failed" }));
      }
    });
    return;
  }
  if (req.url === "/api/cards") return send(res, 200, JSON.stringify({ cards, draft: ALLOW_UNCHECKED }));
  const pathname = new URL(req.url, "http://localhost").pathname;
  const path = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[a-z0-9.]+$/.test(path)) return send(res, 404, "not found", "text/plain");
  try {
    send(res, 200, readFileSync(join("public", path)), TYPES[extname(path)] ?? "text/plain");
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
