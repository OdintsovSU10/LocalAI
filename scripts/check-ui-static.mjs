import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const uiRoot = path.join(projectRoot, "apps", "rag-ui");
const indexPath = path.join(uiRoot, "index.html");
const appPath = path.join(uiRoot, "app.js");
const modulesDir = path.join(uiRoot, "modules");

const pass = [];
const warn = [];
const fail = [];

function recordPass(message) {
  pass.push(message);
}

function recordWarn(message) {
  warn.push(message);
}

function recordFail(message) {
  fail.push(message);
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function displayPath(filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, "/");
}

function isExternalReference(value = "") {
  return /^(?:https?:)?\/\//i.test(value)
    || /^(?:mailto|tel|data|blob):/i.test(value)
    || value.startsWith("#");
}

function resolveUiReference(value = "", fromFile = indexPath) {
  const clean = String(value || "").split(/[?#]/)[0].trim();
  if (!clean || isExternalReference(clean)) return null;
  if (clean.startsWith("/")) return path.join(uiRoot, clean.slice(1));
  return path.resolve(path.dirname(fromFile), clean);
}

function extractAttributes(tag = "") {
  const attrs = {};
  const attrPattern = /([:@A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = attrPattern.exec(tag))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function extractTags(html = "", tagName = "") {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  return html.match(pattern) || [];
}

function extractHtmlReferences(html = "") {
  const references = [];
  for (const tag of extractTags(html, "script")) {
    const attrs = extractAttributes(tag);
    if (attrs.src) references.push({ kind: "script", value: attrs.src, attrs, tag });
  }
  for (const tag of extractTags(html, "link")) {
    const attrs = extractAttributes(tag);
    const rel = String(attrs.rel || "").toLowerCase();
    if (attrs.href && rel.includes("stylesheet")) {
      references.push({ kind: "stylesheet", value: attrs.href, attrs, tag });
    }
  }
  return references;
}

function extractModuleImports(source = "") {
  const imports = [];
  const staticPattern = /import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = staticPattern.exec(source))) imports.push(match[1]);
  while ((match = dynamicPattern.exec(source))) imports.push(match[1]);
  return [...new Set(imports)];
}

function validateImportGraph(entryFiles = []) {
  const seen = new Set();
  const queue = [...entryFiles];

  while (queue.length) {
    const filePath = queue.shift();
    const resolvedFile = path.resolve(filePath);
    if (seen.has(resolvedFile)) continue;
    seen.add(resolvedFile);

    if (!exists(resolvedFile)) {
      recordFail(`Missing module file: ${displayPath(resolvedFile)}`);
      continue;
    }

    const source = readText(resolvedFile);
    for (const specifier of extractModuleImports(source)) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
      const imported = resolveUiReference(specifier, resolvedFile);
      if (!imported) continue;
      if (!exists(imported)) {
        recordFail(`Missing import target: ${displayPath(resolvedFile)} -> ${specifier}`);
        continue;
      }
      if (imported.endsWith(".js")) queue.push(imported);
    }
  }

  if (!fail.some((item) => item.includes("Missing module"))) {
    recordPass(`Module import graph resolved from ${entryFiles.map(displayPath).join(", ")}`);
  }
}

function runNodeCheck(filePath) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  if (result.status === 0) {
    recordPass(`node --check ${displayPath(filePath)}`);
    return;
  }
  recordFail(`node --check failed for ${displayPath(filePath)}: ${String(result.stderr || result.stdout || "").split("\n")[0]}`);
}

function findInlineHandlers(html = "") {
  const handlers = [];
  const tagPattern = /<([A-Za-z][\w:-]*)\b[^>]*>/g;
  let tagMatch;
  while ((tagMatch = tagPattern.exec(html))) {
    const tag = tagMatch[0];
    const attrs = extractAttributes(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (/^on[a-z]+$/.test(name)) {
        handlers.push({ tagName: tagMatch[1], name, value });
      }
    }
  }
  return handlers;
}

function requirePattern(name, pattern, files) {
  const matched = files.some(({ filePath, text }) => {
    const ok = pattern.test(text);
    pattern.lastIndex = 0;
    if (ok) recordPass(`${name}: ${displayPath(filePath)}`);
    return ok;
  });
  if (!matched) recordFail(`Missing UI marker: ${name}`);
}

function scanSuspiciousFrontendDefaults(files) {
  const scans = [
    { name: "private remote host marker", pattern: /01\.vibe|vibe\.local|example-private/i },
    { name: "user-specific Windows path", pattern: /C:\\Users\\|Desktop\\LOCAL_RAG|odintsov/i },
    { name: "OpenAI-style secret key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
    { name: "Bearer token value", pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/i }
  ];

  for (const { name, pattern } of scans) {
    const matches = files
      .filter(({ text }) => pattern.test(text))
      .map(({ filePath }) => displayPath(filePath));
    if (matches.length) recordFail(`Suspicious frontend default found (${name}) in ${[...new Set(matches)].join(", ")}`);
  }
  if (!fail.some((item) => item.startsWith("Suspicious frontend default"))) {
    recordPass("No suspicious frontend private defaults found by static marker scan");
  }
}

function main() {
  if (!exists(indexPath)) recordFail("Missing apps/rag-ui/index.html");
  else recordPass("apps/rag-ui/index.html exists");

  if (!exists(appPath)) recordFail("Missing apps/rag-ui/app.js");
  else recordPass("apps/rag-ui/app.js exists");

  if (!exists(modulesDir)) recordFail("Missing apps/rag-ui/modules directory");
  else recordPass("apps/rag-ui/modules directory exists");

  if (fail.length) return;

  const html = readText(indexPath);
  const moduleFiles = exists(modulesDir)
    ? fs.readdirSync(modulesDir)
      .filter((name) => name.endsWith(".js"))
      .sort()
      .map((name) => path.join(modulesDir, name))
    : [];
  const frontendFiles = [
    indexPath,
    appPath,
    path.join(uiRoot, "styles.css"),
    ...moduleFiles
  ]
    .filter(exists)
    .map((filePath) => ({ filePath, text: readText(filePath) }));

  const references = extractHtmlReferences(html);
  for (const reference of references) {
    const resolved = resolveUiReference(reference.value);
    if (!resolved) continue;
    if (exists(resolved)) recordPass(`${reference.kind} reference exists: ${reference.value}`);
    else recordFail(`Missing ${reference.kind} reference target: ${reference.value}`);
  }

  const appModuleReference = references.find((reference) => {
    const resolved = resolveUiReference(reference.value);
    return resolved && path.resolve(resolved) === path.resolve(appPath);
  });
  if (!appModuleReference) {
    recordFail("index.html does not reference /app.js");
  } else if (String(appModuleReference.attrs.type || "").toLowerCase() !== "module") {
    recordFail("index.html references app.js without type=\"module\"");
  } else {
    recordPass("index.html loads app.js as an ES module");
  }

  validateImportGraph([appPath, ...moduleFiles]);
  [appPath, ...moduleFiles].forEach(runNodeCheck);

  const inlineHandlers = findInlineHandlers(html);
  if (!inlineHandlers.length) {
    recordPass("No inline on* handlers found in index.html");
  } else {
    for (const handler of inlineHandlers) {
      const functionName = String(handler.value || "").match(/^\s*([A-Za-z_$][\w$]*)\s*\(/)?.[1] || "";
      const windowPattern = functionName
        ? new RegExp(`window\\.${functionName}\\b|globalThis\\.${functionName}\\b`)
        : null;
      if (windowPattern && frontendFiles.some(({ text }) => windowPattern.test(text))) {
        recordPass(`Inline handler ${handler.name} uses window-exposed ${functionName}`);
      } else {
        recordWarn(`Inline handler requires manual review: <${handler.tagName}> ${handler.name}`);
      }
    }
  }

  const markerFiles = frontendFiles.filter(({ filePath }) => filePath.endsWith(".html") || filePath.endsWith(".js"));
  const markerChecks = [
    ["chat form", /id=["']chat-form["']|#chat-form\b/],
    ["chat input", /id=["']question["']|#question\b/],
    ["send button", /id=["']send-button["']|#send-button\b/],
    ["stop button", /id=["']stop-button["']|#stop-button\b|function\s+stopChat\b/],
    ["sources panel/list", /id=["']sources["']|id=["']source-select["']|#sources\b|#source-select\b/],
    ["settings panel", /id=["']settings-page["']|#settings-page\b/],
    ["RAG debug panel", /rag-debug|renderRagDebugPanel|compactRagDebug/],
    ["source summary/project card", /source-summary-card|renderSourceSummaryCard|source\.summary/],
    ["remote context warning", /id=["']remote-context-warning["']|#remote-context-warning\b/],
    ["citation/source preview", /source-citation|source-preview|openSourcePreview/],
    ["streaming chat endpoint", /apiStream\(["']\/api\/chat\/stream["']/],
    ["abort controller / stop path", /AbortController|function\s+stopChat\b|\.abort\(\)/],
    ["masked token handling", /hasApiKey|remote-llm-token|placeholder = .*hasApiKey/s]
  ];
  for (const [name, pattern] of markerChecks) requirePattern(name, pattern, markerFiles);

  const agentsUiMarkerChecks = [
    ["#source-viewer-close", /id=["']source-viewer-close["']/],
    ["#indexed-files-panel", /id=["']indexed-files-panel["']/],
    ["#indexed-files-tree", /id=["']indexed-files-tree["']/],
    ["#source-add-shortcut", /id=["']source-add-shortcut["']/],
    ["#new-source-panel", /id=["']new-source-panel["']/],
    ["state.addingSource", /\baddingSource\b/],
    ["focusNewSourceForm()", /function\s+focusNewSourceForm\b/],
    ["loadIndexedFiles()", /function\s+loadIndexedFiles\b/],
    ["renderIndexedFilesPanel()", /function\s+renderIndexedFilesPanel\b/],
    ["buildIndexedFileTree()", /function\s+buildIndexedFileTree\b/],
    ["renderMessageTextContent()", /function\s+renderMessageTextContent\b/],
    ["sourcesByCitationNumber()", /function\s+sourcesByCitationNumber\b/],
    ["applyMatchedSource()", /function\s+applyMatchedSource\b/],
    ["Авто: определить по вопросу", /Авто: определить по вопросу/],
    ["Авто по вопросу", /Авто по вопросу/],
    ["Проект определится из вопроса", /Проект определится из вопроса/]
  ];
  for (const [name, pattern] of agentsUiMarkerChecks) requirePattern(name, pattern, markerFiles);

  const apiMarkerFiles = [
    path.join(projectRoot, "apps", "rag-api", "src", "server.js"),
    path.join(projectRoot, "apps", "rag-api", "src", "llm.js"),
    path.join(projectRoot, "apps", "rag-api", "src", "source-match.js")
  ]
    .filter(exists)
    .map((filePath) => ({ filePath, text: readText(filePath) }));
  const apiMarkerChecks = [
    ["/api/sources/match", /\/api\/sources\/match/],
    ["/api/sources/:id/indexed-files", /\/api\/sources\/:id\/indexed-files/],
    ["matchSourceForQuestion()", /matchSourceForQuestion/],
    ["publicMatchedSource()", /function\s+publicMatchedSource\b/],
    ["matchedSource", /\bmatchedSource\b/],
    ["ensureRemoteModelLoaded", /ensureRemoteModelLoaded/],
    ["remoteRagContextLength = 16384", /remoteRagContextLength\s*=\s*16384/],
    ["context_length", /context_length/]
  ];
  for (const [name, pattern] of apiMarkerChecks) requirePattern(name, pattern, apiMarkerFiles);

  if (!markerFiles.some(({ text }) => /Authorization|Bearer|RAG_AUTH|auth token/i.test(text))) {
    recordWarn("No explicit API auth token UI flow found; keep auth UI behavior in manual checklist.");
  } else {
    recordPass("Auth/token marker found in frontend");
  }

  scanSuspiciousFrontendDefaults(frontendFiles);

  console.log("UI static smoke summary");
  console.log(`PASS: ${pass.length}`);
  console.log(`WARN: ${warn.length}`);
  console.log(`FAIL: ${fail.length}`);

  if (warn.length) {
    console.log("\nWARN");
    warn.forEach((item) => console.log(`- ${item}`));
  }
  if (fail.length) {
    console.log("\nFAIL");
    fail.forEach((item) => console.log(`- ${item}`));
  }

  if (fail.length) process.exit(1);
  console.log("\nUI static smoke: PASS");
}

main();
