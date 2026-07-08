/**
 * Read-only adapter contract for HubTender PostgreSQL.
 * Canonical schema: HubTender/supabase/schemas/prod.sql
 */

import { createPostgresHubTenderAdapter } from "./hubtender-adapter-pg.js";

/**
 * @typedef {Object} HubTenderTenderSummary
 * @property {string} id
 * @property {string} tenderNumber
 * @property {string} title
 * @property {string} version
 * @property {string} clientName
 */

/**
 * @typedef {Object} HubTenderPriceRecord
 * @property {string} id
 * @property {string} recordType
 * @property {string} tenderId
 * @property {string} positionId
 * @property {string} positionName
 * @property {string} itemNo
 * @property {string} supplier
 * @property {string} quoteLink
 * @property {string} unitCode
 * @property {string} materialCostPerUnit
 * @property {string} workCostPerUnit
 * @property {string} totalCommercialMaterialCost
 * @property {string} totalCommercialWorkCost
 */

function publicTenderSummary(record = {}) {
  return {
    id: String(record.id || ""),
    tenderNumber: String(record.tenderNumber || record.tender_number || ""),
    title: String(record.title || ""),
    version: String(record.version || ""),
    clientName: String(record.clientName || record.client_name || "")
  };
}

function publicPriceRecord(record = {}) {
  return {
    id: String(record.id || ""),
    recordType: String(record.recordType || "boq_item"),
    tenderId: String(record.tenderId || ""),
    positionId: String(record.positionId || ""),
    positionName: String(record.positionName || ""),
    itemNo: String(record.itemNo || ""),
    supplier: String(record.supplier || ""),
    quoteLink: String(record.quoteLink || ""),
    unitCode: String(record.unitCode || ""),
    materialCostPerUnit: String(record.materialCostPerUnit || "0"),
    workCostPerUnit: String(record.workCostPerUnit || "0"),
    totalCommercialMaterialCost: String(record.totalCommercialMaterialCost || "0"),
    totalCommercialWorkCost: String(record.totalCommercialWorkCost || "0")
  };
}

export function createMockHubTenderAdapter({
  tenders = [],
  priceRecords = []
} = {}) {
  const tenderList = tenders.map(publicTenderSummary);
  const records = priceRecords.map(publicPriceRecord);

  return {
    kind: "mock",
    async close() {},
    async listTendersForAudit({ tenderIds = [] } = {}) {
      if (!tenderIds.length) return tenderList;
      const allow = new Set(tenderIds.map((id) => String(id)));
      return tenderList.filter((item) => allow.has(item.id));
    },
    async findTenderById(tenderId) {
      const id = String(tenderId || "").trim();
      return tenderList.find((item) => item.id === id) || null;
    },
    async findTenderByNumber(tenderNumber) {
      const number = String(tenderNumber || "").trim();
      return tenderList.find((item) => item.tenderNumber === number) || null;
    },
    async getPriceRecords(tenderId) {
      const id = String(tenderId || "").trim();
      return records.filter((item) => item.tenderId === id);
    }
  };
}

export function createHubTenderAdapterFromEnv(env = process.env) {
  const databaseUrl = String(env.HUBTENDER_DATABASE_URL || "").trim();
  if (!databaseUrl) return createMockHubTenderAdapter();
  return createPostgresHubTenderAdapter(databaseUrl);
}

export function summarizeDbRecords(records = []) {
  return {
    recordCount: records.length,
    suppliers: [...new Set(records.map((item) => item.supplier).filter(Boolean))],
    quoteLinks: [...new Set(records.map((item) => item.quoteLink).filter(Boolean))],
    positionNames: records.slice(0, 20).map((item) => item.positionName).filter(Boolean)
  };
}
