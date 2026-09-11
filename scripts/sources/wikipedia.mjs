import { fetchWithRetry, log, parseLooseDate, parseWikiLink, stripWikiMarkup, warn } from '../lib/util.mjs';
import {
  extractInvokeBlock,
  extractTableAfter,
  parseTemplateParams,
  parseWikiTable,
} from '../lib/wikitext.mjs';

const API = 'https://en.wikipedia.org/w/api.php';

/** The competition has been renamed repeatedly, so try every known title. */
function candidateTitles(season) {
  const label = season.wiki;
  return [
    `${label} South African Premiership`,
    `${label} Betway Premiership`,
    `${label} DStv Premiership`,
    `${label} South African Premier Division`,
    `${label} Premier Soccer League`,
  ];
}

async function fetchWikitext(title) {
  const url = `${API}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&formatversion=2&redirects=1`;
  const payload = await fetchWithRetry(url);
  if (payload.error) return null;
  return { title: payload.parse?.title ?? title, wikitext: payload.parse?.wikitext ?? '' };
}

/** Find the season article that actually carries a league table. */
export async function loadSeasonArticle(season) {
  for (const title of candidateTitles(season)) {
    const article = await fetchWikitext(title);
    if (!article?.wikitext) continue;
    if (!/#invoke:\s*sports table/i.test(article.wikitext)) {
      warn(`"${article.title}" has no league table, trying the next title`);
      continue;
    }
    log(`using Wikipedia article "${article.title}"`);
    return {
      ...article,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(article.title.replace(/ /g, '_'))}`,
    };
  }
  throw new Error(`No Wikipedia season article with a league table for ${season.wiki}`);
}

const ZONE_COLOURS = {
  green1: '#2ecc71',
  green2: '#27ae60',
  green3: '#16a085',
  green4: '#1abc9c',
  blue1: '#3498db',
  blue2: '#2980b9',
  blue3: '#5dade2',
  yellow1: '#f1c40f',
  yellow2: '#f39c12',
  red1: '#e74c3c',
  red2: '#e67e22',
  red3: '#c0392b',
  black1: '#7f8c8d',
};

function toNumber(value, fallback = 0) {
  const number = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number : fallback;
}

/** Read the `{{#invoke:sports table}}` call into a sorted, ranked table. */
export function parseStandings(wikitext) {
  const body = extractInvokeBlock(wikitext, 'sports\\s*table');
  if (!body) throw new Error('League table module call not found');
  const params = parseTemplateParams(body);

  const order = (params.get('team_order') ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);

  const codes = new Set(order);
  for (const key of params.keys()) {
    const match = /^win_(.+)$/.exec(key);
    if (match) codes.add(match[1].trim());
  }
  if (!codes.size) throw new Error('League table has no teams');

  const zones = new Map();
  for (const [key, value] of params) {
    const match = /^text_(.+)$/.exec(key);
    if (!match) continue;
    const code = match[1].trim();
    zones.set(code, {
      code,
      label: stripWikiMarkup(value),
      colour: ZONE_COLOURS[params.get(`col_${code}`)?.trim()] ?? '#8899a6',
    });
  }

  const zoneByPosition = new Map();
  for (const [key, value] of params) {
    const match = /^result(\d+)$/.exec(key);
    if (!match) continue;
    for (const code of value.split('/').map((part) => part.trim())) {
      if (zones.has(code)) zoneByPosition.set(Number(match[1]), zones.get(code));
    }
  }

  const rows = [...codes].map((code) => {
    const won = toNumber(params.get(`win_${code}`));
    const drawn = toNumber(params.get(`draw_${code}`));
    const lost = toNumber(params.get(`loss_${code}`));
    const goalsFor = toNumber(params.get(`gf_${code}`));
    const goalsAgainst = toNumber(params.get(`ga_${code}`));
    const adjustment = toNumber(params.get(`adjust_points_${code}`));
    const link = parseWikiLink(params.get(`name_${code}`) ?? code);
    const override = params.get(`points_${code}`);

    return {
      code,
      team: link.name || code,
      article: link.article,
      played: won + drawn + lost,
      won,
      drawn,
      lost,
      goalsFor,
      goalsAgainst,
      goalDifference: goalsFor - goalsAgainst,
      points: override !== undefined ? toNumber(override) : won * 3 + drawn + adjustment,
      pointsAdjustment: adjustment,
      note: stripWikiMarkup(params.get(`status_${code}`) ?? '') || null,
    };
  });

  // Honour the editor-maintained `team_order` (it encodes the official
  // tie-breakers) and fall back to points/GD/GF for anything not listed.
  const orderIndex = new Map(order.map((code, index) => [code, index]));
  rows.sort((a, b) => {
    const aIndex = orderIndex.has(a.code) ? orderIndex.get(a.code) : Number.MAX_SAFE_INTEGER;
    const bIndex = orderIndex.has(b.code) ? orderIndex.get(b.code) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return (
      b.points - a.points ||
      b.goalDifference - a.goalDifference ||
      b.goalsFor - a.goalsFor ||
      a.team.localeCompare(b.team)
    );
  });

  rows.forEach((row, index) => {
    row.position = index + 1;
    const zone = zoneByPosition.get(row.position);
    row.zone = zone ? zone.code : null;
    row.zoneLabel = zone ? zone.label : null;
    row.zoneColour = zone ? zone.colour : null;
  });

  return {
    rows,
    zones: [...zones.values()],
    // Returned so the caller can re-apply the bands if it reorders the table
    // using the league's own log.
    zoneByPosition,
    sourceUpdated: parseLooseDate(params.get('update')),
    sourceNote: stripWikiMarkup(params.get('source') ?? '') || null,
  };
}

const SCORE = /^\s*(\d+)\s*[–\-—]\s*(\d+)/;

/** Read the `{{#invoke:sports results}}` grid into a flat list of meetings. */
export function parseResults(wikitext, teamsByCode) {
  const body = extractInvokeBlock(wikitext, 'sports\\s*results');
  if (!body) {
    warn('results grid not found on the article');
    return { matches: [], sourceUpdated: null };
  }
  const params = parseTemplateParams(body);
  const matches = [];

  for (const [key, rawValue] of params) {
    const match = /^match_([A-Za-z0-9]+)_([A-Za-z0-9]+)$/.exec(key);
    if (!match) continue;
    const [, home, away] = match;
    if (home === away) continue;

    const value = stripWikiMarkup(rawValue);
    const score = SCORE.exec(value);
    matches.push({
      home,
      away,
      homeTeam: teamsByCode.get(home)?.team ?? home,
      awayTeam: teamsByCode.get(away)?.team ?? away,
      homeScore: score ? Number(score[1]) : null,
      awayScore: score ? Number(score[2]) : null,
      played: Boolean(score),
      note: !score && value ? value : null,
    });
  }

  matches.sort((a, b) => a.homeTeam.localeCompare(b.homeTeam) || a.awayTeam.localeCompare(b.awayTeam));
  return { matches, sourceUpdated: parseLooseDate(params.get('update')) };
}

function parseStatTable(wikitext, heading, valueLabel) {
  const headingPattern = new RegExp(`^=+\\s*${heading}\\s*=+\\s*$`, 'im');
  const headingMatch = headingPattern.exec(wikitext);
  if (!headingMatch) return [];
  const table = extractTableAfter(wikitext, headingMatch.index + headingMatch[0].length);
  if (!table) return [];

  const grid = parseWikiTable(table);
  if (grid.length < 2) return [];

  const header = grid[0].map((cell) => stripWikiMarkup(cell).toLowerCase());
  const rankColumn = header.findIndex((cell) => cell.includes('rank'));
  const playerColumn = header.findIndex((cell) => cell.includes('player'));
  const clubColumn = header.findIndex((cell) => cell.includes('club') || cell.includes('team'));
  const valueColumn = header.findIndex((cell) => cell.includes(valueLabel));
  if (playerColumn === -1 || valueColumn === -1) return [];

  const entries = [];
  for (const row of grid.slice(1)) {
    const player = parseWikiLink(row[playerColumn] ?? '');
    if (!player.name) continue;
    const nationality = /\{\{\s*flagicon\s*\|\s*([A-Za-z]{2,3})/i.exec(row[playerColumn] ?? '')?.[1] ?? null;
    entries.push({
      rank: rankColumn === -1 ? entries.length + 1 : toNumber(row[rankColumn], entries.length + 1),
      player: player.name,
      article: player.article,
      nationality: nationality ? nationality.toUpperCase() : null,
      club: clubColumn === -1 ? null : parseWikiLink(row[clubColumn] ?? '').name || null,
      value: toNumber(row[valueColumn]),
    });
  }
  return entries.filter((entry) => entry.value > 0);
}

export function parseStatistics(wikitext) {
  return {
    goals: parseStatTable(wikitext, 'Goals', 'goal'),
    assists: parseStatTable(wikitext, 'Assists', 'assist'),
  };
}
