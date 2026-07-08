import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDriveFileContextLink,
  buildSpreadsheetContextLinks,
  classifyGoogleDriveUrl,
  parseDriveFolderId,
  parseSpreadsheetId
} from "./google-drive-match.js";

const GOOGLE_COOKIE_ORIGINS = [
  "https://accounts.google.com",
  "https://drive.google.com",
  "https://docs.google.com",
  "https://sheets.googleapis.com",
  "https://www.googleapis.com"
];

export function defaultBrowserProfileDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "LocalAI", "google-browser");
  }
  return path.join(os.homedir(), ".local", "share", "localai", "google-browser");
}

export async function loadPlaywright() {
  try {
    const playwright = await import("playwright");
    return playwright.chromium;
  } catch {
    throw new Error(
      "Playwright is required for Google discovery. Install it once: npm install playwright && npx playwright install chromium"
    );
  }
}

function cleanDriveLabel(value = "") {
  return String(value || "")
    .replace(/\s+Shared\s*$/i, "")
    .replace(/\s+—\s+Google\s+Drive.*$/i, "")
    .replace(/\s+-\s+Google\s+(Sheets|Docs|Drive).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueByHref(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const href = String(item.url || "").trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);
    result.push(item);
  }
  return result;
}

export async function scrapeDriveItems(page) {
  return uniqueByHref(await page.evaluate(() => {
    const results = [];
    const selectors = [
      "[data-target=\"doc\"] a[href]",
      "[role=\"row\"] a[href]",
      "[role=\"gridcell\"] a[href]",
      "a[href*=\"/folders/\"]",
      "a[href*=\"/spreadsheets/\"]",
      "a[href*=\"/document/\"]",
      "a[href*=\"/file/d/\"]"
    ];

    const nodes = new Set();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) nodes.add(node);
    }

    for (const node of nodes) {
      const href = node.href || "";
      if (!href) continue;

      const aria = node.getAttribute("aria-label") || "";
      const text = node.textContent || "";
      const row = node.closest("[data-target=\"doc\"], [role=\"row\"]");
      const rowLabel = row?.getAttribute("aria-label") || "";
      const title = (aria || rowLabel || text).replace(/\s+/g, " ").trim();
      if (!title) continue;

      results.push({ title, url: href });
    }

    return results;
  }));
}

export async function scrapeSpreadsheetTabs(page, spreadsheetId) {
  const id = String(spreadsheetId || "").trim();
  if (!id) return [];

  await page.goto(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.waitForTimeout(1200);

  const tabs = await page.evaluate(() => {
    const results = [];
    const tabNodes = document.querySelectorAll("[role=\"tab\"], .docs-sheet-tab, .sheet-tab");
    for (const node of tabNodes) {
      const title = (node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/g, " ").trim();
      if (!title) continue;

      const sheetId = node.getAttribute("data-sheet-id")
        || node.getAttribute("data-id")
        || node.id?.match(/(\d+)/)?.[1]
        || "";

      results.push({ title, gid: sheetId });
    }
    return results;
  });

  const deduped = [];
  const seen = new Set();
  for (const tab of tabs) {
    const key = `${tab.gid}:${tab.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tab);
  }
  return deduped;
}

export function driveEntriesToContextLinks(entries = [], { tabsBySpreadsheetId = new Map() } = {}) {
  const links = [];

  for (const entry of entries) {
    const title = cleanDriveLabel(entry.title);
    const url = String(entry.url || "").trim();
    const kind = classifyGoogleDriveUrl(url);

    if (kind === "folder" || kind === "unsupported") continue;

    if (kind === "spreadsheet") {
      const spreadsheetId = parseSpreadsheetId(url);
      const tabs = tabsBySpreadsheetId.get(spreadsheetId) || [];
      links.push(...buildSpreadsheetContextLinks(spreadsheetId, { title, tabs }));
      continue;
    }

    const link = buildDriveFileContextLink({ url, title, kind });
    if (link) links.push(link);
  }

  return links;
}

export async function createGoogleBrowserContext({
  profileDir = defaultBrowserProfileDir(),
  headless = false,
  channel
} = {}) {
  const chromium = await loadPlaywright();
  await fs.mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    channel: channel || undefined,
    viewport: { width: 1440, height: 960 },
    locale: "ru-RU",
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const page = context.pages()[0] || await context.newPage();
  return { context, page, profileDir };
}

export async function waitForGoogleLogin(page, {
  timeoutMs = 5 * 60 * 1000,
  loginUrl = "https://drive.google.com/drive/my-drive"
} = {}) {
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const url = page.url();
    if (/accounts\.google\.com/i.test(url)) {
      await page.waitForTimeout(1500);
      continue;
    }
    if (/drive\.google\.com|docs\.google\.com/i.test(url)) return true;
    await page.waitForTimeout(1000);
  }

  throw new Error("Google login was not completed in time. Sign in in the opened browser window and rerun the agent.");
}

export async function listDriveFolderEntries(page, folderUrl, { waitMs = 2500 } = {}) {
  const folderId = parseDriveFolderId(folderUrl);
  if (!folderId) throw new Error(`Invalid Google Drive folder URL: ${folderUrl}`);

  await page.goto(folderUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(waitMs);

  const entries = await scrapeDriveItems(page);
  return entries.map((entry) => ({
    title: cleanDriveLabel(entry.title),
    url: entry.url,
    kind: classifyGoogleDriveUrl(entry.url),
    folderId
  }));
}

export async function createGoogleSessionFetch(context) {
  const cookies = await context.cookies(GOOGLE_COOKIE_ORIGINS);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");

  return async function googleSessionFetch(url, init = {}) {
    const headers = new Headers(init.headers || {});
    if (cookieHeader) headers.set("Cookie", cookieHeader);
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", "Mozilla/5.0 LocalAI-RAG google-session-fetch");
    }
    return fetch(url, { ...init, headers });
  };
}

export async function discoverProjectFolders(page, parentFolderUrl) {
  const entries = await listDriveFolderEntries(page, parentFolderUrl);
  return entries.filter((entry) => entry.kind === "folder");
}

export async function discoverFolderContextLinks(page, folderUrl, { includeTabs = true } = {}) {
  const entries = await listDriveFolderEntries(page, folderUrl);
  const fileEntries = entries.filter((entry) => entry.kind !== "folder");
  const tabsBySpreadsheetId = new Map();

  if (includeTabs) {
    for (const entry of fileEntries) {
      if (entry.kind !== "spreadsheet") continue;
      const spreadsheetId = parseSpreadsheetId(entry.url);
      if (!spreadsheetId || tabsBySpreadsheetId.has(spreadsheetId)) continue;
      const tabs = await scrapeSpreadsheetTabs(page, spreadsheetId);
      tabsBySpreadsheetId.set(spreadsheetId, tabs);
    }
  }

  return driveEntriesToContextLinks(fileEntries, { tabsBySpreadsheetId });
}
