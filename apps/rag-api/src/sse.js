function normalizeEventName(event) {
  const value = String(event || "message").trim().replace(/[^\w.-]+/g, "_");
  return value || "message";
}

function serializeSseData(data) {
  if (typeof data === "string") return data;
  return JSON.stringify(data ?? {});
}

export function formatSseEvent(event, data = {}) {
  const payload = serializeSseData(data).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const dataLines = payload.split("\n").map((line) => `data: ${line}`);
  return [`event: ${normalizeEventName(event)}`, ...dataLines, "", ""].join("\n");
}

export function startSseResponse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

export function writeSseEvent(res, event, data = {}) {
  if (res.writableEnded || res.destroyed) return false;
  return res.write(formatSseEvent(event, data));
}
