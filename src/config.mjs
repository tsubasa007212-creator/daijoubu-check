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
export const QUESTION_URL = process.env.QUESTION_URL ?? "";
export const QUESTION_TOKEN = process.env.QUESTION_TOKEN ?? "";
export const QUESTION_TIMEOUT_MS = 3000;

export const FIXED_REPLY = {
  vague: {
    ja: "どんな様子か教えてください。下の中で近いものを選ぶか、そのままの言葉で書いてください。",
    en: "Tell us what is happening. Pick the closest one below, or write it in your own words.",
  },
  greeting: {
    ja: "バイクの不調を、整備士が確かめた記録と点検の順番で一緒に整理する相談窓口です。気になることを、そのままの言葉で書いてください。",
    en: "We help you sort out what is wrong with your bike, using records a mechanic has confirmed and the order he checks things. Tell us what is bothering you, in your own words.",
  },
};

export const STOP_REPLY = {
  ja: "まだ確かめていない話です。確かめていないことには答えません。今答えられる相談は、下から選べます。",
  en: "We have not confirmed this yet, and we do not answer what we have not confirmed. You can pick a topic we can answer below.",
};

// 止まった質問を外の保存先へ送る。失敗しても例外を出さず、結果だけ返す。相談文はログに出さない。
export async function sendQuestion(entry, { url = QUESTION_URL, token = QUESTION_TOKEN, timeoutMs = QUESTION_TIMEOUT_MS, post = fetch } = {}) {
  if (!url || !token || !/^(https:|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(url)) return false;
  try {
    const response = await post(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(entry),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) console.warn("question send", response.status);
    return response.ok;
  } catch (error) {
    console.warn("question send", error.name);
    return false;
  }
}
