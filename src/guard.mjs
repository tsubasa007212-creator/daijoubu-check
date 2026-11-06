// 返す前の検査。根拠の外へ出た返答は、ここで止める。

const ASSERTIONS = [
  /大丈夫です/, /問題(ありません|ない|なさ)/, /安全です/, /壊れています/, /原因は.{0,30}(です|だ)/,
  /交換(して)?(ください|しましょう)/, /修理(して)?(ください|しましょう)/, /持ち込み(ましょう|ください)/,
  /見てもら(って|い)(ください|ましょう)/, /見てもらう(こと|のが|べき)/, /お店で見てもらい/,
  /平気/, /心配(いり|は)ません/, /(走|乗)れます/, /大丈夫だよ/, /大丈夫でしょう(?!か)/,
  /\b(it|your bike|the bike|this)( is|'s) (fine|ok|okay|safe)\b/i, /\bno problem\b/i, /\bis broken\b/i,
  /\bthe cause is\b/i, /\b(please )?(replace|repair) (it|the)\b/i, /\byou should\b/i, /\btake it to\b/i,
];
// 新しく走って確かめるよう頼む文。否定の文に混ざっていても止める。
const RIDE_REQUESTS = [/(走|乗)って.{0,30}(確かめ|試し)て(ください|みて|ほしい|もらえ|。|$)/];
const MAX_REPLY = 600;
// 金額は data/prices.json から決まった形で出す。Claudeの文には入れない。
const MONEY = /[¥￥]\s?\d|\d[\d,]*\s?(円|yen)/i;
// 「大丈夫です」とは言えません、のような否定は言い切りではない。
const NEGATED = /とは(言え|言い切れ|限ら|決め)|かどうか|か(は|も)(分かり|言え)|cannot say|can't say|not sure|whether|can(?:no|')t tell|can(?:no|')t confirm|have not confirmed/i;

// 「〜とは言えませんが、問題ありません」を否定の文として通さないよう、「が、」「けど、」でも分ける。
export function assertions(reply) {
  const plain = reply.replace(/[’‘]/g, "'").replace(/「[^」]*」/g, "");
  const sentences = plain.split(/(?<=[。．.!?！？\n]|が、|けど、)/);
  return [
    ...sentences.filter((s) => !NEGATED.test(s)).flatMap((s) => ASSERTIONS.filter((p) => p.test(s))),
    ...sentences.flatMap((s) => RIDE_REQUESTS.filter((p) => p.test(s))),
  ];
}

export function checkTurn(turn, cards, { requireHumanCheck = true, released = [], statementIds = null, flows = [] } = {}) {
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
  if (turn.step) {
    const flow = flows.find((f) => f.id === turn.step.flow_id);
    if (!flow || !flow.steps.some((s) => s.id === turn.step.step_id)) errors.push(`step not found: ${turn.step.flow_id}/${turn.step.step_id}`);
    else if (requireHumanCheck && flow.human_check !== "approved") errors.push(`flow not approved: ${flow.id}`);
  }
  if (turn.no_evidence && (turn.citations ?? []).length > 0) errors.push("no_evidence with citations");
  if (assertions(turn.reply ?? "").length > 0) errors.push("assertion in reply");
  if ((turn.reply ?? "").length > MAX_REPLY) errors.push("reply too long");
  if (MONEY.test(turn.reply ?? "")) errors.push("money in reply");
  if ((turn.citations ?? []).length === 0 && !turn.no_evidence && !turn.ask && !turn.step) errors.push("reply has no evidence");
  return errors;
}

// 症状の分からない相談と挨拶は、Claudeの文を使わず決まった文で返す。
export function fixedTurn(turn, lang, replies) {
  const reply = replies[turn.kind];
  if (!reply || turn.step || (turn.citations ?? []).length > 0) return null;
  return { ...turn, reply: reply[lang] ?? reply.ja, citations: [], ask: null, step: null, no_evidence: false, topics: true };
}

// 言い切りで止まった時も、確認済みの流れの問いは大谷の言葉なので、そのまま聞ける。
export function askStepOnly(turn, flows, errors) {
  if (errors.length !== 1 || errors[0] !== "assertion in reply" || !turn.step) return null;
  const flow = flows.find((f) => f.id === turn.step.flow_id);
  const step = flow?.steps.find((s) => s.id === turn.step.step_id);
  return step ? { ...turn, reply: step.ask, ask: null, citations: [], no_evidence: false } : null;
}
