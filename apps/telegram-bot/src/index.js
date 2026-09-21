#!/usr/bin/env node
import "dotenv/config";

import { createBot } from "./bot.js";
import { readBotConfig } from "./config.js";

// Entry point: npm run tg:start. Without a token and an allowlist the bot refuses to start,
// so an unconfigured process can never answer a stranger.

const { config, problems } = readBotConfig(process.env);
if (!config) {
  console.error("Telegram bot is not configured:");
  problems.forEach((problem) => console.error(`- ${problem}`));
  console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_IDS in .env (the token is never read from the repository).");
  process.exit(1);
}

const bot = createBot(config);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    bot.stop();
    process.exit(0);
  });
}

await bot.run();
