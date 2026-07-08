function moneyString(value) {
  if (value === null || value === undefined || value === "") return "0";
  return String(value);
}

function supplierFromQuoteLink(quoteLink = "") {
  return String(quoteLink || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function mapTenderRow(row = {}) {
  return {
    id: String(row.id || ""),
    tenderNumber: String(row.tender_number || ""),
    title: String(row.title || ""),
    version: String(row.version ?? ""),
    clientName: String(row.client_name || ""),
    objectAddress: String(row.object_address || ""),
    isArchived: Boolean(row.is_archived),
    cachedGrandTotal: moneyString(row.cached_grand_total)
  };
}

function mapPriceRow(row = {}) {
  const quoteLink = String(row.quote_link || "");
  return {
    id: String(row.id || ""),
    recordType: "boq_item",
    tenderId: String(row.tender_id || ""),
    positionId: String(row.client_position_id || ""),
    positionName: String(row.position_name || ""),
    itemNo: String(row.item_no || ""),
    supplier: supplierFromQuoteLink(quoteLink),
    quoteLink,
    unitCode: String(row.unit_code || ""),
    materialCostPerUnit: moneyString(row.material_cost_per_unit),
    workCostPerUnit: moneyString(row.work_cost_per_unit),
    totalCommercialMaterialCost: moneyString(row.total_commercial_material_cost),
    totalCommercialWorkCost: moneyString(row.total_commercial_work_cost)
  };
}

export async function createPostgresHubTenderAdapter(connectionString) {
  const url = String(connectionString || "").trim();
  if (!url) throw new Error("HubTender PostgreSQL connection string is required");

  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.HUBTENDER_DB_POOL_MAX || 3),
    idleTimeoutMillis: 30_000
  });

  async function query(text, params = []) {
    const result = await pool.query(text, params);
    return result.rows;
  }

  return {
    kind: "postgres",
    async close() {
      await pool.end();
    },
    async findTenderById(tenderId) {
      const rows = await query(`
        SELECT t.id::text, t.tender_number, t.title, t.version, t.client_name,
               COALESCE(tr.object_address, '') AS object_address,
               t.is_archived, COALESCE(t.cached_grand_total, 0) AS cached_grand_total
        FROM public.tenders t
        LEFT JOIN public.tender_registry tr
          ON tr.tender_number = t.tender_number AND tr.title = t.title
        WHERE t.id = $1::uuid
        LIMIT 1
      `, [String(tenderId || "").trim()]);
      return rows[0] ? mapTenderRow(rows[0]) : null;
    },
    async findTenderByNumber(tenderNumber) {
      const rows = await query(`
        SELECT t.id::text, t.tender_number, t.title, t.version, t.client_name,
               COALESCE(tr.object_address, '') AS object_address,
               t.is_archived, COALESCE(t.cached_grand_total, 0) AS cached_grand_total
        FROM public.tenders t
        LEFT JOIN public.tender_registry tr
          ON tr.tender_number = t.tender_number AND tr.title = t.title
        WHERE t.tender_number = $1
        ORDER BY t.updated_at DESC
        LIMIT 1
      `, [String(tenderNumber || "").trim()]);
      return rows[0] ? mapTenderRow(rows[0]) : null;
    },
    async getPriceRecords(tenderId) {
      const rows = await query(`
        SELECT
          bi.id::text,
          bi.tender_id::text,
          bi.client_position_id::text,
          COALESCE(mn.name, wn.name, bi.description, '') AS position_name,
          COALESCE(cp.item_no, '') AS item_no,
          COALESCE(bi.quote_link, '') AS quote_link,
          COALESCE(bi.unit_code, '') AS unit_code,
          COALESCE(cp.material_cost_per_unit, 0) AS material_cost_per_unit,
          COALESCE(cp.work_cost_per_unit, 0) AS work_cost_per_unit,
          COALESCE(bi.total_commercial_material_cost, 0) AS total_commercial_material_cost,
          COALESCE(bi.total_commercial_work_cost, 0) AS total_commercial_work_cost
        FROM public.boq_items bi
        LEFT JOIN public.client_positions cp ON cp.id = bi.client_position_id
        LEFT JOIN public.material_names mn ON mn.id = bi.material_name_id
        LEFT JOIN public.work_names wn ON wn.id = bi.work_name_id
        WHERE bi.tender_id = $1::uuid
        ORDER BY bi.sort_number
      `, [String(tenderId || "").trim()]);
      return rows.map(mapPriceRow);
    },
    async listTendersForAudit({
      includeArchived = false,
      limit = 10_000,
      tenderIds = []
    } = {}) {
      const args = [];
      let where = "WHERE 1=1";
      if (!includeArchived) where += " AND t.is_archived = false";
      if (Array.isArray(tenderIds) && tenderIds.length) {
        args.push(tenderIds.map((id) => String(id)));
        where += ` AND t.id = ANY($${args.length}::uuid[])`;
      }
      const lim = Number(limit) > 0 ? Number(limit) : 10_000;
      args.push(lim);
      const rows = await query(`
        SELECT t.id::text, t.tender_number, t.title, t.version, t.client_name,
               COALESCE(tr.object_address, '') AS object_address,
               t.is_archived, COALESCE(t.cached_grand_total, 0) AS cached_grand_total
        FROM public.tenders t
        LEFT JOIN public.tender_registry tr
          ON tr.tender_number = t.tender_number AND tr.title = t.title
        ${where}
        ORDER BY t.updated_at DESC
        LIMIT $${args.length}
      `, args);
      return rows.map(mapTenderRow);
    }
  };
}
