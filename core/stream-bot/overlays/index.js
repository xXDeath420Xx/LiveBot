/*
 * Stream bot overlays and alerts (Phase 3; docs/superpowers/specs/2026-11-19-stream-bot-design.md §9; migration 459).
 * Module map:
 *
 *   config.js    overlay types, alert kinds, settings and their validation, goal counting (pure)
 *   store.js     stream_bot_overlays and stream_bot_overlay_media
 *   media.js     the image and video library (files outside git)
 *   service.js   the live side: SSE pages, alerts, chat, event list, goals, counters, now playing, overlay actions
 *   chat.js      Twitch / Kick chat notifications → chat lines and removals (pure)
 *   images.js    chat emotes and badges served from this server
 *   actions.js   Show text on stream, Show an image or video on stream, Change a goal
 *   http.js      the overlay key and the SSE helper
 *   privacy.js   /privacy export and delete
 *
 *   attachOverlays(box, { onRequest }) → { service, ostore, media, images }
 *     Called once from core/stream-bot/index.js build(). It only wraps what is already there, so nothing else changes
 *     when overlays fail to load:
 *       hub.dispatch / hub.hasDevice   target 'overlay' goes to the overlay service (the engine's client-action path:
 *                                      templates rendered, dry run, "Needs an overlay", queueing, the dispatch row)
 *       feed.publish                   every published event also reaches the overlays (alerts, lists, goals, counters)
 *       ingest.twitch / ingest.kick    chat with badges and emotes, and deletions and bans, before normalisation
 *       hub.use({ onRequest })         CertiFried Studio's 'overlays.list'; every other method goes where it went before
 *     and registers the overlay actions with actions.js registerActionType().
 */
import fs from 'node:fs/promises';
import { createOverlayStore } from './store.js';
import { createOverlayService } from './service.js';
import { createMediaLibrary } from './media.js';
import { createImageProxy } from './images.js';
import { registerOverlayActions } from './actions.js';
import { twitchChat, kickChat } from './chat.js';

/** Read a sentence aloud with CertiFried's Piper voices (utils/piper-tts.js) → WAV bytes. */
export function piperSynthesizer(logger = null) {
    let mod = null;
    return async (text, voice) => {
        mod ||= await import('../../../utils/piper-tts.js');
        const file = await mod.synthesize(String(text).slice(0, 200), voice || 'ryan');
        if (!file) return null;
        try { return await fs.readFile(file); } finally { fs.unlink(file).catch(() => logger?.debug?.('[StreamBotOverlay] tts temp file left')); }
    };
}

export async function attachOverlays(box, { onRequest = null } = {}) {
    const { store, hub, feed, ingest, logger, pool } = box;
    const encryption = (await import('../../../utils/encryption.js')).default;
    const actionsMod = await import('../actions.js');
    const ostore = createOverlayStore({ db: pool, prefix: store.prefix || 'stream_bot_', encryption });
    const media = createMediaLibrary({ ostore });
    const images = createImageProxy({ logger });
    const service = createOverlayService({
        store, ostore, media, sounds: box.sounds, render: box.render, images, logger,
        nowPlaying: (profileId) => box.music?.service?.player?.nowPlaying(profileId) || null,
        synthesize: piperSynthesizer(logger),
        baseUrl: process.env.DASHBOARD_URL || 'https://certifriedmultitool.com',
    });
    const serviceRef = { current: service };
    registerOverlayActions(actionsMod, { serviceRef });

    const dispatch = hub.dispatch.bind(hub);
    hub.dispatch = (d) => (d?.target === 'overlay' ? service.dispatch(d) : dispatch(d));
    const hasDevice = hub.hasDevice.bind(hub);
    hub.hasDevice = (profileId, target, capability = null) => hasDevice(profileId, target, capability) || (target === 'overlay' && service.isConnected(profileId, capability));

    const publish = feed.publish.bind(feed);
    feed.publish = (profileId, ev) => {
        publish(profileId, ev);
        service.onEvent(profileId, ev).catch((err) => logger?.warn?.(`[StreamBotOverlay] event failed: ${err?.message}`));
    };

    const tw = ingest.twitch;
    ingest.twitch = (subType, event, specKey) => {
        try { const r = twitchChat(subType, event); if (r) service.onChat('twitch', r).catch(() => {}); } catch { /* chat overlay is best effort */ }
        return tw(subType, event, specKey);
    };
    const kk = ingest.kick;
    ingest.kick = (eventType, event) => {
        try { const r = kickChat(eventType, event); if (r) service.onChat('kick', r).catch(() => {}); } catch { /* chat overlay is best effort */ }
        return kk(eventType, event);
    };

    if (onRequest) {
        hub.use({ onRequest: (conn, method, params) => (String(method).startsWith('overlays.') ? service.onStudioRequest(conn, method, params) : onRequest(conn, method, params)) });
    }
    return { service, ostore, media, images };
}

export default { attachOverlays, piperSynthesizer };
