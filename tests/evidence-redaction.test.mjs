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

// Revision 4 regressions (independent re-verification findings).

test("a multi-word secret is masked whole, up to the end of its clause", () => {
  assert.equal(redactEvidenceText("Пароль: Красная Луна"), `Пароль: ${SECRET_PLACEHOLDER}`);
  assert.equal(redactEvidenceText("Пароль: Красная Луна, выдан 01.02.2026"), `Пароль: ${SECRET_PLACEHOLDER}, выдан 01.02.2026`);
  assert.ok(!redactEvidenceText("Пароль: Красная Луна").includes("Луна"));
});

test("a quoted secret is masked with its quotes, even when it contains a comma", () => {
  assert.equal(redactEvidenceText("Пароль: \"Красная Луна\""), `Пароль: ${SECRET_PLACEHOLDER}`);
  assert.equal(redactEvidenceText("Пароль: «Красная, Луна»"), `Пароль: ${SECRET_PLACEHOLDER}`);
  assert.equal(redactEvidenceText("Пароль: \"Красная, Луна\" (выдан 01.02.2026)"), `Пароль: ${SECRET_PLACEHOLDER} (выдан 01.02.2026)`);
});

test("a prohibition to pass the secret on is not a statement that there is no secret", () => {
  assert.equal(redactEvidenceText("Пароль: DemoPass42 не передавать третьим лицам."), `Пароль: ${SECRET_PLACEHOLDER}.`);
  assert.equal(redactEvidenceText("token: DemoPass42 не передавать."), `token: ${SECRET_PLACEHOLDER}.`);
});

// Revision 5 regressions (independent re-verification findings).

test("escaped quotes inside a quoted secret are masked in one pass", () => {
  for (const [input, expected] of [
    ["Пароль: \"Alpha\\\"Beta42\".", `Пароль: ${SECRET_PLACEHOLDER}.`],
    ["Пароль: 'Alpha\\'Beta42', выдан", `Пароль: ${SECRET_PLACEHOLDER}, выдан`],
    ["Пароль: \"a\\\\b\" конец", `Пароль: ${SECRET_PLACEHOLDER} конец`]
  ]) {
    const once = redactEvidenceText(input);
    assert.equal(once, expected);
    assert.equal(redactEvidenceText(once), once);
  }
});

test("the next sentence after a secret value is kept", () => {
  assert.equal(redactEvidenceText("Пароль: Demo42. Аванс составляет 20%."), `Пароль: ${SECRET_PLACEHOLDER}. Аванс составляет 20%.`);
  assert.equal(redactEvidenceText("Пароль: Demo42! Аванс составляет 20%."), `Пароль: ${SECRET_PLACEHOLDER}! Аванс составляет 20%.`);
  assert.equal(redactEvidenceText("Пароль: Demo42.\nАванс составляет 20%."), `Пароль: ${SECRET_PLACEHOLDER}.\nАванс составляет 20%.`);
  assert.equal(
    redactEvidenceText("пароль: A1. токен: B2. Цена 100 рублей."),
    `пароль: ${SECRET_PLACEHOLDER}. токен: ${SECRET_PLACEHOLDER}. Цена 100 рублей.`
  );
  // Dots inside a value (not followed by a space) are part of the secret.
  assert.equal(redactEvidenceText("Токен: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig. Далее текст."), `Токен: ${SECRET_PLACEHOLDER}. Далее текст.`);
  assert.ok(!redactEvidenceText("Пароль: Demo.42 и прочее").includes("42"));
});

test("a statement of absence may have up to three words before the negation", () => {
  assert.equal(redactEvidenceText("Токен: для доступа не требуется."), "Токен: для доступа не требуется.");
  assert.equal(redactEvidenceText("token: for this access not required."), "token: for this access not required.");
});

test("Cyrillic and Latin keys behave the same way", () => {
  assert.equal(redactEvidenceText("Токен: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"), `Токен: ${SECRET_PLACEHOLDER}`);
  assert.equal(redactEvidenceText("Токен: tok-999"), `Токен: ${SECRET_PLACEHOLDER}`);
  // The negation follows an ordinary word: neither key form masks it.
  assert.equal(redactEvidenceText("token: доступа не требуется."), "token: доступа не требуется.");
  assert.equal(redactEvidenceText("Токен: доступа не требуется."), "Токен: доступа не требуется.");
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
