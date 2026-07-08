const DEFAULT_SNIPPET_CHARS = 400;

export function truncateText(text = "", maxChars = DEFAULT_SNIPPET_CHARS) {
  const value = String(text || "");
  const limit = Math.max(0, Number(maxChars) || 0);
  if (!limit || value.length <= limit) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, limit)}…`,
    truncated: true
  };
}

export function truncateFields(record = {}, fields = [], maxChars = DEFAULT_SNIPPET_CHARS) {
  const output = { ...record };
  let truncated = false;

  for (const field of fields) {
    if (!(field in output)) continue;
    const result = truncateText(output[field], maxChars);
    output[field] = result.text;
    truncated = truncated || result.truncated;
  }

  return { record: output, truncated };
}

export function makeSnippet(text = "", maxChars = DEFAULT_SNIPPET_CHARS) {
  return truncateText(text, maxChars).text;
}
