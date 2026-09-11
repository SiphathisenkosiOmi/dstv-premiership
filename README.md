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

Three sources are combined, each used for what it is actually best at. None requires an API key.

| Source | Provides | Authority |
| --- | --- | --- |
| [psl.co.za match centre](https://www.psl.co.za/matchcentre) | The official log, every remaining fixture with its South African kick-off time and venue, recent results, club crests | Highest |
| [Wikipedia](https://en.wikipedia.org/wiki/2026%E2%80%9327_South_African_Premiership) season article | The full results grid for all 240 meetings, top scorers and assists, the continental/relegation bands | Structural |
| [TheSportsDB](https://www.thesportsdb.com/league/4802) | Round numbers, and kick-off times as a fallback | Lowest |

The league's own site wins on anything it publishes, because it updates within minutes of a final
whistle and prints the real kick-off time. Wikipedia remains the skeleton: its season article carries
a machine-readable table and results grid, which gives every club a stable short code, covers
matches older than the match centre's window, and is the only source here for scorers and for which
positions qualify for the CAF competitions.

Scheduling details are layered in that order, so a source only fills a gap the one above it left.
If psl.co.za is unreachable, the run still succeeds on the other two and simply logs a warning.

### Optional: a TheSportsDB key

TheSportsDB's shared demo key caps every response at five rows per round. This now only affects
round numbers, since kick-off times come from the league site, so a key is rarely worth adding. If
you want one anyway, [get a free key](https://www.thesportsdb.com/api.php) and add it as a
repository secret named `THESPORTSDB_KEY` (Settings → Secrets and variables → Actions).

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
| `timezone` | `Africa/Johannesburg` — every `time` field is South African time |
| `sources` | Each source, what it provided, and whether it responded this run |
| `coverage` | Team and match counts, fixtures still lacking a date, whether the official log was applied |
| `zones` | Continental-qualification and relegation bands, with their colours |
| `standings` | One entry per club: record, points, zone, recent form, next fixture, crest |
| `matches` | All 240 meetings with scores where played and kick-off details where known |
| `statistics` | Top scorers and assist leaders |

A club's `nextFixture` carries `certain: false` when some other fixture of theirs has no published
date and could therefore fall earlier. The page marks those with a `?`.

`data/history.json` keeps one dated snapshot of the table per day (the last 500), which is what the
Trends chart draws. Because both files are committed, the repository doubles as an archive of how
the season unfolded.

## Adjusting the schedule

The cron expression lives in `.github/workflows/update-and-publish.yml` and runs on UTC, two hours
behind South African time. Note that GitHub pauses scheduled workflows in repositories with no
activity for 60 days; the data commits from this workflow count as activity, so it keeps itself
alive while the season is running.

## Caveats

The log and the fixture list come from the league itself, but the page is only as fresh as the last
scheduled run, so it can trail a live broadcast by up to three hours. Press **Refresh now** to
re-read the committed data, or run the workflow manually from the Actions tab to rebuild it.

Results older than the match centre's window fall back to Wikipedia, which is community-maintained
and occasionally a match behind.

## Licence

MIT — see [LICENSE](LICENSE). The league data belongs to its respective sources.
