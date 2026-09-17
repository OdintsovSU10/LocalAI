import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const execFileAsync = promisify(execFile);

// Fake OpenAI-compatible LLM. Behaviour is chosen by markers in the user question:
// "СБОЙ" → HTTP 500, "КОНТЕКСТ" → first call per question/mode fails with a context-size error.
export const FAKE_MODEL = "fake-contract-model";

function userMessage(messages = []) {
  return String(messages.find((message) => message.role === "user")?.content || "");
}

function contextSourceCount(messages = []) {
  return (userMessage(messages).match(/^\[\d+\] Источник:/gm) || []).length;
}

export async function startFakeLlm() {
  const contextFailures = new Set();
  // Chat (non-title) requests as received, for assertions about prompts and conversation history.
  const chatRequests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      // Local LLM settings default to the LM Studio runtime, so the server also queries the native
      // /api/v1|v0/models endpoints and loads the model unless it is reported as already loaded.
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [{ id: FAKE_MODEL, object: "model", type: "llm", state: "loaded", loaded_context_length: 32768 }]
        }));
        return;
      }
      if (req.method === "POST" && /\/models\/(load|unload)$/.test(req.url)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: FAKE_MODEL, status: "loaded" }));
        return;
      }
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.writeHead(404);
        res.end();
        return;
      }

      const payload = JSON.parse(body || "{}");
      const question = userMessage(payload.messages).split("\n\nКонтекст:")[0];
      const title = String(payload.messages?.[0]?.content || "").startsWith("Ты называешь чат");
      if (!title) chatRequests.push({ stream: Boolean(payload.stream), messages: payload.messages || [] });

      if (question.includes("СБОЙ")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fake model crashed" } }));
        return;
      }
      const contextKey = `${question}:${Boolean(payload.stream)}`;
      if (question.includes("КОНТЕКСТ") && !contextFailures.has(contextKey)) {
        contextFailures.add(contextKey);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "context length exceeded (n_ctx 4096)" } }));
        return;
      }

      const text = title
        ? "Сумма договора"
        : `Ответ по документам: сумма договора 12 450 000 рублей [1]. Источников в контексте: ${contextSourceCount(payload.messages)}.`;
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      if (!payload.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage }));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const part of [text.slice(0, 20), text.slice(20, 50), text.slice(50)]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    chatRequests,
    // fetch keeps connections alive; without dropping them server.close() waits and the test run hangs.
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    })
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Writes apps/ as it was at a git revision (the pre-refactor baseline) into destDir.
export async function extractAppsAtRevision(revision, destDir) {
  const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "--name-only", revision, "--", "apps"], {
    cwd: projectRoot,
    maxBuffer: 16 * 1024 * 1024
  });
  const files = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!files.length) throw new Error(`git revision ${revision} has no apps/ files`);
  for (const file of files) {
    const { stdout: content } = await execFileAsync("git", ["show", `${revision}:${file}`], {
      cwd: projectRoot,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024
    });
    const target = path.join(destDir, ...file.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

// Temp runtimes live under <repo>/.tmp so the copied server resolves the repo node_modules.
export async function createTempRuntime({ runDir, label, revision = "" }) {
  const root = path.join(runDir, label);
  await fs.mkdir(root, { recursive: true });
  if (revision) await extractAppsAtRevision(revision, root);
  else await fs.cp(path.join(projectRoot, "apps"), path.join(root, "apps"), { recursive: true });
  await fs.cp(path.join(projectRoot, "fixtures", "demo-project"), path.join(root, "fixtures", "demo-project"), { recursive: true });
  await fs.cp(path.join(projectRoot, "fixtures", "demo-project"), path.join(root, "fixtures", "second-project"), { recursive: true });
  await fs.mkdir(path.join(root, "fixtures", "empty-project"), { recursive: true });
  await fs.writeFile(path.join(root, "fixtures", "empty-project", "notes.md"), "# Заметки\n\nПусто.\n", "utf8");
  return root;
}

export async function startApi({ root, llmBaseUrl = "", llmEnabled = true }) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, "apps", "rag-api", "src", "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: path.join(root, ".env.disabled"),
      NODE_ENV: "test",
      RAG_HOST: "127.0.0.1",
      RAG_PORT: String(port),
      // Not "<root>/data": paths.js maps the legacy repo data dir to the live data folder.
      RAG_DATA_DIR: path.join(root, "contract-data"),
      RAG_METADATA_PROVIDER: "json",
      RAG_REQUIRE_AUTH: "false",
      RAG_AUTH_TOKEN: "",
      RAG_ALLOW_REMOTE_CONTEXT: "false",
      RAG_REMOTE_LLM_ENABLED: "false",
      RAG_LLM_PROVIDER: "local",
      RAG_LLM_ENABLED: llmEnabled ? "true" : "false",
      RAG_LLM_BASE_URL: llmBaseUrl || "http://127.0.0.1:9/v1",
      RAG_LLM_MODEL: FAKE_MODEL,
      RAG_LLM_FALLBACK_TO_LOCAL_ON_REMOTE_ERROR: "false",
      RAG_EMBEDDINGS_ENABLED: "false",
      RAG_VECTOR_STORE_ENABLED: "false",
      QDRANT_ENABLED: "false",
      RAG_RERANKER_ENABLED: "false",
      RAG_OCR_ENABLED: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });

  const startedAt = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`API exited early: ${output.slice(-800)}`);
    if (Date.now() - startedAt > 20000) {
      await stop();
      throw new Error(`API readiness timed out: ${output.slice(-800)}`);
    }
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) break;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return { baseUrl, stop };
}

export async function requestJson(baseUrl, route, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, payload: text ? JSON.parse(text) : null };
}

export async function postJson(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { rawText: text };
  }
  return { status: response.status, payload };
}

export function parseSse(text = "") {
  return String(text)
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      const raw = data.join("\n");
      let payload = raw;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        // keep raw text
      }
      return { event, payload };
    });
}

export async function postSse(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, events: parseSse(await response.text()) };
}

export async function addSource(baseUrl, { title, folder }) {
  const added = await postJson(baseUrl, "/api/sources", { title, path: folder });
  if (!added.payload?.id) throw new Error(`source add failed (${added.status}): ${JSON.stringify(added.payload)}`);
  return added.payload;
}

export async function indexSource(baseUrl, sourceId) {
  const started = await postJson(baseUrl, `/api/sources/${encodeURIComponent(sourceId)}/index`, { force: true });
  const jobId = started.payload?.id;
  if (!jobId) throw new Error(`index start failed (${started.status}): ${JSON.stringify(started.payload)}`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60000) {
    const job = await (await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`)).json();
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new Error(`index failed: ${job.message}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("index timed out");
}

// Replaces run-specific values (temp paths, source ids and path hashes, LLM port, timings,
// timestamps, uuids) so responses from two runtimes can be compared structurally.
export function normalizeForContract(value, { root, llmBaseUrl = "", aliases = {} }) {
  const hashes = new Map();
  const rootVariants = [root, root.replaceAll("\\", "/"), root.replaceAll("\\", "\\\\")];
  const aliasEntries = Object.entries(aliases).sort((left, right) => right[0].length - left[0].length);
  const normalizeString = (text) => {
    let result = String(text);
    for (const variant of rootVariants) result = result.split(variant).join("<ROOT>");
    for (const [id, alias] of aliasEntries) result = result.split(id).join(alias);
    if (llmBaseUrl) result = result.split(llmBaseUrl).join("<LLM>");
    result = result.replace(/\b[0-9a-f]{40}\b/g, (hash) => {
      if (!hashes.has(hash)) hashes.set(hash, `<HASH${hashes.size + 1}>`);
      return hashes.get(hash);
    });
    return result
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIME>")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<UUID>");
  };
  const walk = (item, key = "") => {
    if (Array.isArray(item)) return item.map((entry) => walk(entry));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([entryKey, entry]) => [normalizeString(entryKey), walk(entry, entryKey)]));
    }
    if (typeof item === "number" && /(Ms|At|Seconds|Percent)$/.test(key)) return "<NUM>";
    if (typeof item === "string") return normalizeString(item);
    return item;
  };
  return walk(value);
}
