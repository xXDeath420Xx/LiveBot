/*
 * Stream bot: OBS dock keys (design §5.10). CertiFried Studio asks for a key over the realtime channel (request method
 * `docks.key`) and puts the three dock URLs into OBS's custom browser docks.
 *
 * A dock key is a device row of kind 'dock' (so it shows on the Devices page and Revoke works as for any device):
 *   key       'sbk_' + 16 random bytes (base64url, 22 chars); only its SHA-256 is stored; shown once
 *   scope     the dock pages and their two APIs only: read the live feed, list automations and counters, run an
 *             automation. It never works for the realtime channel (hello accepts 'sbd_' tokens only) or the device
 *             sound download.
 *   linked    capabilities ['dock', 'of:<studio device id>']: asking again from the same Studio revokes the previous key
 *   chat      the optional capabilities 'chat' (send chat, delete, timeout, ban) and 'channel' (title and category) are never
 *             put on a new key: the owner switches them on per key on the Devices page (dashboard/routes/stream-bot-live.js)
 *
 *   newDockKey(), isDockKey(s)
 *   dockUrls(publicUrl, key)              → { activity, controls, chat }
 *   createDockKeys({ store, publicUrl })
 *     issue(profileId, studioDevice)      → { key, deviceId, urls }   (revokes the earlier key of that Studio)
 *     resolve(key)                        → { device, profile } | null (unknown, revoked, or the profile is off)
 *   trackDockStream(deviceId, close) → untrack()     open SSE streams per dock key (at most MAX_STREAMS; oldest closed)
 *   closeDockStreams(deviceId)            Revoke closes them at once
 *
 * Tested in tests/stream-bot-dock.test.js.
 */
import crypto from 'node:crypto';
import { hashSecret, tokenHint } from './pairing.js';

export const DOCK_PREFIX = 'sbk_';
const DOCK_RE = /^sbk_[A-Za-z0-9_-]{22}$/;
export const MAX_STREAMS = 3;
export const DOCK_CHAT = 'chat';
export const DOCK_CHANNEL = 'channel';

export const newDockKey = () => DOCK_PREFIX + crypto.randomBytes(16).toString('base64url');
export const isDockKey = (s) => typeof s === 'string' && DOCK_RE.test(s);

export function dockUrls(publicUrl, key) {
    const base = String(publicUrl || 'https://certifriedmultitool.com').replace(/\/+$/, '');
    const q = `?key=${encodeURIComponent(key)}`;
    return { activity: `${base}/stream/bot/dock/activity${q}`, controls: `${base}/stream/bot/dock/controls${q}`, chat: `${base}/stream/bot/dock/chat${q}` };
}

export function createDockKeys({ store, publicUrl = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '') } = {}) {
    return {
        async issue(profileId, studio) {
            const studioId = Number(studio?.id);
            if (!Number.isInteger(studioId) || studioId <= 0) throw new Error('a Studio device is required');
            const mark = `of:${studioId}`;
            const existing = (await store.listDevices(profileId)).filter((d) => d.kind === 'dock' && !d.revokedAt && Array.isArray(d.capabilities) && d.capabilities.includes(mark));
            for (const d of existing) {
                await store.revokeDevice(profileId, d.id);
                closeDockStreams(d.id);
            }
            const key = newDockKey();
            const name = `OBS docks (${String(studio.name || 'CertiFried Studio').slice(0, 80)})`;
            const deviceId = await store.createDevice(profileId, { kind: 'dock', name, tokenHash: hashSecret(key), tokenHint: tokenHint(key), capabilities: ['dock', mark] });
            return { key, deviceId, urls: dockUrls(publicUrl, key), replaced: existing.length };
        },
        async resolve(key) {
            if (!isDockKey(key)) return null;
            const device = await store.deviceByTokenHash(hashSecret(key));
            if (!device || device.kind !== 'dock') return null;
            const profile = await store.getProfile(device.profileId);
            if (!profile || !profile.enabled) return null;
            return { device, profile };
        },
    };
}

// ── open SSE streams per dock key ───────────────────────────────────────────────────────────

const streams = new Map();   // deviceId -> Set<close fn>

export function trackDockStream(deviceId, close) {
    const id = Number(deviceId);
    if (!streams.has(id)) streams.set(id, new Set());
    const set = streams.get(id);
    while (set.size >= MAX_STREAMS) {
        const oldest = set.values().next().value;
        set.delete(oldest);
        try { oldest(); } catch { /* already gone */ }
    }
    set.add(close);
    return () => {
        set.delete(close);
        if (!set.size) streams.delete(id);
    };
}

export function closeDockStreams(deviceId) {
    const set = streams.get(Number(deviceId));
    if (!set) return 0;
    streams.delete(Number(deviceId));
    let n = 0;
    for (const close of set) { try { close(); n++; } catch { /* ignore */ } }
    return n;
}

export const openDockStreams = (deviceId) => streams.get(Number(deviceId))?.size || 0;

export default { newDockKey, isDockKey, dockUrls, createDockKeys, trackDockStream, closeDockStreams, openDockStreams, DOCK_PREFIX, MAX_STREAMS };
