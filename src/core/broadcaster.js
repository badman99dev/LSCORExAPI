/**
 * Realtime Match Broadcaster & SSE Engine
 *
 * Architecture:
 * - Single Upstream Poller per Match: No matter how many clients subscribe to
 *   a match (1 or 100), only ONE upstream polling task runs for that match.
 * - Initial Snapshot: On connection, each client receives an immediate `event: snapshot`.
 * - Deep Diffing: Every tick, differences are computed and broadcast via `event: update`.
 * - Zero Timeout / Keep-Alive: Continuous heartbeat pings prevent proxy drops.
 * - Live-Only Streaming: SSE is only kept open for LIVE matches.
 *     * Non-live (upcoming / finished) matches receive the first `snapshot`
 *       and are then closed immediately with an `event: end`.
 *     * If an upstream poll reports the match is no longer live (concluded),
 *       all subscribers get `event: end` and the stream is torn down.
 * - Auto-Teardown: When all subscribers for a match disconnect, upstream polling ceases.
 */

import { diffResponse } from './diff.js';
import { getMatchDetail } from '../sources/crex.js';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 15000);

class MatchBroadcaster {
  constructor() {
    this.clients = new Set();               // Set of all connected SSE client objects
    this.matchSubs = new Map();             // matchId -> Set<client>
    this.watchers = new Map();              // matchId -> { timer, isPolling, lastState, ended }
  }

  /**
   * Handle incoming SSE connection for a specific match
   */
  async handleClient(req, res, matchId) {
    if (!matchId) {
      res.status(400).json({ error: 'matchId is required' });
      return;
    }

    // Disable socket timeouts
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    // Set non-buffering SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    res.write(': connected\n\n');

    const client = {
      id: Math.random().toString(36).slice(2, 9),
      res,
      matchId,
      connectedAt: Date.now(),
      closed: false,
      pingTimer: null,
      send: (event, data) => {
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch (_) {}
      },
      ping: () => {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch (_) {}
      },
    };

    this.clients.add(client);

    // Ping timer to keep connection alive indefinitely
    client.pingTimer = setInterval(() => {
      client.ping();
    }, PING_INTERVAL_MS);

    // Subscribe client to specific match
    if (!this.matchSubs.has(matchId)) {
      this.matchSubs.set(matchId, new Set());
    }
    this.matchSubs.get(matchId).add(client);

    // Clean up on disconnect
    req.on('close', () => {
      this.removeClient(client);
    });

    // Send initial snapshot immediately, then decide whether to keep streaming
    await this.sendInitialSnapshot(client, matchId);
  }

  async sendInitialSnapshot(client, matchId) {
    const watcher = this.watchers.get(matchId);
    let match = watcher ? watcher.lastState : null;
    let cached = Boolean(match);

    if (!match) {
      try {
        match = await getMatchDetail(matchId);
      } catch (_) {
        match = null;
      }
      cached = false;
    }

    if (!match) {
      client.send('snapshot', { error: 'Match data not available yet', matchId });
      this.endClient(client, 'unavailable');
      return;
    }

    client.send('snapshot', { match, cached });

    // Only LIVE matches keep the stream alive. Upcoming / finished matches
    // get their one snapshot and are closed straight away.
    if (match.status === 'live') {
      this.startWatcher(matchId, match);
    } else {
      this.endClient(client, match.status);
    }
  }

  /**
   * Start a single upstream poller for matchId
   */
  startWatcher(matchId, initialState = null) {
    if (this.watchers.has(matchId)) {
      return; // Already being watched by existing worker!
    }

    const watcher = {
      matchId,
      isPolling: false,
      lastState: initialState,
      ended: false,
      timer: null,
    };

    const poll = async () => {
      if (watcher.isPolling || watcher.ended) return;
      watcher.isPolling = true;

      try {
        const fresh = await getMatchDetail(matchId);
        if (!fresh) return;

        // Match concluded upstream -> notify everyone and tear the stream down.
        if (fresh.status !== 'live') {
          watcher.lastState = fresh;
          this.terminateWatcher(matchId, fresh.status);
          return;
        }

        if (!watcher.lastState) {
          watcher.lastState = fresh;
          this.broadcast(matchId, 'snapshot', { match: fresh, cached: false });
        } else {
          const changes = diffResponse(watcher.lastState, fresh);
          if (changes.length > 0) {
            this.broadcast(matchId, 'update', {
              id: matchId,
              timestamp: new Date().toISOString(),
              changes,
              match: fresh,
            });
            watcher.lastState = fresh;
          }
        }
      } catch (e) {
        // Log silently
      } finally {
        watcher.isPolling = false;
      }
    };

    watcher.timer = setInterval(poll, POLL_INTERVAL_MS);
    this.watchers.set(matchId, watcher);

    // Execute first tick immediately
    poll();
  }

  /**
   * Stop upstream poller when subscriber count is 0
   */
  stopWatcher(matchId) {
    const watcher = this.watchers.get(matchId);
    if (watcher) {
      watcher.ended = true;
      clearInterval(watcher.timer);
      this.watchers.delete(matchId);
    }
  }

  /**
   * Notify + close every subscriber of a match (used when it is no longer live).
   */
  terminateWatcher(matchId, reason) {
    const watcher = this.watchers.get(matchId);
    if (watcher) watcher.ended = true;

    this.broadcast(matchId, 'end', { matchId, reason, live: false });

    const subs = this.matchSubs.get(matchId);
    if (subs) {
      for (const client of [...subs]) {
        try { client.res.end(); } catch (_) {}
        this.removeClient(client);
      }
    }
    this.stopWatcher(matchId);
  }

  /**
   * Send `end`, close the response and remove a single client.
   */
  endClient(client, reason) {
    client.send('end', { matchId: client.matchId, reason, live: false });
    try { client.res.end(); } catch (_) {}
    this.removeClient(client);
  }

  /**
   * Remove a client from all bookkeeping (idempotent).
   */
  removeClient(client) {
    if (client.closed) return;
    client.closed = true;
    if (client.pingTimer) clearInterval(client.pingTimer);
    this.clients.delete(client);

    const subs = this.matchSubs.get(client.matchId);
    if (subs) {
      subs.delete(client);
      // If no more clients watching this match, stop upstream poller!
      if (subs.size === 0) {
        this.matchSubs.delete(client.matchId);
        this.stopWatcher(client.matchId);
      }
    }
  }

  /**
   * Broadcast event to subscribers of matchId
   */
  broadcast(matchId, event, payload) {
    const subs = this.matchSubs.get(matchId);
    if (subs) {
      for (const client of subs) {
        client.send(event, payload);
      }
    }
  }

  /**
   * Service stats
   */
  getStats() {
    return {
      connectedClients: this.clients.size,
      activeWatchers: this.watchers.size,
      watchedMatches: [...this.watchers.keys()],
      subscriptions: Object.fromEntries(
        [...this.matchSubs.entries()].map(([k, set]) => [k, set.size])
      ),
      pollIntervalMs: POLL_INTERVAL_MS,
      pingIntervalMs: PING_INTERVAL_MS,
    };
  }
}

export const broadcaster = new MatchBroadcaster();