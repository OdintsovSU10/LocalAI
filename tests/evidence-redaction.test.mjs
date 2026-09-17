import assert from "node:assert/strict";
import test from "node:test";

import { PATH_PLACEHOLDER, SECRET_PLACEHOLDER, redactEvidenceText } from "../apps/rag-api/src/evidence/evidence-redaction.js";

test("absolute Windows, UNC, POSIX and file:// paths are masked without eating the following text", () => {
  assert.equal(
    redactEvidenceText("Файл: C:\\Users\\ivan\\Documents\\Проект Стромынка\\dogovor.docx, см. приложение."),
    `Файл: ${PATH_PLACEHOLDER}, см. приложение.`
  );
  assert.equal(
    redactEvidenceText("Путь D:/LOCAL_RAG/data/state/x.json и сеть \\\\fileserver\\share\\ПД\\АР.pdf."),
    `Путь ${PATH_PLACEHOLDER} и сеть ${PATH_PLACEHOLDER}.`
  );
  assert.equal(redactEvidenceText("Скан в /home/ivan/scans/act.pdf или /Users/ivan/x.pdf."), `Скан в ${PATH_PLACEHOLDER} или ${PATH_PLACEHOLDER}.`);
  assert.equal(redactEvidenceText("см. file:///C:/secret/x.md"), `см. ${PATH_PLACEHOLDER}`);
});

test("secret-like values are masked", () => {
  const redacted = redactEvidenceText([
    "api_key=abc123secret; пароль: hunter2; token = \"tok-999\"",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
    "https://user:pass@example.test/path?token=abc&x=1",
    "ключ sk-abcdefghijklmnopqrstuv1234",
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----"
  ].join("\n"));
  for (const leaked of ["abc123secret", "hunter2", "tok-999", "eyJhbGci", "user:pass", "token=abc", "sk-abcdef", "MIIEvQ"]) {
    assert.ok(!redacted.includes(leaked), `leaked ${leaked}`);
  }
  assert.ok(redacted.includes(SECRET_PLACEHOLDER));
});

// Revision 2 regressions (independent re-verification findings).

test("file:// paths with spaces in folder names are masked completely", () => {
  assert.equal(redactEvidenceText("Путь file:///C:/Проект Альфа/акт.pdf."), `Путь ${PATH_PLACEHOLDER}.`);
  assert.equal(redactEvidenceText("file://fileserver/share/Проект Бета/смета.xlsx, лист 2"), `${PATH_PLACEHOLDER}, лист 2`);
  for (const leaked of ["Альфа", "акт.pdf", "fileserver", "Бета"]) {
    assert.ok(!redactEvidenceText("Путь file:///C:/Проект Альфа/акт.pdf и file://fileserver/share/Проект Бета/смета.xlsx").includes(leaked), `leaked ${leaked}`);
  }
});

test("plain-language statements that there is no secret keep their meaning", () => {
  for (const text of [
    "Пароль: не требуется.",
    "Password: not required.",
    "api_key: none",
    "пароль: нет",
    "Пароль: отсутствует.",
    "token: unknown",
    "Пароль: —",
    // The value itself is an ordinary word, the negation follows it.
    "Токен: доступа не требуется.",
    "Токен: отсутствует; пароль — не задан.",
    "Токен не требуется. Пароль не задан."
  ]) {
    assert.equal(redactEvidenceText(text), text);
  }
});

test("a Cyrillic password is a secret, not a statement about its absence", () => {
  assert.equal(redactEvidenceText("Пароль: Секрет"), `Пароль: ${SECRET_PLACEHOLDER}`);
  assert.equal(redactEvidenceText("Пароль: Ромашка2026, выдан администратором"), `Пароль: ${SECRET_PLACEHOLDER}, выдан администратором`);
});

test("secret values are masked while the sentence punctuation after them stays", () => {
  assert.equal(redactEvidenceText("пароль: hunter2."), `пароль: ${SECRET_PLACEHOLDER}.`);
  assert.equal(redactEvidenceText("Пароль: Секрет123, логин admin"), `Пароль: ${SECRET_PLACEHOLDER}, логин admin`);
  assert.equal(redactEvidenceText("password: qwerty"), `password: ${SECRET_PLACEHOLDER}`);
  assert.equal(redactEvidenceText("api_key=abc123secret; token = \"tok-999\""), `api_key=${SECRET_PLACEHOLDER}; token = ${SECRET_PLACEHOLDER}`);
});

test("ordinary contract text is unchanged and redaction is idempotent", () => {
  const ordinary = [
    "3.1. Аванс в размере 20% от цены договора 245 000 000 рублей, НДС 20%, пени 1/300 ставки, срок до 10.02.2026.",
    "| 5 | 2 | Арматура А500С d12–d32 | т | 1 380 | 68 900 |",
    "Приложение С: график. Токен доступа не требуется. Секретность обеспечивает Заказчик."
  ].join("\n");
  assert.equal(redactEvidenceText(ordinary), ordinary);
  for (const input of [
    "C:\\Users\\ivan\\x.docx пароль: hunter2 Bearer abc.def",
    "Путь file:///C:/Проект Альфа/акт.pdf. Пароль: не требуется. api_key=abc123secret."
  ]) {
    const once = redactEvidenceText(input);
    assert.equal(redactEvidenceText(once), once);
  }
});
