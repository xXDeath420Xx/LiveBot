/*
 * Stream bot control (wave 2 group A of the feature-parity backlog, 2026-11-20). Module map:
 *
 *   events.js       moderation, redemption-updated, title/category, goals, Kicks triggers and their converters (pure)
 *   platform.js     the Helix and Kick public API calls the new actions use
 *   actions.js      moderation steps, on/off steps, reward steps, marker / snooze / cancel raid / YouTube title, reply, run program
 *   conditions.js   only while live, time and day, category, viewer count, follow check, stored value
 *   queues.js       named action queues (blocking or not), pause / resume / clear, {queue.pending}
 *   chat-polls.js   !vote polls on Kick and YouTube with Twitch-shaped poll events
 *   service.js      first words, viewer arrived, viewer count steps, upcoming ads, follow and user info caches
 *
 *   attachControl(box) → { service, queues, polls }
 *     Called once from core/stream-bot/index.js build(), after the overlays. Registers through the hooks of actions.js,
 *     events.js, conditions.js and render.js, sets the engine's run gate (queues) and wraps feed.publish (first words,
 *     viewer arrived, chat poll votes). startStreamBot() starts the 30-second poll.
 */
import { CONTROL_EVENT_TYPES, normaliseControlTwitch, normaliseControlKick, describeControl } from './events.js';
import { createTwitchControl, createKickControl } from './platform.js';
import { controlActions } from './actions.js';
import { controlConditions } from './conditions.js';
import { createQueues, validateQueue } from './queues.js';
import { createChatPolls } from './chat-polls.js';
import { createControlService } from './service.js';

/** Events the stream bot raises itself on a viewer's platform (ingest.internal accepts them). Not stored: high rate. */
export const INTERNAL_TYPES = Object.freeze(['chat.first_words', 'chat.arrived', 'stream.viewers', 'ad.upcoming', 'poll.begin', 'poll.progress', 'poll.end']);
export const UNSTORED_TYPES = Object.freeze(['stream.viewers', 'poll.progress', 'chat.arrived']);

/** tokes_timers by name for a profile's own timers. */
export function timerDb(db) {
    return {
        async byName(pid, name) {
            const [rows] = await db.query('SELECT id, is_enabled FROM tokes_timers WHERE profile_id = ? AND LOWER(name) = ?', [pid, String(name).trim().toLowerCase()]);
            return rows;
        },
        async setEnabled(ids, on) { if (ids.length) await db.query('UPDATE tokes_timers SET is_enabled = ? WHERE id IN (?)', [on ? 1 : 0, ids]); },
        async reset(ids) { if (ids.length) await db.query('UPDATE tokes_timers SET last_sent_at = NOW() WHERE id IN (?)', [ids]); },
    };
}

/** Channel bot custom commands (tokes_custom_commands) on the profile's linked channels. */
export function commandDb(db, invalidate = () => {}) {
    return {
        async find(chans, name) {
            const out = [];
            for (const c of chans) {
                const [rows] = await db.query(`SELECT cc.id, cc.is_enabled, ch.channel_id FROM tokes_custom_commands cc JOIN tokes_channels ch ON ch.id = cc.channel_id
                    WHERE ch.platform = ? AND ch.channel_id = ? AND LOWER(cc.command_name) IN (?, ?)`, [c.platform, String(c.platform_user_id), name, `!${name}`]);
                out.push(...rows);
            }
            return out;
        },
        async setEnabled(rows, on) {
            await db.query('UPDATE tokes_custom_commands SET is_enabled = ? WHERE id IN (?)', [on ? 1 : 0, rows.map((r) => r.id)]);
            for (const r of rows) { try { invalidate(String(r.channel_id)); } catch { /* cache is best effort */ } }
        },
    };
}

export async function attachControl(box) {
    const { store, feed, hub, logger, pool } = box;
    const [actionsMod, eventsMod, conditionsMod, renderMod, engineGate] = await Promise.all([
        import('../actions.js'), import('../events.js'), import('../conditions.js'), import('../render.js'), Promise.resolve(box.engine),
    ]);
    const twitch = createTwitchControl({ helix: box.helix });
    const kick = createKickControl();
    let invalidate = () => {};
    try { ({ invalidateChannelCache: invalidate } = await import('../../../services/certifried-bot/command-registry.js')); } catch { /* not loaded here */ }

    const queues = createQueues({ logger });
    const raise = (pid, ev) => box.ingest.internal(pid, ev);
    const polls = createChatPolls({
        raise,
        say: async (pid, platforms, text) => {
            const list = (await box.io.channelsFor(pid).catch(() => [])).filter((c) => platforms.includes(c.platform));
            for (const c of list) await box.io.sendChat({ profileId: pid, platform: c.platform, channelId: c.platform_user_id, login: c.login, text }).catch(() => {});
        },
    });
    const service = createControlService({
        db: pool, store, io: box.io, ingest: box.ingest, streamInfo: box.streamInfo, twitch, prefix: store.prefix || 'stream_bot_', logger, raise,
        ignoreLogins: [process.env.TWITCH_BOT_USERNAME, process.env.TWITCH_USERNAME].filter(Boolean),
    });

    // Events: the catalogue, the converters, feed lines and which internal events ingest takes.
    for (const def of CONTROL_EVENT_TYPES) eventsMod.registerEventType(def);
    eventsMod.registerNormaliser?.('twitch', normaliseControlTwitch);
    eventsMod.registerNormaliser?.('kick', normaliseControlKick);
    eventsMod.registerDescriber?.(describeControl);
    for (const t of INTERNAL_TYPES) box.ingest.allowInternal?.(t, { store: !UNSTORED_TYPES.includes(t) });

    // Actions.
    const deps = {
        twitch, kick, hub, queues, polls,
        timers: timerDb(pool), commands: commandDb(pool, invalidate),
        kickBan: (channelId, userId, o) => box.kick.ban(channelId, userId, o),
        async reply({ platform, channel, text, replyTo }) {
            if (platform === 'kick') { box.ingest.noteSent('kick', channel.platform_user_id, text); await kick.reply(channel.platform_user_id, text, replyTo); return { ok: true }; }
            const bot = globalThis.certiFriedBot?.twitchBot;
            if (!bot?.client || !bot.isConnected) return { ok: false, error: 'the CertiFried Twitch chat bot is not connected' };
            if (!(await bot.joinChannel(channel.login))) return { ok: false, error: `could not join #${channel.login}` };
            const msg = String(text).replace(/[\r\n]+/g, ' ').slice(0, 500);
            box.ingest.noteSent('twitch', channel.platform_user_id, msg);
            if (typeof bot.client.raw === 'function' && /^[A-Za-z0-9-]{1,64}$/.test(String(replyTo))) await bot.client.raw(`@reply-parent-msg-id=${replyTo} PRIVMSG #${channel.login} :${msg}`);
            else await bot.say(channel.login, msg);
            return { ok: true };
        },
        async youtubeTitle(profile, { title, description }) {
            const yt = box.youtube;
            if (!yt?.service || !yt.auth) return { status: 'skipped', detail: 'YouTube is not set up on this server' };
            const ch = (await box.io.channelsFor(profile.id).catch(() => [])).find((c) => c.platform === 'youtube');
            if (!ch) return { status: 'skipped', detail: 'no linked YouTube channel' };
            const live = yt.service.status(profile.id).find((c) => String(c.channelId) === String(ch.platform_user_id));
            const broadcastId = live?.broadcastId || null;
            const a = yt.quota.allow('liveBroadcasts.update');
            if (!a.ok) return { status: 'skipped', detail: 'today\'s YouTube allowance is too low for this (50 units)' };
            let tok;
            try { tok = await yt.auth.token({ ownerId: profile.ownerDiscordId, channelId: ch.platform_user_id }, { write: true }); } catch (err) { return { status: 'failed', detail: String(err?.message || 'YouTube sign-in failed').slice(0, 200) }; }
            const base = 'https://www.googleapis.com/youtube/v3/liveBroadcasts';
            const headers = { Authorization: `Bearer ${tok.accessToken}`, Accept: 'application/json' };
            yt.quota.spend('liveBroadcasts.list', profile.id);
            const listQ = broadcastId ? `id=${encodeURIComponent(broadcastId)}` : 'broadcastStatus=active&broadcastType=all';
            const lr = await fetch(`${base}?part=id,snippet&${listQ}`, { headers });
            const b = lr.ok ? (await lr.json())?.items?.[0] : null;
            if (!b) return { status: 'skipped', detail: 'no YouTube broadcast is live or scheduled to change' };
            yt.quota.spend('liveBroadcasts.update', profile.id);
            const snippet = { title, description: description ?? b.snippet?.description ?? '', scheduledStartTime: b.snippet?.scheduledStartTime };
            const ur = await fetch(`${base}?part=snippet`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.id, snippet }) });
            if (!ur.ok) return { status: 'failed', detail: `YouTube refused the change (HTTP ${ur.status})` };
            return { status: 'ok', detail: `YouTube title set to "${title.slice(0, 100)}"` };
        },
    };
    for (const def of controlActions(deps)) actionsMod.registerActionType(def);

    // Conditions.
    for (const def of controlConditions({ streamInfo: (pid, ev) => service.streamInfoFor(pid, ev), followedAt: (pid, ev) => service.followedAt(pid, ev), variable: (pid, ev, s, k) => service.variable(pid, ev, s, k) })) {
        conditionsMod.registerConditionType(def);
    }
    conditionsMod.registerTriggerOption?.('queue', validateQueue);

    // Variables: {queue.pending}, {user.created}, {user.accountage}, {user.followage}, {user.followed}, {marker.time}.
    renderMod.registerTemplateVars(queues.vars);
    renderMod.registerTemplateVars({
        names: [...service.USER_VARS, 'marker.time'],
        vars: [
            { token: '{user.created}', description: 'Twitch: the date the viewer made their account' },
            { token: '{user.accountage}', description: 'Twitch: how old the viewer\'s account is, such as 3 years, 2 months' },
            { token: '{user.followage}', description: 'Twitch: how long the viewer has followed you' },
            { token: '{user.followed}', description: 'Twitch: the date the viewer followed you' },
            { token: '{marker.time}', description: 'The time of the stream marker an "Add a stream marker" step made earlier in this run' },
            { token: '{math:2*(3+4)}', description: 'Arithmetic: + - * / % ^, brackets, round, floor, ceil, min, max, abs. Variables work inside' },
        ],
        values: (o) => service.userValues(o),
    });

    // Queues: the engine asks the gate before each run started by an event.
    engineGate.setRunGate?.((profile, automation, start) => queues.gate(profile, automation, start));

    // Every published event: first words, viewer arrived, chat poll votes.
    const publish = feed.publish.bind(feed);
    feed.publish = (profileId, ev) => {
        publish(profileId, ev);
        try { polls.onChat(profileId, ev); } catch { /* votes are best effort */ }
        service.onPublish(profileId, ev).catch((err) => logger?.debug?.(`[StreamBotControl] publish hook: ${err?.message}`));
    };
    return { service, queues, polls, twitch, kick };
}

export default { attachControl, INTERNAL_TYPES, UNSTORED_TYPES, timerDb, commandDb };
