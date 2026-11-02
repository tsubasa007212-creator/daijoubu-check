// 画面なしで会話を試す。開発用なので、本人確認前のカードも通す。
import { readFileSync } from "node:fs";
import { applyTurn, comparisons, ledger, newState } from "../src/engine.mjs";
import { checkTurn } from "../src/guard.mjs";
import { createClient, readTurn } from "../src/claude.mjs";

const cards = JSON.parse(readFileSync("data/cards.json", "utf8"));
const messages = process.argv.slice(2);
const client = createClient();
let state = newState();
let spent = 0;

for (const message of messages) {
  const { turn, usage } = await readTurn(client, { cards, state, message });
  spent += (usage.input_tokens * 4 + (usage.cache_creation_input_tokens ?? 0) * 5 + (usage.cache_read_input_tokens ?? 0) * 0.2 + usage.output_tokens * 20) / 1e6;
  state = applyTurn(state, turn);
  console.log("\n相談者:", message);
  console.log("返答:", turn.reply);
  console.log("引用:", JSON.stringify(turn.citations), "質問:", JSON.stringify(turn.ask), "根拠なし:", turn.no_evidence);
  console.log("検査:", JSON.stringify(checkTurn(turn, cards, { requireHumanCheck: false })));
  for (const [origin, rows] of Object.entries(ledger(state))) console.log(" ", origin, rows.map((r) => `${r.id}:${r.text}`).join(" / "));
  console.log("比較:", comparisons(state).map((c) => `${c.statement_id}-${c.card_id}/${c.observation_id}:${c.status}`).join(" "));
}
console.log(`\n概算費用 $${spent.toFixed(4)}`);
