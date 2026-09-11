import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentSeason, log, resolveTeam, warn } from './lib/util.mjs';
import { loadSeasonArticle, parseResults, parseStandings, parseStatistics } from './sources/wikipedia.mjs';
import { fetchMatchCentre } from './sources/psl.mjs';
import { fetchLeagueProfile, fetchSchedule } from './sources/thesportsdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_LIMIT = 500;
const FORM_LENGTH = 5;
// Every kick-off time we store and display is South African time.
const TIMEZONE = 'Africa/Johannesburg';

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

/** Copy across only the fields a layer actually knows about. */
function overlay(base, incoming) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Build one record per meeting.
 *
 * The Wikipedia grid defines the full set of 240 pairings and the historical
 * scores. Scheduling details are layered on top in increasing order of
 * authority: data carried over from the last run, then TheSportsDB, then the
 * league's own match centre, which wins because it publishes the real South
 * African kick-off time and venue for every remaining fixture.
 */
function mergeMatches(resultMatches, layers, standings) {
  const candidates = standings.rows.map((row) => ({ key: row.code, name: row.team }));
  const codeByName = new Map();
  const unresolved = new Set();
  const resolveCode = (name) => {
    if (!name) return null;
    if (codeByName.has(name)) return codeByName.get(name);
    const resolved = resolveTeam(name, candidates)?.key ?? null;
    if (!resolved) unresolved.add(name);
    codeByName.set(name, resolved);
    return resolved;
  };

  const scheduleByPair = new Map();
  for (const entries of layers) {
    for (const entry of entries) {
      const home = entry.home ?? resolveCode(entry.homeName);
      const away = entry.away ?? resolveCode(entry.awayName);
      if (!home || !away || home === away) continue;
      const pair = `${home}|${away}`;
      scheduleByPair.set(pair, overlay(scheduleByPair.get(pair) ?? {}, { ...entry, home, away }));
    }
  }

  if (unresolved.size) {
    warn(`could not match to the league table: ${[...unresolved].join(', ')}`);
  }

  const teamsByCode = new Map(standings.rows.map((row) => [row.code, row]));
  const matches = new Map();

  const scoreOf = (extra, result) => {
    // A scoreline from a scheduling source is only trusted once that source
    // says the match is over.
    const finished = extra?.played || extra?.status === 'FT';
    if (finished && extra?.homeScore !== null && extra?.homeScore !== undefined) {
      return { homeScore: extra.homeScore, awayScore: extra.awayScore, played: true };
    }
    if (result?.played) {
      return { homeScore: result.homeScore, awayScore: result.awayScore, played: true };
    }
    return { homeScore: null, awayScore: null, played: false };
  };

  for (const result of resultMatches) {
    const pair = `${result.home}|${result.away}`;
    const extra = scheduleByPair.get(pair);
    matches.set(pair, {
      home: result.home,
      away: result.away,
      homeTeam: result.homeTeam,
      awayTeam: result.awayTeam,
      ...scoreOf(extra, result),
      round: extra?.round ?? null,
      date: extra?.date ?? null,
      time: extra?.time ?? null,
      venue: extra?.venue ?? null,
      postponed: extra?.postponed ?? false,
      officialId: extra?.officialId ?? null,
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
      ...scoreOf(fixture, null),
      round: fixture.round ?? null,
      date: fixture.date ?? null,
      time: fixture.time ?? null,
      venue: fixture.venue ?? null,
      postponed: fixture.postponed ?? false,
      officialId: fixture.officialId ?? null,
      note: null,
    });
  }

  const list = [...matches.values()];
  list.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    // Same day: order by kick-off so the fixture list reads chronologically.
    const aTime = a.time ?? '99:99';
    const bTime = b.time ?? '99:99';
    if (a.date && b.date && aTime !== bTime) return aTime < bTime ? -1 : 1;
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
    const remaining = matches.filter(
      (match) => !match.played && (match.home === row.code || match.away === row.code),
    );
    const upcoming = remaining
      .filter((match) => match.date && match.date >= today)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const next = upcoming[0];
    row.nextFixture = next
      ? {
          opponent: next.home === row.code ? next.awayTeam : next.homeTeam,
          home: next.home === row.code,
          date: next.date,
          time: next.time,
          venue: next.venue,
          // An undated fixture could fall earlier than this one, in which case
          // we cannot honestly call it the next match.
          certain: remaining.every((match) => Boolean(match.date)),
        }
      : null;
  }
}

/**
 * Overlay the league's own log onto the table.
 *
 * The Wikipedia table supplies the three-letter codes that every match is keyed
 * by, plus the continental and relegation bands, so it stays the skeleton. The
 * official log replaces the numbers and the ordering, because it is updated
 * within minutes of a final whistle rather than whenever an editor gets to it.
 */
function applyOfficialLog(standings, officialRows) {
  if (!officialRows?.length) return { applied: 0, changedOrder: false };

  const candidates = standings.rows.map((row) => ({ key: row.code, name: row.team }));
  const byCode = new Map(standings.rows.map((row) => [row.code, row]));
  const originalOrder = standings.rows.map((row) => row.code).join(',');
  const seen = new Set();
  let applied = 0;

  for (const entry of officialRows) {
    const resolved = resolveTeam(entry.team, candidates);
    const row = resolved ? byCode.get(resolved.key) : null;
    if (!row || seen.has(row.code)) {
      if (!row) warn(`official log team "${entry.team}" did not match the league table`);
      continue;
    }
    seen.add(row.code);
    applied++;
    Object.assign(row, {
      position: entry.position,
      played: entry.played,
      won: entry.won,
      drawn: entry.drawn,
      lost: entry.lost,
      goalsFor: entry.goalsFor,
      goalsAgainst: entry.goalsAgainst,
      goalDifference: entry.goalDifference,
      points: entry.points,
      officialName: entry.team,
    });
    if (entry.badge) row.badge = entry.badge;
  }

  if (applied !== standings.rows.length) {
    warn(`official log covered ${applied} of ${standings.rows.length} clubs; leaving the rest as parsed`);
    return { applied, changedOrder: false };
  }

  standings.rows.sort((a, b) => a.position - b.position);
  standings.rows.forEach((row, index) => {
    row.position = index + 1;
    const zone = standings.zoneByPosition?.get(row.position) ?? null;
    row.zone = zone?.code ?? null;
    row.zoneLabel = zone?.label ?? null;
    row.zoneColour = zone?.colour ?? null;
  });

  return { applied, changedOrder: standings.rows.map((row) => row.code).join(',') !== originalOrder };
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

  // The official site only ever publishes the season in progress.
  const isCurrentSeason = season.short === currentSeason().short;
  const [official, schedule, league] = await Promise.all([
    isCurrentSeason ? fetchMatchCentre() : Promise.resolve(null),
    fetchSchedule(season),
    fetchLeagueProfile(),
  ]);

  const carried = previousSchedule(previous, season);
  if (carried.size) log(`carried ${carried.size} previously known kick-off times forward`);

  const matches = mergeMatches(
    results.matches,
    [[...carried.values()], schedule.fixtures, official?.results ?? [], official?.fixtures ?? []],
    standings,
  );

  const badgeCandidates = [...schedule.badges.keys()].map((name) => ({ key: name, name }));
  const previousBadges = new Map((previous?.standings ?? []).map((row) => [row.code, row.badge]));
  for (const row of standings.rows) {
    const match = resolveTeam(row.team, badgeCandidates);
    row.badge = (match ? schedule.badges.get(match.key) : null) ?? previousBadges.get(row.code) ?? null;
  }

  // Applied after the crest fallbacks so the official logos take precedence.
  const officialLog = applyOfficialLog(standings, official?.standings);
  if (officialLog.applied) {
    log(
      `applied the official log for all ${officialLog.applied} clubs` +
        `${officialLog.changedOrder ? ' (it reordered the table)' : ''}`,
    );
  }

  attachForm(standings, matches);
  attachNextFixtures(standings, matches, capturedAt.slice(0, 10));

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
    timezone: TIMEZONE,
    sources: [
      {
        name: 'Premier Soccer League',
        detail: official ? 'Official match centre' : 'Unavailable on this run',
        url: official?.url ?? 'https://www.psl.co.za/matchcentre',
        available: Boolean(official),
        provides: ['log', 'fixtures', 'kick-off times', 'venues', 'crests'],
      },
      {
        name: 'Wikipedia',
        detail: article.title,
        url: article.url,
        lastUpdated: standings.sourceUpdated ?? results.sourceUpdated,
        available: true,
        provides: ['full results grid', 'scorers and assists', 'qualification bands'],
      },
      {
        name: 'TheSportsDB',
        detail: schedule.isDemoKey ? 'Demo key — at most five matches per round' : 'Personal API key',
        url: `https://www.thesportsdb.com/league/${schedule.leagueId}`,
        available: schedule.fixtures.length > 0,
        provides: ['round numbers', 'fallback kick-off times'],
      },
    ],
    coverage: {
      teams: standings.rows.length,
      matchesKnown: matches.length,
      matchesPlayed: played.length,
      matchesWithKickoff: matches.filter((match) => match.date).length,
      upcomingWithoutKickoff: matches.filter((match) => !match.played && !match.date).length,
      officialLogApplied: officialLog.applied === standings.rows.length,
      scheduleIsPartial: schedule.isDemoKey && !official,
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
