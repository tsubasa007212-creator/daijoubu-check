// 公開時の守り。費用の上限と、画面から届く台帳の形を確かめる。
const ORIGINS = new Set(["checked", "heard", "guess", "unknown"]);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function createLimiter({ perHour = 20, perDay = 300, now = Date.now } = {}) {
  const visitors = new Map();
  let dayStart = now();
  let dayCount = 0;
  return (ip) => {
    const t = now();
    if (t - dayStart >= DAY) {
      dayStart = t;
      dayCount = 0;
    }
    const recent = (visitors.get(ip) ?? []).filter((at) => t - at < HOUR);
    if (recent.length >= perHour || dayCount >= perDay) return false;
    visitors.set(ip, [...recent, t]);
    dayCount += 1;
    return true;
  };
}

const text = (value, max) => typeof value === "string" && value.length <= max;

export function isValidState(state) {
  if (!state || !Array.isArray(state.statements) || !Array.isArray(state.links)) return false;
  if (state.statements.length > 40 || state.links.length > 80) return false;
  const statementsOk = state.statements.every((s) =>
    text(s?.id, 20) && text(s?.text, 300) && ORIGINS.has(s?.origin) && Array.isArray(s?.history) && s.history.length <= 10);
  const linksOk = state.links.every((l) => text(l?.statement_id, 20) && text(l?.card_id, 40) && text(l?.observation_id, 40));
  return statementsOk && linksOk;
}
