// Claude Codeのフック。git commit の前に、鍵と非公開ファイルの混入、カードの崩れを止める。
import { execFileSync } from "node:child_process";

const input = JSON.parse(await new Promise((resolve) => {
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => resolve(body || "{}"));
}));
if (!/\bgit\b.*\bcommit\b/.test(input.tool_input?.command ?? "")) process.exit(0);

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const stop = (reason) => {
  console.error(reason);
  process.exit(2);
};

const staged = git("diff", "--cached", "--name-only").split("\n").filter(Boolean);
const blocked = staged.filter((path) => /^private\/|\.env|\.pdf$/i.test(path));
if (blocked.length > 0) stop(`公開できないファイル: ${blocked.join(", ")}`);
if (/sk-ant-[a-z0-9]/i.test(git("diff", "--cached"))) stop("APIキーらしき文字列が含まれています");
try {
  execFileSync("node", ["tools/check_cards.mjs"], { stdio: "pipe" });
} catch (error) {
  stop(String(error.stderr));
}
