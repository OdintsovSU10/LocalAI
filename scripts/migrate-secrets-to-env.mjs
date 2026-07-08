import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const settingsPath = path.join(projectRoot, "config", "settings.json");
const envPath = path.join(projectRoot, ".env");
const dryRun = process.argv.includes("--dry-run");

const nonSecretDefaults = new Set(["", "lm-studio", "local"]);

function getNested(object, keys) {
  return keys.reduce((value, key) => (value && typeof value === "object" ? value[key] : undefined), object);
}

function setNested(object, keys, value) {
  let target = object;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== "object") target[key] = {};
    target = target[key];
  }
  target[keys.at(-1)] = value;
}

function envEscape(value) {
  const text = String(value || "");
  if (!/[\s#"']/u.test(text)) return text;
  return JSON.stringify(text);
}

function parseEnvKeys(text) {
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function main() {
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const envText = await readTextIfExists(envPath);
  const envKeys = parseEnvKeys(envText);
  const envLines = [];
  const migrated = [];
  const skipped = [];

  const secrets = [
    { keys: ["llm", "apiKey"], env: "RAG_LLM_API_KEY", skipDefaults: true },
    { keys: ["llm", "remote", "apiKey"], env: "RAG_REMOTE_LLM_API_KEY", skipDefaults: false },
    { keys: ["embeddings", "apiKey"], env: "RAG_EMBEDDINGS_API_KEY", skipDefaults: true },
    { keys: ["vectorStore", "qdrant", "apiKey"], env: "QDRANT_API_KEY", skipDefaults: false }
  ];

  for (const secret of secrets) {
    const value = String(getNested(settings, secret.keys) || "").trim();
    if (!value) continue;
    if (secret.skipDefaults && nonSecretDefaults.has(value.toLowerCase())) continue;

    if (envKeys.has(secret.env)) {
      skipped.push(secret.env);
    } else {
      envLines.push(`${secret.env}=${envEscape(value)}`);
      migrated.push(secret.env);
    }
    setNested(settings, secret.keys, "");
  }

  if (!migrated.length && !skipped.length) {
    console.log("No stored secrets found in config/settings.json.");
    return;
  }

  if (dryRun) {
    console.log(`Would migrate: ${migrated.join(", ") || "none"}.`);
    if (skipped.length) console.log(`Already present in .env: ${skipped.join(", ")}.`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.copyFile(settingsPath, `${settingsPath}.bak-${stamp}`);

  if (envLines.length) {
    const prefix = envText && !envText.endsWith("\n") ? "\n" : "";
    await fs.appendFile(envPath, `${prefix}\n# Migrated from config/settings.json on ${new Date().toISOString()}\n${envLines.join("\n")}\n`, "utf8");
  }

  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  console.log(`Migrated: ${migrated.join(", ") || "none"}.`);
  if (skipped.length) console.log(`Already present in .env, cleared from settings: ${skipped.join(", ")}.`);
  console.log("Secret values were not printed.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
