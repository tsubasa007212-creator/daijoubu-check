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
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`cards ok: ${cards.length}`);
