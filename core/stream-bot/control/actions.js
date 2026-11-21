/*
 * Stream bot control: the wave 2 group A actions, registered through actions.js registerActionType().
 *
 *   W2.2  mod.timeout, mod.ban, mod.unban, mod.purge, mod.chat_mode, mod.vip, mod.moderator, mod.shield, mod.warn
 *   W2.5  automation.state, timer.state, timer.reset, command.state
 *   W2.6  reward.update, redemption.update
 *   W2.12 stream.marker, stream.ad_snooze, stream.raid_cancel, youtube.title
 *   W2.16 chat.reply, system.run (CertiFried Studio; the program must be on Studio's own allow-list)
 *   W2.4  queue.pause, queue.resume, queue.clear (queues.js)
 *   W2.18 poll.chat (chat-polls.js)
 *
 *   controlActions(deps) → action definitions
 *     deps = { twitch, kick, store, db, hub, queues, polls, youtube: () => box.youtube, invalidateCommands(channelId) }
 *
 * Every action answers in plain words in run history; Dry run calls nothing. A Twitch permission the grant lacks makes the
 * step "skipped: Reconnect Twitch to enable this" (platform.js friendlyError).
 *
 * Tested in tests/stream-bot-control.test.js.
 */
import { friendlyError } from './platform.js';
import { CHAT_MODES } from './events.js';

const f = (name, kind, label, extra = {}) => ({ name, kind, label, ...extra });
const short = (s, n = 200) => String(s ?? '').slice(0, n);
const txt = (v, n = 500) => String(v ?? '').slice(0, n).trim();
const pick = (v, list, d) => (list.includes(v) ? v : d);
const intIn = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

const WHO = Object.freeze({ event: 'The viewer behind the event', named: 'A viewer by name' });
const WHERE = Object.freeze({ event: 'Where the event came from', twitch: 'Twitch', kick: 'Kick' });
const STATE = Object.freeze({ on: 'Turn on', off: 'Turn off', toggle: 'Switch' });

const whoFields = () => [
    f('platform', 'select', 'Where', { options: Object.keys(WHERE), default: 'event', optionLabels: WHERE }),
    f('who', 'select', 'Who', { options: Object.keys(WHO), default: 'event', optionLabels: WHO }),
    f('viewer', 'template', 'Viewer name (when "A viewer by name"), such as {arg1}', { optional: true }),
];
function validateWho(s, out, err) {
    out.platform = pick(s.platform, Object.keys(WHERE), 'event');
    out.who = s.who === 'named' ? 'named' : 'event';
    out.viewer = txt(s.viewer, 200);
    if (out.who === 'named' && !out.viewer) err('enter the viewer name, or a variable such as {arg1}.');
}

/** The platform a step acts on and the linked channel there. */
function platformOf(step, ctx, allowed = ['twitch', 'kick']) {
    const p = step.platform === 'event' || !step.platform ? ctx.ev?.platform : step.platform;
    if (!allowed.includes(p)) return { error: `not available for ${p || 'this'} events (pick ${allowed.map((x) => x[0].toUpperCase() + x.slice(1)).join(' or ')})` };
    return { platform: p };
}
async function channelOn(ctx, platform) {
    let list = [];
    try { list = await ctx.io.channelsFor(ctx.profile.id); } catch { /* none */ }
    const own = ctx.ev?.platform === platform && ctx.ev?.channelId ? list.find((c) => c.platform === platform && String(c.platform_user_id) === String(ctx.ev.channelId)) : null;
    return own || list.find((c) => c.platform === platform) || null;
}

/** The viewer a moderation step is about, on `platform`. */
async function targetOf(deps, step, ctx, platform, channel) {
    if (step.who === 'named') {
        const name = String(await ctx.render(step.viewer || '')).trim().replace(/^@/, '').split(/\s+/)[0] || '';
        if (!name) return { error: 'the viewer name came out empty' };
        if (ctx.dryRun) return { user: { id: '(dry-run)', name, login: name.toLowerCase() } };
        if (platform === 'twitch') return { user: await deps.twitch.userByLogin(ctx.profile.id, name) };
        return { user: await deps.kick.userIdBySlug(channel.platform_user_id, name) };
    }
    const u = ctx.ev?.user;
    if (!u?.id || ctx.ev.platform !== platform) return { error: `this event has no ${platform === 'twitch' ? 'Twitch' : 'Kick'} viewer (use "A viewer by name")` };
    if ((u.roles || []).includes('broadcaster')) return { error: 'that is you, the broadcaster' };
    return { user: { id: String(u.id), name: u.name || u.login || u.id, login: u.login || '' } };
}

/** Shared frame of a moderation step: platform, channel, target, dry run, errors. */
function modAction({ type, label, platforms = ['twitch', 'kick'], fields = [], validate = () => {}, needsUser = true, run }, deps) {
    return {
        type, label, target: 'server', group: 'Moderation', platforms,
        fields: [...(needsUser ? whoFields() : [f('platform', 'select', 'Where', { options: ['event', 'twitch'], default: 'twitch', optionLabels: WHERE })]), ...fields],
        templates: ['viewer', ...fields.filter((x) => x.kind === 'template').map((x) => x.name)],
        validate(s, out, err) {
            if (needsUser) validateWho(s, out, err); else out.platform = pick(s.platform, ['event', 'twitch'], 'twitch');
            validate(s, out, err);
        },
        async execute(step, ctx) {
            try {
                const p = platformOf(step, ctx, platforms);
                if (p.error) return { status: 'skipped', detail: p.error };
                const channel = await channelOn(ctx, p.platform);
                if (!channel) return { status: 'skipped', detail: `no linked ${p.platform === 'twitch' ? 'Twitch' : 'Kick'} channel` };
                let user = null;
                if (needsUser) {
                    const t = await targetOf(deps, step, ctx, p.platform, channel);
                    if (t.error) return { status: 'skipped', detail: t.error };
                    user = t.user;
                }
                return await run({ step, ctx, platform: p.platform, channel, user, pid: ctx.profile.id });
            } catch (err) {
                return friendlyError(err);
            }
        },
    };
}

const reasonField = f('reason', 'template', 'Reason (optional)', { optional: true });
const dry = (ctx, text) => (ctx.dryRun ? { status: 'dry', detail: `would ${text}` } : null);

function moderationActions(deps) {
    const { twitch, kick } = deps;
    return [
        modAction({
            type: 'mod.timeout', label: 'Time out a viewer', fields: [f('seconds', 'number', 'For (seconds)', { min: 1, max: 1209600, default: 600 }), reasonField],
            validate(s, out, err) {
                out.seconds = intIn(s.seconds ?? 600, 1, 1209600, 600);
                if (!Number.isFinite(Number(s.seconds ?? 600))) err('the timeout is 1 second to 14 days.');
                out.reason = txt(s.reason, 500);
            },
            async run({ step, ctx, platform, channel, user, pid }) {
                const reason = step.reason ? (await ctx.render(step.reason)).trim() : '';
                const d = dry(ctx, `time out ${user.name} for ${step.seconds} s on ${platform}`); if (d) return d;
                if (platform === 'twitch') await twitch.ban(pid, { userId: user.id, seconds: step.seconds, reason });
                else await deps.kickBan(channel.platform_user_id, user.id, { seconds: Math.max(60, step.seconds) });
                return { status: 'ok', detail: `${user.name} timed out for ${platform === 'kick' ? `${Math.ceil(Math.max(60, step.seconds) / 60)} min` : `${step.seconds} s`} on ${platform}` };
            },
        }, deps),
        modAction({
            type: 'mod.ban', label: 'Ban a viewer', fields: [reasonField],
            validate(s, out) { out.reason = txt(s.reason, 500); },
            async run({ step, ctx, platform, channel, user, pid }) {
                const reason = step.reason ? (await ctx.render(step.reason)).trim() : '';
                const d = dry(ctx, `ban ${user.name} on ${platform}`); if (d) return d;
                if (platform === 'twitch') await twitch.ban(pid, { userId: user.id, reason });
                else await deps.kickBan(channel.platform_user_id, user.id, {});
                return { status: 'ok', detail: `${user.name} banned on ${platform}` };
            },
        }, deps),
        modAction({
            type: 'mod.unban', label: 'Unban a viewer or end a timeout',
            async run({ ctx, platform, channel, user, pid }) {
                const d = dry(ctx, `unban ${user.name} on ${platform}`); if (d) return d;
                if (platform === 'twitch') await twitch.unban(pid, user.id);
                else await kick.unban(channel.platform_user_id, user.id);
                return { status: 'ok', detail: `${user.name} unbanned on ${platform}` };
            },
        }, deps),
        modAction({
            type: 'mod.purge', label: 'Purge a viewer\'s messages (1 second timeout)', platforms: ['twitch'],
            async run({ ctx, user, pid }) {
                const d = dry(ctx, `purge ${user.name}'s messages on Twitch`); if (d) return d;
                await twitch.ban(pid, { userId: user.id, seconds: 1, reason: 'Messages purged' });
                return { status: 'ok', detail: `${user.name}'s messages purged` };
            },
        }, deps),
        modAction({
            type: 'mod.chat_mode', label: 'Change a chat mode', platforms: ['twitch'], needsUser: false,
            fields: [
                f('mode', 'select', 'Mode', { options: [...CHAT_MODES], default: 'slow', optionLabels: { emote: 'Emote-only', followers: 'Followers-only', slow: 'Slow mode', subscribers: 'Subscribers-only', unique: 'Unique chat' } }),
                f('state', 'select', 'Action', { options: ['on', 'off'], default: 'on', optionLabels: { on: 'Turn on', off: 'Turn off' } }),
                f('value', 'number', 'Slow mode seconds, or followers-only minutes (optional)', { min: 0, max: 129600, optional: true }),
            ],
            validate(s, out) {
                out.mode = pick(s.mode, CHAT_MODES, 'slow');
                out.state = s.state === 'off' ? 'off' : 'on';
                if (s.value !== '' && s.value != null && Number.isFinite(Number(s.value))) out.value = intIn(s.value, 0, 129600, 0);
            },
            async run({ step, ctx, pid }) {
                const on = step.state === 'on';
                const body = {};
                if (step.mode === 'emote') body.emote_mode = on;
                if (step.mode === 'subscribers') body.subscriber_mode = on;
                if (step.mode === 'unique') body.unique_chat_mode = on;
                if (step.mode === 'slow') { body.slow_mode = on; if (on && step.value != null) body.slow_mode_wait_time = Math.min(120, Math.max(3, step.value)); }
                if (step.mode === 'followers') { body.follower_mode = on; if (on && step.value != null) body.follower_mode_duration = Math.min(129600, step.value); }
                const d = dry(ctx, `turn ${step.mode} mode ${step.state}`); if (d) return d;
                await twitch.chatSettings(pid, body);
                return { status: 'ok', detail: `${step.mode} mode ${step.state}` };
            },
        }, deps),
        ...['vip', 'moderator'].map((role) => modAction({
            type: `mod.${role}`, label: role === 'vip' ? 'Add or remove a VIP' : 'Add or remove a moderator', platforms: ['twitch'],
            fields: [f('change', 'select', 'Action', { options: ['add', 'remove'], default: 'add', optionLabels: { add: 'Add', remove: 'Remove' } })],
            validate(s, out) { out.change = s.change === 'remove' ? 'remove' : 'add'; },
            async run({ step, ctx, user, pid }) {
                const add = step.change !== 'remove';
                const what = role === 'vip' ? 'VIP' : 'moderator';
                const d = dry(ctx, `${add ? 'make' : 'remove'} ${user.name} ${add ? `a ${what}` : `as ${what}`}`); if (d) return d;
                await twitch[role](pid, user.id, add);
                return { status: 'ok', detail: `${user.name} ${add ? `is now a ${what}` : `is no longer a ${what}`}` };
            },
        }, deps)),
        modAction({
            type: 'mod.shield', label: 'Turn shield mode on or off', platforms: ['twitch'], needsUser: false,
            fields: [f('state', 'select', 'Action', { options: ['on', 'off'], default: 'on', optionLabels: { on: 'Turn on', off: 'Turn off' } })],
            validate(s, out) { out.state = s.state === 'off' ? 'off' : 'on'; },
            async run({ step, ctx, pid }) {
                const d = dry(ctx, `turn shield mode ${step.state}`); if (d) return d;
                await twitch.shield(pid, step.state === 'on');
                return { status: 'ok', detail: `shield mode ${step.state}` };
            },
        }, deps),
        modAction({
            type: 'mod.warn', label: 'Warn a viewer', platforms: ['twitch'], fields: [f('reason', 'template', 'Warning (shown to the viewer)')],
            validate(s, out, err) { out.reason = txt(s.reason, 500); if (!out.reason) err('enter the warning.'); },
            async run({ step, ctx, user, pid }) {
                const reason = (await ctx.render(step.reason)).trim();
                if (!reason) return { status: 'skipped', detail: 'the warning came out empty' };
                const d = dry(ctx, `warn ${user.name}: ${short(reason, 100)}`); if (d) return d;
                await twitch.warn(pid, user.id, reason);
                return { status: 'ok', detail: `${user.name} warned: ${short(reason, 200)}` };
            },
        }, deps),
    ];
}

// ── W2.5: turn things on or off from a step ──
function stateActions(deps) {
    const notify = (pid) => { try { deps.hub?.notify(pid, 'studio', { type: 'automations_changed' }); } catch { /* not attached */ } };
    const next = (state, cur) => (state === 'toggle' ? !cur : state === 'on');
    const stateField = f('state', 'select', 'Action', { options: Object.keys(STATE), default: 'toggle', optionLabels: STATE });
    return [
        {
            type: 'automation.state', label: 'Turn an automation on or off', target: 'server', group: 'Flow',
            fields: [f('automationId', 'automation', 'Automation'), stateField],
            validate(s, out, err, ctx) {
                const id = Number(s.automationId);
                if (!Number.isInteger(id) || id <= 0) err('pick an automation.');
                else if (ctx?.automationIds && !ctx.automationIds.has(id)) err('that automation does not exist.');
                out.automationId = id;
                out.state = pick(s.state, Object.keys(STATE), 'toggle');
            },
            async execute(step, ctx) {
                const a = await ctx.store.getAutomation(ctx.profile.id, Number(step.automationId));
                if (!a) return { status: 'failed', detail: 'that automation no longer exists' };
                const want = next(step.state, !!a.enabled);
                if (ctx.dryRun) return { status: 'dry', detail: `would turn ${a.name} ${want ? 'on' : 'off'}` };
                if (want !== !!a.enabled) { await ctx.store.setAutomationEnabled(ctx.profile.id, a.id, want); notify(ctx.profile.id); }
                return { status: 'ok', detail: `${a.name} is ${want ? 'on' : 'off'}` };
            },
        },
        {
            type: 'timer.state', label: 'Turn a timer on or off', target: 'server', group: 'Flow',
            fields: [f('timer', 'text', 'Timer name, as on the Timers tab'), stateField],
            validate(s, out, err) { out.timer = txt(s.timer, 100); if (!out.timer) err('enter the timer name.'); out.state = pick(s.state, Object.keys(STATE), 'toggle'); },
            async execute(step, ctx) {
                const rows = await deps.timers.byName(ctx.profile.id, step.timer);
                if (!rows.length) return { status: 'failed', detail: `no timer called "${short(step.timer, 60)}"` };
                const want = next(step.state, rows.every((r) => !!r.is_enabled));
                if (ctx.dryRun) return { status: 'dry', detail: `would turn ${step.timer} ${want ? 'on' : 'off'}` };
                await deps.timers.setEnabled(rows.map((r) => r.id), want);
                return { status: 'ok', detail: `timer ${step.timer} is ${want ? 'on' : 'off'}` };
            },
        },
        {
            type: 'timer.reset', label: 'Restart a timer\'s countdown', target: 'server', group: 'Flow',
            fields: [f('timer', 'text', 'Timer name, as on the Timers tab')],
            validate(s, out, err) { out.timer = txt(s.timer, 100); if (!out.timer) err('enter the timer name.'); },
            async execute(step, ctx) {
                const rows = await deps.timers.byName(ctx.profile.id, step.timer);
                if (!rows.length) return { status: 'failed', detail: `no timer called "${short(step.timer, 60)}"` };
                if (ctx.dryRun) return { status: 'dry', detail: `would restart ${step.timer}` };
                await deps.timers.reset(rows.map((r) => r.id));
                return { status: 'ok', detail: `timer ${step.timer} starts counting again from now` };
            },
        },
        {
            type: 'command.state', label: 'Turn a channel command on or off', target: 'server', group: 'Flow',
            fields: [f('command', 'text', 'Command, such as !discord (Commands tab)'), f('platform', 'select', 'Where', { options: ['all', 'twitch', 'kick'], default: 'all', optionLabels: { all: 'Twitch and Kick', twitch: 'Twitch', kick: 'Kick' } }), stateField],
            validate(s, out, err) {
                out.command = txt(s.command, 50).replace(/^!/, '').toLowerCase();
                if (!/^[a-z0-9_-]{1,50}$/.test(out.command)) err('enter the command name, such as !discord.');
                out.platform = pick(s.platform, ['all', 'twitch', 'kick'], 'all');
                out.state = pick(s.state, Object.keys(STATE), 'toggle');
            },
            async execute(step, ctx) {
                let list = [];
                try { list = await ctx.io.channelsFor(ctx.profile.id); } catch { /* none */ }
                const chans = list.filter((c) => (step.platform === 'all' ? ['twitch', 'kick'].includes(c.platform) : c.platform === step.platform));
                if (!chans.length) return { status: 'skipped', detail: 'no linked channel for that' };
                const rows = await deps.commands.find(chans, step.command);
                if (!rows.length) return { status: 'failed', detail: `no command !${step.command} on your channels (Commands tab)` };
                const want = next(step.state, rows.every((r) => !!r.is_enabled));
                if (ctx.dryRun) return { status: 'dry', detail: `would turn !${step.command} ${want ? 'on' : 'off'} (${rows.length})` };
                await deps.commands.setEnabled(rows, want);
                return { status: 'ok', detail: `!${step.command} is ${want ? 'on' : 'off'} on ${rows.length} channel${rows.length === 1 ? '' : 's'}` };
            },
        },
    ];
}

// ── W2.6: channel rewards and redemptions ──
const BOOL3 = Object.freeze({ keep: 'Leave as is', yes: 'Yes', no: 'No' });
const REWARD_HINT = 'Twitch and Kick only let the app that made a reward change it. For an imported reward, use Import, "Recreate under CertiFried" first.';

function rewardActions(deps) {
    const { twitch, kick } = deps;
    async function findReward(list, wanted) {
        const w = String(wanted || '').trim().toLowerCase();
        return list.find((r) => r.id.toLowerCase() === w) || list.find((r) => r.title.toLowerCase() === w) || null;
    }
    return [
        {
            type: 'reward.update', label: 'Change a channel points reward', target: 'server', group: 'Channel points', platforms: ['twitch', 'kick'],
            help: REWARD_HINT,
            fields: [
                f('platform', 'select', 'Where', { options: ['twitch', 'kick'], default: 'twitch', optionLabels: { twitch: 'Twitch', kick: 'Kick' } }),
                f('reward', 'template', `Reward title or id. ${REWARD_HINT}`),
                f('enabled', 'select', 'Turned on', { options: Object.keys(BOOL3), default: 'keep', optionLabels: BOOL3 }),
                f('paused', 'select', 'Paused', { options: Object.keys(BOOL3), default: 'keep', optionLabels: BOOL3 }),
                f('cost', 'template', 'New cost (empty: unchanged)', { optional: true }),
                f('title', 'template', 'New title (empty: unchanged)', { optional: true }),
                f('prompt', 'template', 'New description (empty: unchanged)', { optional: true }),
                f('cooldown', 'number', 'Cooldown in seconds, Twitch (empty: unchanged; 0 turns it off)', { min: 0, max: 604800, optional: true }),
                f('maxPerStream', 'number', 'Most per stream, Twitch (empty: unchanged; 0 turns it off)', { min: 0, max: 100000, optional: true }),
                f('maxPerUser', 'number', 'Most per viewer per stream, Twitch (empty: unchanged; 0 turns it off)', { min: 0, max: 100000, optional: true }),
            ],
            templates: ['reward', 'cost', 'title', 'prompt'],
            validate(s, out, err) {
                out.platform = s.platform === 'kick' ? 'kick' : 'twitch';
                out.reward = txt(s.reward, 200);
                if (!out.reward) err('enter the reward title or id.');
                out.enabled = pick(s.enabled, Object.keys(BOOL3), 'keep');
                out.paused = pick(s.paused, Object.keys(BOOL3), 'keep');
                for (const k of ['cost', 'title', 'prompt']) out[k] = txt(s[k], k === 'prompt' ? 200 : 100);
                if (out.cost && !out.cost.includes('{') && !/^\d{1,9}$/.test(out.cost)) err('the cost is a whole number of 1 or more, or a variable.');
                for (const [k, max] of [['cooldown', 604800], ['maxPerStream', 100000], ['maxPerUser', 100000]]) {
                    if (s[k] !== '' && s[k] != null && Number.isFinite(Number(s[k]))) out[k] = intIn(s[k], 0, max, 0);
                }
                const changes = ['enabled', 'paused'].some((k) => out[k] !== 'keep') || ['cost', 'title', 'prompt'].some((k) => out[k]) || ['cooldown', 'maxPerStream', 'maxPerUser'].some((k) => out[k] != null);
                if (!changes) err('choose at least one thing to change.');
            },
            async execute(step, ctx) {
                try {
                    const pid = ctx.profile.id;
                    const wanted = (await ctx.render(step.reward)).trim();
                    const body = {};
                    if (step.enabled !== 'keep') body.is_enabled = step.enabled === 'yes';
                    if (step.paused !== 'keep') body.is_paused = step.paused === 'yes';
                    if (step.cost) {
                        const c = Number(String(await ctx.render(step.cost)).replace(/,/g, '').trim());
                        if (!Number.isInteger(c) || c < 1) return { status: 'failed', detail: 'the cost did not come out as a whole number of 1 or more' };
                        body.cost = c;
                    }
                    if (step.title) body.title = (await ctx.render(step.title)).trim().slice(0, step.platform === 'kick' ? 50 : 45);
                    if (step.prompt) body[step.platform === 'kick' ? 'description' : 'prompt'] = (await ctx.render(step.prompt)).trim().slice(0, 200);
                    if (step.platform === 'twitch') {
                        if (step.cooldown != null) { body.is_global_cooldown_enabled = step.cooldown > 0; if (step.cooldown > 0) body.global_cooldown_seconds = step.cooldown; }
                        if (step.maxPerStream != null) { body.is_max_per_stream_enabled = step.maxPerStream > 0; if (step.maxPerStream > 0) body.max_per_stream = step.maxPerStream; }
                        if (step.maxPerUser != null) { body.is_max_per_user_per_stream_enabled = step.maxPerUser > 0; if (step.maxPerUser > 0) body.max_per_user_per_stream = step.maxPerUser; }
                    }
                    const summary = Object.entries(body).map(([k, v]) => `${k}=${short(v, 40)}`).join(', ');
                    if (ctx.dryRun) return { status: 'dry', detail: `would change "${short(wanted, 50)}" on ${step.platform}: ${summary}` };
                    if (step.platform === 'twitch') {
                        const r = await findReward(await twitch.manageableRewards(pid), wanted);
                        if (!r) return { status: 'failed', detail: `no reward "${short(wanted, 50)}" that CertiFried can change. ${REWARD_HINT}` };
                        await twitch.updateReward(pid, r.id, body);
                        return { status: 'ok', detail: `${r.title}: ${summary}` };
                    }
                    const ch = await channelOn(ctx, 'kick');
                    if (!ch) return { status: 'skipped', detail: 'no linked Kick channel' };
                    const r = await findReward(await kick.rewards(ch.platform_user_id), wanted);
                    if (!r) return { status: 'failed', detail: `no Kick reward "${short(wanted, 50)}". ${REWARD_HINT}` };
                    await kick.updateReward(ch.platform_user_id, r.id, body);
                    return { status: 'ok', detail: `${r.title}: ${summary}` };
                } catch (err) { return friendlyError(err); }
            },
        },
        {
            type: 'redemption.update', label: 'Mark the redemption done or refund it', target: 'server', group: 'Channel points', platforms: ['twitch', 'kick'],
            help: REWARD_HINT,
            fields: [f('result', 'select', 'Do', { options: ['fulfil', 'refund'], default: 'fulfil', optionLabels: { fulfil: 'Mark it done', refund: 'Refund the points' } })],
            validate(s, out) { out.result = s.result === 'refund' ? 'refund' : 'fulfil'; },
            async execute(step, ctx) {
                const ev = ctx.ev || {};
                const m = ev.metadata || {};
                if (ev.type !== 'redemption' || !m.redemptionId || !m.rewardId) return { status: 'skipped', detail: 'only a channel points redemption can be marked done or refunded (this event is not one)' };
                if (ev.test) return { status: 'skipped', detail: 'a test redemption has nothing to change' };
                const refund = step.result === 'refund';
                if (ctx.dryRun) return { status: 'dry', detail: `would ${refund ? 'refund' : 'mark done'} ${m.reward || 'the redemption'} on ${ev.platform}` };
                try {
                    if (ev.platform === 'twitch') await twitch.updateRedemption(ctx.profile.id, { rewardId: m.rewardId, redemptionId: m.redemptionId, status: refund ? 'CANCELED' : 'FULFILLED' });
                    else if (ev.platform === 'kick') await kick.redemption(ev.channelId, m.redemptionId, !refund);
                    else return { status: 'skipped', detail: `no channel points on ${ev.platform}` };
                    return { status: 'ok', detail: `${m.reward || 'redemption'} ${refund ? 'refunded' : 'marked done'}` };
                } catch (err) {
                    const r = friendlyError(err);
                    if (err?.status === 403 && ev.platform === 'twitch') r.detail = `${r.detail}. ${REWARD_HINT}`;
                    return r;
                }
            },
        },
    ];
}

// ── W2.12: marker, snooze, cancel raid, YouTube title ──
function streamActions(deps) {
    const { twitch } = deps;
    const twitchOnly = async (ctx, fn) => {
        const ch = await channelOn(ctx, 'twitch');
        if (!ch) return { status: 'skipped', detail: 'no linked Twitch channel' };
        try { return await fn(); } catch (err) { return friendlyError(err); }
    };
    return [
        {
            type: 'stream.marker', label: 'Add a stream marker', target: 'server', group: 'Stream', platforms: ['twitch'],
            fields: [f('description', 'template', 'Note (optional, up to 140 characters)', { optional: true })], templates: ['description'], outputs: ['marker.time'],
            validate(s, out) { out.description = txt(s.description, 500); },
            execute: (step, ctx) => twitchOnly(ctx, async () => {
                const d = step.description ? (await ctx.render(step.description)).trim() : '';
                if (ctx.dryRun) return { status: 'dry', detail: `would add a marker${d ? `: ${short(d, 100)}` : ''}`, vars: { 'marker.time': '0:00:00' } };
                const m = await twitch.marker(ctx.profile.id, d);
                const t = `${Math.floor(m.seconds / 3600)}:${String(Math.floor(m.seconds / 60) % 60).padStart(2, '0')}:${String(m.seconds % 60).padStart(2, '0')}`;
                return { status: 'ok', detail: `marker at ${t}${d ? `: ${short(d, 100)}` : ''}`, vars: { 'marker.time': t } };
            }),
        },
        {
            type: 'stream.ad_snooze', label: 'Snooze the next ad break', target: 'server', group: 'Stream', platforms: ['twitch'], fields: [],
            validate() {},
            execute: (step, ctx) => twitchOnly(ctx, async () => {
                if (ctx.dryRun) return { status: 'dry', detail: 'would snooze the next ad by 5 minutes' };
                const r = await twitch.snoozeAd(ctx.profile.id);
                return { status: 'ok', detail: `next ad snoozed 5 minutes; ${r.snoozes} snooze${r.snoozes === 1 ? '' : 's'} left` };
            }),
        },
        {
            type: 'stream.raid_cancel', label: 'Cancel the raid', target: 'server', group: 'Stream', platforms: ['twitch'], fields: [],
            validate() {},
            execute: (step, ctx) => twitchOnly(ctx, async () => {
                if (ctx.dryRun) return { status: 'dry', detail: 'would cancel the raid' };
                await twitch.cancelRaid(ctx.profile.id);
                return { status: 'ok', detail: 'raid cancelled' };
            }),
        },
        {
            type: 'youtube.title', label: 'Change the YouTube title', target: 'server', group: 'Stream', platforms: ['youtube'],
            fields: [f('title', 'template', 'New title'), f('description', 'template', 'New description (empty: unchanged)', { optional: true })],
            templates: ['title', 'description'],
            validate(s, out, err) { out.title = txt(s.title, 2000); out.description = txt(s.description, 2000); if (!out.title) err('enter the title.'); },
            async execute(step, ctx) {
                const title = (await ctx.render(step.title)).trim().slice(0, 100);
                if (!title) return { status: 'skipped', detail: 'the title came out empty' };
                const description = step.description ? (await ctx.render(step.description)).slice(0, 5000) : null;
                if (ctx.dryRun) return { status: 'dry', detail: `would set the YouTube title to "${short(title, 100)}" (50 units of the daily allowance)` };
                return deps.youtubeTitle(ctx.profile, { title, description });
            },
        },
    ];
}

// ── W2.16: reply in a thread; run a program on the streamer's PC ──
function miscActions(deps) {
    return [
        {
            type: 'chat.reply', label: 'Reply to the message', target: 'server', group: 'Chat', platforms: ['twitch', 'kick'],
            fields: [f('text', 'template', 'Reply')], templates: ['text'],
            validate(s, out, err) { out.text = String(s.text ?? '').slice(0, 2000).trim(); if (!out.text) err('enter the reply.'); },
            async execute(step, ctx) {
                const ev = ctx.ev || {};
                const id = ev.metadata?.messageId;
                if (ev.type !== 'chat' || !id) return { status: 'skipped', detail: 'only a chat message can be replied to (this event is not one)' };
                const text = (await ctx.render(step.text)).trim();
                if (!text) return { status: 'skipped', detail: 'the reply came out empty' };
                if (ctx.dryRun) return { status: 'dry', detail: `would reply on ${ev.platform}: ${short(text, 300)}` };
                const ch = await channelOn(ctx, ev.platform);
                if (!ch) return { status: 'skipped', detail: `no linked ${ev.platform} channel` };
                try {
                    const r = await deps.reply({ platform: ev.platform, channel: ch, text, replyTo: id, test: !!ev.test });
                    return r.ok ? { status: 'ok', detail: `replied: ${short(text, 300)}` } : { status: 'failed', detail: r.error || 'could not reply' };
                } catch (err) { return friendlyError(err); }
            },
        },
        {
            type: 'system.run', label: 'Run a program on your PC', target: 'studio', capability: 'run', group: 'Studio', phase: 2,
            fields: [f('program', 'text', 'Program name, as listed in CertiFried Studio (Settings, Programs it may run)')],
            validate(s, out, err) {
                out.program = txt(s.program, 100);
                if (!/^[\w .()-]{1,100}$/.test(out.program)) err('enter the name of a program on Studio\'s list (letters, numbers, spaces, . _ - and brackets).');
            },
            // Never reached: the engine sends studio actions to CertiFried Studio (registerActionType wants an execute).
            execute: async () => ({ status: 'failed', detail: 'runs in CertiFried Studio' }),
        },
    ];
}

export function controlActions(deps) {
    return [
        ...moderationActions(deps), ...stateActions(deps), ...rewardActions(deps), ...streamActions(deps), ...miscActions(deps),
        ...(deps.queues ? deps.queues.actions() : []), ...(deps.polls ? deps.polls.actions() : []),
    ];
}

export default { controlActions };
