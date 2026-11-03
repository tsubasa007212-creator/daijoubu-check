// 相談文を読み取り、台帳への変更と返答を作る。根拠はカードだけ。
import Anthropic from "@anthropic-ai/sdk";
import { EFFORT, MAX_TOKENS, MODEL } from "./config.mjs";
import { SYSTEM, TURN_SCHEMA } from "./prompt.mjs";

export function createClient() {
  return new Anthropic({ maxRetries: 1, timeout: 60000 });
}

export async function readTurn(client, { cards, flows = [], state, message, previousReply = "", hint = null, lang = "ja" }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: TURN_SCHEMA } },
    system: [
      { type: "text", text: SYSTEM },
      { type: "text", text: `## 記録カード\n${JSON.stringify(cards)}\n\n## 点検の流れ\n${JSON.stringify(flows)}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: JSON.stringify({ ledger: state, previous_reply: previousReply, fix_this: hint, language: lang, message }) }],
  });
  if (response.stop_reason !== "end_turn") throw new Error(`stopped: ${response.stop_reason}`);
  const text = response.content.find((block) => block.type === "text");
  return { turn: JSON.parse(text.text), usage: response.usage };
}
