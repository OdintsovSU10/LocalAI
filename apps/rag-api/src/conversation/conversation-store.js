import crypto from "node:crypto";

import { openAppStateDatabase } from "./app-state-db.js";

export const CONVERSATION_CHANNELS = ["web", "telegram", "api"];
export const MESSAGE_ROLES = ["user", "assistant"];
export const MAX_TITLE_CHARS = 200;
export const MAX_MESSAGE_CHARS = 40000;
export const MAX_CITATIONS = 20;

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function cleanTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
}

function cleanChannel(channel = "web") {
  const value = String(channel || "web").trim().toLowerCase();
  if (!CONVERSATION_CHANNELS.includes(value)) throw new Error(`unknown conversation channel "${channel}"`);
  return value;
}

function numberOrUndefined(value) {
  const number = Number(value);
  return value === undefined || value === null || value === "" || !Number.isFinite(number) ? undefined : number;
}

// Citations keep only ids and document-relative location; absolute paths and snippets never reach app state.
export function safeCitations(sources = []) {
  return (Array.isArray(sources) ? sources : []).slice(0, MAX_CITATIONS).map((source, index) => {
    const target = source?.citationTarget || {};
    return {
      citationId: index + 1,
      sourceId: String(source?.sourceId || target.sourceId || ""),
      fileId: String(source?.fileId || target.fileId || ""),
      chunkId: String(source?.chunkId || target.chunkId || source?.id || ""),
      label: String(source?.citationLabel || target.label || "").slice(0, 300),
      fileLabel: String(target.fileLabel || source?.fileLabel || "").slice(0, 200),
      pageStart: numberOrUndefined(target.pageStart ?? source?.pageStart),
      pageEnd: numberOrUndefined(target.pageEnd ?? source?.pageEnd),
      sheetName: String(target.sheetName || source?.sheetName || "") || undefined,
      rowStart: numberOrUndefined(target.rowStart ?? source?.rowStart),
      rowEnd: numberOrUndefined(target.rowEnd ?? source?.rowEnd)
    };
  });
}

function publicConversation(row, messageCount = undefined) {
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    title: row.title,
    pinnedSourceId: row.pinned_source_id || "",
    selectedSourceIds: parseJson(row.selected_source_ids_json, []),
    legacyId: row.legacy_id || "",
    archived: Boolean(row.archived_at),
    archivedAt: row.archived_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(messageCount === undefined ? {} : { messageCount: Number(messageCount) })
  };
}

function publicMessage(row) {
  return {
    id: row.id,
    seq: Number(row.seq),
    role: row.role,
    text: row.text,
    scope: parseJson(row.scope_json, {}),
    answerStatus: row.answer_status || "",
    citations: parseJson(row.citations_json, []),
    verifier: parseJson(row.verifier_json, null),
    traceId: row.trace_id || "",
    createdAt: row.created_at
  };
}

export async function createConversationStore({ databasePath, now = () => new Date().toISOString() }) {
  const db = await openAppStateDatabase(databasePath);

  const transaction = (work) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const getRow = (id, channel) => (channel
    ? db.prepare("SELECT * FROM conversations WHERE id = ? AND channel = ?").get(String(id || ""), channel)
    : db.prepare("SELECT * FROM conversations WHERE id = ?").get(String(id || "")));

  const insertMessage = (conversationId, message, createdAt) => {
    const role = String(message.role || "");
    if (!MESSAGE_ROLES.includes(role)) throw new Error(`unknown message role "${role}"`);
    const text = String(message.text || "");
    if (!text.trim()) throw new Error("message text is required");
    const { next } = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?").get(conversationId);
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO messages (id, conversation_id, seq, role, text, scope_json, answer_status, citations_json, verifier_json, trace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      conversationId,
      Number(next),
      role,
      text.slice(0, MAX_MESSAGE_CHARS),
      JSON.stringify(message.scope || {}),
      String(message.answerStatus || ""),
      JSON.stringify(safeCitations(message.sources)),
      message.verifier ? JSON.stringify(message.verifier) : null,
      String(message.traceId || ""),
      createdAt
    );
    return id;
  };

  const store = {
    createConversation({ channel = "web", title = "", pinnedSourceId = "", legacyId = "", externalUserIdHash = "", createdAt = "" } = {}) {
      const id = crypto.randomUUID();
      const timestamp = createdAt || now();
      db.prepare(`
        INSERT INTO conversations (id, channel, external_user_id_hash, legacy_id, title, pinned_source_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        cleanChannel(channel),
        externalUserIdHash || null,
        legacyId || null,
        cleanTitle(title),
        String(pinnedSourceId || ""),
        timestamp,
        timestamp
      );
      return publicConversation(getRow(id));
    },

    getConversation(id, { channel = "" } = {}) {
      const row = getRow(id, channel);
      if (!row) return null;
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(row.id);
      return publicConversation(row, count);
    },

    listConversations({ channel = "web", includeArchived = false, limit = 100 } = {}) {
      const rows = db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
        FROM conversations c
        WHERE c.channel = ? ${includeArchived ? "" : "AND c.archived_at IS NULL"}
        ORDER BY c.updated_at DESC
        LIMIT ?
      `).all(cleanChannel(channel), Math.max(1, Math.min(Number(limit) || 100, 500)));
      return rows.map((row) => publicConversation(row, row.message_count));
    },

    updateConversation(id, { title, pinnedSourceId, archived } = {}, { channel = "" } = {}) {
      const row = getRow(id, channel);
      if (!row) return null;
      const archivedAt = archived === undefined ? row.archived_at : (archived ? (row.archived_at || now()) : null);
      db.prepare(`
        UPDATE conversations SET title = ?, pinned_source_id = ?, archived_at = ?, updated_at = ? WHERE id = ?
      `).run(
        title === undefined ? row.title : cleanTitle(title),
        pinnedSourceId === undefined ? row.pinned_source_id : String(pinnedSourceId || ""),
        archivedAt,
        now(),
        row.id
      );
      return store.getConversation(row.id);
    },

    deleteConversation(id, { channel = "" } = {}) {
      const row = getRow(id, channel);
      if (!row) return false;
      db.prepare("DELETE FROM conversations WHERE id = ?").run(row.id);
      return true;
    },

    appendMessage(conversationId, message = {}) {
      return transaction(() => {
        const row = getRow(conversationId);
        if (!row) throw new Error("conversation not found");
        const createdAt = message.createdAt || now();
        const id = insertMessage(row.id, message, createdAt);
        db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), row.id);
        return publicMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id));
      });
    },

    // Stores one question/answer pair atomically and moves the conversation's pinned project.
    appendTurn(conversationId, { question, answer, userScope = {}, assistant = {} }) {
      return transaction(() => {
        const row = getRow(conversationId);
        if (!row) throw new Error("conversation not found");
        const timestamp = now();
        const userId = insertMessage(row.id, { role: "user", text: question, scope: userScope, traceId: assistant.traceId }, timestamp);
        const assistantId = insertMessage(row.id, { role: "assistant", text: answer, ...assistant }, timestamp);
        const pinnedSourceId = assistant.pinnedSourceId || row.pinned_source_id || "";
        const title = row.title || cleanTitle(question).slice(0, 72);
        db.prepare("UPDATE conversations SET pinned_source_id = ?, title = ?, updated_at = ? WHERE id = ?")
          .run(pinnedSourceId, title, timestamp, row.id);
        return { userMessageId: userId, assistantMessageId: assistantId };
      });
    },

    listMessages(conversationId, { limit = 0 } = {}) {
      const rows = limit
        ? db.prepare("SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC")
          .all(String(conversationId || ""), Number(limit))
        : db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC").all(String(conversationId || ""));
      return rows.map(publicMessage);
    },

    // Imports a browser localStorage session once; repeated imports return the same conversation.
    importLegacySession(session = {}, { channel = "web" } = {}) {
      const legacyId = String(session.id || "").trim();
      if (!legacyId) throw new Error("legacy session id is required");
      const existing = db.prepare("SELECT id FROM conversations WHERE channel = ? AND legacy_id = ?").get(cleanChannel(channel), legacyId);
      if (existing) return { conversation: store.getConversation(existing.id), created: false };

      return transaction(() => {
        const conversation = store.createConversation({
          channel,
          title: session.title === "Новый чат" ? "" : session.title,
          pinnedSourceId: session.sourceId,
          legacyId,
          createdAt: String(session.createdAt || "") || undefined
        });
        for (const message of Array.isArray(session.messages) ? session.messages : []) {
          if (!MESSAGE_ROLES.includes(message?.role) || !String(message?.text || "").trim()) continue;
          insertMessage(conversation.id, {
            role: message.role,
            text: message.text,
            sources: message.role === "assistant" ? message.sources : [],
            answerStatus: message.role === "assistant" ? "imported" : ""
          }, String(message.createdAt || "") || now());
        }
        const archivedAt = session.archivedAt ? String(session.archivedAt) : null;
        const updatedAt = String(session.updatedAt || "") || now();
        db.prepare("UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?").run(archivedAt, updatedAt, conversation.id);
        return { conversation: store.getConversation(conversation.id), created: true };
      });
    },

    close() {
      db.close();
    }
  };

  return store;
}
