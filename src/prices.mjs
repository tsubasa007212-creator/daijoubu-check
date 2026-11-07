// 値段の質問。金額はClaudeに言わせず、大谷の店（WINGオオタニ）の公開料金（data/prices.json）から決まった形で出す。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const PRICES = JSON.parse(readFileSync(join(here, "..", "data", "prices.json"), "utf8"));
// 「高い」「安い」だけでは値段の質問にしない（空気圧が高い、など）。
const PRICE_ASK = /いくら|幾ら|値段|費用|料金|金額|価格|予算|相場|修理代|工賃|円|お金|\bcost|\bprice|how much|expensive|cheap|\byen\b|¥/i;
const MAX_ITEMS = 3;

export function isPriceQuestion(message) {
  return PRICE_ASK.test(String(message ?? ""));
}

// 相談の文と、これまでの発言から関係する料金を選ぶ。合うものが無ければ点検の料金だけ。
export function pickPrices(message, state = null, lang = "ja") {
  const text = String(message ?? "").toLowerCase();
  const hay = [text, ...(state?.statements ?? []).map((s) => String(s.text ?? "").toLowerCase())].join("\n");
  const has = (item, where) => item.keys.some((k) => where.includes(k.toLowerCase()));
  // 合った語の長さ（「ベルトが切れ」は「ベルト」より具体的）で、相談の文に直接ある語を先に。点検は最後。
  const score = (item) => Math.max(0, ...item.keys.filter((k) => text.includes(k.toLowerCase())).map((k) => k.length));
  const hit = PRICES.items.filter((item) => has(item, hay));
  const ordered = [...hit].sort((a, b) => score(b) - score(a) || Number(a.id === "inspect") - Number(b.id === "inspect"));
  const chosen = (ordered.length > 0 ? ordered : PRICES.items.filter((i) => i.id === "inspect")).slice(0, MAX_ITEMS);
  return {
    shop: PRICES.shop,
    source: PRICES.source,
    taken: PRICES.taken,
    note: lang === "en" ? PRICES.note_en : PRICES.note,
    items: chosen.map((i) => ({ id: i.id, label: lang === "en" ? i.label_en : i.label, cost: lang === "en" ? i.cost_en : i.cost })),
  };
}

