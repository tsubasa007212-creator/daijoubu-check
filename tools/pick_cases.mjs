// 相談文を固定の手順で選ぶ。訂正6・通常2・根拠なし2を試験用に、残りを再試験用にする。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SEED = "2026-11-02";
const rank = (c) => createHash("sha256").update(SEED + c.id).digest("hex");
const cases = JSON.parse(readFileSync("data/eval/cases_all.json", "utf8"));
const quota = { correction: 6, normal: 2, no_evidence: 2 };
const test = [];
const spare = [];
for (const [kind, count] of Object.entries(quota)) {
  const rows = cases.filter((c) => c.kind === kind).sort((a, b) => rank(a).localeCompare(rank(b)));
  test.push(...rows.slice(0, count));
  spare.push(...rows.slice(count));
}
writeFileSync("data/eval/cases_test.json", JSON.stringify(test, null, 2) + "\n");
writeFileSync("data/eval/cases_spare.json", JSON.stringify(spare, null, 2) + "\n");
console.log("test", test.map((c) => c.id).join(" "), "spare", spare.map((c) => c.id).join(" "));
