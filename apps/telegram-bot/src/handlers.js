import {
  HELP_TEXT,
  answerKeyboard,
  answerMessage,
  excerptMessage,
  projectKeyboard,
  splitMessage
} from "./format.js";
import { cancelRequest, finishRequest, startRequest } from "./sessions.js";

// Dispatch of Telegram updates (Stage 08). The bot holds no RAG logic: every answer comes from
// /api/chat of the local portal, with the same verification as the web UI.

const DENIED = "Доступ не настроен.";
const RATE_LIMITED = "Слишком много запросов подряд. Подождите минуту.";
const PORTAL_DOWN = "Портал сейчас недоступен. Проверьте, запущен ли Locus на компьютере.";
const TYPING_INTERVAL_MS = 4000;

export function isAllowed(config, userId) {
  return config.allowedUserIds.includes(String(userId));
}

async function send(ctx, chatId, text, options = {}) {
  const parts = splitMessage(text);
  let last = null;
  for (let index = 0; index < parts.length; index += 1) {
    const isLast = index === parts.length - 1;
    last = await ctx.telegram.sendMessage(chatId, parts[index], isLast ? options : {});
  }
  return last;
}

async function withTyping(ctx, chatId, action) {
  await ctx.telegram.sendChatAction(chatId, "typing");
  const timer = setInterval(() => {
    ctx.telegram.sendChatAction(chatId, "typing");
  }, TYPING_INTERVAL_MS);
  try {
    return await action();
  } finally {
    clearInterval(timer);
  }
}

async function loadProjects(ctx, session) {
  session.projects = await ctx.api.sources();
  return session.projects;
}

async function conversationId(ctx, session) {
  if (!session.conversationId) session.conversationId = await ctx.api.conversationForChat(session.chatId);
  return session.conversationId;
}

export async function askAndReply(ctx, session, question) {
  const controller = startRequest(session);
  try {
    const conversation = await conversationId(ctx, session);
    const payload = await withTyping(ctx, session.chatId, () => ctx.api.ask({
      question,
      conversationId: conversation,
      sourceId: session.pinnedSourceId,
      signal: controller.signal
    }));
    session.lastSources = Array.isArray(payload.sources) ? payload.sources : [];
    session.clarification = (payload.projectCandidates || []).map((candidate) => ({ id: candidate.id, title: candidate.title }));
    const keyboard = session.clarification.length
      ? projectKeyboard(session.clarification, "c")
      : answerKeyboard(session.lastSources);
    await send(ctx, session.chatId, answerMessage(payload), keyboard ? { reply_markup: keyboard } : {});
    return payload;
  } catch (error) {
    if (controller.signal.aborted) return null;
    // Never leak the local error text (it can carry paths or endpoints) — only a plain hint.
    console.warn(`telegram: chat request failed: ${String(error?.message || error).slice(0, 200)}`);
    await send(ctx, session.chatId, error?.status === 404 ? "Разговор потерян, начните заново: /new" : PORTAL_DOWN);
    return null;
  } finally {
    finishRequest(session, controller);
  }
}

async function handleCommand(ctx, session, command, argument) {
  const chatId = session.chatId;
  if (command === "/start" || command === "/help") return send(ctx, chatId, HELP_TEXT);

  if (command === "/new") {
    cancelRequest(session);
    const previous = session.conversationId;
    ctx.sessions.reset(chatId);
    if (previous) await ctx.api.archiveConversation(previous);
    session.conversationId = await ctx.api.newConversation();
    return send(ctx, chatId, "Начал новый разговор. Проект снова определяется по вопросу.");
  }

  if (command === "/cancel") {
    return send(ctx, chatId, cancelRequest(session) ? "Запрос остановлен." : "Сейчас ничего не выполняется.");
  }

  if (command === "/project") {
    if (/^(авто|auto|сброс|reset)$/i.test(argument.trim())) {
      session.pinnedSourceId = "";
      return send(ctx, chatId, "Проект определяется по вопросу.");
    }
    const projects = await loadProjects(ctx, session);
    if (!projects.length) return send(ctx, chatId, "В портале пока нет проектов.");
    const current = projects.find((project) => project.id === session.pinnedSourceId);
    return send(ctx, chatId, `Текущий проект: ${current ? current.title : "определяется по вопросу"}.\nВыберите проект или отправьте «/project авто».`, {
      reply_markup: projectKeyboard(projects, "p")
    });
  }

  if (command === "/sources") {
    const projects = await loadProjects(ctx, session);
    if (!projects.length) return send(ctx, chatId, "В портале пока нет проектов.");
    const lines = projects.map((project) => {
      const state = project.indexStatus === "completed" ? "" : ` · индексация: ${project.indexStatus || "нет данных"}`;
      return `• ${project.title} — файлов в индексе: ${project.indexedFiles}${state}`;
    });
    return send(ctx, chatId, `Проекты (${projects.length}):\n${lines.join("\n")}`);
  }

  if (command === "/status") {
    const status = await ctx.api.status();
    const lines = [
      `Портал: ${status.ok ? "доступен" : "недоступен"}`,
      `Проектов: ${status.projects}`,
      `Проверка ответов: ${status.verified ? "включена" : "выключена"}`,
      `Проверяющий: ${status.verifier}`,
      `Модель ответа: ${status.model || "не задана"}`
    ];
    return send(ctx, chatId, lines.join("\n"));
  }

  return send(ctx, chatId, "Не знаю такую команду. /help — список команд.");
}

export async function handleMessage(ctx, message) {
  const userId = message.from?.id;
  const chatId = message.chat?.id;
  if (!chatId) return;
  if (!isAllowed(ctx.config, userId)) {
    // A stranger learns nothing about the portal, its projects or its owner.
    await ctx.telegram.sendMessage(chatId, DENIED);
    return;
  }
  const text = String(message.text || "").trim();
  if (!text) return;

  const session = ctx.sessions.get(chatId);
  if (text.startsWith("/")) {
    const [command, ...rest] = text.split(/\s+/);
    return handleCommand(ctx, session, command.split("@")[0].toLowerCase(), rest.join(" "));
  }

  if (!ctx.rateLimiter.allow(userId)) return ctx.telegram.sendMessage(chatId, RATE_LIMITED);
  return askAndReply(ctx, session, text);
}

export async function handleCallback(ctx, callback) {
  const chatId = callback.message?.chat?.id;
  const [kind, rawIndex] = String(callback.data || "").split(":");
  if (!chatId || !isAllowed(ctx.config, callback.from?.id)) {
    await ctx.telegram.answerCallbackQuery(callback.id, DENIED);
    return;
  }
  const session = ctx.sessions.get(chatId);
  const index = Number(rawIndex);

  if (kind === "f") {
    const source = session.lastSources[index];
    await ctx.telegram.answerCallbackQuery(callback.id);
    if (!source) return ctx.telegram.sendMessage(chatId, "Этот фрагмент уже недоступен, задайте вопрос заново.");
    return ctx.telegram.sendMessage(chatId, excerptMessage(source, index), { disable_web_page_preview: true });
  }

  if (kind === "p") {
    const project = session.projects[index];
    await ctx.telegram.answerCallbackQuery(callback.id);
    if (!project) return ctx.telegram.sendMessage(chatId, "Список проектов устарел, откройте /project заново.");
    session.pinnedSourceId = project.id;
    return ctx.telegram.sendMessage(chatId, `Проект: ${project.title}. Следующие вопросы — по нему.`);
  }

  if (kind === "c") {
    const option = session.clarification[index];
    await ctx.telegram.answerCallbackQuery(callback.id);
    if (!option) return ctx.telegram.sendMessage(chatId, "Уточнение устарело, повторите вопрос.");
    session.clarification = [];
    if (!ctx.rateLimiter.allow(callback.from?.id)) return ctx.telegram.sendMessage(chatId, RATE_LIMITED);
    // The planner resumes the original question for the chosen project (Stage 05).
    return askAndReply(ctx, session, option.title);
  }

  await ctx.telegram.answerCallbackQuery(callback.id);
}

export async function handleUpdate(ctx, update = {}) {
  if (update.message) return handleMessage(ctx, update.message);
  if (update.callback_query) return handleCallback(ctx, update.callback_query);
  return undefined;
}
