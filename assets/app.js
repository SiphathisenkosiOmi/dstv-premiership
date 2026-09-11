const DATA_URL = 'data/league.json';
const HISTORY_URL = 'data/history.json';
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const STALE_AFTER_HOURS = 12;

const SERIES_COLOURS = [
  '#16c37a', '#ffc247', '#5aa9ff', '#ff7ba9', '#9d7bff',
  '#3fd8c8', '#ff9d5c', '#c3e63f', '#ff6b6b', '#7fb0ff',
];

const RECORD_COLUMNS = [
  ['played', 'num'],
  ['won', 'num hide-sm'],
  ['drawn', 'num hide-sm'],
  ['lost', 'num hide-sm'],
  ['goalsFor', 'num hide-sm'],
  ['goalsAgainst', 'num hide-sm'],
];

const state = {
  league: null,
  history: null,
  filter: '',
  sort: null,
  panel: 'table',
  trendTeams: new Set(),
};

const el = (id) => document.getElementById(id);

const dateFormat = new Intl.DateTimeFormat('en-ZA', {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
});
const shortDate = new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'short' });

function parseDate(isoDate) {
  if (!isoDate) return null;
  const date = new Date(`${isoDate}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(isoDate, formatter = dateFormat) {
  const date = parseDate(isoDate);
  return date ? formatter.format(date) : 'Date to be confirmed';
}

function relativeTime(isoTimestamp) {
  const then = Date.parse(isoTimestamp);
  if (Number.isNaN(then)) return 'unknown';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------ rendering ------------------------------ */

function badgeNode(row) {
  if (row?.badge) {
    const img = document.createElement('img');
    img.className = 'team-badge';
    img.src = row.badge;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.replaceWith(fallbackBadge(row)));
    return img;
  }
  return fallbackBadge(row);
}

function fallbackBadge(row) {
  const span = document.createElement('span');
  span.className = 'team-badge-fallback';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = (row?.code ?? row?.team ?? '?').slice(0, 3).toUpperCase();
  return span;
}

function teamRowByCode(code) {
  return state.league?.standings.find((row) => row.code === code) ?? null;
}

function matchesFilter(...names) {
  if (!state.filter) return true;
  return names.some((name) => String(name ?? '').toLowerCase().includes(state.filter));
}

function renderCards() {
  const { standings, matches, statistics, coverage } = state.league;
  const leader = standings[0];
  const topScorer = statistics.goals[0];
  const nextMatch = matches
    .filter((match) => !match.played && match.date && match.date >= todayISO())
    .sort((a, b) => (a.date < b.date ? -1 : 1))[0];

  const cards = [
    leader && {
      label: 'Log leader',
      value: leader.team,
      meta: `${leader.points} pts from ${leader.played} · GD ${leader.goalDifference > 0 ? '+' : ''}${leader.goalDifference}`,
    },
    {
      label: 'Matches played',
      value: `${coverage.matchesPlayed} of ${coverage.matchesKnown}`,
      meta: `${Math.round((coverage.matchesPlayed / coverage.matchesKnown) * 100)}% of the season complete`,
    },
    topScorer && {
      label: 'Golden boot',
      value: topScorer.player,
      meta: `${topScorer.value} goals · ${topScorer.club ?? 'unknown club'}`,
    },
    nextMatch && {
      label: 'Next kick-off',
      value: `${nextMatch.homeTeam} v ${nextMatch.awayTeam}`,
      meta: `${formatDate(nextMatch.date)}${nextMatch.time ? ` · ${nextMatch.time}` : ''}`,
    },
  ].filter(Boolean);

  el('cards').replaceChildren(
    ...cards.map((card) => {
      const article = document.createElement('article');
      article.className = 'card';
      article.innerHTML = `
        <p class="card-label"></p>
        <p class="card-value"></p>
        <p class="card-meta"></p>`;
      article.querySelector('.card-label').textContent = card.label;
      article.querySelector('.card-value').textContent = card.value;
      article.querySelector('.card-meta').textContent = card.meta;
      return article;
    }),
  );
}

function sortedStandings() {
  const rows = [...state.league.standings];
  if (!state.sort) return rows;
  const { key, direction } = state.sort;
  return rows.sort((a, b) => (a[key] - b[key]) * (direction === 'ascending' ? 1 : -1) || a.position - b.position);
}

function renderStandings() {
  const body = el('standings').querySelector('tbody');
  const rows = sortedStandings().filter((row) => matchesFilter(row.team, row.code));

  body.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement('tr');

      const position = document.createElement('td');
      position.className = 'col-pos';
      if (row.zoneColour) {
        const bar = document.createElement('span');
        bar.className = 'zone-bar';
        bar.style.background = row.zoneColour;
        bar.title = row.zoneLabel ?? '';
        position.append(bar);
      }
      position.append(document.createTextNode(String(row.position)));
      tr.append(position);

      const team = document.createElement('td');
      team.className = 'col-team';
      const cell = document.createElement('div');
      cell.className = 'team-cell';
      cell.append(badgeNode(row));
      const name = document.createElement('span');
      name.className = 'team-name';
      name.textContent = row.team;
      cell.append(name);
      if (row.pointsAdjustment) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = `${row.pointsAdjustment > 0 ? '+' : ''}${row.pointsAdjustment} pts`;
        cell.append(tag);
      }
      team.append(cell);
      tr.append(team);

      // Narrow screens keep only the columns that decide the log: P, GD and Pts.
      for (const [key, className] of RECORD_COLUMNS) {
        const td = document.createElement('td');
        td.className = className;
        td.textContent = row[key];
        tr.append(td);
      }

      const gd = document.createElement('td');
      gd.className = 'num';
      gd.textContent = `${row.goalDifference > 0 ? '+' : ''}${row.goalDifference}`;
      tr.append(gd);

      const points = document.createElement('td');
      points.className = 'num pts';
      points.textContent = row.points;
      tr.append(points);

      const form = document.createElement('td');
      form.className = 'col-form hide-sm';
      const formRow = document.createElement('div');
      formRow.className = 'form-row';
      for (const entry of row.form ?? []) {
        const pip = document.createElement('span');
        pip.className = `pip pip-${entry.outcome}`;
        pip.textContent = entry.outcome;
        pip.title = `${entry.score} ${entry.home ? 'v' : 'at'} ${entry.opponent} (${formatDate(entry.date, shortDate)})`;
        formRow.append(pip);
      }
      if (!formRow.childElementCount) formRow.textContent = '—';
      form.append(formRow);
      tr.append(form);

      const next = document.createElement('td');
      next.className = 'col-next hide-md next-cell';
      next.textContent = row.nextFixture
        ? `${row.nextFixture.home ? 'v' : 'at'} ${row.nextFixture.opponent}, ${formatDate(row.nextFixture.date, shortDate)}`
        : '—';
      tr.append(next);

      return tr;
    }),
  );

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 12;
    td.className = 'empty';
    td.textContent = 'No team matches that filter.';
    tr.append(td);
    body.append(tr);
  }

  el('legend').replaceChildren(
    ...state.league.zones.map((zone) => {
      const li = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = zone.colour;
      li.append(swatch, document.createTextNode(zone.label));
      return li;
    }),
  );

  const partialForm = state.league.standings.some((row) => row.formComplete === false);
  el('form-note').textContent = partialForm
    ? 'Form is built from matches with a confirmed date, so a club may show fewer than five results.'
    : '';
}

function matchNode(match) {
  const li = document.createElement('li');
  li.className = 'match';

  const home = document.createElement('div');
  home.className = 'match-side home';
  home.append(badgeNode(teamRowByCode(match.home) ?? { code: match.home, team: match.homeTeam }));
  const homeName = document.createElement('span');
  homeName.className = 'team-name';
  homeName.textContent = match.homeTeam;
  home.append(homeName);

  const centre = document.createElement('div');
  centre.className = 'match-centre';
  const primary = document.createElement('span');
  if (match.played && match.homeScore !== null) {
    primary.className = 'match-score';
    primary.textContent = `${match.homeScore} – ${match.awayScore}`;
  } else {
    primary.className = 'match-kick';
    primary.textContent = match.postponed ? 'Postponed' : match.time ?? 'TBC';
  }
  centre.append(primary);
  const meta = document.createElement('span');
  meta.className = 'match-meta';
  meta.textContent = [match.round ? `Round ${match.round}` : null, match.venue].filter(Boolean).join(' · ');
  if (meta.textContent) centre.append(meta);

  const away = document.createElement('div');
  away.className = 'match-side away';
  away.append(badgeNode(teamRowByCode(match.away) ?? { code: match.away, team: match.awayTeam }));
  const awayName = document.createElement('span');
  awayName.className = 'team-name';
  awayName.textContent = match.awayTeam;
  away.append(awayName);

  li.append(home, centre, away);
  return li;
}

function groupByDate(matches) {
  const groups = new Map();
  for (const match of matches) {
    const key = match.date ?? 'tbc';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  }
  return groups;
}

function renderMatchGroups(container, groups, emptyMessage) {
  const nodes = [];
  for (const [key, matches] of groups) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.className = 'match-group-title';
    title.textContent = key === 'tbc' ? 'Date to be confirmed' : formatDate(key);
    const list = document.createElement('ul');
    list.className = 'match-list';
    list.append(...matches.map(matchNode));
    section.append(title, list);
    nodes.push(section);
  }
  if (!nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyMessage;
    nodes.push(empty);
  }
  container.replaceChildren(...nodes);
}

function renderFixtures() {
  const today = todayISO();
  const upcoming = state.league.matches
    .filter((match) => !match.played && matchesFilter(match.homeTeam, match.awayTeam))
    .filter((match) => !match.date || match.date >= today)
    .sort((a, b) => {
      if (a.date && b.date) return a.date < b.date ? -1 : 1;
      return a.date ? -1 : b.date ? 1 : 0;
    });

  renderMatchGroups(
    el('fixtures-list'),
    groupByDate(upcoming),
    'No upcoming fixtures to show for that filter.',
  );
}

function renderResults() {
  const played = state.league.matches
    .filter((match) => match.played && match.homeScore !== null)
    .filter((match) => matchesFilter(match.homeTeam, match.awayTeam))
    .sort((a, b) => {
      if (a.date && b.date) return a.date > b.date ? -1 : 1;
      return a.date ? -1 : b.date ? 1 : 0;
    });

  renderMatchGroups(el('results-list'), groupByDate(played), 'No results to show for that filter.');
}

function renderChart(listId, entries, unit) {
  const list = el(listId);
  const visible = entries.filter((entry) => matchesFilter(entry.player, entry.club));
  if (!visible.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.style.gridColumn = '1 / -1';
    empty.textContent = entries.length ? 'Nothing matches that filter.' : `No ${unit} published yet.`;
    list.replaceChildren(empty);
    return;
  }

  const max = Math.max(...entries.map((entry) => entry.value));
  list.replaceChildren(
    ...visible.map((entry) => {
      const li = document.createElement('li');
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = entry.rank;

      const who = document.createElement('span');
      who.className = 'who';
      const strong = document.createElement('strong');
      strong.textContent = entry.player;
      const span = document.createElement('span');
      span.textContent = [entry.nationality, entry.club].filter(Boolean).join(' · ');
      who.append(strong, span);

      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(8, (entry.value / max) * 100)}%`;
      const value = document.createElement('b');
      value.textContent = entry.value;
      bar.append(fill, value);

      li.append(rank, who, bar);
      return li;
    }),
  );
}

function renderScorers() {
  renderChart('goals-chart', state.league.statistics.goals, 'goals');
  renderChart('assists-chart', state.league.statistics.assists, 'assists');
}

/** Line chart of league position over time, one series per selected team. */
function renderTrends() {
  const wrap = el('trends-wrap');
  const snapshots = (state.history?.snapshots ?? []).filter(
    (snapshot) => snapshot.season === state.league.season.label,
  );

  if (snapshots.length < 2) {
    wrap.replaceChildren(
      Object.assign(document.createElement('p'), {
        className: 'empty',
        textContent:
          snapshots.length === 1
            ? 'One snapshot saved so far. The chart appears once a second daily update lands.'
            : 'No snapshots stored for this season yet.',
      }),
    );
    el('trend-teams').replaceChildren();
    return;
  }

  const teams = state.league.standings;
  if (!state.trendTeams.size) {
    for (const row of teams.slice(0, 5)) state.trendTeams.add(row.code);
  }

  const width = 900;
  const height = 360;
  const pad = { top: 20, right: 24, bottom: 34, left: 38 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const maxPosition = teams.length;

  const x = (index) => pad.left + (snapshots.length === 1 ? plotWidth / 2 : (index / (snapshots.length - 1)) * plotWidth);
  const y = (position) => pad.top + ((position - 1) / Math.max(1, maxPosition - 1)) * plotHeight;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'League position over time');

  const add = (tag, attrs, text) => {
    const node = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    svg.append(node);
    return node;
  };

  for (let position = 1; position <= maxPosition; position++) {
    if (position !== 1 && position !== maxPosition && position % 3 !== 0) continue;
    add('line', { class: 'axis', x1: pad.left, x2: width - pad.right, y1: y(position), y2: y(position) });
    add('text', { class: 'tick', x: pad.left - 8, y: y(position) + 3, 'text-anchor': 'end' }, String(position));
  }

  const labelEvery = Math.max(1, Math.ceil(snapshots.length / 8));
  snapshots.forEach((snapshot, index) => {
    if (index % labelEvery !== 0 && index !== snapshots.length - 1) return;
    add(
      'text',
      { class: 'tick', x: x(index), y: height - pad.bottom + 18, 'text-anchor': 'middle' },
      formatDate(snapshot.date, shortDate),
    );
  });

  const colourFor = (code) => SERIES_COLOURS[teams.findIndex((row) => row.code === code) % SERIES_COLOURS.length];

  for (const code of state.trendTeams) {
    const points = [];
    snapshots.forEach((snapshot, index) => {
      const entry = snapshot.standings.find((item) => item.code === code);
      if (entry) points.push(`${x(index)},${y(entry.position)}`);
    });
    if (points.length < 2) continue;
    add('polyline', { class: 'series', points: points.join(' '), stroke: colourFor(code) });
  }

  wrap.replaceChildren(svg);

  el('trend-teams').replaceChildren(
    ...teams.map((row) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.style.color = state.trendTeams.has(row.code) ? colourFor(row.code) : '';
      chip.setAttribute('aria-pressed', String(state.trendTeams.has(row.code)));
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      chip.append(swatch, document.createTextNode(row.team));
      chip.addEventListener('click', () => {
        if (state.trendTeams.has(row.code)) state.trendTeams.delete(row.code);
        else state.trendTeams.add(row.code);
        renderTrends();
      });
      return chip;
    }),
  );
}

function renderHeader() {
  const { competition, season, sources, generatedAt, coverage } = state.league;

  if (competition.badge) {
    const badge = el('league-badge');
    badge.src = competition.badge;
    badge.hidden = false;
  }

  el('season-line').textContent =
    `${competition.sponsoredName} · ${season.display} season · ${coverage.teams} clubs`;

  const ageHours = (Date.now() - Date.parse(generatedAt)) / 3600000;
  const freshness = el('freshness');
  freshness.classList.toggle('is-stale', ageHours > STALE_AFTER_HOURS);
  freshness.classList.remove('is-error');
  el('freshness-text').textContent = `Data rebuilt ${relativeTime(generatedAt)}`;
  freshness.title = new Date(generatedAt).toString();

  const wikipedia = sources.find((source) => source.name === 'Wikipedia');
  el('sources-line').replaceChildren(
    document.createTextNode('Sources: '),
    Object.assign(document.createElement('a'), {
      href: wikipedia?.url ?? '#',
      textContent: wikipedia?.detail ?? 'Wikipedia',
      rel: 'noreferrer',
    }),
    document.createTextNode(
      `${wikipedia?.lastUpdated ? ` (table updated ${formatDate(wikipedia.lastUpdated)})` : ''}, kick-off times and crests from `,
    ),
    Object.assign(document.createElement('a'), {
      href: 'https://www.thesportsdb.com/',
      textContent: 'TheSportsDB',
      rel: 'noreferrer',
    }),
    document.createTextNode(
      coverage.matchesWithKickoff < coverage.matchesKnown
        ? `. ${coverage.matchesWithKickoff} of ${coverage.matchesKnown} matches have a confirmed kick-off time.`
        : '.',
    ),
  );
}

function renderAll() {
  if (!state.league) return;
  renderHeader();
  renderCards();
  renderStandings();
  renderFixtures();
  renderResults();
  renderScorers();
  renderTrends();
}

/* ------------------------------ data loading ------------------------------ */

async function loadJson(url) {
  const response = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function load({ showSpinner = false } = {}) {
  const button = el('refresh');
  if (showSpinner) button.disabled = true;
  try {
    const [league, history] = await Promise.all([
      loadJson(DATA_URL),
      loadJson(HISTORY_URL).catch(() => ({ snapshots: [] })),
    ]);
    state.league = league;
    state.history = history;
    el('alert').hidden = true;
    renderAll();
  } catch (error) {
    const alert = el('alert');
    alert.hidden = false;
    alert.textContent = state.league
      ? `Could not refresh the data (${error.message}). Showing the last copy that loaded.`
      : `Could not load the league data: ${error.message}. If you just cloned this repository, run "npm run update" to build data/league.json.`;
    el('freshness').classList.add('is-error');
    el('freshness-text').textContent = 'Update failed';
  } finally {
    if (showSpinner) button.disabled = false;
  }
}

/* ------------------------------ interactions ------------------------------ */

function showPanel(panel) {
  state.panel = panel;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.panel === panel);
  }
  for (const section of document.querySelectorAll('.panel')) {
    section.classList.toggle('is-active', section.id === `panel-${panel}`);
  }
  if (location.hash.slice(1) !== panel) history.replaceState(null, '', `#${panel}`);
}

el('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) showPanel(tab.dataset.panel);
});

el('refresh').addEventListener('click', () => load({ showSpinner: true }));

el('team-filter').addEventListener('input', (event) => {
  state.filter = event.target.value.trim().toLowerCase();
  el('clear-filter').hidden = !state.filter;
  if (state.league) {
    renderStandings();
    renderFixtures();
    renderResults();
    renderScorers();
  }
});

el('clear-filter').addEventListener('click', () => {
  el('team-filter').value = '';
  el('team-filter').dispatchEvent(new Event('input'));
});

for (const header of document.querySelectorAll('.sortable')) {
  header.addEventListener('click', () => {
    const key = header.dataset.sort;
    const descending = state.sort?.key === key && state.sort.direction === 'descending';
    state.sort = { key, direction: descending ? 'ascending' : 'descending' };
    for (const other of document.querySelectorAll('.sortable')) other.removeAttribute('aria-sort');
    header.setAttribute('aria-sort', state.sort.direction);
    renderStandings();
  });
}

const initialPanel = location.hash.slice(1);
if (document.getElementById(`panel-${initialPanel}`)) showPanel(initialPanel);

await load();
setInterval(() => load(), POLL_INTERVAL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.league) return;
  const ageMinutes = (Date.now() - Date.parse(state.league.generatedAt)) / 60000;
  if (ageMinutes > 15) load();
});
