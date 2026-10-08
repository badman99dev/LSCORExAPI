/**
 * REST & SSE Streaming Routes
 */

import express from 'express';
import { getLiveMatches, getMatchDetail, squadFor } from '../sources/crex.js';
import { broadcaster } from '../core/broadcaster.js';

export const router = express.Router();

// Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'LSCORExAPI',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Broadcaster & real-time watcher statistics
router.get('/stats', (req, res) => {
  res.json(broadcaster.getStats());
});

// List all matches
router.get('/matches', async (req, res) => {
  try {
    const list = await getLiveMatches();
    const statusFilter = req.query.status;
    const filtered = statusFilter ? list.filter((m) => m.status === statusFilter) : list;

    res.json({
      success: true,
      count: filtered.length,
      matches: filtered,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Live matches only
router.get('/matches/live', async (req, res) => {
  try {
    const list = await getLiveMatches();
    const live = list.filter((m) => m.status === 'live');
    res.json({
      success: true,
      count: live.length,
      matches: live,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single match detailed state (including active batsman headshots, bowler headshot, jerseys)
router.get('/matches/:id', async (req, res) => {
  try {
    const data = await getMatchDetail(req.params.id);
    if (!data) {
      return res.status(404).json({ success: false, error: 'Match not found or unavailable' });
    }
    res.json({
      success: true,
      match: data,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Squad and Playing XI endpoint (Names, roles, C/WK tags, Player Headshots, Team Jerseys)
router.get('/matches/:id/squad', async (req, res) => {
  try {
    const squad = await squadFor(req.params.id);
    if (!squad) {
      return res.status(404).json({ success: false, error: 'Squad not available for this match' });
    }
    res.json({
      success: true,
      squad,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Alias for playing-xi
router.get('/matches/:id/playing-xi', async (req, res) => {
  try {
    const squad = await squadFor(req.params.id);
    if (!squad) {
      return res.status(404).json({ success: false, error: 'Playing XI not available for this match' });
    }
    res.json({
      success: true,
      isXIAnnounced: squad.meta?.isXIAnnounced || false,
      squad,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ball-by-ball commentary and timeline
router.get('/matches/:id/commentary', async (req, res) => {
  try {
    const data = await getMatchDetail(req.params.id);
    if (!data || !data.rich) {
      return res.status(404).json({ success: false, error: 'Commentary not available' });
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
});

// Detailed scorecard breakdown
router.get('/matches/:id/scorecard', async (req, res) => {
  try {
    const data = await getMatchDetail(req.params.id);
    if (!data) {
      return res.status(404).json({ success: false, error: 'Scorecard not available' });
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
});

// Canonical SSE Streaming Route for a specific match
router.get('/matches/:id/stream', (req, res) => {
  const matchId = req.params.id;
  broadcaster.handleClient(req, res, matchId);
});
