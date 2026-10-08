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
} from "../sources/crex.js";
import { broadcaster } from "../core/broadcaster.js";

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
const handleStream = (req, res) => {
  const matchId = req.params.id;
  broadcaster.handleClient(req, res, matchId);
};

router.get("/matches/:id/stream", handleStream);
router.get("/events/:id/stream", handleStream);
