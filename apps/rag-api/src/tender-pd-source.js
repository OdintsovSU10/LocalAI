/**
 * Разбор постраничного формата распознавателя тендерной ПД.
 *
 * Распознаватель отдаёт один markdown на целый том:
 *
 *     # Document: <файл>.pdf
 *     **Stamp:** Code: ... | Stage: ... | Object: ... | Organization: ...
 *     ## Page 1
 *     ### BLOCK #1 [IMAGE]: blk_<id>
 *     > **Crop:** [Crop](<url>)
 *     > **Stamp:** Code: ... | Sheet: ... | Name: ... | Revisions: ...
 *     **[IMAGE]** | Type: План | Axes: ... | Level: ... | Zone: ...
 *     **Summary:** ...
 *
 * Обычный chunkMarkdown режет это окнами по 1800 символов и теряет привязку к листу.
 * Здесь единица чанка — страница, ровно как строка в SHEET_INDEX.csv тендера. Тогда
 * попадание поиска сразу указывает на лист, а удалённой машине не нужна своя схема.
 *
 * Грамматика перенесена один в один из TenderSkills/scripts/ocr_document.py, включая
 * разделение перечислений: запятая внутри «-9,300» — десятичный знак, а не разделитель.
 * Ничего не додумывает: неразобранное поле остаётся пустой строкой.
 */

const PAGE_RE = /^##\s+Page\s+(\d+)\s*$/gm;
const DOC_NAME_RE = /^#\s+Document:\s*(.+?)\s*$/m;
const DOC_PATH_RE = /^Path:\s*(.+?)\s*$/m;
const STAMP_RE = /^>?\s*\*\*Stamp:\*\*\s*(.+?)\s*$/gm;
const BLOCK_RE = /^###\s+BLOCK\s+#(\d+)\s+\[([A-Z]+)\]:\s*(\S+)\s*$/gm;
const CROP_RE = /^>\s*\*\*Crop:\*\*\s*\[[^\]]*\]\((\S+?)\)/gm;
const ATTR_RE = /^\*\*\[([A-Z]+)\]\*\*\s*\|\s*(.+?)\s*$/gm;
const SUMMARY_RE = /^\*\*Summary:\*\*\s*(.+?)\s*$/m;
const LIST_SPLIT_RE = /\s*;\s*|\s*,(?!\d)\s*/;

/** Тип листа из поля Type штампа блока — те же коды, что и в SHEET_INDEX.csv. */
const SHEET_TYPE_MAP = [
  ["план", "plan"],
  ["разрез", "section"],
  ["фасад", "elevation"],
  ["узел", "detail"],
  ["схема", "scheme"],
  ["спецификац", "specification"],
  ["ведомост", "schedule"],
  ["экспликац", "explication"],
  ["общих данных", "general"],
  ["общие данные", "general"],
  ["пояснительная записка", "note"],
  ["таблица", "table"],
  ["текст", "text"]
];

export function looksLikeTenderPd(markdown) {
  const text = String(markdown || "");
  if (!DOC_NAME_RE.test(text)) return false;
  PAGE_RE.lastIndex = 0;
  return PAGE_RE.test(text);
}

/** Разобрать «Code: X | Stage: Y | Sheet: Z» в объект с приведёнными ключами. */
export function parseFields(line) {
  const fields = {};
  for (const part of String(line || "").split("|")) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    fields[part.slice(0, separator).trim().toLowerCase()] = part.slice(separator + 1).trim();
  }
  return fields;
}

function normalizeSheetType(value) {
  const lowered = String(value || "").toLowerCase();
  const codes = [];
  for (const [phrase, code] of SHEET_TYPE_MAP) {
    if (lowered.includes(phrase) && !codes.includes(code)) codes.push(code);
  }
  return codes.join("|");
}

/** Первое непустое: штампы блоков одной страницы обычно совпадают. */
function firstValue(values) {
  return values.find((value) => value) || "";
}

function joinUnique(values, limit) {
  const seen = [];
  for (const value of values) {
    for (const item of String(value || "").split(LIST_SPLIT_RE)) {
      const trimmed = item.trim();
      if (trimmed && !seen.includes(trimmed)) seen.push(trimmed);
    }
  }
  return seen.slice(0, limit).join("|");
}

function matchAll(regex, text, mapper) {
  regex.lastIndex = 0;
  const found = [];
  let match = regex.exec(text);
  while (match) {
    found.push(mapper(match));
    match = regex.exec(text);
  }
  return found;
}

/**
 * `drawing`, `text` или `mixed` — по составу блоков страницы.
 *
 * Геометрия живёт на чертёжных страницах, а расчётные записки состоят из текстовых
 * распечаток: в томе КР1.РР1 их больше тысячи. Без этого признака поиск по разделу
 * тонет в записках, хотя нужен один лист.
 */
function pageKind(blockTypes) {
  const kinds = new Set(blockTypes);
  if (kinds.size === 1 && kinds.has("image")) return "drawing";
  if (kinds.has("image")) return "mixed";
  return kinds.size ? "text" : "";
}

export function parsePage(number, body) {
  const stamps = matchAll(STAMP_RE, body, (match) => parseFields(match[1]));
  const attributes = matchAll(ATTR_RE, body, (match) => parseFields(match[2]));
  const blocks = matchAll(BLOCK_RE, body, (match) => ({ type: match[2].toLowerCase(), id: match[3] }));
  const cropUrls = matchAll(CROP_RE, body, (match) => match[1]);
  const summary = SUMMARY_RE.exec(body);

  // Полезный текст: всё, кроме служебных строк блока. Summary и Description — это
  // распознанное содержимое листа-изображения, а не служебка: без них графический лист
  // выглядел бы пустым, хотя распознавание отработало.
  const payload = body
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^(> |### |\*\*Stamp:|\*\*\[)/.test(line));

  return {
    page: number,
    documentCode: firstValue(stamps.map((stamp) => stamp.code || "")),
    stage: firstValue(stamps.map((stamp) => stamp.stage || "")),
    sheet: firstValue(stamps.map((stamp) => stamp.sheet || "")),
    title: firstValue(stamps.map((stamp) => stamp.name || "")),
    revision: firstValue(stamps.map((stamp) => stamp.revisions || "")),
    sheetType: normalizeSheetType(attributes.map((item) => item.type || "").join(" ")),
    axes: joinUnique(attributes.map((item) => item.axes || ""), 6),
    levels: joinUnique(attributes.map((item) => item.level || ""), 6),
    zone: joinUnique(attributes.map((item) => item.zone || ""), 4),
    blockIds: blocks.map((block) => block.id),
    blockTypes: blocks.map((block) => block.type),
    pageKind: pageKind(blocks.map((block) => block.type)),
    cropUrl: cropUrls[0] || "",
    summary: summary ? summary[1].slice(0, 400) : "",
    text: payload.join("\n")
  };
}

export function parseTenderPd(markdown) {
  const text = String(markdown || "");
  const nameMatch = DOC_NAME_RE.exec(text);
  const pathMatch = DOC_PATH_RE.exec(text);
  const document = {
    documentName: nameMatch ? nameMatch[1] : "",
    documentPath: pathMatch ? pathMatch[1] : "",
    documentCode: "",
    stage: "",
    organization: "",
    object: "",
    pages: []
  };

  PAGE_RE.lastIndex = 0;
  const starts = [];
  let match = PAGE_RE.exec(text);
  while (match) {
    starts.push({ number: Number(match[1]), start: match.index, end: match.index + match[0].length });
    match = PAGE_RE.exec(text);
  }

  const head = starts.length ? text.slice(0, starts[0].start) : text;
  STAMP_RE.lastIndex = 0;
  const headerStamp = STAMP_RE.exec(head);
  if (headerStamp) {
    const fields = parseFields(headerStamp[1]);
    document.documentCode = fields.code || "";
    document.stage = fields.stage || "";
    document.organization = fields.organization || "";
    document.object = fields.object || "";
  }

  for (let index = 0; index < starts.length; index += 1) {
    const finish = index + 1 < starts.length ? starts[index + 1].start : text.length;
    document.pages.push(parsePage(starts[index].number, text.slice(starts[index].end, finish)));
  }

  // Шифр тома берётся из шапки, а если её нет — из первой страницы, где он распознан.
  if (!document.documentCode) {
    document.documentCode = firstValue(document.pages.map((page) => page.documentCode));
  }
  if (!document.stage) document.stage = firstValue(document.pages.map((page) => page.stage));
  return document;
}

/**
 * Шапка чанка: метаданные листа перед телом страницы.
 *
 * Они идут впереди, потому что короткие страницы вроде «Лист общих данных» иначе не
 * имеют по чему матчиться, а раздел, шифр и отметка — это ровно то, чем инженер
 * формулирует запрос. Шапка повторяется в каждой части разрезанной страницы: без неё
 * вторая половина расчётной записки теряет привязку к листу.
 */
export function chunkHeader(meta) {
  return [
    meta.discipline,
    meta.documentCode,
    meta.sheetOrBlock && `лист ${meta.sheetOrBlock}`,
    meta.title,
    meta.sheetType,
    meta.levels && `отметки ${meta.levels}`,
    meta.axes && `оси ${meta.axes}`,
    meta.zone && `зона ${meta.zone}`,
    meta.summary
  ]
    .filter(Boolean)
    .join(" | ");
}

/**
 * Чанки одного тома: по одному на страницу.
 *
 * Расчётные записки бывают длиннее лимита. Такая страница режется на части с общим
 * номером страницы и растущим chunkOrd — ссылка на лист при этом не теряется.
 */
export function chunkTenderPd({ markdown, filePath, discipline = "", revision = "", sourceId = "", maxChars = 4000 }) {
  const document = parseTenderPd(markdown);
  const chunks = [];
  for (const page of document.pages) {
    const meta = {
      sourceId,
      filePath,
      discipline,
      revision,
      documentCode: page.documentCode || document.documentCode,
      sheetOrBlock: page.sheet || page.blockIds[0] || "",
      title: page.title,
      sheetType: page.sheetType,
      levels: page.levels,
      axes: page.axes,
      zone: page.zone,
      pageKind: page.pageKind,
      cropUrl: page.cropUrl,
      summary: page.summary,
      sheetRevision: page.revision,
      // Идентификаторы блоков страницы: по ним ищется заранее снятый текст кропов.
      blockIds: page.blockIds
    };
    const header = chunkHeader(meta);
    // Шапка повторяется в каждой части, поэтому бюджет тела — то, что от лимита осталось.
    // Нижняя граница не даёт вырожденному случаю (шапка длиннее лимита) уйти в вечный цикл.
    const budget = Math.max(200, maxChars - header.length - 1);
    const body = page.text;
    const parts = [];
    if (body.length <= budget) parts.push(body);
    else for (let at = 0; at < body.length; at += budget) parts.push(body.slice(at, at + budget));

    parts.forEach((part, ordinal) => {
      chunks.push({
        ...meta,
        page: page.page,
        chunkOrd: ordinal,
        text: part ? `${header}\n${part}` : header
      });
    });
  }
  return { document, chunks };
}
