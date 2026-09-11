import { fetchWithRetry, log, sleep, warn } from '../lib/util.mjs';

const LEAGUE_ID = '4802'; // South African Premier Soccer League
const MAX_ROUNDS = 30; // 16 teams playing home and away
const EMPTY_ROUNDS_BEFORE_STOP = 4;
const REQUEST_SPACING_MS = 700; // the free tier starts returning 429s above ~30 requests/minute

/**
 * TheSportsDB supplies the kick-off dates, venues and crests that Wikipedia does
 * not. The shared demo key ("3") caps every response at five rows, so the data is
 * partial unless THESPORTSDB_KEY holds a personal key. Either way it is only ever
 * used to decorate the Wikipedia data, never as the source of truth.
 */
export async function fetchSchedule(season) {
  const key = process.env.THESPORTSDB_KEY?.trim() || '3';
  const isDemoKey = key === '3';
  const events = [];
  const failedRounds = [];

  const loadRound = async (round) => {
    const url = `https://www.thesportsdb.com/api/v1/json/${key}/eventsround.php?id=${LEAGUE_ID}&r=${round}&s=${season.sportsdb}`;
    try {
      const payload = await fetchWithRetry(url, { attempts: 3, timeoutMs: 15000 });
      return payload?.events ?? [];
    } catch (error) {
      warn(`round ${round} unavailable: ${error.message}`);
      return null;
    }
  };

  let emptyRounds = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const roundEvents = await loadRound(round);
    if (roundEvents === null) {
      failedRounds.push(round);
    } else if (roundEvents.length === 0) {
      // Only genuine empty responses mean we have run past the end of the
      // schedule; a throttled request tells us nothing.
      if (++emptyRounds >= EMPTY_ROUNDS_BEFORE_STOP) break;
    } else {
      emptyRounds = 0;
      events.push(...roundEvents);
    }
    await sleep(REQUEST_SPACING_MS);
  }

  if (failedRounds.length) {
    log(`retrying ${failedRounds.length} throttled round(s) after a pause`);
    await sleep(15000);
    for (const round of failedRounds.splice(0)) {
      const roundEvents = await loadRound(round);
      if (roundEvents === null) failedRounds.push(round);
      else events.push(...roundEvents);
      await sleep(REQUEST_SPACING_MS);
    }
  }

  const badges = new Map();
  const fixtures = [];
  for (const event of events) {
    if (event.strHomeTeam && event.strHomeTeamBadge) badges.set(event.strHomeTeam, event.strHomeTeamBadge);
    if (event.strAwayTeam && event.strAwayTeamBadge) badges.set(event.strAwayTeam, event.strAwayTeamBadge);
    fixtures.push({
      id: event.idEvent ?? null,
      round: event.intRound ? Number(event.intRound) : null,
      date: event.dateEvent || null,
      time: event.strTime ? event.strTime.slice(0, 5) : null,
      kickoff: event.strTimestamp ? `${event.strTimestamp}Z`.replace(/Z+$/, 'Z') : null,
      homeName: event.strHomeTeam ?? null,
      awayName: event.strAwayTeam ?? null,
      homeScore: event.intHomeScore === null || event.intHomeScore === '' ? null : Number(event.intHomeScore),
      awayScore: event.intAwayScore === null || event.intAwayScore === '' ? null : Number(event.intAwayScore),
      venue: event.strVenue || null,
      status: event.strStatus && event.strStatus !== 'NS' ? event.strStatus : null,
      postponed: event.strPostponed === 'yes',
    });
  }

  log(
    `TheSportsDB returned ${fixtures.length} scheduled matches` +
      `${isDemoKey ? ' (demo key: max 5 per round)' : ''}` +
      `${failedRounds.length ? `; rounds ${failedRounds.join(', ')} could not be read` : ''}`,
  );
  return { fixtures, badges, isDemoKey, failedRounds, leagueId: LEAGUE_ID };
}

/** League crest and blurb, handy for the page header. */
export async function fetchLeagueProfile() {
  const key = process.env.THESPORTSDB_KEY?.trim() || '3';
  try {
    const payload = await fetchWithRetry(
      `https://www.thesportsdb.com/api/v1/json/${key}/lookupleague.php?id=${LEAGUE_ID}`,
      { attempts: 2, timeoutMs: 15000 },
    );
    const league = payload?.leagues?.[0];
    if (!league) return null;
    return {
      name: league.strLeague ?? null,
      alternateName: league.strLeagueAlternate ?? null,
      badge: league.strBadge ?? null,
      website: league.strWebsite ? `https://${league.strWebsite.replace(/^https?:\/\//, '')}` : null,
      currentSeason: league.strCurrentSeason ?? null,
    };
  } catch (error) {
    warn(`league profile unavailable: ${error.message}`);
    return null;
  }
}
