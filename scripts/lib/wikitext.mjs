/**
 * Minimal wikitext helpers: enough to read the Lua-module league table, the
 * results grid and the sortable statistics tables on a season article.
 */

const OPENERS = [
  ['{{', '}}'],
  ['[[', ']]'],
  ['{|', '|}'],
];

/** Walk `text` from `start` and return the index just past the balanced `{{ }}`. */
function endOfTemplate(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text.startsWith('{{', i)) {
      depth++;
      i++;
    } else if (text.startsWith('}}', i)) {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * Grab the `{{#invoke:Module|...}}` call for a module, e.g. "sports table".
 * Returns the inner body (everything after the module and function name).
 */
export function extractInvokeBlock(wikitext, moduleName) {
  const pattern = new RegExp(`\\{\\{\\s*#invoke:\\s*${moduleName}\\s*\\|`, 'i');
  const match = pattern.exec(wikitext);
  if (!match) return null;
  const start = match.index;
  const end = endOfTemplate(wikitext, start);
  return wikitext.slice(start + 2, end - 2);
}

/** Split on `|` characters that sit outside templates, links and nested tables. */
export function splitTopLevelPipes(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    let matchedOpener = false;
    for (const [open, close] of OPENERS) {
      if (body.startsWith(open, i)) {
        depth++;
        current += open;
        i++;
        matchedOpener = true;
        break;
      }
      if (body.startsWith(close, i)) {
        depth = Math.max(0, depth - 1);
        current += close;
        i++;
        matchedOpener = true;
        break;
      }
    }
    if (matchedOpener) continue;
    if (body[i] === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += body[i];
  }
  parts.push(current);
  return parts;
}

/** Read `name = value` parameters out of a template/invoke body. */
export function parseTemplateParams(body) {
  const params = new Map();
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, '');
  for (const part of splitTopLevelPipes(withoutComments)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || /\s{2,}/.test(name) || name.includes('\n')) continue;
    params.set(name, part.slice(eq + 1).trim());
  }
  return params;
}

function indexOfTopLevelPipe(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    let matched = false;
    for (const [open, close] of OPENERS) {
      if (text.startsWith(open, i)) {
        depth++;
        i++;
        matched = true;
        break;
      }
      if (text.startsWith(close, i)) {
        depth = Math.max(0, depth - 1);
        i++;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (text[i] === '|' && depth === 0) return i;
  }
  return -1;
}

function splitTopLevelSeparator(text, separator) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    let matched = false;
    for (const [open, close] of OPENERS) {
      if (text.startsWith(open, i)) {
        depth++;
        current += open;
        i++;
        matched = true;
        break;
      }
      if (text.startsWith(close, i)) {
        depth = Math.max(0, depth - 1);
        current += close;
        i++;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(current);
      current = '';
      i += separator.length - 1;
      continue;
    }
    current += text[i];
  }
  parts.push(current);
  return parts;
}

/** Find the first `{| ... |}` table that appears after `fromIndex`. */
export function extractTableAfter(wikitext, fromIndex) {
  const start = wikitext.indexOf('{|', fromIndex);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < wikitext.length; i++) {
    if (wikitext.startsWith('{|', i)) {
      depth++;
      i++;
    } else if (wikitext.startsWith('|}', i)) {
      depth--;
      i++;
      if (depth === 0) return wikitext.slice(start, i + 1);
    }
  }
  return null;
}

function parseCell(raw) {
  const pipe = indexOfTopLevelPipe(raw);
  let attributes = '';
  let content = raw;
  if (pipe !== -1) {
    const prefix = raw.slice(0, pipe);
    const looksLikeAttributes =
      prefix.includes('=') && !prefix.includes('[[') && !prefix.includes('{{') && prefix.length < 160;
    if (looksLikeAttributes) {
      attributes = prefix;
      content = raw.slice(pipe + 1);
    }
  }
  const rowspan = Number(/rowspan\s*=\s*"?(\d+)"?/i.exec(attributes)?.[1] ?? 1);
  const colspan = Number(/colspan\s*=\s*"?(\d+)"?/i.exec(attributes)?.[1] ?? 1);
  return { rowspan, colspan, content: content.trim() };
}

function rowCells(rowText) {
  const cells = [];
  for (const line of rowText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('|') || trimmed.startsWith('!')) {
      const isHeader = trimmed.startsWith('!');
      const body = trimmed.slice(1);
      for (const part of splitTopLevelSeparator(body, isHeader ? '!!' : '||')) cells.push(part);
    } else if (cells.length) {
      cells[cells.length - 1] += `\n${trimmed}`;
    }
  }
  return cells.map(parseCell);
}

/**
 * Parse a wikitable into a grid of raw cell strings, expanding `rowspan` and
 * `colspan` so every logical row has the same number of columns.
 */
export function parseWikiTable(tableWikitext) {
  const inner = tableWikitext
    .replace(/^\{\|[^\n]*\n/, '')
    .replace(/\n\|\}\s*$/, '');
  const rawRows = inner
    .split(/^[ \t]*\|-[^\n]*$/m)
    .map((row) => row.trim())
    .filter(Boolean);

  const grid = [];
  /** @type {{column: number, content: string, remaining: number}[]} */
  let carry = [];

  for (const rawRow of rawRows) {
    const cells = rowCells(rawRow);
    if (!cells.length) continue;
    const row = [];
    let cellIndex = 0;
    let column = 0;
    const nextCarry = [];

    const width = Math.max(
      grid[0]?.length ?? 0,
      cells.reduce((total, cell) => total + cell.colspan, 0) + carry.length,
    );

    while (column < width && (cellIndex < cells.length || carry.some((h) => h.column === column))) {
      const held = carry.find((candidate) => candidate.column === column);
      if (held) {
        row[column] = held.content;
        if (held.remaining > 1) {
          nextCarry.push({ column, content: held.content, remaining: held.remaining - 1 });
        }
        column++;
        continue;
      }
      const cell = cells[cellIndex++];
      if (!cell) break;
      for (let span = 0; span < cell.colspan; span++) {
        row[column] = cell.content;
        if (cell.rowspan > 1) {
          nextCarry.push({ column, content: cell.content, remaining: cell.rowspan - 1 });
        }
        column++;
      }
    }

    carry = nextCarry;
    grid.push(row);
  }

  return grid;
}
