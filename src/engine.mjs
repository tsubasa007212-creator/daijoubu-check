// 台帳の仕組み。判断の連動はここで行い、Claudeには任せない。

export const ORIGINS = ["checked", "heard", "guess", "unknown"];
export const ORIGIN_LABELS = {
  checked: "自分で確かめたこと",
  heard: "聞いた話",
  guess: "推測",
  unknown: "まだ分からないこと",
};

export function newState() {
  return { statements: [], links: [] };
}

// Claudeの1回分の読み取りを台帳へ反映する。既存の発言は消さず、出所だけ変える。
export function applyTurn(state, turn) {
  const statements = state.statements.map((s) => ({ ...s }));
  for (const added of turn.added ?? []) {
    statements.push({ id: added.id, text: added.text, origin: added.origin, history: [] });
  }
  for (const change of turn.changed ?? []) {
    const target = statements.find((s) => s.id === change.id);
    if (!target) throw new Error(`unknown statement: ${change.id}`);
    target.history = [...target.history, { from: target.origin, text: target.text, reason: change.reason }];
    target.origin = change.origin;
    if (change.text) target.text = change.text;
  }
  const links = [...state.links];
  for (const link of turn.links ?? []) {
    if (!links.some((l) => sameLink(l, link))) links.push(link);
  }
  return { statements, links };
}

function sameLink(a, b) {
  return a.statement_id === b.statement_id && a.card_id === b.card_id && a.observation_id === b.observation_id;
}

// 見立ては、本人が確かめた発言に支えられている間だけ「比べられる」。
export function comparisons(state) {
  return state.links.map((link) => {
    const statement = state.statements.find((s) => s.id === link.statement_id);
    return { ...link, status: statement?.origin === "checked" ? "active" : "released" };
  });
}

// 外れた比較しか残っていないカード。同じカードで別の比較が生きていれば含めない。
export function releasedCards(state) {
  const rows = comparisons(state);
  const active = new Set(rows.filter((c) => c.status === "active").map((c) => c.card_id));
  return [...new Set(rows.filter((c) => c.status === "released").map((c) => c.card_id))].filter((id) => !active.has(id));
}

export function ledger(state) {
  return Object.fromEntries(ORIGINS.map((o) => [o, state.statements.filter((s) => s.origin === o)]));
}
