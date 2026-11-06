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
  checkup: {
    ja: "画面の「初心者向け点検チェック」で、エンジン、ブレーキ、ライト、タイヤ、オイルを、○・△・×・？で見られます。気になる所があれば、その結果のまま相談できます。",
    en: "Use the Beginner's bike check on this page to look at the engine, brakes, lights, tires, and oil with ○, △, ×, or ？. If anything worries you, you can ask about those results.",
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

// 止まった相談が整備士に届く設定になっているか。Discord の webhook は URL 自体が鍵なのでトークンは要らない。
const DISCORD_WEBHOOK = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;
export function questionDelivery(url = QUESTION_URL, token = QUESTION_TOKEN) {
  if (!url || !/^(https:|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(url)) return null;
  if (DISCORD_WEBHOOK.test(url)) return "discord";
  return token ? "bearer" : null;
}

// 止まった時に相談者へ添える一言。届く設定の時だけ出す。
export const STOP_NOTICE = {
  ja: "この相談は整備士の大谷に届けます（名前や連絡先は送りません）。確かめて言葉にできたら、次から答えられるようになります。",
  en: "This question will be passed to Otani, the mechanic (no name or contact details are sent). Once he has checked it and put it into words, the app can answer it next time.",
};

// Discord へ出す形。相談の文はそのまま、時刻は日本時間で。
function discordBody(entry) {
  const at = entry.at ? new Date(entry.at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) : "";
  const quoted = String(entry.message ?? "").split("\n").map((line) => `> ${line}`).join("\n");
  return { username: "二輪問診", content: `止まった相談（${at}）\n${quoted}` };
}

// 止まった質問を外の保存先へ送る。失敗しても例外を出さず、結果だけ返す。相談文はログに出さない。
export async function sendQuestion(entry, { url = QUESTION_URL, token = QUESTION_TOKEN, timeoutMs = QUESTION_TIMEOUT_MS, post = fetch } = {}) {
  const delivery = questionDelivery(url, token);
  if (!delivery) return false;
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (delivery === "bearer") headers.authorization = `Bearer ${token}`;
  try {
    const response = await post(url, {
      method: "POST",
      headers,
      body: JSON.stringify(delivery === "discord" ? discordBody(entry) : entry),
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
