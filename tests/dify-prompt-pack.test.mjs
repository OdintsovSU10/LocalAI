import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const packRoot = path.join(projectRoot, "docs", "dify-localai-prompt-pack");

async function readPackFile(relativePath) {
  return fs.readFile(path.join(packRoot, relativePath), "utf8");
}

test("Dify prompt pack manifest points to existing files", async () => {
  const manifest = JSON.parse(await readPackFile("manifest.json"));
  assert.equal(manifest.integration, "Dify as workflow layer, LOCAL_RAG as retrieval core");
  assert.ok(manifest.privacy?.noDirectFilesystemAccessFromDify);
  assert.ok(manifest.files.includes("templates/dify-external-knowledge-request.json"));
  assert.ok(manifest.files.includes("templates/dify-chatflow-poc-blueprint.json"));

  for (const relativePath of manifest.files) {
    await fs.access(path.join(packRoot, relativePath));
  }
});

test("Dify prompt pack JSON templates parse and keep secrets as placeholders", async () => {
  const manifest = JSON.parse(await readPackFile("manifest.json"));
  const jsonFiles = manifest.files.filter((file) => file.endsWith(".json"));

  for (const relativePath of jsonFiles) {
    const text = await readPackFile(relativePath);
    const parsed = JSON.parse(text);
    const serialized = JSON.stringify(parsed);
    assert.ok(!/sk-[A-Za-z0-9_-]{20,}/.test(serialized), `${relativePath} contains OpenAI-style secret`);
    assert.ok(!/Bearer\s+[A-Za-z0-9._-]{20,}/i.test(serialized), `${relativePath} contains bearer token value`);
  }

  const variables = JSON.parse(await readPackFile("templates/dify-variables.json"));
  assert.equal(variables.LOCALAI_DIFY_ADAPTER_TOKEN, "SET_IN_DIFY_SECRET_VARIABLES_ONLY");

  const externalKnowledge = JSON.parse(await readPackFile("templates/dify-external-knowledge-request.json"));
  assert.equal(externalKnowledge.endpoint, "{{LOCALAI_DIFY_EXTERNAL_KNOWLEDGE_ENDPOINT}}");
  assert.equal(externalKnowledge.request.retrieval_setting.top_k, 8);
  assert.equal(externalKnowledge.request.retrieval_setting.score_threshold, 0.15);

  const blueprint = JSON.parse(await readPackFile("templates/dify-chatflow-poc-blueprint.json"));
  assert.equal(blueprint.not_importable, true);
  assert.ok(blueprint.acceptance.includes("Dify never indexes LOCAL_RAG documents."));
});

test("Dify contract documents External Knowledge and HTTP tool modes", async () => {
  const contract = await readPackFile("contracts/localai-dify-retrieval-contract.md");
  assert.match(contract, /http:\/\/127\.0\.0\.1:8787\/api\/dify/);
  assert.match(contract, /POST \/api\/dify\/retrieval/);
  assert.match(contract, /retrieval_setting/);
  assert.match(contract, /metadata_condition/);

  const poc = await fs.readFile(path.join(projectRoot, "docs", "dify-localai-poc.md"), "utf8");
  assert.match(poc, /visual workflow \/ orchestration layer/);
  assert.match(poc, /Dify не индексирует live-документы/);
});
