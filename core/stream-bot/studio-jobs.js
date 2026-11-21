/*
 * One-off Studio jobs (2026-11-20, Studio 0.2.10): an action the server sends to a streamer's CertiFried Studio once, when it is
 * safe, instead of asking the streamer to press a button. Used for the owner-approved "Let CertiFried manage Sound Alerts and
 * Blerp audio" (obs.alert_audio) and the voice confidence correction (voice.set with onlyIfUnset).
 *
 * Jobs live in the profile's settings JSON under `studioJobs` (at most 20):
 *   { id, actionType, capability, params, minVersion, notLive, status: 'pending'|'done'|'failed', tries, createdAt,
 *     lastTryAt, doneAt, result, error, skipped }
 *
 *   createStudioJobs({ store, hub, isLive, logger?, now?, ackWaitMs?, minGapMs? })
 *     .add(profileId, job)       queue one (same id twice: the second is ignored) → the stored job
 *     .check(profileId)          run the pending jobs that can run now: a connected Studio with the capability and at least
 *                                minVersion, and (notLive) the streamer not live. At most one check per profile at a time, and
 *                                not more often than minGapMs. Three failed tries and a job is marked failed.
 *     .list(profileId)
 *
 * The caller (studio.js onState) runs check() whenever a Studio reports its state, so a queued job runs soon after Studio
 * connects or updates. isLive(profileId) must answer true when unsure: a job never runs while the streamer might be live.
 * Tested in tests/stream-bot-studio-jobs.test.js.
 */
const MAX_JOBS = 20;
const MAX_TRIES = 3;

/** '0.2.10' >= '0.2.9' and so on; anything unreadable is treated as too old. */
export function versionAtLeast(have, want) {
    const a = String(have || '').match(/^(\d+)\.(\d+)\.(\d+)/);
    const b = String(want || '').match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!b) return true;
    if (!a) return false;
    for (let i = 1; i <= 3; i++) {
        if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
    }
    return true;
}

/** The Studio version a connection announced ("certifried-studio 0.2.10" or { app, version }). */
export function studioVersion(conn) {
    const c = conn?.client;
    if (c && typeof c === 'object') return String(c.version || '') || null;
    return String(c || '').match(/^certifried-studio\s+(\S+)/)?.[1] || null;
}

/** isLive for the stream bot: the profile owner's live_announcements row still open (as the server's cf_quiet check). */
export function ownerLiveCheck({ db, store }) {
    return async (profileId) => {
        try {
            const p = await store.getProfile(profileId);
            const owner = p?.ownerDiscordId || p?.owner_discord_id;
            if (!owner) return true;
            const [rows] = await db.query('SELECT COUNT(*) AS n FROM live_announcements WHERE offline_check_count = 0 AND discord_user_id = ?', [String(owner)]);
            return Number(rows?.[0]?.n) !== 0;
        } catch {
            return true;   // unsure: treat as live
        }
    };
}

export function createStudioJobs({ store, hub, isLive, logger = null, now = () => Date.now(), ackWaitMs = 30_000, minGapMs = 60_000 } = {}) {
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[StreamBotStudioJobs] ${m}`, meta); } catch { /* ignore */ } };
    const running = new Set();
    const lastCheck = new Map();

    async function load(profileId) {
        const list = await store.getSettingsKey(profileId, 'studioJobs');
        return Array.isArray(list) ? list : [];
    }
    const save = (profileId, list) => store.setSettingsKey(profileId, 'studioJobs', list.slice(-MAX_JOBS));

    function waitAck(id) {
        return new Promise((resolve) => {
            let off = null;
            const timer = setTimeout(() => { off?.(); resolve({ status: 'timeout', result: null, error: 'Studio did not answer in time' }); }, ackWaitMs);
            timer.unref?.();
            off = hub.onAck(id, (r) => { clearTimeout(timer); resolve(r); });
        });
    }

    async function runOne(profileId, job) {
        const conns = (hub.connected(profileId) || []).filter((c) => c.kind === 'studio').sort((a, b) => new Date(b.connectedAt) - new Date(a.connectedAt));
        const conn = conns.find((c) => (!job.capability || (c.capabilities || []).includes(job.capability)) && versionAtLeast(studioVersion(c), job.minVersion));
        if (!conn) return { ran: false, skipped: conns.length ? 'studio_too_old' : 'studio_offline' };
        if (job.notLive && await isLive(profileId)) return { ran: false, skipped: 'live' };
        const d = await hub.dispatch({ profileId, runId: null, target: 'studio', capability: job.capability || null, actionType: job.actionType, params: job.params || {}, queueSeconds: 0 });
        if (!d || d.status === 'none') return { ran: false, skipped: 'studio_offline' };
        const r = await waitAck(d.id);
        return { ran: true, ok: r.status === 'acked', result: r.result ?? null, error: r.error ?? null };
    }

    return {
        async add(profileId, job) {
            const list = await load(profileId);
            const id = String(job.id || '').slice(0, 60);
            if (!/^[a-z0-9_.:-]{3,60}$/i.test(id)) throw new Error('bad job id');
            const have = list.find((j) => j.id === id);
            if (have) return have;
            const rec = { id, actionType: String(job.actionType), capability: job.capability || null, params: job.params || {}, minVersion: job.minVersion || null,
                notLive: job.notLive !== false, status: 'pending', tries: 0, createdAt: new Date(now()).toISOString(), lastTryAt: null, doneAt: null, result: null, error: null, skipped: null };
            list.push(rec);
            await save(profileId, list);
            return rec;
        },
        async list(profileId) { return load(profileId); },
        async check(profileId) {
            if (running.has(profileId)) return { checked: false };
            const t = now();
            if (t - (lastCheck.get(profileId) || 0) < minGapMs) return { checked: false };
            lastCheck.set(profileId, t);
            running.add(profileId);
            try {
                const list = await load(profileId);
                const pending = list.filter((j) => j.status === 'pending');
                if (!pending.length) return { checked: true, ran: 0 };
                let ran = 0;
                for (const job of pending) {
                    const r = await runOne(profileId, job);
                    if (!r.ran) { job.skipped = r.skipped; continue; }
                    ran += 1;
                    job.tries += 1;
                    job.lastTryAt = new Date(now()).toISOString();
                    job.skipped = null;
                    if (r.ok) { job.status = 'done'; job.doneAt = job.lastTryAt; job.result = r.result; job.error = null; }
                    else { job.error = String(r.error || 'failed').slice(0, 250); if (job.tries >= MAX_TRIES) job.status = 'failed'; }
                    log(r.ok ? 'info' : 'warn', 'studio job', { profileId, id: job.id, status: job.status, error: job.error });
                }
                await save(profileId, list);
                return { checked: true, ran };
            } catch (e) {
                log('warn', 'studio job check failed', { profileId, error: e?.message });
                return { checked: true, error: e?.message };
            } finally { running.delete(profileId); }
        },
    };
}

export default { createStudioJobs, ownerLiveCheck, versionAtLeast, studioVersion };
