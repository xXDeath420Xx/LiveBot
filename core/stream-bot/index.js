/*
 * Stream bot (Phase 1, "the engine"): the process-wide instance and the hooks the existing receivers call.
 * Design: docs/superpowers/specs/2026-11-19-stream-bot-design.md. Module map:
 *
 *   events.js      normalised event model + converters (pure)       conditions.js  triggers, conditions, cooldowns
 *   actions.js     action catalogue + validation                    engine.js      runs automations, logs runs
 *   render.js      action text through core/custom-command-vars.js  store.js       all SQL (table prefix for tests)
 *   ingest.js      event intake from the existing hooks             feed.js        live feed for the dashboard (SSE)
 *   realtime.js    WebSocket hub for Studio and overlays            pairing.js     device tokens and pairing codes
 *   webhook-out.js SSRF-safe webhook action                         tip-feeds.js   StreamElements / Streamlabs sockets
 *   scopes.js      the Stream bot Twitch grant + feature coverage   live.js        live io, linkable channels, health
 *   privacy.js     /privacy export and delete
 *   studio.js      Phase 2: CertiFried Studio's state, OBS events and requests   sounds.js  Phase 2: the sound library
 *   twitch-auth.js the Stream bot grant's token, refreshed before use        helix.js   Twitch Helix calls (stream actions)
 *   kick-api.js    Kick public API (title, category, delete message)        stream-info.js {stream.*}, cached 60 s
 *   stream-actions.js clips, title, category, ads, raids, polls, predictions, announcements, shoutouts, chat clear/delete
 *   counters.js    Counter changed events (observed variable store)          timers.js / timer-job.js  timers (tokes_timers)
 *   overlays/      Phase 3: OBS overlays and alerts (alert box, chat, events, goal, counter, now playing, text and media)
 *   devices/       Phase 5: lights (Studio's and Govee / LIFX cloud), Voicemeeter and Stream Deck actions and requests
 *   viewers/       viewer stats and loyalty points (H-747): records, watch time, points, ranks, the points commands
 *   youtube/       YouTube Live (H-741): live detection, chat through streamList, Super Chats, memberships, quota guard
 *
 *   getStreamBot()             → { store, feed, hub, engine, ingest, io, render, sounds, studio, auth, helix, kick, streamInfo,
 *                                  streamActions } (built on first use)
 *   startStreamBot(httpServer) the dashboard calls this once it listens: WebSocket endpoint, tip sockets,
 *                              interrupted-run cleanup
 *   onTwitch / onKick / onTip  fire-and-forget hooks for the existing receivers; never throw, never wait
 */
import { createStore } from './store.js';
import { createFeed } from './feed.js';
import { createHub, WS_PATH } from './realtime.js';
import { createEngine } from './engine.js';
import { createIngest } from './ingest.js';
import { createRenderer } from './render.js';
import { createIo } from './live.js';
import { createTipFeeds } from './tip-feeds.js';
import { createSoundLibrary } from './sounds.js';
import { createStudioServices } from './studio.js';
import { createGrantAuth } from './twitch-auth.js';
import { createHelix } from './helix.js';
import { createKickApi } from './kick-api.js';
import { createStreamInfo, pickInfoChannel, twitchAppStreamInfo } from './stream-info.js';
import { createStreamActions } from './stream-actions.js';
import { observeVariables, variableChangedEvent } from './counters.js';
import { noteChatLine } from './timers.js';

let building = null;
let started = false;

async function build() {
    const [{ default: pool }, { default: encryption }, { default: logger }, { safeFetch }] = await Promise.all([
        import('../../utils/db.js'), import('../../utils/encryption.js'), import('../../utils/logger.js'), import('../../utils/safe-fetch.js'),
    ]);
    const store = createStore({ db: pool, encryption });
    // Every value write ({sdb:}/{db:}, Set a variable, Add to a counter) raises "Counter or variable changed" (counters.js).
    store.variableStore = observeVariables(store.variableStore, { onChange: (c) => box.ingest?.internal(c.profileId, variableChangedEvent(c)), logger });
    const feed = createFeed();
    const hub = createHub({ store, logger });
    const render = createRenderer({ variableStore: store.variableStore, fetcher: (url) => safeFetch(url), onError: (err) => logger.debug?.(`[StreamBot] template: ${err?.message}`) });
    const ignoreLogins = [process.env.TWITCH_BOT_USERNAME, process.env.TWITCH_USERNAME].filter(Boolean);
    const box = { store, feed, hub, render, logger, pool };
    const io = createIo({ store, hub, ingest: { noteSent: (...a) => box.ingest?.noteSent(...a) }, logger });
    // Stream management (Phase 4 pulled forward): the grant's token refreshed before use, Helix and Kick calls, stream info.
    const auth = createGrantAuth({ store, logger });
    const helix = createHelix({ auth, logger });
    const kick = createKickApi();
    const streamInfo = createStreamInfo({ fetchers: { twitch: ({ channelId }) => twitchAppStreamInfo(channelId), kick: ({ channelId }) => kick.streamInfo(channelId),
        youtube: (c) => box.youtube?.service?.streamInfo(c) || null } });   // YouTube: the service's own state, no API call
    const streamActions = createStreamActions({ helix, kick, streamInfo, sendChat: (m) => io.sendChat(m) });
    io.streamAction = (step, ctx) => streamActions.run(step, ctx);
    io.streamInfo = async (profileId, ev) => {
        const pick = pickInfoChannel(ev, await io.channelsFor(profileId).catch(() => []));
        return pick ? streamInfo.get({ profileId, ...pick }) : null;
    };
    const engine = createEngine({ store, render, io, logger });
    const ingest = createIngest({ store, engine, feed, hub, logger, ignoreLogins, onChatLine: noteChatLine });
    const sounds = createSoundLibrary({ store });
    const studio = createStudioServices({ store, engine, ingest, sounds, logger });
    // Studio's music.* requests (music.overlay: the "CertiFried Music" source URL) go to song requests; the rest as before.
    let onRequest = (conn, method, params) => (String(method).startsWith('music.') && box.music ? box.music.service.onStudioRequest(conn, method, params) : studio.onRequest(conn, method, params));
    hub.use({ onState: studio.onState, onEvent: studio.onEvent, onRequest, onConnect: studio.onConnect });
    Object.assign(box, { io, engine, ingest, sounds, studio, auth, helix, kick, streamInfo, streamActions });
    // Song requests through CertiFried's music pipeline (core/stream-bot/music, migration 457): the "Song requests" action,
    // the "Song changed" trigger and {music.*} variables register through the hooks in actions.js, events.js and render.js.
    try {
        const [{ createMusic }, { registerMusic }, actionsMod, eventsMod, renderMod] = await Promise.all([
            import('./music/index.js'), import('./music/register.js'), import('./actions.js'), import('./events.js'), import('./render.js'),
        ]);
        box.musicRef = { current: null };
        registerMusic({ musicRef: box.musicRef, actions: actionsMod, events: eventsMod, render: renderMod });
        box.music = createMusic({ db: pool, store, hub, ingest, encryption, logger });
        box.musicRef.current = box.music;
    } catch (err) {
        logger.warn?.(`[StreamBot] song requests did not load: ${err?.message}`);
    }
    // Lights, Voicemeeter and the Stream Deck (Phase 5; core/stream-bot/devices, migration 461): registers the light.* and
    // voicemeeter.* actions, runs cloud lights here (hub.dispatch for target 'studio' light actions) and answers Studio's
    // 'lights.*' and 'counters.*' requests. Before overlays, so the overlay request wrapper hands other methods on to it.
    try {
        const { attachDevices } = await import('./devices/index.js');
        box.devices = await attachDevices(box, { onRequest });
        onRequest = box.devices.onRequest;
    } catch (err) {
        logger.warn?.(`[StreamBot] devices did not load: ${err?.message}`);
    }
    // Viewer stats and loyalty points (H-747; core/stream-bot/viewers, migration 464): records from every published event,
    // the 5-minute watch-time sample (started in startStreamBot), the points actions, conditions, variables and rank-up trigger.
    try {
        const { attachViewers } = await import('./viewers/index.js');
        box.viewers = await attachViewers(box);
    } catch (err) {
        logger.warn?.(`[StreamBot] viewers did not load: ${err?.message}`);
    }
    // YouTube Live (H-741; core/stream-bot/youtube, migration 470): chat, Super Chats, memberships and going live through the
    // YouTube Data API with the streamer's own Google sign-in. Wraps io.sendChat and io.streamAction (YouTube chat, delete) and
    // feed.publish (go-live hints); registers chat.timeout and chat.ban. Off (Connections says why) without GOOGLE_OAUTH_CLIENT_ID.
    try {
        const { attachYouTube } = await import('./youtube/index.js');
        box.youtube = await attachYouTube(box);
    } catch (err) {
        logger.warn?.(`[StreamBot] YouTube did not load: ${err?.message}`);
    }
    // Overlays and alerts (Phase 3; core/stream-bot/overlays, migration 459): OBS browser-source pages fed over SSE. It wraps
    // hub.dispatch / hasDevice (target 'overlay'), feed.publish, ingest.twitch / kick (chat) and Studio's requests ('overlays.*').
    try {
        const { attachOverlays } = await import('./overlays/index.js');
        box.overlays = await attachOverlays(box, { onRequest });
    } catch (err) {
        logger.warn?.(`[StreamBot] overlays did not load: ${err?.message}`);
    }
    return box;
}

export function getStreamBot() {
    building ||= build().catch((err) => { building = null; throw err; });
    return building;
}

/** Start the realtime endpoint and tip sockets on the dashboard's HTTP server (once). */
export async function startStreamBot(server) {
    if (started) return;
    started = true;
    const sb = await getStreamBot();
    sb.hub.attach(server, WS_PATH);
    sb.store.failInterruptedRuns(new Date()).catch(() => {});
    sb.music?.service.boot(new Date()).catch(() => {});   // song requests: plays cut off by the restart, the VOD gate sweep
    sb.viewers?.service.start();                           // viewer watch time: a sample every 5 minutes while a channel is live
    sb.youtube?.service?.start();                          // YouTube Live: live checks and the chat reader (only when set up)
    sb.tipFeeds = createTipFeeds({ store: sb.store, ingest: sb.ingest, logger: sb.logger });
    sb.tipFeeds.start().catch((err) => sb.logger.warn?.(`[StreamBot] tip feeds did not start: ${err.message}`));
    sb.logger.info?.(`[StreamBot] realtime endpoint on ${WS_PATH}; tip feeds started`);
}

const fire = (fn) => { getStreamBot().then(fn).catch(() => { /* the stream bot never breaks a receiver */ }); };

/** core/twitch-eventsub-manager.js handleNotification(). */
export function onTwitch(subType, event, specKey) { fire((sb) => sb.ingest.twitch(subType, event, specKey)); }
/** services/certifried-bot/kick-events.js. */
export function onKick(eventType, event) { fire((sb) => sb.ingest.kick(eventType, event)); }
/** Ko-fi (ref = server id), Throne (ref = creator username), Fourthwall (ref = server id), Buy Me a Coffee (ref = Discord user id). */
export function onTip(source, payload, ref) { fire((sb) => sb.ingest.tip(source, payload, ref)); }

/** Stream bot grant scopes for a Twitch user (EventSub eligibility). Empty set on any error. */
export async function streamBotScopesFor(twitchUserId) {
    try { return await (await getStreamBot()).store.grantScopesForTwitchUser(twitchUserId); } catch { return new Set(); }
}
/** Twitch channels linked to profiles (EventSub reconcile keeps their subscriptions). */
export async function streamBotTwitchChannels() {
    try { return await (await getStreamBot()).store.linkedTwitchChannels(); } catch { return []; }
}
/** Buy Me a Coffee: Discord users who turned it on as a stream-bot tip source (the poller polls them too). */
export async function streamBotBmacOwners() {
    try { return await (await getStreamBot()).store.bmacOwnersWithSource(); } catch { return []; }
}

export default { getStreamBot, startStreamBot, onTwitch, onKick, onTip, streamBotScopesFor, streamBotTwitchChannels, streamBotBmacOwners };
