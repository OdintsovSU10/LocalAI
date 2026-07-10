#!/usr/bin/env node
// Быстрый git push: staging + commit + push текущей ветки в origin.
//
// Использование:
//   npm run push -- "текст коммита"   // add -A, commit, push
//   npm run push                      // если коммитить нечего — просто push
//
// Коммит-сообщение задаётся аргументом; хуки не пропускаются, подпись не
// отключается. Приписки Claude/Co-Authored-By намеренно не добавляются
// (git-конвенция проекта).
import { execFileSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitInherit(args) {
  execFileSync("git", args, { stdio: "inherit" });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  git(["rev-parse", "--is-inside-work-tree"]);
} catch {
  fail("Не git-репозиторий. Запустите команду внутри репозитория.");
}

const message = process.argv.slice(2).join(" ").trim();
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const hasChanges = Boolean(git(["status", "--porcelain"]));

if (hasChanges) {
  if (!message) {
    fail('Есть незакоммиченные изменения. Укажите сообщение: npm run push -- "текст коммита"');
  }
  gitInherit(["add", "-A"]);
  gitInherit(["commit", "-m", message]);
} else {
  console.log("Нет изменений для коммита — выполняю только push.");
}

gitInherit(["push", "origin", branch]);
console.log(`\nГотово: ветка ${branch} отправлена в origin.`);
