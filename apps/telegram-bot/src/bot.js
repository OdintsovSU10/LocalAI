import { handleUpdate } from "./handlers.js";
import { createLocalApi } from "./local-api.js";
import { createRateLimiter, createSessions } from "./sessions.js";
import { createTelegramApi } from "./telegram-api.js";

// Long polling loop (Stage 08): outbound only, so the local machine never opens an inbound port.
// Message contents are not logged; only counts and error kinds reach the console.

const ERROR_BACKOFF_MS = [1000, 3000, 10_000, 30_000];

export function createBot(config, { fetchImpl = fetch, logger = console } = {}) {
  const telegram = createTelegramApi({ token: config.token, baseUrl: config.telegramApiBaseUrl, fetchImpl });
  const api = createLocalApi({
    baseUrl: config.apiBaseUrl,
    authToken: config.authToken,
    fetchImpl,
    timeoutSeconds: config.requestTimeoutSeconds
  });
  const ctx = {
    config,
    telegram,
    api,
    sessions: createSessions(),
    rateLimiter: createRateLimiter({ perMinute: config.rateLimitPerMinute })
  };

  let offset = 0;
  let stopped = false;
  const controller = new AbortController();

  async function pollOnce() {
    const updates = await telegram.getUpdates({ offset, timeoutSeconds: config.pollTimeoutSeconds, signal: controller.signal });
    for (const update of updates || []) {
      offset = Math.max(offset, Number(update.update_id) + 1);
      try {
        await handleUpdate(ctx, update);
      } catch (error) {
        logger.warn(`telegram: update handling failed: ${telegram.safeMessage(error?.message || error).slice(0, 200)}`);
      }
    }
    return (updates || []).length;
  }

  async function run() {
    let failures = 0;
    logger.log(`Telegram bot started: ${config.allowedUserIds.length} allowed user(s), portal ${config.apiBaseUrl}`);
    while (!stopped) {
      try {
        await pollOnce();
        failures = 0;
      } catch (error) {
        if (stopped) break;
        const delay = ERROR_BACKOFF_MS[Math.min(failures, ERROR_BACKOFF_MS.length - 1)];
        failures += 1;
        logger.warn(`telegram: polling failed (retry in ${delay} ms): ${telegram.safeMessage(error?.message || error).slice(0, 200)}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  return {
    ctx,
    run,
    pollOnce,
    stop() {
      stopped = true;
      controller.abort();
      ctx.sessions.all().forEach((session) => session.inflight?.controller.abort());
    }
  };
}
