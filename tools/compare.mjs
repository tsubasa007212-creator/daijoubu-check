// 本作と普通のRAGを1回ずつ実行し、方式を隠した採点表を作る。再実行して良い方を選ばない。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { applyTurn, ledger, newState } from "../src/engine.mjs";
import { createClient, readTurn } from "../src/claude.mjs";
import { ragTurn } from "../src/rag.mjs";

const OUT = process.argv[3] ?? "private/eval_key.json";
if (existsSync(OUT)) throw new Error("already ran: 各方式1回だけ");
const cards = JSON.parse(readFileSync("data/cards.json", "utf8"));
const cases = JSON.parse(readFileSync(process.argv[2] ?? "data/eval/cases_test.json", "utf8"));
const client = createClient();
const sheet = [];
const key = {};

async function runOurs(c) {
  let state = newState();
  let last;
  for (const message of [c.first, c.correction].filter(Boolean)) {
    const { turn } = await readTurn(client, { cards, state, message });
    state = applyTurn(state, turn);
    last = turn;
  }
  const l = ledger(state);
  return {
    can_say: l.checked.map((s) => s.text),
    cannot_say: [...l.heard, ...l.guess, ...l.unknown].map((s) => s.text),
    reply: last.reply,
    citations: last.citations,
    no_evidence: last.no_evidence,
  };
}

async function runRag(c) {
  let history = [];
  let last;
  for (const message of [c.first, c.correction].filter(Boolean)) {
    const out = await ragTurn(client, { cards, history, message });
    history = out.history;
    last = out.result;
  }
  return last;
}

for (const c of cases) {
  const [ours, rag] = await Promise.all([runOurs(c), runRag(c)]);
  const flip = createHash("sha256").update("arm" + c.id).digest()[0] % 2 === 0;
  const [x, y] = flip ? [ours, rag] : [rag, ours];
  key[c.id] = { X: flip ? "ours" : "rag", Y: flip ? "rag" : "ours", ours, rag };
  const show = (name, r) => `### 出力${name}\n今言えること: ${r.can_say.join(" / ")}\nまだ言えないこと: ${r.cannot_say.join(" / ")}\n返答: ${r.reply}\n`;
  sheet.push(`## ${c.id}\n1回目: ${c.first}\n訂正: ${c.correction ?? "なし"}\n\n${show("X", x)}\n${show("Y", y)}`);
  console.log("done", c.id);
}
writeFileSync(OUT, JSON.stringify(key, null, 2));
writeFileSync(OUT.replace(/\.json$/, "") + "_sheet.md", sheet.join("\n"));
