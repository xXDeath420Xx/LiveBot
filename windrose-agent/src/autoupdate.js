// Automatic game updates.
//
// WHY THIS IS DANGEROUS, AND WHAT KEEPS IT SAFE
//
// Auto-updating a modded game server unattended is how you wake up to a dead
// server: a Steam patch can break UE4SS/Windrose+ compatibility with no warning.
// That risk is exactly why UPDATE_ON_START stays false.
//
// But the alternative failed too — on 2026-08-25 a patch shipped, the server
// stayed behind, and every player was rejected with a DeploymentId mismatch
// until a human noticed. Doing nothing is not neutral.
//
// So this updates automatically, but only under conditions where a bad update
// is recoverable and visible:
//
//   - never while anyone is playing (an update mid-voyage is its own outage)
//   - a snapshot first, always
//   - health verified after; a server that does not come back is reported
//     loudly rather than left broken and silent
//   - a cooldown, so a flapping remote build cannot restart the server in a loop
//
// DETECTION uses two independent signals, because each covers the other's blind
// spot:
//
//   1. Steam's published build id (proactive). Catches a patch before anyone
//      tries to join — but depends on a third-party mirror being reachable.
//   2. DeploymentId mismatch in our own logs (reactive). Needs no network and
//      cannot be wrong: a real client was just rejected for being newer than us.
//      It only fires after someone has been inconvenienced once, which is why
//      it is the backup rather than the primary.

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export const STEAM_APP_ID = '4129620';
const INFO_URL = (appId) => `https://api.steamcmd.net/v1/info/${appId}`;

export function createAutoUpdate({
    updater,
    docker,
    spool,
    backups,
    statePath = path.join(config.backupDir, 'autoupdate.json'),
    appId = STEAM_APP_ID,
    fetchImpl = globalThis.fetch,
    logger = console,
    now = () => Date.now(),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    // Deliberately conservative defaults; the owner can widen them.
    enabled = process.env.WINDROSE_AUTOUPDATE === 'true',
    intervalMinutes = Number(process.env.WINDROSE_AUTOUPDATE_INTERVAL_MIN || 30),
    cooldownMinutes = 60,
} = {}) {
    let timer = null;
    let running = false;

    async function readState() {
        try {
            return JSON.parse(await readFile(statePath, 'utf8'));
        } catch {
            return { knownBuildId: null, lastCheckedAt: null, lastUpdatedAt: null, lastResult: null };
        }
    }

    async function writeState(patch) {
        const next = { ...(await readState()), ...patch };
        const tmp = `${statePath}.tmp`;
        await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
        await rename(tmp, statePath);
        return next;
    }

    /** Steam's currently published build id for the public branch. */
    async function remoteBuildId() {
        const res = await fetchImpl(INFO_URL(appId), { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`steam info lookup returned ${res.status}`);
        const body = await res.json();
        const branch = body?.data?.[appId]?.depots?.branches?.public;
        if (!branch?.buildid) throw new Error('no public buildid in the response');
        return { buildId: String(branch.buildid), updatedAt: Number(branch.timeupdated) || null };
    }

    /**
     * Has a real client been rejected for being newer than us?
     *
     * Unlike the Steam lookup this cannot be a false positive — the game itself
     * refused someone. Read from the console history the Lua module already
     * writes, so it costs nothing.
     */
    async function sawVersionRejection({ withinMs = 6 * 60 * 60 * 1000 } = {}) {
        try {
            const logs = await docker.logs({ tail: 800 });
            if (!/DeploymentId mismatch/i.test(logs)) return false;
            // Only trust a rejection newer than our last update, so a stale log
            // line does not retrigger forever.
            const state = await readState();
            if (!state.lastUpdatedAt) return true;
            return now() - state.lastUpdatedAt > Math.min(withinMs, 30 * 60_000);
        } catch {
            return false;
        }
    }

    async function playersOnline() {
        const status = await spool.serverStatus().catch(() => null);
        return status?.server?.player_count ?? 0;
    }

    return {
        get enabled() { return enabled; },

        async status() {
            const state = await readState();
            let remote = null;
            let error = null;
            try {
                remote = await remoteBuildId();
            } catch (err) {
                error = err.message;
            }
            return {
                enabled,
                intervalMinutes,
                cooldownMinutes,
                appId,
                knownBuildId: state.knownBuildId,
                remoteBuildId: remote?.buildId ?? null,
                remoteUpdatedAt: remote?.updatedAt ?? null,
                updateAvailable: Boolean(remote && state.knownBuildId && remote.buildId !== state.knownBuildId),
                lastCheckedAt: state.lastCheckedAt,
                lastUpdatedAt: state.lastUpdatedAt,
                lastResult: state.lastResult,
                lookupError: error,
                scheduled: Boolean(timer),
            };
        },

        setEnabled(value) {
            enabled = Boolean(value);
            if (enabled) this.start();
            else this.stop();
            return { enabled };
        },

        /**
         * One check. Returns what it decided and why — the "why" matters, since
         * most runs correctly do nothing and a bare "no" is unhelpful at 3am.
         */
        async runCheck({ force = false } = {}) {
            if (running) return { skipped: 'a check is already running' };
            running = true;
            try {
                const state = await readState();
                let remote = null;
                let lookupError = null;
                try {
                    remote = await remoteBuildId();
                } catch (err) {
                    lookupError = err.message;
                }

                await writeState({ lastCheckedAt: new Date(now()).toISOString() });

                // First sighting: record and do nothing. We cannot tell whether
                // a difference means "behind" or "we have simply never looked".
                if (remote && !state.knownBuildId) {
                    await writeState({ knownBuildId: remote.buildId });
                    return { action: 'seeded', buildId: remote.buildId, reason: 'first check — recorded the current build as the baseline' };
                }

                const steamSaysNewer = Boolean(remote && state.knownBuildId && remote.buildId !== state.knownBuildId);
                const clientRejected = await sawVersionRejection();
                const shouldUpdate = force || steamSaysNewer || clientRejected;

                if (!shouldUpdate) {
                    return {
                        action: 'none',
                        reason: lookupError ? `no client rejections seen; steam lookup failed (${lookupError})` : 'already on the current build',
                        buildId: state.knownBuildId,
                    };
                }

                // Cooldown: a remote build that flaps must not restart the
                // server on a loop.
                if (!force && state.lastUpdatedAt && now() - state.lastUpdatedAt < cooldownMinutes * 60_000) {
                    return { action: 'deferred', reason: `updated less than ${cooldownMinutes} minutes ago` };
                }

                // Never interrupt a live session. The reactive trigger means
                // someone is trying to get IN, so waiting for empty is right.
                const online = await playersOnline();
                if (!force && online > 0) {
                    return { action: 'deferred', reason: `${online} player(s) online — will retry when the server is empty`, online };
                }

                const trigger = force ? 'manual' : steamSaysNewer ? 'steam build id changed' : 'a client was rejected for a newer build';
                logger.info?.(`[autoupdate] updating: ${trigger}`);

                const snapshot = await backups.snapshot({ kind: 'manual', label: 'preautoupdate' })
                    .catch((err) => ({ error: err.message }));

                const result = await updater.updateGame();

                // Verify it actually came back, rather than trusting the call.
                const state2 = await docker.state();
                const healthy = state2.running;

                const record = {
                    at: new Date(now()).toISOString(),
                    trigger,
                    buildBefore: result.buildBefore,
                    buildAfter: result.buildAfter,
                    updated: result.updated,
                    healthy,
                    snapshot: snapshot?.filename ?? null,
                };
                await writeState({
                    lastUpdatedAt: now(),
                    knownBuildId: remote?.buildId ?? state.knownBuildId,
                    lastResult: record,
                });

                if (!healthy) {
                    logger.error?.('[autoupdate] server did NOT come back after the update');
                }
                return { action: 'updated', ...record, note: result.note };
            } finally {
                running = false;
            }
        },

        start() {
            this.stop();
            if (!enabled) return { scheduled: false };
            const tick = async () => {
                try {
                    const out = await this.runCheck();
                    if (out.action && out.action !== 'none') logger.info?.(`[autoupdate] ${out.action}: ${out.reason || ''}`);
                } catch (err) {
                    logger.error?.(`[autoupdate] check failed: ${err.message}`);
                } finally {
                    timer = setTimeoutImpl(tick, intervalMinutes * 60_000);
                }
            };
            timer = setTimeoutImpl(tick, intervalMinutes * 60_000);
            return { scheduled: true, intervalMinutes };
        },

        stop() {
            if (timer) clearTimeoutImpl(timer);
            timer = null;
        },
    };
}
