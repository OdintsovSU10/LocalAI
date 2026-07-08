export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export function parseSseEventBlock(block) {
  const lines = String(block || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let event = "message";
  const data = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }

  const raw = data.join("\n");
  let payload = raw;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = raw;
  }
  return { event, payload };
}

export async function apiStream(path, options = {}, onEvent = () => {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  if (!response.body) {
    const payload = await response.json().catch(() => ({}));
    onEvent({ event: "done", payload });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consume = (block) => {
    const parsed = parseSseEventBlock(block);
    if (parsed.event) onEvent(parsed);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (buffer.trim()) consume(buffer);
}

export function apiErrorMessage(error, action = "Не удалось выполнить запрос") {
  const message = String(error?.message || "").trim();
  if (message === "Failed to fetch" || /networkerror|load failed/i.test(message)) {
    return "Сервер Local RAG недоступен. Запустите npm run dev и обновите страницу.";
  }
  return message ? `${action}: ${message}` : action;
}
