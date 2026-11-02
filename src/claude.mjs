// 相談文を読み取り、台帳への変更と返答を作る。根拠はカードだけ。
import Anthropic from "@anthropic-ai/sdk";
import { EFFORT, MODEL } from "./config.mjs";
import { SYSTEM, TURN_SCHEMA } from "./prompt.mjs";

export function createClient() {
  return new Anthropic();
}

export async function readTurn(client, { cards, state, message }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: TURN_SCHEMA } },
    system: [
      { type: "text", text: SYSTEM },
      { type: "text", text: `## 記録カード\n${JSON.stringify(cards)}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{
      role: "user",
      content: `## 今の台帳\n${JSON.stringify(state)}\n\n## 相談者の発言\n${message}`,
    }],
  });
  if (response.stop_reason !== "end_turn") throw new Error(`stopped: ${response.stop_reason}`);
  const text = response.content.find((block) => block.type === "text");
  return { turn: JSON.parse(text.text), usage: response.usage };
}
