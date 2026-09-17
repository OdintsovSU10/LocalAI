import { normalizeDocumentNumber } from "./document-classifier.js";
import { normalizedKey } from "./fact-extractor.js";
import { sha1 } from "./evidence-spans.js";

// Fact types that describe the same quantity across different documents of a source
// (contract price vs. estimate total). Other types are compared only inside a contract family.
const CROSS_DOCUMENT_GROUPS = {
  contract_price: "total_cost",
  estimate_total: "total_cost"
};

function parentFor(document, documents) {
  const ref = document.parentRef;
  if (!ref?.numberKey) return { parent: null, reason: "document names no parent contract" };
  const candidates = documents.filter((item) => item.kind === "contract"
    && item.sourceId === document.sourceId
    && normalizeDocumentNumber(item.number) === ref.numberKey
    && (!ref.date || !item.documentDate || ref.date === item.documentDate));
  if (candidates.length === 1) return { parent: candidates[0], reason: "" };
  return {
    parent: null,
    reason: candidates.length ? `ambiguous parent contract № ${ref.number}` : `parent contract № ${ref.number} not found in source`
  };
}

function byDateThenOrder(left, right) {
  if (left.documentDate && right.documentDate && left.documentDate !== right.documentDate) {
    return left.documentDate < right.documentDate ? -1 : 1;
  }
  return 0;
}

/**
 * Links amendments/appendices to their base contract and applies amendments to facts:
 * a fact from a clause "пункт N изложить в новой редакции" supersedes the base fact of the same type and clause.
 * Nothing is deleted: superseded facts keep their evidence with status "superseded" and valid_to.
 * Values that differ without a stated precedence are marked "conflict" instead of picking one silently.
 */
export function linkDocumentFamily({ documents = [], facts = [] }) {
  const docs = documents.map((document) => ({ ...document, parentDocumentId: null, relation: "none" }));
  const docById = new Map(docs.map((document) => [document.documentId, document]));
  const outFacts = facts.map((fact) => ({ ...fact, evidenceIds: [...fact.evidenceIds] }));
  const relations = [];
  const conflicts = [];

  for (const document of docs) {
    if (!["amendment", "appendix"].includes(document.kind)) continue;
    const { parent, reason } = parentFor(document, docs);
    const relation = parent ? (document.kind === "amendment" ? "amends" : "appendix_of") : "unknown";
    document.relation = relation;
    document.parentDocumentId = parent?.documentId || null;
    relations.push({ sourceId: document.sourceId, fromDocumentId: document.documentId, toDocumentId: parent?.documentId || null, relation, reason });
  }

  const familyRoot = (document) => (document.parentDocumentId ? docById.get(document.parentDocumentId) : document);

  // Apply amendments in date order; amendments without a date cannot be ordered and do not supersede.
  const amendments = docs.filter((document) => document.relation === "amends").sort(byDateThenOrder);
  for (const amendment of amendments) {
    const root = familyRoot(amendment);
    const familyDocIds = new Set(docs.filter((document) => familyRoot(document) === root && document !== amendment
      && (!document.documentDate || !amendment.documentDate || document.documentDate <= amendment.documentDate))
      .map((document) => document.documentId));

    for (const fact of outFacts.filter((item) => item.documentId === amendment.documentId && item.amends)) {
      if (!amendment.documentDate) continue;
      const candidates = outFacts.filter((item) => familyDocIds.has(item.documentId)
        && item.factType === fact.factType
        && item.status === "active");
      const sameClause = candidates.filter((item) => item.clauseRef && item.clauseRef === fact.clauseRef);
      const targets = sameClause.length ? sameClause : (candidates.length === 1 ? candidates : []);
      for (const target of targets) {
        target.status = "superseded";
        target.supersededByFactId = fact.factId;
        target.validTo = amendment.documentDate;
        fact.supersedesFactId = fact.supersedesFactId || target.factId;
      }
      fact.validFrom = amendment.documentDate;
    }
  }

  const markConflict = (group, members, typeGroup, reason) => {
    const values = new Set(members.map((fact) => normalizedKey(fact.normalized)));
    if (members.length < 2 || values.size < 2) return;
    for (const fact of members) fact.status = "conflict";
    const factIds = members.map((fact) => fact.factId).sort();
    conflicts.push({
      conflictId: `conflict_${sha1(`${group}|${factIds.join(",")}`).slice(0, 16)}`,
      sourceId: members[0].sourceId,
      typeGroup,
      factIds,
      reason
    });
  };

  const active = () => outFacts.filter((fact) => fact.status === "active");
  const families = new Map();
  for (const fact of active()) {
    if (CROSS_DOCUMENT_GROUPS[fact.factType]) continue;
    const root = familyRoot(docById.get(fact.documentId));
    const key = `${root.documentId}|${fact.factType}`;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(fact);
  }
  for (const [key, members] of families) {
    markConflict(key, members, members[0].factType, "different values in one contract family without a stated amendment");
  }

  const crossGroups = new Map();
  for (const fact of active()) {
    const typeGroup = CROSS_DOCUMENT_GROUPS[fact.factType];
    if (!typeGroup) continue;
    const key = `${fact.sourceId}|${typeGroup}`;
    if (!crossGroups.has(key)) crossGroups.set(key, []);
    crossGroups.get(key).push(fact);
  }
  for (const [key, members] of crossGroups) {
    markConflict(key, members, CROSS_DOCUMENT_GROUPS[members[0].factType], "documents of the source state different totals");
  }

  return { documents: docs, facts: outFacts, relations, conflicts };
}
