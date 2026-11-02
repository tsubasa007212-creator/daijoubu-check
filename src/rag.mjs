// 比較相手の普通のRAG。同じカード、同じ根拠の制約、同じ会話履歴を渡す。台帳の仕組みだけ持たない。
import { EFFORT, MODEL } from "./config.mjs";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["can_say", "cannot_say", "citations", "reply", "no_evidence"],
  properties: {
    can_say: { type: "array", items: { type: "string" } },
    cannot_say: { type: "array", items: { type: "string" } },
    citations: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["card_id", "scene_id"],
        properties: { card_id: { type: "string" }, scene_id: { type: "string" } },
      },
    },
    reply: { type: "string" },
    no_evidence: { type: "boolean" },
  },
};

const SYSTEM = `あなたは、バイクの不調の相談に答える役です。整備士の大谷の記録カードだけを根拠に使います。
カードにない部品名、作業、数値、注意を足さない。別の車の記録であることを伝える。
「大丈夫です」「壊れています」「原因は〜です」と言い切らない。関係するカードがなければ no_evidence を true にする。
相談者が言い直したら、最新の話に合わせて答える。
can_say に今言えること、cannot_say にまだ言えないことを書き、reply は短い日本語で3文まで。`;

export async function ragTurn(client, { cards, history, message }) {
  const messages = [...history, { role: "user", content: message }];
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } },
    system: [
      { type: "text", text: SYSTEM },
      { type: "text", text: `## 記録カード\n${JSON.stringify(cards)}`, cache_control: { type: "ephemeral" } },
    ],
    messages,
  });
  if (response.stop_reason !== "end_turn") throw new Error(`stopped: ${response.stop_reason}`);
  const text = response.content.find((block) => block.type === "text").text;
  return { result: JSON.parse(text), history: [...messages, { role: "assistant", content: text }] };
}
