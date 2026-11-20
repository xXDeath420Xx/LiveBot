/*
 * Stream bot, YouTube: how YouTube plugs into the engine without changing its contracts (design §13.5).
 *
 *   io.sendChat        wrapped: platform 'youtube' goes to the YouTube service (as the channel, 20 units, 200 characters)
 *   io.streamAction    wrapped: "Delete the message that triggered this" (chat.delete) on a YouTube event deletes it on YouTube
 *   actions            chat.timeout "Time out the viewer who triggered this" and chat.ban "Ban the viewer who triggered this",
 *                      YouTube only for now (Twitch would need moderator:manage:banned_users, which the grant does not ask for)
 *   feed.publish       wrapped: another platform going live, or CertiFried Studio starting the stream, makes the service check
 *                      YouTube at once (hint), which is what makes "went live" quick without spending quota on frequent checks
 *
 * registerYouTubeActions(actions) is separate so the importer (core/stream-bot/import/mapper.js) and tests can register the
 * actions without the running bot. Whoever registers first, the actions find the service through youtubeServiceRef, the one
 * reference per process that attachYouTube fills in (registerActionType refuses a second registration of a type).
 */

const TIMEOUT_OPTIONS = ['10', '60', '300', '600', '1800', '3600', '86400'];

/** The running YouTube service, or null (switched off, or not built yet). Set by attachYouTube (index.js). */
export const youtubeServiceRef = { current: null };

export function registerYouTubeActions(actionsMod, serviceRef = youtubeServiceRef) {
    const notReady = { status: 'failed', detail: 'YouTube is not set up on this server' };
    const timeout = {
        type: 'chat.timeout', label: 'Time out the viewer who triggered this', target: 'server', group: 'Chat', platforms: ['youtube'],
        fields: [{ name: 'seconds', kind: 'select', label: 'For (seconds)', options: TIMEOUT_OPTIONS, default: '300' }],
        validate(step, out, err) {
            out.seconds = TIMEOUT_OPTIONS.includes(String(step.seconds)) ? String(step.seconds) : '300';
        },
        async execute(step, ctx) {
            const svc = serviceRef.current;
            if (!svc) return notReady;
            if (ctx.ev?.platform !== 'youtube') return { status: 'skipped', detail: 'time-outs work on YouTube events for now' };
            return svc.moderate(ctx.profile.id, ctx.ev, { seconds: Number(step.seconds) || 300, dryRun: !!ctx.dryRun });
        },
    };
    const ban = {
        type: 'chat.ban', label: 'Ban the viewer who triggered this', target: 'server', group: 'Chat', platforms: ['youtube'], fields: [],
        validate() {},
        async execute(step, ctx) {
            const svc = serviceRef.current;
            if (!svc) return notReady;
            if (ctx.ev?.platform !== 'youtube') return { status: 'skipped', detail: 'bans work on YouTube events for now' };
            return svc.moderate(ctx.profile.id, ctx.ev, { seconds: null, dryRun: !!ctx.dryRun });
        },
    };
    const added = [];
    for (const def of [timeout, ban]) if (actionsMod.registerActionType(def)) added.push(def.type);
    return added;
}

/** Wire the service into a built stream bot box (core/stream-bot/index.js). */
export function wireYouTube(box, serviceRef = youtubeServiceRef) {
    const io = box.io;
    const sendChat = io.sendChat;
    io.sendChat = async (m) => {
        if (m?.platform !== 'youtube') return sendChat(m);
        const svc = serviceRef.current;
        if (!svc) return { ok: false, error: 'YouTube is not set up on this server' };
        return svc.sendChat({ profileId: m.profileId, channelId: m.channelId, text: m.text });
    };
    const streamAction = io.streamAction;
    io.streamAction = async (step, ctx) => {
        if (step?.type === 'chat.delete' && ctx?.ev?.platform === 'youtube') {
            const svc = serviceRef.current;
            if (!svc) return { status: 'failed', detail: 'YouTube is not set up on this server' };
            return svc.deleteMessage(ctx.profile.id, ctx.ev, { dryRun: !!ctx.dryRun });
        }
        return streamAction ? streamAction(step, ctx) : { status: 'failed', detail: 'stream actions are not available on this server yet' };
    };
    const publish = box.feed.publish.bind(box.feed);
    box.feed.publish = (profileId, pub) => {
        const r = publish(profileId, pub);
        try {
            if (pub && !pub.test && ((pub.type === 'stream.online' && pub.platform !== 'youtube') || pub.type === 'obs.stream_started')) serviceRef.current?.hint(profileId);
        } catch { /* hints are best effort */ }
        return r;
    };
}

export default { registerYouTubeActions, wireYouTube, youtubeServiceRef };
