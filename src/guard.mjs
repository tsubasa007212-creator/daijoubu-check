// 返す前の検査。根拠の外へ出た返答は、ここで止める。

const ASSERTIONS = [
  /大丈夫です/, /問題(ありません|ない|なさ)/, /安全です/, /壊れています/, /原因は.{0,30}(です|だ)/,
  /交換(して)?(ください|しましょう)/, /修理(して)?(ください|しましょう)/, /持ち込み(ましょう|ください)/,
  /見てもら(って|い)(ください|ましょう)/, /見てもらう(こと|のが|べき)/, /お店で見てもらい/,
  /平気/, /心配(いり|は)ません/, /(走|乗)れます/,
  /\b(it|your bike|the bike|this)( is|'s) (fine|ok|okay|safe)\b/i, /\bno problem\b/i, /\bis broken\b/i,
  /\bthe cause is\b/i, /\b(please )?(replace|repair) (it|the)\b/i, /\byou should\b/i, /\btake it to\b/i,
];
const MAX_REPLY = 600;
// 「大丈夫です」とは言えません、のような否定は言い切りではない。
const NEGATED = /とは(言え|言い切れ|限ら|決め)|かどうか|か(は|も)(分かり|言え)|cannot say|can't say|not sure/i;

function assertions(reply) {
  const plain = reply.replace(/[’‘]/g, "'").replace(/「[^」]*」/g, "");
  const sentences = plain.split(/(?<=[。．.!?！？\n])/);
  return sentences.filter((s) => !NEGATED.test(s)).flatMap((s) => ASSERTIONS.filter((p) => p.test(s)));
}

export function checkTurn(turn, cards, { requireHumanCheck = true, released = [], statementIds = null } = {}) {
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
    if (statementIds && !statementIds.includes(link.statement_id)) errors.push(`statement not found: ${link.statement_id}`);
  }
  for (const cite of turn.citations ?? []) {
    if (released.includes(cite.card_id)) errors.push(`card released: ${cite.card_id}`);
    const card = usable(cite.card_id);
    if (card && !card.scenes.some((s) => s.id === cite.scene_id)) {
      errors.push(`scene not found: ${cite.card_id}/${cite.scene_id}`);
    }
  }
  if (turn.ask) {
    if (released.includes(turn.ask.card_id)) errors.push(`card released: ${turn.ask.card_id}`);
    const card = usable(turn.ask.card_id);
    if (card && !card.observations.some((o) => o.id === turn.ask.observation_id)) {
      errors.push(`question not on card: ${turn.ask.card_id}/${turn.ask.observation_id}`);
    }
  }
  if (turn.no_evidence && (turn.citations ?? []).length > 0) errors.push("no_evidence with citations");
  if (assertions(turn.reply ?? "").length > 0) errors.push("assertion in reply");
  if ((turn.reply ?? "").length > MAX_REPLY) errors.push("reply too long");
  if ((turn.citations ?? []).length === 0 && !turn.no_evidence && !turn.ask) errors.push("reply has no evidence");
  return errors;
}
