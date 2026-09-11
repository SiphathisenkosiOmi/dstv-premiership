const USER_AGENT =
  'dstv-premiership-tracker/1.0 (https://github.com/; static site data updater)';

export function log(...args) {
  console.log('[update]', ...args);
}

export function warn(...args) {
  console.warn('[update] WARN', ...args);
}

/** Fetch a URL with retries and exponential backoff. Returns the parsed body. */
export async function fetchWithRetry(url, { parse = 'json', attempts = 4, timeoutMs = 20000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: parse === 'json' ? 'application/json' : '*/*' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      return parse === 'json' ? await response.json() : await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        // Free tiers throttle hard, so back off much further on a 429.
        const base = error.status === 429 ? 4000 : 500;
        const delay = base * 2 ** (attempt - 1);
        warn(`${url} failed (${error.message}), retrying in ${delay}ms`);
        await sleep(delay);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Giving up on ${url}: ${lastError?.message}`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The South African top flight runs roughly August to May, so anything from July
 * onwards belongs to the season that takes this calendar year as its start year.
 */
export function currentSeason(now = new Date()) {
  const year = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 6 ? year : year - 1;
  return {
    startYear,
    endYear: startYear + 1,
    short: `${startYear}-${String(startYear + 1).slice(2)}`,
    wiki: `${startYear}\u2013${String(startYear + 1).slice(2)}`,
    sportsdb: `${startYear}-${startYear + 1}`,
  };
}

/** Comparable key for a team name across sources with differing spellings. */
export function normaliseTeamName(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|f\.c\.|afc|sc|s\.c\.|football club)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STOP_TOKENS = new Set(['united', 'city', 'fc', 'the', 'town']);

/** Pick the best match for `name` from `candidates` ([{ key, name }]). */
export function resolveTeam(name, candidates) {
  const target = normaliseTeamName(name);
  if (!target) return null;

  const exact = candidates.find((candidate) => normaliseTeamName(candidate.name) === target);
  if (exact) return exact;

  const targetTokens = target.split(' ');
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const value = normaliseTeamName(candidate.name);
    const tokens = value.split(' ');
    let score = 0;
    if (value.includes(target) || target.includes(value)) score += 3;
    for (const token of targetTokens) {
      if (!tokens.includes(token)) continue;
      score += STOP_TOKENS.has(token) ? 0.25 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 1 ? best : null;
}

/** Strip wiki markup down to readable text. */
export function stripWikiMarkup(value) {
  let text = String(value ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<ref[^>]*\/>/gi, '');
  text = text.replace(/<ref[\s\S]*?<\/ref>/gi, '');
  text = text.replace(/\{\{(?:nowrap|nobold|small|sortname)\|([^{}]*)\}\}/gi, '$1');
  text = text.replace(/\{\{flagicon\|([^|{}]*)[^{}]*\}\}/gi, '');
  text = text.replace(/\{\{[^{}]*\}\}/g, '');
  text = text.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
  text = text.replace(/\[\[([^\]]*)\]\]/g, '$1');
  text = text.replace(/\[[^\s\]]+\s+([^\]]*)\]/g, '$1');
  text = text.replace(/'''?/g, '');
  text = text.replace(/<[^>]+>/g, '');
  return text.replace(/\s+/g, ' ').trim();
}

/** Pull `[[Target|Display]]` apart into its display text and article title. */
export function parseWikiLink(value) {
  const raw = String(value ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const piped = raw.match(/\[\[([^\]|]+)\|([^\]]+)\]\]/);
  if (piped) return { name: stripWikiMarkup(piped[2]), article: piped[1].trim() };
  const plain = raw.match(/\[\[([^\]]+)\]\]/);
  if (plain) return { name: stripWikiMarkup(plain[1]), article: plain[1].trim() };
  const text = stripWikiMarkup(raw);
  return { name: text, article: text || null };
}

/** Parse "09 September 2026" and similar into an ISO date, or null. */
export function parseLooseDate(value) {
  const text = stripWikiMarkup(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}
