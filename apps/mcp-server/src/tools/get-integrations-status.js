import { sanitizeValue } from "../sanitize/redact.js";

export async function getIntegrationsStatus(apiClient) {
  const payload = await apiClient.get("/api/integrations/status");
  return sanitizeValue({
    vectorStore: payload.vectorStore || {},
    reranker: payload.reranker || {},
    pdf: payload.pdf || {}
  });
}
