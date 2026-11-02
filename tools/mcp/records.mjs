// 確認済みの記録と未回答の質問を読むMCPサーバー。読むだけで、書き込みはしない。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

function scoreCard(card, words) {
  const body = JSON.stringify([card.title, card.conditions, card.scenes.map((s) => s.line)]);
  return words.filter((word) => body.includes(word)).length;
}

// 未回答の質問は本文を渡さず、大谷が匿名化した一覧だけを読む。
function unanswered() {
  const path = join(ROOT, "private", "unanswered_public.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

const server = new McpServer({ name: "daijoubu-records", version: "1.0.0" });

server.tool(
  "search_records",
  "記録カードを言葉で探す。本人確認の状態も返す。",
  { words: z.array(z.string()).min(1), approved_only: z.boolean().default(false) },
  async ({ words, approved_only: approvedOnly }) => {
    const hits = readJson("data/cards.json")
      .filter((card) => !approvedOnly || card.human_check === "approved")
      .map((card) => ({ card, score: scoreCard(card, words) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ card, score }) => ({ id: card.id, title: card.title, human_check: card.human_check, video_id: card.video_id, score }));
    return { content: [{ type: "text", text: JSON.stringify(hits) }] };
  },
);

server.tool(
  "list_unanswered",
  "記録がなく止まった質問のうち、匿名化済みのものを返す。",
  {},
  async () => ({ content: [{ type: "text", text: JSON.stringify(unanswered()) }] }),
);

await server.connect(new StdioServerTransport());
