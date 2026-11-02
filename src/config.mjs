// 変えやすい設定はここに集める。
export const MODEL = process.env.MODEL ?? "claude-opus-5-5";
export const EFFORT = process.env.EFFORT ?? "medium";
export const PORT = Number(process.env.PORT ?? 8787);
export const ALLOW_UNCHECKED = process.env.ALLOW_UNCHECKED === "1";
export const LIMIT_HOUR = Number(process.env.LIMIT_HOUR ?? 20);
export const LIMIT_DAY = Number(process.env.LIMIT_DAY ?? 300);
export const MAX_BODY = 20000;
export const MAX_MESSAGE = 1000;

export const STOP_REPLY = {
  ja: "該当動画なし。この話に合う記録を、今は確かめられません。",
  en: "No matching video. We cannot confirm a record that fits this right now.",
};
