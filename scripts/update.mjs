import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentSeason, log, resolveTeam, warn } from './lib/util.mjs';
import { loadSeasonArticle, parseResults, parseStandings, parseStatistics } from './sources/wikipedia.mjs';
import { fetchLeagueProfile, fetchSchedule } from './sources/thesportsdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_LIMIT = 500;
const FORM_LENGTH = 5;

function seasonFromEnv() {
  const override = process.env.SEASON_START_YEAR?.trim();
  if (!override) return currentSeason();
  const startYear = Number(override);
  if (!Number.isInteger(startYear)) throw new Error(`SEASON_START_YEAR must be a year, got "${override}"`);
  return currentSeason(new Date(Date.UTC(startYear, 7, 1)));
}

/**
 * Kick-off details are fetched from a throttled free endpoint, so a run that
 * gets rate limited would otherwise drop dates that a previous run already
 * captured. Seed the merge with whatever the last successful run stored.
 */
function previousSchedule(previous, season) {
  const carried = new Map();
  if (previous?.season?.label !== season.short) return carried;
  for (const match of previous.matches ?? []) {
    if (!match.date && !match.venue && match.round === null) continue;
    carried.set(`${match.home}|${match.away}`, {
      home: match.home,
      away: match.away,
      homeName: match.homeTeam,
      awayName: match.awayTeam,
      round: match.round ?? null,
      date: match.date ?? null,
      time: match.time ?? null,
      venue: match.venue ?? null,
      postponed: Boolean(match.postponed),
      homeScore: null,
      awayScore: null,
      status: null,
    });
  }
  return carried;
}

/** Attach kick-off details from TheSportsDB to the Wikipedia result grid. */
function mergeMatches(resultMatches, schedule, standings, carriedSchedule) {
  const candidates = standings.rows.map((row) => ({ key: row.code, name: row.team }));
  const codeByName = new Map();
  const resolveCode = (name) => {
    if (!name) return null;
    if (codeByName.has(name)) return codeByName.get(name);
    const resolved = resolveTeam(name, candidates)?.key ?? null;
    if (!resolved) warn(`could not match schedule team "${name}" to the league table`);
    codeByName.set(name, resolved);
    return resolved;
  };

  const scheduleByPair = new Map(carriedSchedule);
  for (const fixture of schedule.fixtures) {
    const home = resolveCode(fixture.homeName);
    const away = resolveCode(fixture.awayName);
    if (!home || !away || home === away) continue;
    scheduleByPair.set(`${home}|${away}`, { ...fixture, home, away });
  }

  const teamsByCode = new Map(standings.rows.map((row) => [row.code, row]));
  const matches = new Map();

  for (const result of resultMatches) {
    const pair = `${result.home}|${result.away}`;
    const extra = scheduleByPair.get(pair);
    matches.set(pair, {
      home: result.home,
      away: result.away,
      homeTeam: result.homeTeam,
      awayTeam: result.awayTeam,
      homeScore: result.played ? result.homeScore : extra?.homeScore ?? null,
      awayScore: result.played ? result.awayScore : extra?.awayScore ?? null,
      played: result.played || (extra?.homeScore !== null && extra?.homeScore !== undefined && extra?.status === 'FT'),
      round: extra?.round ?? null,
      date: extra?.date ?? null,
      time: extra?.time ?? null,
      venue: extra?.venue ?? null,
      postponed: extra?.postponed ?? false,
      note: result.note,
    });
  }

  // Anything the schedule knows about but the grid does not (e.g. a newly added
  // fixture) still belongs on the page.
  for (const [pair, fixture] of scheduleByPair) {
    if (matches.has(pair)) continue;
    matches.set(pair, {
      home: fixture.home,
      away: fixture.away,
      homeTeam: teamsByCode.get(fixture.home)?.team ?? fixture.homeName,
      awayTeam: teamsByCode.get(fixture.away)?.team ?? fixture.awayName,
      homeScore: fixture.homeScore,
      awayScore: fixture.awayScore,
      played: fixture.homeScore !== null && fixture.status === 'FT',
      round: fixture.round,
      date: fixture.date,
      time: fixture.time,
      venue: fixture.venue,
      postponed: fixture.postponed,
      note: null,
    });
  }

  const list = [...matches.values()];
  list.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return (a.round ?? 99) - (b.round ?? 99) || a.homeTeam.localeCompare(b.homeTeam);
  });
  return list;
}

/** Recent form, built only from matches we have a date for. */
function attachForm(standings, matches) {
  const dated = matches.filter((match) => match.played && match.date && match.homeScore !== null);
  for (const row of standings.rows) {
    const played = dated
      .filter((match) => match.home === row.code || match.away === row.code)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    row.form = played.slice(-FORM_LENGTH).map((match) => {
      const isHome = match.home === row.code;
      const scored = isHome ? match.homeScore : match.awayScore;
      const conceded = isHome ? match.awayScore : match.homeScore;
      return {
        outcome: scored > conceded ? 'W' : scored < conceded ? 'L' : 'D',
        opponent: isHome ? match.awayTeam : match.homeTeam,
        score: `${scored}-${conceded}`,
        date: match.date,
        home: isHome,
      };
    });
    // The grid holds every played match but only some carry a date, so say so
    // rather than implying the form guide is the full picture.
    row.formComplete = played.length >= Math.min(row.played, FORM_LENGTH);
  }
}

function attachNextFixtures(standings, matches, today) {
  for (const row of standings.rows) {
    const upcoming = matches
      .filter(
        (match) =>
          !match.played &&
          match.date &&
          match.date >= today &&
          (match.home === row.code || match.away === row.code),
      )
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const next = upcoming[0];
    row.nextFixture = next
      ? {
          opponent: next.home === row.code ? next.awayTeam : next.homeTeam,
          home: next.home === row.code,
          date: next.date,
          time: next.time,
          venue: next.venue,
        }
      : null;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Keep one snapshot per day so the page can chart position and points over time. */
async function updateHistory(file, season, standings, capturedAt) {
  const history = await readJson(file, { snapshots: [] });
  const snapshots = Array.isArray(history.snapshots) ? history.snapshots : [];
  const date = capturedAt.slice(0, 10);
  const snapshot = {
    date,
    capturedAt,
    season: season.short,
    standings: standings.rows.map((row) => ({
      code: row.code,
      team: row.team,
      position: row.position,
      played: row.played,
      points: row.points,
      goalDifference: row.goalDifference,
    })),
  };

  const filtered = snapshots.filter((entry) => !(entry.date === date && entry.season === season.short));
  filtered.push(snapshot);
  filtered.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { updatedAt: capturedAt, snapshots: filtered.slice(-HISTORY_LIMIT) };
}

async function main() {
  const season = seasonFromEnv();
  const capturedAt = new Date().toISOString();
  log(`building data for the ${season.short} season`);

  const article = await loadSeasonArticle(season);
  const standings = parseStandings(article.wikitext);
  log(`parsed ${standings.rows.length} teams from the league table`);

  const teamsByCode = new Map(standings.rows.map((row) => [row.code, row]));
  const results = parseResults(article.wikitext, teamsByCode);
  const statistics = parseStatistics(article.wikitext);
  log(
    `parsed ${results.matches.filter((m) => m.played).length}/${results.matches.length} played matches, ` +
      `${statistics.goals.length} scorers, ${statistics.assists.length} assist leaders`,
  );

  const bundleFile = path.join(DATA_DIR, 'league.json');
  const previous = await readJson(bundleFile, null);

  const [schedule, league] = await Promise.all([fetchSchedule(season), fetchLeagueProfile()]);

  const carried = previousSchedule(previous, season);
  if (carried.size) log(`carried ${carried.size} previously known kick-off times forward`);

  const matches = mergeMatches(results.matches, schedule, standings, carried);
  attachForm(standings, matches);
  attachNextFixtures(standings, matches, capturedAt.slice(0, 10));

  const badgeCandidates = [...schedule.badges.keys()].map((name) => ({ key: name, name }));
  const previousBadges = new Map((previous?.standings ?? []).map((row) => [row.code, row.badge]));
  for (const row of standings.rows) {
    const match = resolveTeam(row.team, badgeCandidates);
    row.badge = (match ? schedule.badges.get(match.key) : null) ?? previousBadges.get(row.code) ?? null;
  }

  const played = matches.filter((match) => match.played);
  const bundle = {
    generatedAt: capturedAt,
    season: {
      label: season.short,
      display: `${season.startYear}/${String(season.endYear).slice(2)}`,
      startYear: season.startYear,
      endYear: season.endYear,
    },
    competition: {
      name: 'South African Premiership',
      commonName: 'DStv Premiership',
      sponsoredName: league?.alternateName ?? previous?.competition?.sponsoredName ?? 'Betway Premiership',
      badge: league?.badge ?? previous?.competition?.badge ?? null,
      website: league?.website ?? previous?.competition?.website ?? 'https://www.psl.co.za',
    },
    sources: [
      {
        name: 'Wikipedia',
        detail: article.title,
        url: article.url,
        lastUpdated: standings.sourceUpdated ?? results.sourceUpdated,
        provides: ['standings', 'results', 'statistics'],
      },
      {
        name: 'TheSportsDB',
        detail: schedule.isDemoKey
          ? 'Demo key — at most five matches per round'
          : 'Personal API key',
        url: `https://www.thesportsdb.com/league/${schedule.leagueId}`,
        provides: ['kick-off dates', 'venues', 'crests'],
      },
    ],
    coverage: {
      teams: standings.rows.length,
      matchesKnown: matches.length,
      matchesPlayed: played.length,
      matchesWithKickoff: matches.filter((match) => match.date).length,
      scheduleIsPartial: schedule.isDemoKey,
    },
    zones: standings.zones,
    standings: standings.rows,
    matches,
    statistics,
  };

  await mkdir(DATA_DIR, { recursive: true });
  const historyFile = path.join(DATA_DIR, 'history.json');
  const history = await updateHistory(historyFile, season, standings, capturedAt);

  await writeFile(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
  await writeFile(historyFile, `${JSON.stringify(history, null, 2)}\n`);

  log(
    `wrote data/league.json (${standings.rows.length} teams, ${played.length}/${matches.length} matches played) ` +
      `and data/history.json (${history.snapshots.length} snapshots)`,
  );
}

main().catch((error) => {
  console.error('[update] FAILED', error);
  process.exit(1);
});
