/*
 * Stream bot viewer stats and loyalty points (H-747; docs/superpowers/specs/2026-11-19-stream-bot-design.md §11; migration 464).
 * Replaces StreamElements / Streamlabs loyalty points, Firebot currency and ranks and Streamer.bot user tracking.
 *
 *   settings.js  the Viewers settings (currency, earning, ranks, give, gamble, not counted) and the pure maths
 *   store.js     stream_bot_viewers and stream_bot_viewer_history
 *   service.js   events → records, the 5-minute watch-time sample, points changes, rank-ups, the chat commands
 *   register.js  points actions, "Viewers: run a command", the rank-up trigger, {user.points} and friends, the conditions
 *   seed.js      the chat commands as automations (switched off)
 *   import.js    Firebot users.db and Streamer.bot users.dat rows → viewer records (through the importer)
 *   privacy.js   /privacy export and delete, as a streamer and as a viewer
 *
 *   attachViewers(box) → { service, vstore }
 *     Called once from core/stream-bot/index.js build(). It wraps feed.publish (every published event also reaches the
 *     viewer service, like the overlays) and registers with the engine's hooks. startStreamBot() calls service.start().
 */
import { createViewerStore } from './store.js';
import { createViewerService } from './service.js';
import { registerViewers } from './register.js';

export async function attachViewers(box) {
    const { store, feed, logger, pool } = box;
    const [actions, events, render, conditions] = await Promise.all([import('../actions.js'), import('../events.js'), import('../render.js'), import('../conditions.js')]);
    const vstore = createViewerStore({ db: pool, prefix: store.prefix || 'stream_bot_' });
    const service = createViewerService({
        db: pool, store, vstore, helix: box.helix, streamInfo: box.streamInfo, io: box.io, ingest: box.ingest, logger,
        ignoreLogins: [process.env.TWITCH_BOT_USERNAME, process.env.TWITCH_USERNAME].filter(Boolean),
    });
    const ref = { current: service };
    registerViewers({ ref, actions, events, render, conditions });

    const publish = feed.publish.bind(feed);
    feed.publish = (profileId, ev) => {
        publish(profileId, ev);
        service.onEvent(profileId, ev).catch((err) => logger?.warn?.(`[StreamBotViewers] event failed: ${err?.message}`));
    };
    return { service, vstore };
}

export default { attachViewers };
