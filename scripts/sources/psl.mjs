import { fetchWithRetry, log, warn } from '../lib/util.mjs';

/**
 * psl.co.za is the league's own site and the authoritative source for the log
 * and the fixture list. Its match centre is server-rendered and holds every
 * upcoming fixture with a South African kick-off time and venue, plus the most
 * recent results, all in one document.
 */
const MATCH_CENTRE_URL = 'https://www.psl.co.za/matchcentre?type=fixtures';

// The site rejects requests without a browser-ish user agent.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&ndash;': '-', '&mdash;': '-',
};

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

function text(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Turn the group id "12Sep2026" into "2026-09-12". */
function parseDateKey(key) {
  const match = /^(\d{1,2})([A-Za-z]{3})(\d{4})$/.exec(String(key ?? '').trim());
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

/** Pull one `<td class="...">` cell out of a row. */
function cell(block, className) {
  const pattern = new RegExp(`<td[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</td>`, 'i');
  return pattern.exec(block)?.[1] ?? null;
}

function teamFrom(block, className) {
  const html = cell(block, className);
  if (!html) return null;
  const name = text(/team-meta__name[^>]*>([\s\S]*?)</.exec(html)?.[1] ?? '');
  if (!name) return null;
  const logo = /<img[^>]*src="([^"]+)"/i.exec(html)?.[1];
  return {
    name,
    // Logo URLs contain spaces, which browsers tolerate but are safer encoded.
    badge: logo && !/noclublogo/i.test(logo) ? decodeEntities(logo).replace(/ /g, '%20') : null,
  };
}

/**
 * Footers read "12 Sep 15:00 - Princess Magogo Stadium, Durban" for fixtures and
 * "11 Sep 2026 - Athlone Stadium, Cape Town" for results.
 */
function parseFooter(block, className) {
  const raw = text(cell(block, className) ?? '');
  if (!raw) return { time: null, venue: null };
  const separator = raw.indexOf(' - ');
  const left = separator === -1 ? raw : raw.slice(0, separator);
  const right = separator === -1 ? '' : raw.slice(separator + 3).trim();
  const time = /\b(\d{1,2}):(\d{2})\b/.exec(left);
  return {
    time: time ? `${time[1].padStart(2, '0')}:${time[2]}` : null,
    venue: right || null,
  };
}

function* matchGroups(html, kind) {
  const pattern = new RegExp(`<tbody[^>]*name="${kind}_([^"]+)"[^>]*>([\\s\\S]*?)</tbody>`, 'gi');
  for (const match of html.matchAll(pattern)) {
    const date = parseDateKey(match[1]);
    if (date) yield { date, block: match[2] };
  }
}

function parseFixtures(html) {
  const fixtures = [];
  for (const { date, block } of matchGroups(html, 'fixtures')) {
    const home = teamFrom(block, 'fixtures-team1');
    const away = teamFrom(block, 'fixtures-team2');
    if (!home || !away) continue;
    const { time, venue } = parseFooter(block, 'fixtures-footer-block');
    fixtures.push({ date, time, venue, homeName: home.name, awayName: away.name, played: false });
  }
  return fixtures;
}

function parseResults(html) {
  const results = [];
  for (const { date, block } of matchGroups(html, 'results')) {
    const home = teamFrom(block, 'results-team1');
    const away = teamFrom(block, 'results-team2');
    if (!home || !away) continue;
    const score = /(\d+)\s*-\s*(\d+)/.exec(text(cell(block, 'results-score') ?? ''));
    const { venue } = parseFooter(block, 'results-footer-block');
    results.push({
      date,
      time: null,
      venue,
      homeName: home.name,
      awayName: away.name,
      homeScore: score ? Number(score[1]) : null,
      awayScore: score ? Number(score[2]) : null,
      played: Boolean(score),
      officialId: /\/matchcentre\/detail\/(\d+)-/.exec(block)?.[1] ?? null,
    });
  }
  return results;
}

function number(block, className) {
  const value = text(cell(block, className) ?? '');
  const parsed = Number(value.replace(/[^\d-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** The official log, in the league's own order. */
function parseLog(html) {
  const body = /<tbody[^>]*id="LogViewContent"[^>]*>([\s\S]*?)<\/tbody>/i.exec(html)?.[1];
  if (!body) return [];

  const rows = [];
  for (const match of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const block = match[1];
    const teamCell = cell(block, 'logs-team');
    if (!teamCell) continue;

    const position = Number(text(/<h5[^>]*team-meta__name[^>]*>([\s\S]*?)<\/h5>/i.exec(teamCell)?.[1] ?? ''));
    const team = text(/<h6[^>]*team-meta__name[^>]*>([\s\S]*?)<\/h6>/i.exec(teamCell)?.[1] ?? '');
    if (!team) continue;

    const logo = /<img[^>]*src="([^"]+)"/i.exec(teamCell)?.[1];
    const won = number(block, 'logs-win') ?? 0;
    const drawn = number(block, 'logs-draw') ?? 0;
    const lost = number(block, 'logs-lost') ?? 0;
    const goalsFor = number(block, 'logs-goals-for') ?? 0;
    const goalsAgainst = number(block, 'logs-goals-against') ?? 0;

    rows.push({
      position: Number.isFinite(position) && position > 0 ? position : rows.length + 1,
      team,
      badge: logo && !/noclublogo/i.test(logo) ? decodeEntities(logo).replace(/ /g, '%20') : null,
      played: number(block, 'logs-played') ?? won + drawn + lost,
      won,
      drawn,
      lost,
      goalsFor,
      goalsAgainst,
      goalDifference: number(block, 'logs-goal-diff') ?? goalsFor - goalsAgainst,
      points: number(block, 'logs-points') ?? won * 3 + drawn,
    });
  }

  rows.sort((a, b) => a.position - b.position);
  return rows;
}

/**
 * Read the match centre. Any failure is reported and returns null so the caller
 * can fall back to the other sources rather than lose a whole update.
 */
export async function fetchMatchCentre() {
  let html;
  try {
    html = await fetchWithRetry(MATCH_CENTRE_URL, {
      parse: 'text',
      attempts: 3,
      timeoutMs: 30000,
      headers: { 'user-agent': BROWSER_UA },
    });
  } catch (error) {
    warn(`psl.co.za match centre unavailable: ${error.message}`);
    return null;
  }

  const standings = parseLog(html);
  const fixtures = parseFixtures(html);
  const results = parseResults(html);

  if (!standings.length && !fixtures.length) {
    warn('psl.co.za returned a page we could not parse; ignoring it this run');
    return null;
  }

  log(
    `psl.co.za: ${standings.length} log rows, ${fixtures.length} upcoming fixtures, ${results.length} recent results`,
  );
  return { standings, fixtures, results, url: MATCH_CENTRE_URL };
}
