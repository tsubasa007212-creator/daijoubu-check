// 変えやすい設定はここに集める。
export const MODEL = process.env.MODEL ?? "claude-opus-5-5";
export const EFFORT = process.env.EFFORT ?? "medium";
export const PORT = Number(process.env.PORT ?? 8787);
export const ALLOW_UNCHECKED = process.env.ALLOW_UNCHECKED === "1";
export const LIMIT_HOUR = Number(process.env.LIMIT_HOUR ?? 20);
export const LIMIT_DAY = Number(process.env.LIMIT_DAY ?? 300);
export const MAX_BODY = 64000;
export const MAX_TOKENS = 3000;
export const MAX_MESSAGE = 1000;

export const STOP_REPLY = {
  ja: "まだ確かめていない話です。確かめていないことには答えません。",
  en: "We have not confirmed this yet, and we do not answer what we have not confirmed.",
};
