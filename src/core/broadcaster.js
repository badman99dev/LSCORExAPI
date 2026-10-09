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
 * - Per-Client Delay (DVR): A client may request `?delay=N` (seconds, 0-60).
 *     * delay = 0  -> instant live (unchanged behaviour).
 *     * delay > 0  -> the client is served N seconds behind live. A short
 *       in-memory history ring buffer lets late joiners receive the correct
 *       historical snapshot and then replay each event N seconds later.
 *     * Memory is tiny: at a 2s poll, 30s of history is ~15-30 small entries.
 * - Auto-Teardown: When all subscribers for a match disconnect, upstream polling ceases.
 */

import { diffResponse } from './diff.js';
import { getMatchDetail } from '../sources/crex.js';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 15000);
const DELIVERY_TICK_MS = Number(process.env.DELIVERY_TICK_MS || 500);
const MAX_HISTORY_MS = Number(process.env.MAX_HISTORY_MS || 90000); // keep > max delay
const MAX_HISTORY_ENTRIES = Number(process.env.MAX_HISTORY_ENTRIES || 400);

class MatchBroadcaster {
  constructor() {
    this.clients = new Set();               // Set of all connected SSE client objects
    this.matchSubs = new Map();             // matchId -> Set<client>
    this.watchers = new Map();              // matchId -> { timer, ticker, isPolling, lastState, ended, history, seq }
  }

  /**
   * Handle incoming SSE connection for a specific match.
   * delayMs = 0 means instant live; > 0 means N ms behind live.
   */
  async handleClient(req, res, matchId, delayMs = 0) {
    if (!matchId) {
      res.status(400).json({ error: 'matchId is required' });
      return;
    }

    const delay = Math.max(0, Math.min(60000, Number(delayMs) || 0));

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
      delayMs: delay,
      cursor: 0,
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
      client.send('snapshot', { error: 'Match data not available yet', matchId, delayMs: client.delayMs });
      this.endClient(client, 'unavailable');
      return;
    }

    // For delayed clients, start them at the state as of (now - delay) using the
    // history buffer. Late joiners therefore see the correct historical score.
    if (client.delayMs > 0 && watcher && watcher.history.length) {
      const cutoff = Date.now() - client.delayMs;
      let base = null;
      for (const e of watcher.history) {
        if (e.t <= cutoff) base = e;
        else break; // history is time-ordered
      }
      // Match younger than requested delay -> best effort, start at oldest we have.
      if (!base) base = watcher.history[0];
      if (base && base.payload && base.payload.match) {
        match = base.payload.match;
        client.cursor = base.seq;
      } else {
        client.cursor = watcher.seq;
      }
    } else if (watcher) {
      client.cursor = watcher.seq;
    }

    client.send('snapshot', { match, cached, delayMs: client.delayMs });

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
      ticker: null,
      history: [],
      seq: 0,
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
          this.record(matchId, 'snapshot', { match: fresh, cached: false });
        } else {
          const changes = diffResponse(watcher.lastState, fresh);
          if (changes.length > 0) {
            this.record(matchId, 'update', {
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
    watcher.ticker = setInterval(() => this.flush(matchId), DELIVERY_TICK_MS);
    this.watchers.set(matchId, watcher);

    // Execute first tick immediately
    poll();
  }

  /**
   * Record an event into the match history and deliver it instantly to
   * non-delayed clients. Delayed clients are served later by flush().
   */
  record(matchId, event, payload) {
    const watcher = this.watchers.get(matchId);
    let entry = null;

    if (watcher) {
      entry = { seq: ++watcher.seq, t: Date.now(), event, payload };
      watcher.history.push(entry);
      this.trimHistory(watcher);
    }

    const subs = this.matchSubs.get(matchId);
    if (subs) {
      for (const client of subs) {
        if (client.delayMs > 0) continue; // handled by ticker
        client.send(event, payload);
        if (entry) client.cursor = entry.seq;
      }
    }

    return entry;
  }

  /**
   * Backwards-compatible alias: broadcast == record + instant delivery.
   */
  broadcast(matchId, event, payload) {
    return this.record(matchId, event, payload);
  }

  /**
   * Delivery ticker: replay due history entries to each delayed client.
   */
  flush(matchId) {
    const watcher = this.watchers.get(matchId);
    if (!watcher) return;

    const subs = this.matchSubs.get(matchId);
    if (!subs || subs.size === 0) {
      this.stopWatcher(matchId);
      return;
    }

    const now = Date.now();

    for (const client of subs) {
      if (client.delayMs <= 0) continue;
      const due = watcher.history
        .filter((e) => e.seq > client.cursor && now >= e.t + client.delayMs)
        .sort((a, b) => a.seq - b.seq);

      for (const e of due) {
        client.send(e.event, e.payload);
        client.cursor = e.seq;
        if (e.event === 'end') {
          try { client.res.end(); } catch (_) {}
          this.removeClient(client);
        }
      }
    }

    // Watcher concluded: stop once all delayed clients have drained.
    if (watcher.ended) {
      const remaining = this.matchSubs.get(matchId);
      const stillPending = remaining && [...remaining].some((c) => c.delayMs > 0);
      if (!stillPending) this.stopWatcher(matchId);
    }
  }

  /**
   * Trim the history ring buffer (time + count caps).
   */
  trimHistory(watcher) {
    const cutoff = Date.now() - MAX_HISTORY_MS;
    while (watcher.history.length && watcher.history[0].t < cutoff) {
      watcher.history.shift();
    }
    while (watcher.history.length > MAX_HISTORY_ENTRIES) {
      watcher.history.shift();
    }
  }

  /**
   * Stop upstream poller (and ticker) for a match
   */
  stopWatcher(matchId) {
    const watcher = this.watchers.get(matchId);
    if (watcher) {
      watcher.ended = true;
      if (watcher.timer) clearInterval(watcher.timer);
      if (watcher.ticker) clearInterval(watcher.ticker);
      this.watchers.delete(matchId);
    }
  }

  /**
   * Notify + close every subscriber of a match (used when it is no longer live).
   * Non-delayed clients close immediately; delayed clients receive the `end`
   * event after their delay and are closed by the delivery ticker.
   */
  terminateWatcher(matchId, reason) {
    const watcher = this.watchers.get(matchId);
    if (watcher) {
      watcher.ended = true;
      if (watcher.timer) clearInterval(watcher.timer);
      watcher.timer = null;
    }

    // Record so delayed clients eventually get the terminal event too.
    this.record(matchId, 'end', { matchId, reason, live: false });

    const subs = this.matchSubs.get(matchId);
    if (!subs) {
      this.stopWatcher(matchId);
      return;
    }

    for (const client of [...subs]) {
      if (client.delayMs > 0) continue; // ticker handles drain + close
      try { client.res.end(); } catch (_) {}
      this.removeClient(client);
    }

    const stillPending = this.matchSubs.get(matchId);
    if (!stillPending || ![...stillPending].some((c) => c.delayMs > 0)) {
      this.stopWatcher(matchId);
    }
  }

  /**
   * Send `end`, close the response and remove a single client.
   */
  endClient(client, reason) {
    client.send('end', { matchId: client.matchId, reason, live: false, delayMs: client.delayMs });
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
      deliveryTickMs: DELIVERY_TICK_MS,
    };
  }
}

export const broadcaster = new MatchBroadcaster();