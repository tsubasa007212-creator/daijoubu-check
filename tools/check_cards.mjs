// カードの形を確かめる。作業用の字幕があれば、時刻の実在も確かめる。
import { existsSync, readFileSync } from "node:fs";

const cards = JSON.parse(readFileSync("data/cards.json", "utf8"));
const errors = [];
for (const card of cards) {
  const ids = new Set(card.scenes.map((s) => s.id));
  for (const o of card.observations) {
    if (!ids.has(o.scene)) errors.push(`${card.id}: observation ${o.id} -> ${o.scene}`);
  }
  if (card.human_check === "approved" && !card.owner_note) errors.push(`${card.id}: approved without owner_note`);
  const path = `private/transcripts/${card.video_id}.txt`;
  if (!existsSync(path)) continue;
  const transcript = readFileSync(path, "utf8");
  for (const scene of card.scenes) {
    if (!transcript.includes(`${scene.t} `)) errors.push(`${card.id}: no line at ${scene.t}`);
  }
}
const flows = JSON.parse(readFileSync("data/flows.json", "utf8"));
for (const flow of flows) {
  const ids = new Set(flow.steps.map((s) => s.id));
  for (const step of flow.steps) {
    for (const target of [step.if_yes, step.if_no]) {
      if (target === "stop" || ids.has(target)) continue;
      if (target.startsWith("cards:") && cards.some((c) => c.id === target.slice(6))) continue;
      errors.push(`${flow.id}/${step.id}: no target ${target}`);
    }
    const path = `private/transcripts/${step.video_id}.txt`;
    if (step.source === "video" && existsSync(path) && !readFileSync(path, "utf8").includes(`${step.t} `)) {
      errors.push(`${flow.id}/${step.id}: no line at ${step.t}`);
    }
  }
}
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`cards ok: ${cards.length}`);
