// 大谷モードの試験で使う偽の Claude。まとめ、1問、下書きの3つの呼び出しに決まった形で答える。
import { readFileSync } from "node:fs";
import { join } from "node:path";
const reply = (value) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }], usage: {} });
const ownerStep = (id) => ({ id, ask: "球が切れていませんか", how: "最初に球切れを見る。", needs: "工具なし", video_id: null, t: null, line: null,
  if_yes: "stop", if_no: "stop", cannot_tell: "見方は、まだ確かめていない。", source: "owner" });
export const client = { beta: { messages: { create: async (request) => {
  const props = request.output_config.format.schema.properties;
  const input = JSON.parse(request.messages[0].content);
  if (props.groups) {
    const pick = (word) => input.questions.filter((q) => q.text.includes(word)).map((q) => q.n);
    const groups = [
      { title: "ウインカーが点かない", kind: "bike", members: pick("ウインカー"), covered_by: null, question: "ウインカーが点かない時、最初に何を見ますか？" },
      { title: "ライトがつかない", kind: "bike", members: pick("ライト"), covered_by: null, question: "ライトがつかない時、次に何を見ますか？" },
      { title: "天気", kind: "not_bike", members: pick("天気"), covered_by: null, question: "" },
    ].filter((g) => g.members.length > 0);
    return reply({ groups });
  }
  if (props.decision) {
    const flows = JSON.parse(readFileSync(join(process.env.OWNER_ROOT, "data/flows.json"), "utf8"));
    if (input.title.includes("ウインカー")) {
      return reply({ decision: "new", reason: "合う流れがない", conflicts: [], unsaid: ["見方"],
        flow: { id: "winker", symptom: "ウインカーが点かない", scope: "all", steps: [ownerStep("s1")], stop_here: "ここから先は、専門家に見てもらうほうが良いです。", limits: [] } });
    }
    const light = structuredClone(flows.find((f) => f.id === "light"));
    const ids = light.steps.map((s) => s.id);
    const next = "s" + (ids.length + 1);
    light.steps.at(-1).if_no = next;
    light.steps.push(ownerStep(next));
    return reply({ decision: "add_to", reason: "ライトの流れに足す", conflicts: [], unsaid: [], flow: light });
  }
  return reply({ question: "最初に何を見ますか？", related_flow_id: null });
} } } };
