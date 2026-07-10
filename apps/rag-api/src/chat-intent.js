function normalizeIntentText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const broadAnswerIntentPatterns = [
  /\b(?:summary|overview|summarize|summarise)\b/i,
  /\b(?:main|key|essential)\s+(?:terms|conditions|points|facts|risks)\b/i,
  /(?:^|\s)(?:основн|ключев|существенн)\p{L}*\s+(?:услов|положен|пункт|факт|риск|требован)\p{L}*(?:\s|$)/u,
  /(?:^|\s)(?:сводк|обзор|резюме)\p{L}*(?:\s|$)/u,
  /(?:^|\s)(?:проанализируй|разбери|проверь)\s+(?:договор|контракт|проект)\p{L}*(?:\s|$)/u,
  /(?:^|\s)(?:что|чего)\s+(?:в|по)\s+(?:договор|контракт)\p{L}*(?:\s|$)/u
];

const contractOverviewPatterns = [
  /(?:^|\s)(?:договор|контракт|соглашени|дс|допсоглашени|услов)\p{L}*(?:\s|$)/u,
  /\b(?:contract|agreement|terms|conditions)\b/i
];

const contractOverviewRetrievalTerms = [
  "предмет договора",
  "стороны заказчик подрядчик исполнитель",
  "цена стоимость сумма договора НДС",
  "срок выполнения работ дата окончания период",
  "оплата платеж аванс",
  "гарантийное удержание банковская гарантия обеспечение",
  "ответственность штраф пени неустойка",
  "дополнительное соглашение изменение цены"
].join(" ");

export function hasBroadAnswerIntent(question = "") {
  const text = normalizeIntentText(question);
  return broadAnswerIntentPatterns.some((pattern) => pattern.test(text));
}

export function expandedChatRetrievalQuery(question = "") {
  const text = normalizeIntentText(question);
  if (!hasBroadAnswerIntent(text)) return String(question || "");
  const isContractOverview = contractOverviewPatterns.some((pattern) => pattern.test(text));
  if (!isContractOverview) return String(question || "");
  return `${question}\n${contractOverviewRetrievalTerms}`;
}
