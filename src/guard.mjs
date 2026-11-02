// 返す前の検査。根拠の外へ出た返答は、ここで止める。

const ASSERTIONS = [
  /大丈夫です/, /問題ありません/, /安全です/, /壊れています/,
  /原因は.{0,30}(です|だ)[。\s]*$/m, /交換してください/, /修理してください/,
  /\b(it|your bike|this) (is|'s) (fine|ok|okay|safe)\b/i, /\bno problem\b/i, /\bis broken\b/i,
  /\bthe cause is\b/i, /\b(please )?(replace|repair) (it|the)\b/i,
];

export function checkTurn(turn, cards, { requireHumanCheck = true, released = [] } = {}) {
  const errors = [];
  const usable = (id) => {
    const card = cards.find((c) => c.id === id);
    if (!card) return errors.push(`card not found: ${id}`), null;
    if (requireHumanCheck && card.human_check !== "approved") return errors.push(`card not approved: ${id}`), null;
    return card;
  };

  for (const link of turn.links ?? []) {
    const card = usable(link.card_id);
    if (card && !card.observations.some((o) => o.id === link.observation_id)) {
      errors.push(`observation not found: ${link.card_id}/${link.observation_id}`);
    }
  }
  for (const cite of turn.citations ?? []) {
    if (released.includes(cite.card_id)) errors.push(`card released: ${cite.card_id}`);
    const card = usable(cite.card_id);
    if (card && !card.scenes.some((s) => s.id === cite.scene_id)) {
      errors.push(`scene not found: ${cite.card_id}/${cite.scene_id}`);
    }
  }
  if (turn.ask) {
    const card = usable(turn.ask.card_id);
    if (card && !card.observations.some((o) => o.id === turn.ask.observation_id)) {
      errors.push(`question not on card: ${turn.ask.card_id}/${turn.ask.observation_id}`);
    }
  }
  for (const pattern of ASSERTIONS) {
    if (pattern.test(turn.reply ?? "")) errors.push(`assertion: ${pattern}`);
  }
  if ((turn.citations ?? []).length === 0 && !turn.no_evidence && !turn.ask) {
    errors.push("reply has no evidence");
  }
  return errors;
}
