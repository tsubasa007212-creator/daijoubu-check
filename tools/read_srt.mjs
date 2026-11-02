// 字幕(.srt)を「MM:SS 本文」の行へ直す。作業用の全文は private/ に置き、公開しない。
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [srcDir, outDir, ...ids] = process.argv.slice(2);
for (const id of ids) {
  const text = readFileSync(join(srcDir, `${id}.ja.srt`), "utf8").replace(/\r/g, "");
  const lines = text.trim().split(/\n\s*\n/).flatMap((block) => {
    const rows = block.split("\n");
    if (rows.length < 3) return [];
    return [`${rows[1].slice(3, 8)} ${rows.slice(2).join(" ")}`];
  });
  writeFileSync(join(outDir, `${basename(id)}.txt`), lines.join("\n") + "\n");
  console.log(id, lines.length);
}
