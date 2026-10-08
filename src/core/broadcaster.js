/**
 * Realtime Match Broadcaster & SSE Engine
 *
 * Architecture:
 * - Single Upstream Poller per Match: No matter how many clients subscribe to
 *   a match (1 or 100), only ONE upstream polling task runs for that match.
 * - Initial Snapshot: On connection, each client receives an immediate `event: snapshot`.
 * - Deep Diffing: Every tick, differences are computed and broadcast via `event: update`.
 * - Zero Timeout / Keep-Alive: Continuous heartbeat pings prevent proxy drops.
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
    this.watchers = new Map();              // matchId -> { timer, isPolling, lastState }
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
    const pingTimer = setInterval(() => {
      client.ping();
    }, PING_INTERVAL_MS);

    // Subscribe client to specific match
    if (!this.matchSubs.has(matchId)) {
      this.matchSubs.set(matchId, new Set());
    }
    this.matchSubs.get(matchId).add(client);

    // Start single upstream watcher for this match if not already running
    this.startWatcher(matchId);

    // Send initial snapshot immediately
    this.sendInitialSnapshot(client, matchId);

    // Clean up on disconnect
    req.on('close', () => {
      clearInterval(pingTimer);
      this.clients.delete(client);

      const subs = this.matchSubs.get(matchId);
      if (subs) {
        subs.delete(client);
        // If no more clients watching this match, stop upstream poller!
        if (subs.size === 0) {
          this.matchSubs.delete(matchId);
          this.stopWatcher(matchId);
        }
      }
    });
  }

  async sendInitialSnapshot(client, matchId) {
    const watcher = this.watchers.get(matchId);
    if (watcher && watcher.lastState) {
      client.send('snapshot', { match: watcher.lastState, cached: true });
      return;
    }

    try {
      const data = await getMatchDetail(matchId);
      if (data) {
        if (watcher) watcher.lastState = data;
        client.send('snapshot', { match: data, cached: false });
      } else {
        client.send('snapshot', { error: 'Match data not available yet', matchId });
      }
    } catch (err) {
      client.send('snapshot', { error: err.message, matchId });
    }
  }

  /**
   * Start a single upstream poller for matchId
   */
  startWatcher(matchId) {
    if (this.watchers.has(matchId)) {
      return; // Already being watched by existing worker!
    }

    const watcher = {
      matchId,
      isPolling: false,
      lastState: null,
      timer: null,
    };

    const poll = async () => {
      if (watcher.isPolling) return;
      watcher.isPolling = true;

      try {
        const fresh = await getMatchDetail(matchId);
        if (fresh) {
          if (!watcher.lastState) {
            watcher.lastState = fresh;
            this.broadcast(matchId, 'snapshot', { match: fresh });
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
      clearInterval(watcher.timer);
      this.watchers.delete(matchId);
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
