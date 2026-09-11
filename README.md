# DStv Premiership Tracker

A single self-updating page for the South African Premiership (the DStv / Betway Premiership):
league table, fixtures, results, scoring charts and a chart of how each club's position has moved
over the season.

There is no server and no build step. A scheduled GitHub Action rebuilds the data, commits it to
this repository, and republishes the page to GitHub Pages, so the site is only ever static files.

## How it works

```
GitHub Actions (every 3 hours)
        │
        ├── node scripts/update.mjs   → writes data/league.json + data/history.json
        ├── git commit + push         → the data is versioned, so nothing is ever lost
        └── deploy to GitHub Pages    → index.html reads the JSON in the browser
```

`index.html` fetches `data/league.json` and `data/history.json` directly, re-checks them every five
minutes while the tab is open, and shows how long ago the data was rebuilt.

## Data sources

| Source | Provides | Key needed |
| --- | --- | --- |
| [Wikipedia](https://en.wikipedia.org/wiki/2026%E2%80%9327_South_African_Premiership) season article | Standings, every result, top scorers and assists | No |
| [TheSportsDB](https://www.thesportsdb.com/league/4802) | Kick-off dates and times, venues, club crests | Optional |

Wikipedia is the source of truth for anything with a number attached to it. The season article
carries a machine-readable league table and results grid that club editors keep current, which is
why it can be parsed reliably rather than scraped from a rendered page. TheSportsDB only decorates
that data with scheduling details Wikipedia does not publish.

### Optional: a fuller fixture list

Without a key, the updater uses TheSportsDB's shared demo key, which caps every response at five
rows — so roughly 60% of matches get a confirmed kick-off time and the rest show as "TBC". Matches
are still all listed, because the fixture list comes from Wikipedia.

To get all of them, [get a free TheSportsDB key](https://www.thesportsdb.com/api.php) and add it as
a repository secret named `THESPORTSDB_KEY` (Settings → Secrets and variables → Actions). The
workflow picks it up automatically; nothing else changes.

## Running it locally

Requires Node 20 or newer. There are no dependencies to install.

```bash
npm run update   # rebuild data/league.json and data/history.json
npm run serve    # preview at http://localhost:8080
```

To rebuild a different season:

```bash
SEASON_START_YEAR=2025 npm run update      # macOS / Linux
$env:SEASON_START_YEAR=2025; npm run update # PowerShell
```

## Stored data

`data/league.json` holds the current picture:

| Field | Meaning |
| --- | --- |
| `generatedAt` | When the updater last ran, as an ISO timestamp |
| `season`, `competition` | Season labels and league branding |
| `sources` | Where each part of the data came from, and when it was last edited upstream |
| `coverage` | Team and match counts, and whether the schedule is partial |
| `zones` | Continental-qualification and relegation bands, with their colours |
| `standings` | One entry per club: record, points, zone, recent form, next fixture, crest |
| `matches` | All 240 meetings with scores where played and kick-off details where known |
| `statistics` | Top scorers and assist leaders |

`data/history.json` keeps one dated snapshot of the table per day (the last 500), which is what the
Trends chart draws. Because both files are committed, the repository doubles as an archive of how
the season unfolded.

## Adjusting the schedule

The cron expression lives in `.github/workflows/update-and-publish.yml` and runs on UTC, two hours
behind South African time. Note that GitHub pauses scheduled workflows in repositories with no
activity for 60 days; the data commits from this workflow count as activity, so it keeps itself
alive while the season is running.

## Caveats

Scores come from community-maintained sources and can lag a live broadcast by a few minutes to a few
hours. For anything official, check [psl.co.za](https://www.psl.co.za).

## Licence

MIT — see [LICENSE](LICENSE). The league data belongs to its respective sources.
