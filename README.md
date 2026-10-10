# ⚡ LSCORExAPI

High-performance, RESTful and Server-Sent Events (SSE) Live Cricket & Sports Score API backed by live reverse-engineered CREX feeds.

Deployable on **Render** (via `render.yaml`), VPS, Docker, or any Node.js environment.

---

## 🚀 Key Features

- ⚡ **Zero-Polling SSE Streaming**: Client receives an instant `event: snapshot` on connect, followed by real-time `event: update` deltas computed with a deep object-diff engine.
- 🎯 **Single Upstream Broadcaster (Smart Fan-Out)**: Even if 100 clients watch the same match, only **ONE** background worker requests data from the upstream provider. Zero duplicate queries, zero IP throttling.
- ♾️ **No Timeouts / Continuous Connection**: Periodic keep-alive heartbeat pings prevent proxies, firewalls, and browsers from terminating the stream.
- 👕 **Official Team Jerseys & Player Headshots**: Live batsman & bowler widgets and squad views include HD headshot photos (`cricketvectors.akamaized.net/players/org/...`) and official team jerseys (Limited overs & Test formats).
- 📋 **Playing XI & Full Squad**: Full team lineups with roles (Batter, Bowler, All-Rounder, Wicket Keeper), Captain `(C)` and Keeper `(WK)` indicators.
- 🏏 **Rich Match Metadata**: Current Run Rate (CRR), Required Run Rate (RRR), Target, Partnership, ball-by-ball commentary feeds, shot types, wagons, and fall of wickets.

---

## 🛠️ Endpoints

| Method | Route | Description |
|---|---|---|
| `SSE` | `/matches/:id/stream` | Canonical infinite SSE stream for a match. Streams initial snapshot then live diffs on every ball. |
| `GET` | `/matches` | List all active and recent matches with live scores, series, and team logos. |
| `GET` | `/matches/live` | Filtered list of currently live matches. |
| `GET` | `/matches/:id` | Detailed match state, current striker & bowler with headshot photos and jerseys. |
| `GET` | `/matches/:id/squad` | Both teams' Playing XI and full squad with player photos and jerseys. |
| `GET` | `/matches/:id/playing-xi` | Playing XI alias with announcement status. |
| `GET` | `/matches/:id/commentary` | Ball-by-ball commentary, shot types, wagons, and fall of wickets. |
| `GET` | `/matches/:id/scorecard` | Structured scorecard breakdown for both innings. |
| `GET`/`POST` | `/search?q=:query` | Search teams, series, and players by name. |
| `GET` | `/series/:id/points-table` | Series points table & standings. |
| `GET` | `/series/:id/team-squad` | Series squads with player photos & roles. |
| `GET` | `/series/:id/matches` | All fixtures in a series with scores & venues. |
| `GET` | `/team/:id` | Team overview, ranking, trophies, recent form & bio. |
| `GET` | `/team/:id/matches` | All international & domestic fixtures for a team. |
| `GET`/`POST` | `/find-match` | **Advanced finder** — give two team names + optional start time, returns the exact fixture. |
| `GET` | `/stats` | Broadcaster metrics: active SSE clients, watched matches, worker pool. |
| `GET` | `/health` | Server uptime and health status. |
| `GET` | `/docs` | Interactive Swagger-style documentation & real-time SSE stream tester. |
| `GET` | `/documentation/api` | Full static API reference: every endpoint, param, and response shape. |

---

## 🔎 Advanced Match Finder

Find a fixture two ways — by **two team names** or by a **series name** — always with a
**required** start time.

**Mode A — by teams** (`team1` + `team2` + `startTime`):
1. Searches each team name → takes the top **2** Team results for both teams.
2. For every ordered combo — `1x1 → 1x2 → 2x1 → 2x2` — fetches both teams'
   *Team Matches & Tours* and intersects them by match id.
3. Inside each combo, picks the common fixture whose start time is closest to the
   supplied start time (exact → within tolerance → same UTC day). `1x1` (top × top)
   has the highest priority; the first combo that yields a time match wins.

**Mode B — by series** (`series` + `startTime`):
1. Searches the series name (Series *and* Other tour entities).
2. Prioritises editions whose year matches `startTime`, then probes their fixtures.
3. Returns the series match closest to `startTime`. Optional `team1`/`team2` filter within the series.

**Fallback:** if **no** fixture falls inside the time tolerance, the **closest available fixture**
is returned as a best-effort fallback, flagged with `timeMatch: false` and
`timeMatchType: "closest"`.

**Series-mode cache (1 day):** series searches and their fixture lists are cached for
**24 hours**, so repeated lookups are near-instant. Inspect or clear it with
`GET /find-match/cache` and `POST /find-match/cache/clear`.

```bash
# Team mode — startTime as epoch milliseconds since 1970 (required)
GET /find-match?team1=India&team2=Australia&startTime=1822896000000

# Team mode — startTime as a datetime string (YYYY/MM/DD HH:mm:ss +ZZZZ)
GET /find-match?team1=India&team2=Australia&startTime=2026/10/09%2013:30:14%20%2B0000

# Series mode
GET /find-match?series=World%20Cup%202027&startTime=2027/10/07%2008:00:00%20%2B0000

# Series mode + team filter
GET /find-match?series=Australia%20tour%20of%20South%20Africa%202026&team1=Australia&startTime=2026/10/20%2008:00:00%20%2B0000

# POST body
POST /find-match  { "series": "World Cup 2027", "startTime": "2027/10/07 08:00:00 +0000" }
```

**Optional query params:** `toleranceMs` (default `10800000` = 3h) or `toleranceMin`,
`topN` (default `2`, team mode). Response includes `matched`, `mode` (`series` when
used), `timeMatch` / `timeMatchType` (`exact` · `within-tolerance` · `same-day` ·
`closest` · `none`), `strategy` (team mode), `series` (series mode), `match`,
`candidates`, and a full `attempts` trace (team mode). Missing or invalid
`startTime`, or neither a series nor both teams, returns `400`.

---

## 📡 SSE Stream Usage (Client-side)

```javascript
// Connect to a specific match live stream
const matchId = "1272"; // Match ID from /matches
const es = new EventSource(`https://your-api.onrender.com/matches/${matchId}/stream`);

// 1. Initial snapshot of match
es.addEventListener('snapshot', (e) => {
  const { match } = JSON.parse(e.data);
  console.log("Initial match state:", match);
});

// 2. Real-time ball-by-ball delta updates
es.addEventListener('update', (e) => {
  const { id, changes, match } = JSON.parse(e.data);
  console.log("Changes:", changes);
  // Example change: [{ path: "rich.striker.runs", from: 48, to: 52 }]
});

// 3. Heartbeat keepalive (handled automatically by EventSource)
es.onerror = (err) => {
  console.error("SSE connection error, retrying...", err);
};
```

---

## ☁️ Deploy to Render

This repository includes a production-ready `render.yaml` configuration.

1. Fork or push this repository to your GitHub account (`badman99dev/LSCORExAPI`).
2. Go to [Render Dashboard](https://dashboard.render.com).
3. Click **New +** > **Blueprint**.
4. Select your `LSCORExAPI` repository.
5. Click **Apply** to deploy!

---

## 💻 Local Quickstart

```bash
# Clone the repository
git clone https://github.com/badman99dev/LSCORExAPI.git
cd LSCORExAPI

# Install dependencies
npm install

# Start development server with auto-reload
npm run dev
```

Visit `http://localhost:3000/docs` in your browser to launch the live testing console.

---

## 📝 License
For personal and research purposes only.
