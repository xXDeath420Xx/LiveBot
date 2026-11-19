/**
 * Short-lived cache that correlates `guildAuditLogEntryCreate` events with the
 * matching gateway events (channel/role/ban/kick). Discord emits both for a
 * single admin action, but ordering is not guaranteed; usually the audit entry
 * comes first by a handful of milliseconds.
 *
 * Pre-2026, every destructive handler would `guild.fetchAuditLogs()` to find
 * out who did it — a REST call that costs rate-limit budget. With this
 * correlator, the audit-log entry handler puts the entry in a map keyed by
 * (guildId, action, targetId); the gateway handler reads the entry back
 * instead of hitting REST. If the gateway event races in first, a brief wait
 * gives the audit entry time to arrive before we fall through.
 *
 * Entries age out at ENTRY_TTL_MS to bound memory.
 */

const ENTRY_TTL_MS = 30_000;   // live cache lifetime
const WAIT_TIMEOUT_MS = 2000;  // how long gateway handlers wait for the entry to arrive
const WAIT_POLL_MS = 50;       // granularity of the wait loop

/** key -> { entry, expiresAt } */
const cache = new Map();
/** key -> array of resolver callbacks waiting for an entry */
const waiters = new Map();

function keyOf(guildId, action, targetId) {
  return `${guildId}:${action}:${targetId || ''}`;
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
}

/**
 * Store an audit-log entry so a near-future gateway event can find it.
 * Called from events/guildAuditLogEntryCreate.js for every entry we care about.
 */
export function recordEntry(guild, entry) {
  if (!guild?.id || entry?.action == null) return;
  const targetId = entry.target?.id ?? entry.targetId ?? '';
  const k = keyOf(guild.id, entry.action, targetId);
  cache.set(k, { entry, expiresAt: Date.now() + ENTRY_TTL_MS });

  // Wake anyone waiting on this (action, target) tuple.
  const ws = waiters.get(k);
  if (ws) {
    waiters.delete(k);
    for (const resolve of ws) resolve(entry);
  }

  // Opportunistic sweep so the map doesn't grow unbounded on quiet servers.
  if (cache.size > 500) sweep();
}

/** Immediate (non-blocking) lookup — returns the cached entry or null. */
export function peekEntry(guildId, action, targetId) {
  if (!guildId || action == null) return null;
  const k = keyOf(guildId, action, targetId);
  const v = cache.get(k);
  if (!v) return null;
  if (v.expiresAt <= Date.now()) { cache.delete(k); return null; }
  return v.entry;
}

/**
 * Wait up to `timeoutMs` for the audit-log entry matching (action, target) to arrive.
 * Resolves to the entry, or null on timeout.
 */
export function waitForEntry(guildId, action, targetId, timeoutMs = WAIT_TIMEOUT_MS) {
  const hit = peekEntry(guildId, action, targetId);
  if (hit) return Promise.resolve(hit);

  const k = keyOf(guildId, action, targetId);
  return new Promise(resolve => {
    const t = setTimeout(() => {
      // Remove our resolver before timing out.
      const ws = waiters.get(k);
      if (ws) {
        const idx = ws.indexOf(resolve);
        if (idx >= 0) ws.splice(idx, 1);
        if (!ws.length) waiters.delete(k);
      }
      resolve(null);
    }, timeoutMs);

    // Wrap the resolver so timeout and arrival both clear the pending timer.
    const wrapped = entry => { clearTimeout(t); resolve(entry); };
    const ws = waiters.get(k);
    if (ws) ws.push(wrapped); else waiters.set(k, [wrapped]);
  });
}

/** Diagnostics; used only in tests. */
export function _dumpCache() {
  sweep();
  return { entries: cache.size, waiters: waiters.size };
}

/** Explicit reset for tests. */
export function _reset() {
  cache.clear();
  waiters.clear();
}
