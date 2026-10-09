/**
 * REST & SSE Streaming Routes
 * Supports both /matches and /events (with /cricket/events)
 * Categorized by tabs: all | live | upcoming | finished
 */

import express from "express";
import {
  getAllMatches,
  getLiveMatches,
  getUpcomingMatches,
  getFinishedMatches,
  getMatchDetail,
  squadFor,
  searchCricket,
} from "../sources/crex.js";
import {
  getSeriesPointsTable,
  getSeriesSquads,
  getSeriesMatches,
  getTeamOverview,
  getTeamMatches,
} from "../sources/crexSeriesTeam.js";
import { findMatch } from "../sources/matchFinder.js";
import { broadcaster } from "../core/broadcaster.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "../../public");

function shouldServeHtml(req) {
  if (req.query.format === "json" || req.query.json === "true") return false;
  if (req.headers["sec-fetch-dest"] === "document") return true;
  if (req.headers.accept && req.headers.accept.includes("text/html") && !req.headers.accept.includes("application/json") && !req.xhr) {
    return true;
  }
  return false;
}

export const router = express.Router();

// Health check
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "LSCORExAPI",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Broadcaster & real-time watcher statistics
router.get("/stats", (req, res) => {
  res.json(broadcaster.getStats());
});

// Shared match list fetcher
async function getMatchesByTab(tabQuery) {
  const tab = (tabQuery || "all").toLowerCase();
  let matches = [];
  if (tab === "live") {
    matches = await getLiveMatches();
  } else if (tab === "upcoming") {
    matches = await getUpcomingMatches();
  } else if (tab === "finished") {
    matches = await getFinishedMatches();
  } else {
    matches = await getAllMatches();
  }
  return { tab, matches };
}

// List all matches / events (Supports ?tab=all|live|upcoming|finished)
const handleListAll = async (req, res) => {
  try {
    const { tab, matches } = await getMatchesByTab(req.query.tab);
    res.json({
      success: true,
      sport: "cricket",
      source: "crex",
      tab,
      count: matches.length,
      events: matches,
      matches,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/matches", handleListAll);
router.get("/events", handleListAll);
router.get("/cricket/events", handleListAll);

// Live matches only
const handleLive = async (req, res) => {
  try {
    const live = await getLiveMatches();
    res.json({
      success: true,
      sport: "cricket",
      source: "crex",
      tab: "live",
      count: live.length,
      events: live,
      matches: live,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/matches/live", handleLive);
router.get("/events/live", handleLive);
router.get("/cricket/events/live", handleLive);

// Upcoming matches only (MUST be before /:id)
const handleUpcoming = async (req, res) => {
  try {
    const upcoming = await getUpcomingMatches();
    res.json({
      success: true,
      sport: "cricket",
      source: "crex",
      tab: "upcoming",
      count: upcoming.length,
      events: upcoming,
      matches: upcoming,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/matches/upcoming", handleUpcoming);
router.get("/events/upcoming", handleUpcoming);
router.get("/cricket/events/upcoming", handleUpcoming);

// Finished matches only (MUST be before /:id)
const handleFinished = async (req, res) => {
  try {
    const finished = await getFinishedMatches();
    res.json({
      success: true,
      sport: "cricket",
      source: "crex",
      tab: "finished",
      count: finished.length,
      events: finished,
      matches: finished,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/matches/finished", handleFinished);
router.get("/events/finished", handleFinished);
router.get("/cricket/events/finished", handleFinished);

// Single match detailed state
const handleMatchDetail = async (req, res) => {
  try {
    const data = await getMatchDetail(req.params.id);
    if (!data) {
      return res.status(404).json({ success: false, error: "Match not found or unavailable" });
    }
    res.json({
      success: true,
      match: data,
      event: data,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/matches/:id", handleMatchDetail);
router.get("/events/:id", handleMatchDetail);

// Squad and Playing XI endpoint
const handleSquad = async (req, res) => {
  try {
    const squad = await squadFor(req.params.id);
    if (!squad) {
      return res.status(404).json({ success: false, error: "Squad not available for this match" });
    }
    res.json({
      success: true,
      squad,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/matches/:id/squad", handleSquad);
router.get("/events/:id/squad", handleSquad);

// Alias for playing-xi
const handlePlayingXI = async (req, res) => {
  try {
    const squad = await squadFor(req.params.id);
    if (!squad) {
      return res.status(404).json({ success: false, error: "Playing XI not available for this match" });
    }
    res.json({
      success: true,
      isXIAnnounced: squad.meta?.isXIAnnounced || false,
      squad,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/matches/:id/playing-xi", handlePlayingXI);
router.get("/events/:id/playing-xi", handlePlayingXI);

// Ball-by-ball commentary
const handleCommentary = async (req, res) => {
  try {
    const data = await getMatchDetail(req.params.id);
    if (!data || !data.rich) {
      return res.status(404).json({ success: false, error: "Commentary not available" });
    }
    res.json({
      success: true,
      matchId: req.params.id,
      recentBalls: data.rich.recentBalls || [],
      lastOvers: data.rich.lastOvers || [],
      wickets: data.rich.wickets || [],
      timeline: data.rich.timeline || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/matches/:id/commentary", handleCommentary);
router.get("/events/:id/commentary", handleCommentary);

// Detailed scorecard
const handleScorecard = async (req, res) => {
  try {
    const data = await getMatchDetail(req.params.id);
    if (!data) {
      return res.status(404).json({ success: false, error: "Scorecard not available" });
    }
    res.json({
      success: true,
      matchId: req.params.id,
      teams: data.teams,
      status: data.status,
      statusText: data.statusText,
      battingTeam: data.rich?.battingTeam || null,
      striker: data.rich?.striker || null,
      nonStriker: data.rich?.nonStriker || null,
      bowler: data.rich?.bowler || null,
      partnership: data.rich?.partnership || null,
      target: data.rich?.target || null,
      crr: data.rich?.crr || null,
      rrr: data.rich?.rrr || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/matches/:id/scorecard", handleScorecard);
router.get("/events/:id/scorecard", handleScorecard);

// Canonical SSE Streaming Route for a specific match
// Optional ?delay=N (seconds, 0-60) puts the client N seconds behind live.
const handleStream = (req, res) => {
  const matchId = req.params.id;
  const rawDelay = parseFloat(req.query.delay);
  const delaySec = Number.isFinite(rawDelay) ? Math.max(0, Math.min(60, rawDelay)) : 0;
  broadcaster.handleClient(req, res, matchId, Math.round(delaySec * 1000));
};

router.get("/matches/:id/stream", handleStream);
router.get("/events/:id/stream", handleStream);

// Search endpoints (Supports ?q=..., ?exp=..., POST body { exp: "..." } or { q: "..." })
const handleSearch = async (req, res) => {
  try {
    const query = req.query.q || req.query.exp || req.body?.exp || req.body?.q || req.body?.query || "";
    if (!query) {
      if (req.path.includes("redisearch")) return res.json([]);
      return res.json({ success: true, query: "", count: 0, results: [] });
    }
    const results = await searchCricket(query);
    if (req.path.includes("redisearch")) {
      return res.json(results);
    }
    res.json({
      success: true,
      query,
      count: results.length,
      results,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/search", handleSearch);
router.post("/search", handleSearch);
router.get("/api/search", handleSearch);
router.post("/api/search", handleSearch);
router.post("/api/search/redisearch", handleSearch);

// ==========================================
// ADVANCED MATCH FINDER
// Give two team names + an optional start time and the API figures
// out which fixture you mean. Tries the search results for both
// teams (top 2 each) in priority order 1x1 -> 1x2 -> 2x1 -> 2x2,
// intersecting their "Team Matches & Tours" and time-matching the
// common fixtures against the supplied start time.
// ==========================================
const handleFindMatch = async (req, res) => {
  try {
    const src = { ...req.query, ...(req.body || {}) };
    const team1 = src.team1 || src.teamA || src.t1 || src.home || src.team;
    const team2 = src.team2 || src.teamB || src.t2 || src.away || src.opponent;
    const startTime = src.startTime || src.start_time || src.time || src.start || src.date;
    const toleranceMs = src.toleranceMs
      ? Number(src.toleranceMs)
      : (src.toleranceMin ? Number(src.toleranceMin) * 60000 : undefined);
    const topN = src.topN ? Number(src.topN) : undefined;

    if (!team1 || !team2) {
      return res.status(400).json({
        success: false,
        error: "Both 'team1' and 'team2' are required",
        usage: "/find-match?team1=India&team2=Australia&startTime=2027-10-07T00:00:00Z",
      });
    }

    const result = await findMatch({ team1, team2, startTime, toleranceMs, topN });
    res.json({ success: true, query: { team1, team2, startTime: startTime || null }, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get("/find-match", handleFindMatch);
router.get("/match-finder", handleFindMatch);
router.post("/find-match", handleFindMatch);
router.get("/api/find-match", handleFindMatch);
router.post("/api/find-match", handleFindMatch);

// ==========================================
// SERIES ROUTES (Points Table, Squads, Matches)
// ==========================================

// 1. Series Points Table
const handlePointsTable = async (req, res) => {
  if (shouldServeHtml(req)) {
    return res.sendFile(path.join(publicDir, "series.html"));
  }
  try {
    const data = await getSeriesPointsTable(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: "Series points table not found" });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get(["/series/:id/points-table", "/series/:id/point-table", "/api/series/:id/points-table", "/api/series/:id/point-table"], handlePointsTable);

// 2. Series Squads
const handleSeriesSquads = async (req, res) => {
  if (shouldServeHtml(req)) {
    return res.sendFile(path.join(publicDir, "series.html"));
  }
  try {
    const data = await getSeriesSquads(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: "Series squads not found" });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get(["/series/:id/team-squad", "/series/:id/squad", "/series/:id/squads", "/api/series/:id/team-squad", "/api/series/:id/squad", "/api/series/:id/squads"], handleSeriesSquads);

// 3. Series Matches
const handleSeriesMatches = async (req, res) => {
  if (shouldServeHtml(req)) {
    return res.sendFile(path.join(publicDir, "series.html"));
  }
  try {
    const data = await getSeriesMatches(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: "Series matches not found" });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get(["/series/:id/matches", "/api/series/:id/matches"], handleSeriesMatches);

// Series Hub Root
router.get(["/series/:id", "/api/series/:id"], async (req, res) => {
  if (shouldServeHtml(req)) {
    return res.sendFile(path.join(publicDir, "series.html"));
  }
  try {
    const data = await getSeriesPointsTable(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: "Series not found" });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// TEAM ROUTES (Overview & Fixtures)
// ==========================================

// 4. Team Matches
const handleTeamMatches = async (req, res) => {
  if (shouldServeHtml(req)) {
    return res.sendFile(path.join(publicDir, "team.html"));
  }
  try {
    const data = await getTeamMatches(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: "Team matches not found" });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get(["/team/:id/matches", "/api/team/:id/matches"], handleTeamMatches);

// 5. Team Overview & Bio
const handleTeamOverview = async (req, res) => {
  if (shouldServeHtml(req)) {
    return res.sendFile(path.join(publicDir, "team.html"));
  }
  try {
    const data = await getTeamOverview(req.params.id);
    if (!data) return res.status(404).json({ success: false, error: "Team not found" });
    res.json({ success: true, team: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

router.get(["/team/:id", "/api/team/:id"], handleTeamOverview);


