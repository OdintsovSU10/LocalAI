import { sanitizeValue } from "../sanitize/redact.js";

export async function getAgentRuns(apiClient, args = {}) {
  const limit = Math.min(Math.max(Number(args.limit || 10), 1), 20);
  const rows = await apiClient.get("/api/agent/runs");
  const runs = (Array.isArray(rows) ? rows : [])
    .slice(0, limit)
    .map((run) => sanitizeValue({
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      force: Boolean(run.force),
      dryRun: Boolean(run.dryRun),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      totals: run.totals || {},
      error: run.error || ""
    }));

  return { runs };
}
