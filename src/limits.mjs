// 公開時の守り。回数の上限と、画面から届く台帳の形を確かめる。
const ORIGINS = new Set(["checked", "heard", "guess", "unknown"]);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const MAX_STATEMENTS = 40;
export const MAX_TEXT = 300;

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

// Claudeの出力を台帳へ入れる前に、長さと件数を収める。次の送信で弾かれないように。
export function trimState(state) {
  const statements = state.statements.slice(-MAX_STATEMENTS).map((s) => ({
    ...s,
    text: s.text.slice(0, MAX_TEXT),
    history: s.history.slice(-5).map((h) => ({ ...h, text: h.text?.slice(0, MAX_TEXT), reason: h.reason?.slice(0, MAX_TEXT) })),
  }));
  const ids = new Set(statements.map((s) => s.id));
  return { statements, links: state.links.filter((l) => ids.has(l.statement_id)).slice(-80) };
}

const text = (value, max) => typeof value === "string" && value.length <= max;

export function isValidState(state) {
  if (!state || !Array.isArray(state.statements) || !Array.isArray(state.links)) return false;
  if (state.statements.length > MAX_STATEMENTS || state.links.length > 80) return false;
  const statementsOk = state.statements.every((s) =>
    text(s?.id, 20) && text(s?.text, MAX_TEXT) && ORIGINS.has(s?.origin) && Array.isArray(s?.history) && s.history.length <= 5);
  const linksOk = state.links.every((l) => text(l?.statement_id, 20) && text(l?.card_id, 40) && text(l?.observation_id, 40));
  return statementsOk && linksOk;
}
