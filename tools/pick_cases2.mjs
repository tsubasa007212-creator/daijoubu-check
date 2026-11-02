// 2回目の比較の問題を固定の手順で選ぶ。各区分から2問を試験用にする。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const rank = (c) => createHash("sha256").update("2026-11-03" + c.id).digest("hex");
const cases = JSON.parse(readFileSync("data/eval/cases2_all.json", "utf8"));
const test = [];
for (const kind of ["source", "number", "no_evidence", "other_bike"]) {
  test.push(...cases.filter((c) => c.kind === kind).sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, 2));
}
writeFileSync("data/eval/cases2_test.json", JSON.stringify(test, null, 2) + "\n");
for (const c of test) console.log(c.id, c.kind, "|", c.first, "|", c.correction);
