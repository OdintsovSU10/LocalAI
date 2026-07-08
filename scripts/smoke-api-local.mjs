import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const keepTemp = process.argv.includes("--keep-temp");
const smokeToken = "smoke-test-token";
const question = "Какая сумма договора?";
const paymentQuestion = "Какой график оплаты?";

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

function assertSmoke(condition, message) {
  if (!condition) {
    recordFail(message);
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactedLine(value = "") {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["'\s:=]+[^"',\s]+/gi, "apiKey=[redacted]")
    .split(/\r?\n/)
    .slice(-6)
    .join("\n");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function copyRuntimeProject(tempProjectRoot) {
  await fs.mkdir(tempProjectRoot, { recursive: true });
  await fs.cp(path.join(projectRoot, "apps"), path.join(tempProjectRoot, "apps"), { recursive: true });
  await fs.cp(
    path.join(projectRoot, "fixtures", "demo-project"),
    path.join(tempProjectRoot, "fixtures", "demo-project"),
    { recursive: true }
  );
}

function runtimeEnv({ tempProjectRoot, port, requireAuth = false }) {
  return {
    ...process.env,
    DOTENV_CONFIG_PATH: path.join(tempProjectRoot, ".env.disabled"),
    NODE_ENV: "test",
    RAG_HOST: "127.0.0.1",
    RAG_PORT: String(port),
    RAG_DATA_DIR: path.join(tempProjectRoot, "data"),
    RAG_METADATA_PROVIDER: "json",
    RAG_REQUIRE_AUTH: requireAuth ? "true" : "false",
    RAG_AUTH_TOKEN: requireAuth ? smokeToken : "",
    RAG_ALLOW_REMOTE_CONTEXT: "false",
    RAG_REMOTE_LLM_ENABLED: "false",
    RAG_LLM_PROVIDER: "local",
    RAG_LLM_ENABLED: "false",
    RAG_LLM_FALLBACK_TO_LOCAL_ON_REMOTE_ERROR: "false",
    RAG_EMBEDDINGS_ENABLED: "false",
    RAG_VECTOR_STORE_ENABLED: "false",
    QDRANT_ENABLED: "false",
    RAG_RERANKER_ENABLED: "false",
    RAG_OCR_ENABLED: "false"
  };
}

function authHeader(enabled) {
  return enabled ? { Authorization: `Bearer ${smokeToken}` } : {};
}

async function startServer({ name, requireAuth = false, tempRoot }) {
  const tempProjectRoot = path.join(tempRoot, name);
  await copyRuntimeProject(tempProjectRoot);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(tempProjectRoot, "apps", "rag-api", "src", "server.js")], {
    cwd: tempProjectRoot,
    env: runtimeEnv({ tempProjectRoot, port, requireAuth }),
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForReady(baseUrl, authHeader(requireAuth), child);
  } catch (error) {
    child.kill();
    const details = redactedLine(`${stdout}\n${stderr}`);
    throw new Error(`${error.message}${details ? `\n${details}` : ""}`);
  }

  return {
    baseUrl,
    child,
    requireAuth,
    headers: authHeader(requireAuth),
    tempProjectRoot
  };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.child.kill("SIGKILL");
      resolve();
    }, 2500);
    server.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    server.child.kill();
  });
}

async function waitForReady(baseUrl, headers, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 12000) {
    if (child.exitCode !== null) throw new Error(`server exited before readiness with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers });
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(120);
  }
  throw new Error("server readiness timed out");
}

async function requestJson(baseUrl, route, options = {}) {
  const headers = {
    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {})
  };
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { text };
  }
  return { response, payload, text };
}

function parseSseEvents(text = "") {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      const raw = data.join("\n");
      let payload = raw;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        // Keep raw payload for non-JSON SSE data.
      }
      return { event, payload };
    });
}

async function requestSse(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(options.body || {})
  });
  const text = await response.text();
  return { response, events: parseSseEvents(text), text };
}

function sourceHasSafeSummary(source) {
  const summary = source?.summary || {};
  const serialized = JSON.stringify(summary);
  return source?.summary
    && Number(summary.fileCount || 0) > 0
    && Number(summary.chunkCount || 0) > 0
    && !/Bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{20,}|api[_-]?key/i.test(serialized);
}

async function setupDemoSource(server) {
  const fixturePath = path.join(server.tempProjectRoot, "fixtures", "demo-project");
  const add = await requestJson(server.baseUrl, "/api/sources", {
    method: "POST",
    headers: server.headers,
    body: {
      title: "Demo Project",
      path: fixturePath
    }
  });
  assertSmoke(add.response.status === 201 || add.response.status === 200, "source add endpoint failed");
  const source = add.payload;
  assertSmoke(source?.id, "source add did not return source id");

  const index = await requestJson(server.baseUrl, `/api/sources/${encodeURIComponent(source.id)}/index`, {
    method: "POST",
    headers: server.headers,
    body: { force: true }
  });
  assertSmoke(index.response.status === 202 || index.response.status === 200, "source index endpoint failed");
  const jobId = index.payload.id;
  assertSmoke(jobId, "source index did not return job id");

  const job = await waitForJob(server.baseUrl, jobId, server.headers);
  assertSmoke(job.status === "completed", "source index job did not complete");
  assertSmoke(Number(job.indexedFiles || job.files || 0) >= 5, "source index did not cover demo files");
  return source;
}

async function waitForJob(baseUrl, jobId, headers) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < 45000) {
    const result = await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(jobId)}`, { headers });
    if (result.response.ok) {
      last = result.payload;
      if (["completed", "failed"].includes(last.status)) return last;
    }
    await sleep(250);
  }
  throw new Error(`index job timed out with last status ${last?.status || "unknown"}`);
}

function assertLocalPrivacyMetadata(metadata = {}, label = "chat metadata") {
  assertSmoke(metadata.remoteContextAllowed === false, `${label} allowed remote context`);
  assertSmoke(metadata.selectedProvider !== "remote", `${label} selected remote provider`);
  assertSmoke(metadata.selectedBaseUrlKind !== "remote", `${label} selected remote base URL`);
}

function sourceMatchesFileHint(source = {}, expectedFileHint = "") {
  const hint = String(expectedFileHint || "").toLowerCase();
  return [
    source.fileLabel,
    source.pathLabel,
    source.title,
    source.citationLabel,
    source.path
  ].some((value) => String(value || "").toLowerCase().endsWith(hint));
}

function previewText(payload = {}) {
  return [
    payload.excerpt,
    payload.text,
    payload.markdown
  ].filter(Boolean).join("\n");
}

function previewParamsForSource(source = {}, fallbackSourceId = "") {
  const target = source.citationTarget || {};
  const sourceId = source.sourceId || target.sourceId || fallbackSourceId;
  const chunkId = source.chunkId || target.chunkId || source.id || "";
  const fileId = source.fileId || target.fileId || "";
  const params = new URLSearchParams({ sourceId });
  if (chunkId) params.set("chunkId", chunkId);
  else if (fileId) params.set("fileId", fileId);
  else params.set("path", source.path || "");
  return params;
}

async function assertExactCitationPreview(server, {
  chatPayload,
  fallbackSourceId,
  expectedFileHint,
  mustContain,
  label
}) {
  const previewSource = chatPayload.sources.find((item) => sourceMatchesFileHint(item, expectedFileHint));
  assertSmoke(previewSource, `${label}: chat sources did not include ${expectedFileHint}`);
  assertSmoke(
    previewSource.chunkId || previewSource.citationTarget?.chunkId || previewSource.id,
    `${label}: citation source has no chunk target`
  );

  const preview = await requestJson(server.baseUrl, `/api/files/preview?${previewParamsForSource(previewSource, fallbackSourceId)}`);
  assertSmoke(preview.response.status === 200, `${label}: preview endpoint failed for citation target`);
  assertSmoke(preview.payload.targetMatched === true, `${label}: preview target was not matched exactly`);
  assertSmoke(sourceMatchesFileHint(preview.payload, expectedFileHint), `${label}: preview file did not match ${expectedFileHint}`);
  const text = previewText(preview.payload);
  for (const expected of mustContain) {
    assertSmoke(text.includes(expected), `${label}: preview did not contain expected evidence: ${expected}`);
  }
  recordPass(`${label}: exact evidence preview`);
}

async function runNoAuthScenario(server) {
  const health = await requestJson(server.baseUrl, "/api/health");
  assertSmoke(health.response.status === 200 && health.payload.ok === true, "no-auth health failed");
  recordPass("no-auth health");

  const initialSources = await requestJson(server.baseUrl, "/api/sources");
  assertSmoke(initialSources.response.status === 200 && Array.isArray(initialSources.payload), "no-auth sources list failed");
  recordPass("no-auth sources list");

  const source = await setupDemoSource(server);
  recordPass("source add/index via API");

  const sourcesAfterIndex = await requestJson(server.baseUrl, "/api/sources");
  assertSmoke(sourcesAfterIndex.response.status === 200, "sources after index failed");
  const indexedSource = sourcesAfterIndex.payload.find((item) => item.id === source.id);
  assertSmoke(indexedSource, "indexed demo source not visible through /api/sources");
  assertSmoke(sourceHasSafeSummary(indexedSource), "source summary missing, empty, or suspicious");
  recordPass("source summary via /api/sources");

  const indexedFiles = await requestJson(server.baseUrl, `/api/sources/${encodeURIComponent(source.id)}/indexed-files`);
  assertSmoke(indexedFiles.response.status === 200, "indexed files endpoint failed");
  assertSmoke(Number(indexedFiles.payload.total || 0) >= 5, "indexed files endpoint did not expose demo files");

  const chat = await requestJson(server.baseUrl, "/api/chat", {
    method: "POST",
    body: { question, sourceId: source.id }
  });
  assertSmoke(chat.response.status === 200, "/api/chat fallback failed");
  assertSmoke(Array.isArray(chat.payload.sources) && chat.payload.sources.length > 0, "/api/chat returned no sources");
  assertLocalPrivacyMetadata(chat.payload.metadata || {}, "/api/chat metadata");
  recordPass("/api/chat fallback without LLM");

  const stream = await requestSse(server.baseUrl, "/api/chat/stream", {
    body: { question, sourceId: source.id }
  });
  assertSmoke(stream.response.status === 200, "/api/chat/stream failed");
  const eventNames = stream.events.map((item) => item.event);
  assertSmoke(eventNames.includes("done"), "/api/chat/stream did not emit done");
  assertSmoke(eventNames.includes("sources"), "/api/chat/stream did not emit sources");
  const streamDone = stream.events.find((item) => item.event === "done")?.payload || {};
  assertLocalPrivacyMetadata(streamDone.metadata || {}, "/api/chat/stream metadata");
  recordPass("/api/chat/stream fallback without LLM");

  await runAbortProbe(server, source.id);

  await assertExactCitationPreview(server, {
    chatPayload: chat.payload,
    fallbackSourceId: source.id,
    expectedFileHint: "contract.md",
    mustContain: ["12 450 000 рублей"],
    label: "contract amount"
  });

  const paymentChat = await requestJson(server.baseUrl, "/api/chat", {
    method: "POST",
    body: { question: paymentQuestion, sourceId: source.id }
  });
  assertSmoke(paymentChat.response.status === 200, "/api/chat payment fallback failed");
  assertSmoke(Array.isArray(paymentChat.payload.sources) && paymentChat.payload.sources.length > 0, "/api/chat payment returned no sources");
  await assertExactCitationPreview(server, {
    chatPayload: paymentChat.payload,
    fallbackSourceId: source.id,
    expectedFileHint: "budget.md",
    mustContain: ["аванс 30%", "финальный платеж 30%"],
    label: "payment schedule"
  });

  const traversal = await requestJson(
    server.baseUrl,
    `/api/files/preview?sourceId=${encodeURIComponent(source.id)}&path=${encodeURIComponent("../../package.json")}`
  );
  assertSmoke([400, 403, 404].includes(traversal.response.status), "preview traversal probe returned unexpected status");
  recordPass("preview traversal guard");

  return { sourceId: source.id };
}

async function runAbortProbe(server, sourceId) {
  const controller = new AbortController();
  let partial = false;
  try {
    const response = await fetch(`${server.baseUrl}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...server.headers },
      signal: controller.signal,
      body: JSON.stringify({ question, sourceId })
    });
    assertSmoke(response.status === 200, "abort probe stream did not start");
    if (!response.body) {
      recordWarn("AbortController path partial: response body was not stream-readable");
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const chunkText = first.value ? decoder.decode(first.value, { stream: true }) : "";
    partial = chunkText.includes("event: done");
    controller.abort();
    try {
      await reader.read();
    } catch {
      // Expected after abort.
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  }

  await sleep(150);
  const health = await requestJson(server.baseUrl, "/api/health", { headers: server.headers });
  assertSmoke(health.response.status === 200, "server health failed after AbortController probe");
  if (partial) {
    recordWarn("AbortController path partial: fallback stream completed before abort could interrupt it");
  } else {
    recordPass("AbortController stream probe");
  }
}

async function runAuthScenario(server) {
  const noTokenSources = await requestJson(server.baseUrl, "/api/sources");
  assertSmoke(noTokenSources.response.status === 401, "auth /api/sources without token did not return 401");

  const wrongTokenSources = await requestJson(server.baseUrl, "/api/sources", {
    headers: { Authorization: "Bearer wrong-smoke-token" }
  });
  assertSmoke(wrongTokenSources.response.status === 401, "auth /api/sources with wrong token did not return 401");

  const authorizedSources = await requestJson(server.baseUrl, "/api/sources", { headers: server.headers });
  assertSmoke(authorizedSources.response.status === 200, "auth /api/sources with token failed");

  const source = await setupDemoSource(server);
  const chatNoToken = await requestJson(server.baseUrl, "/api/chat", {
    method: "POST",
    body: { question, sourceId: source.id }
  });
  assertSmoke(chatNoToken.response.status === 401, "auth /api/chat without token did not return 401");

  const chatAuthorized = await requestJson(server.baseUrl, "/api/chat", {
    method: "POST",
    headers: server.headers,
    body: { question, sourceId: source.id }
  });
  assertSmoke(chatAuthorized.response.status === 200, "auth /api/chat with token failed");
  assertSmoke(Array.isArray(chatAuthorized.payload.sources) && chatAuthorized.payload.sources.length > 0, "auth /api/chat returned no sources");

  const streamNoToken = await requestJson(server.baseUrl, "/api/chat/stream", {
    method: "POST",
    body: { question, sourceId: source.id }
  });
  assertSmoke(streamNoToken.response.status === 401, "auth /api/chat/stream without token did not return 401");

  const options = await fetch(`${server.baseUrl}/api/sources`, {
    method: "OPTIONS",
    headers: server.headers
  });
  if (options.status >= 500) {
    recordWarn("OPTIONS/preflight returned server error in auth smoke");
  } else {
    recordPass("auth OPTIONS/preflight did not break base flow");
  }

  recordPass("auth 401 and authorized API flow");
}

function printSummary() {
  console.log("API runtime smoke summary");
  console.log(`PASS: ${pass.length}`);
  console.log(`WARN: ${warn.length}`);
  console.log(`FAIL: ${fail.length}`);
  console.log("Temp runtime: created");
  console.log("Live config/data/env: not used");
  console.log("LM Studio/Qdrant/OCR/eval:llm: not used");

  if (warn.length) {
    console.log("\nWARN");
    warn.forEach((item) => console.log(`- ${item}`));
  }

  if (fail.length) {
    console.log("\nFAIL");
    fail.forEach((item) => console.log(`- ${item}`));
  }
}

async function main() {
  const tempRoot = path.join(projectRoot, ".tmp", "smoke-api-local", `run-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const servers = [];

  try {
    const noAuthServer = await startServer({ name: "no-auth", requireAuth: false, tempRoot });
    servers.push(noAuthServer);
    await runNoAuthScenario(noAuthServer);
    await stopServer(noAuthServer);

    const authServer = await startServer({ name: "auth", requireAuth: true, tempRoot });
    servers.push(authServer);
    await runAuthScenario(authServer);
    await stopServer(authServer);
  } finally {
    await Promise.allSettled(servers.map(stopServer));
    if (keepTemp) {
      console.log(`Keeping temp runtime: ${tempRoot}`);
    } else {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  printSummary();
  if (fail.length) process.exit(1);
  console.log("\nAPI runtime smoke: PASS");
}

await main();
