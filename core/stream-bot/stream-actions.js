/*
 * Stream bot: the stream management actions (Phase 4 pulled forward): clips, title, category, ads, raids, polls,
 * predictions, announcements, shoutouts, clearing chat and deleting the triggering message.
 *
 *   createStreamActions({ helix, kick, streamInfo?, sendChat, shoutoutText? })
 *     .run(step, ctx) → { status: 'ok'|'failed'|'skipped'|'dry', detail, vars? }
 *       ctx = { profile, ev, render(text) → Promise<string>, dryRun, channels: [{ platform, platform_user_id, login }] }
 *
 * `vars` are values later steps of the same run can use ({clip.url}, {clip.id}, {poll.id}, {prediction.id}).
 * Twitch runs through helix.js with the Stream bot grant; Kick through kick-api.js with the Kick Defender sign-in.
 * Where Kick has no public endpoint the action is Twitch only (actions.js marks them so the editor can say it).
 * A Kick shoutout posts the same chat line as the bot's built-in !so (services/certifried-bot/commands/shoutout.js).
 *
 * Tested in tests/stream-bot-gaps.test.js with fake helix and Kick clients.
 */

const lines = (s) => String(s ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const short = (s, n = 200) => String(s ?? '').slice(0, n);

/** Which linked channels a step with a `platform` field acts on (the chat action's rule). */
export function targetChannels(platform, ev, channels) {
    const usable = (channels || []).filter((c) => c.platform === 'twitch' || c.platform === 'kick');
    if (platform === 'all') return usable;
    const p = platform === 'event' || !platform ? ev?.platform : platform;
    const own = ev?.channelId ? usable.filter((c) => c.platform === p && String(c.platform_user_id) === String(ev.channelId)) : [];
    return own.length ? own : usable.filter((c) => c.platform === p).slice(0, 1);
}

export function createStreamActions({ helix, kick, streamInfo = null, sendChat, shoutoutText = null } = {}) {
    const fail = (err) => ({ status: 'failed', detail: short(err?.message || 'failed', 300) });

    async function kickShoutoutLine(target) {
        if (shoutoutText) return shoutoutText(target);
        const { shoutoutCommand } = await import('../../services/certifried-bot/commands/shoutout.js');
        let line = '';
        await shoutoutCommand({ args: [target], platform: 'kick', reply: (t) => { line = String(t); } });
        return line;
    }

    /** Run per-platform work on each target channel; one failure fails the step, the rest are still tried. */
    async function each(targets, ctx, label, fns) {
        if (!targets.length) return { status: 'skipped', detail: 'no linked Twitch or Kick channel for this' };
        const done = [];
        let failed = false;
        for (const c of targets) {
            const fn = fns[c.platform];
            if (!fn) { done.push(`${c.platform}: not available on ${c.platform === 'kick' ? 'Kick' : c.platform}`); continue; }
            if (ctx.dryRun) { done.push(`would ${label} on ${c.platform}/${c.login}`); continue; }
            try { done.push(`${c.platform}/${c.login}: ${await fn(c)}`); } catch (err) { failed = true; done.push(`${c.platform}/${c.login}: ${short(err?.message, 200)}`); }
        }
        return { status: ctx.dryRun ? 'dry' : failed ? 'failed' : 'ok', detail: done.join('; ') };
    }

    async function run(step, ctx) {
        const { profile, ev, render, dryRun } = ctx;
        const pid = profile.id;
        try {
            switch (step.type) {
                case 'stream.clip': {
                    if (dryRun) return { status: 'dry', detail: 'would create a clip on Twitch', vars: { 'clip.url': 'https://clips.twitch.tv/(dry-run)', 'clip.id': '(dry-run)' } };
                    const c = await helix.createClip(pid);
                    return { status: 'ok', detail: `clip ${c.url}`, vars: { 'clip.url': c.url, 'clip.id': c.id } };
                }
                case 'stream.title': {
                    const title = (await render(step.title)).trim();
                    if (!title) return { status: 'skipped', detail: 'the title came out empty' };
                    const r = await each(targetChannels(step.platform, ev, ctx.channels), ctx, `set the title to "${short(title, 100)}"`, {
                        twitch: async (c) => { await helix.setTitle(pid, title); streamInfo?.forget('twitch', c.platform_user_id); return `title set to "${short(title, 100)}"`; },
                        kick: async (c) => { await kick.setTitle(c.platform_user_id, title); streamInfo?.forget('kick', c.platform_user_id); return `title set to "${short(title, 100)}"`; },
                    });
                    return r;
                }
                case 'stream.category': {
                    const name = (await render(step.category)).trim();
                    if (!name) return { status: 'skipped', detail: 'the category came out empty' };
                    return each(targetChannels(step.platform, ev, ctx.channels), ctx, `set the category to "${short(name, 80)}"`, {
                        twitch: async (c) => { const cat = await helix.setCategory(pid, name); streamInfo?.forget('twitch', c.platform_user_id); return `category set to ${cat.name}`; },
                        kick: async (c) => { const cat = await kick.setCategory(c.platform_user_id, name); streamInfo?.forget('kick', c.platform_user_id); return `category set to ${cat.name}`; },
                    });
                }
                case 'stream.ad': {
                    if (dryRun) return { status: 'dry', detail: `would run a ${step.length} s ad on Twitch` };
                    const r = await helix.startAd(pid, step.length);
                    return { status: 'ok', detail: `ad of ${r.length} s started${r.retryAfter ? `; next one possible in ${r.retryAfter} s` : ''}` };
                }
                case 'stream.raid': {
                    const target = (await render(step.target)).trim().replace(/^@/, '').split(/\s+/)[0] || '';
                    if (!target) return { status: 'skipped', detail: 'no channel to raid' };
                    if (dryRun) return { status: 'dry', detail: `would start a raid to ${short(target, 40)} on Twitch` };
                    const u = await helix.startRaid(pid, target);
                    return { status: 'ok', detail: `raid to ${u.name} started (Twitch sends it after its countdown)` };
                }
                case 'stream.poll': {
                    const title = (await render(step.title)).trim();
                    const choices = [];
                    for (const l of lines(step.choices)) { const t = (await render(l)).trim(); if (t) choices.push(t); }
                    if (!title || choices.length < 2) return { status: 'skipped', detail: 'a poll needs a title and at least two choices' };
                    if (dryRun) return { status: 'dry', detail: `would start the poll "${short(title, 60)}" (${choices.join(' / ').slice(0, 150)}) for ${step.duration} s` };
                    const p = await helix.createPoll(pid, { title, choices, duration: step.duration });
                    return { status: 'ok', detail: `poll "${short(p.title, 60)}" started`, vars: { 'poll.id': p.id || '' } };
                }
                case 'stream.poll_end': {
                    if (dryRun) return { status: 'dry', detail: `would end the running poll (${step.show === 'archive' ? 'hide the result' : 'show the result'})` };
                    const p = await helix.endPoll(pid, { show: step.show !== 'archive' });
                    return { status: 'ok', detail: `poll "${short(p.title, 60)}" ended` };
                }
                case 'stream.prediction': {
                    const title = (await render(step.title)).trim();
                    const outcomes = [];
                    for (const l of lines(step.outcomes)) { const t = (await render(l)).trim(); if (t) outcomes.push(t); }
                    if (!title || outcomes.length < 2) return { status: 'skipped', detail: 'a prediction needs a title and at least two outcomes' };
                    if (dryRun) return { status: 'dry', detail: `would start the prediction "${short(title, 45)}" (${outcomes.join(' / ').slice(0, 150)})` };
                    const p = await helix.createPrediction(pid, { title, outcomes, window: step.window });
                    return { status: 'ok', detail: `prediction "${short(p.title, 45)}" started`, vars: { 'prediction.id': p.id || '' } };
                }
                case 'stream.prediction_end': {
                    const winner = step.action === 'resolve' ? (await render(step.winner)).trim() : '';
                    if (step.action === 'resolve' && !winner) return { status: 'skipped', detail: 'the winning outcome came out empty' };
                    if (dryRun) return { status: 'dry', detail: `would ${step.action} the running prediction${winner ? ` with "${short(winner, 40)}" winning` : ''}` };
                    const p = await helix.endPrediction(pid, { action: step.action, winner });
                    return { status: 'ok', detail: `prediction "${short(p.title, 45)}" ${step.action === 'lock' ? 'locked' : step.action === 'cancel' ? 'cancelled, points returned' : `resolved: ${short(winner, 40)}`}` };
                }
                case 'stream.announce': {
                    const message = (await render(step.text)).trim();
                    if (!message) return { status: 'skipped', detail: 'the announcement came out empty' };
                    if (dryRun) return { status: 'dry', detail: `would announce (${step.color}): ${short(message, 300)}` };
                    await helix.announce(pid, { message, color: step.color });
                    return { status: 'ok', detail: `announced: ${short(message, 300)}` };
                }
                case 'stream.shoutout': {
                    const target = (await render(step.target)).trim().replace(/^@/, '').split(/\s+/)[0] || '';
                    if (!target) return { status: 'skipped', detail: 'no one to shout out' };
                    return each(targetChannels(step.platform, ev, ctx.channels), ctx, `shout out ${short(target, 40)}`, {
                        twitch: async () => { const u = await helix.shoutout(pid, target); return `shoutout to ${u.name}`; },
                        kick: async (c) => {
                            const line = await kickShoutoutLine(target);
                            const r = await sendChat({ profileId: pid, platform: 'kick', channelId: c.platform_user_id, login: c.login, text: line });
                            if (!r.ok) throw new Error(r.error || 'could not send');
                            return `said: ${short(line, 120)}`;
                        },
                    });
                }
                case 'chat.clear': {
                    if (dryRun) return { status: 'dry', detail: 'would clear Twitch chat' };
                    await helix.deleteChat(pid);
                    return { status: 'ok', detail: 'Twitch chat cleared' };
                }
                case 'chat.delete': {
                    const id = ev?.metadata?.messageId;
                    if (ev?.type !== 'chat' || !id) return { status: 'skipped', detail: 'only a chat message can be deleted (this event is not one)' };
                    if (ev.test) return { status: 'skipped', detail: 'a test message has nothing to delete' };
                    if (dryRun) return { status: 'dry', detail: `would delete the message on ${ev.platform}` };
                    if (ev.platform === 'twitch') { await helix.deleteChat(pid, id); return { status: 'ok', detail: 'message deleted on Twitch' }; }
                    if (ev.platform === 'kick') { await kick.deleteMessage(ev.channelId, id); return { status: 'ok', detail: 'message deleted on Kick' }; }
                    return { status: 'skipped', detail: `no chat on ${ev.platform}` };
                }
                default:
                    return { status: 'failed', detail: `no executor for ${step.type}` };
            }
        } catch (err) {
            return fail(err);
        }
    }

    return { run };
}

export default { createStreamActions, targetChannels };
