/*
 * Stream bot viewers: what they add to the automation engine, through the registration hooks of actions.js, events.js,
 * render.js and conditions.js (no viewer code inside the engine files).
 *
 *   points.add / points.remove / points.set   "Give points", "Take points", "Set points" (server actions): the viewer behind
 *                                             the event, or one named by a template such as {arg1}; the amount is a template.
 *                                             Give and Set are skipped for a YouTube event or a YouTube viewer (YouTube API
 *                                             policy III.F.3.c: no rewards for engaging with YouTube; youtube/policy.js)
 *   viewers.command                           "Viewers: run a command": !points, !top, !give, !gamble, !addpoints, !removepoints,
 *                                             answering in the chat the event came from
 *   viewer.rank_up                            trigger "Viewer reached a new rank" ({rank.name}, {rank.previous})
 *   {user.points} {user.watchtime} {user.messages} {user.rank} {points.name}   template variables (read only when a text uses one)
 *   viewer.points / viewer.watch / viewer.messages   conditions: at least N points, minutes watched, chat messages
 *
 *   registerViewers({ ref, actions, events, render, conditions })   once at start-up; ref.current = the viewer service
 *
 * Tested in tests/stream-bot-viewers.test.js.
 */
import { replyInEventChat, commandInput } from '../music/register.js';
import { formatPoints, formatWatch } from './settings.js';
import { noRewards } from '../youtube/policy.js';

const f = (name, kind, label, extra = {}) => ({ name, kind, label, ...extra });

export const COMMANDS = Object.freeze([
    { key: 'points', label: 'Points and watch time (!points, !points @name)' },
    { key: 'top', label: 'Leaderboard (!top, !top watch, !top messages)' },
    { key: 'give', label: 'Give points to someone (!give @name 100)' },
    { key: 'gamble', label: 'Gamble points (!gamble 100, all or 50%)' },
    { key: 'addpoints', label: 'Moderators: add points (!addpoints @name 100)' },
    { key: 'removepoints', label: 'Moderators: remove points (!removepoints @name 100)' },
]);
export const COMMAND_KEYS = Object.freeze(COMMANDS.map((c) => c.key));
const COMMAND_LABELS = Object.freeze(Object.fromEntries(COMMANDS.map((c) => [c.key, c.label])));

const WHO = Object.freeze({ event: 'The viewer behind the event', named: 'A viewer by name' });
const AMOUNT_MAX = 1_000_000_000;

/** The viewer a points step is about: the event's viewer, or one named by the rendered template (on the event's platform). */
async function stepViewer(svc, step, ctx) {
    if (step.who === 'named') {
        const name = String(await ctx.render(step.viewer || '')).trim().split(/\s+/)[0] || '';
        if (!name) return { error: 'the viewer name came out empty' };
        const row = await svc.findTarget(ctx.profile.id, ctx.ev, name);
        return row ? { row } : { error: `no viewer called ${name.replace(/^@/, '').slice(0, 40)} has been seen here` };
    }
    if (!ctx.ev?.user?.id || !['twitch', 'kick', 'youtube'].includes(ctx.ev.platform)) return { error: 'this event has no Twitch, Kick or YouTube viewer' };
    const row = await svc.ensureViewer(ctx.profile.id, ctx.ev);
    return row ? { row } : { error: 'viewer stats are not running yet' };
}

function pointsAction(ref, type, label, verb) {
    return {
        type, label, target: 'server', group: 'Viewers and points',
        fields: [
            f('who', 'select', 'Who', { options: Object.keys(WHO), default: 'event', optionLabels: WHO }),
            f('viewer', 'template', 'Viewer name (when "A viewer by name"), such as {arg1}', { optional: true }),
            f('amount', 'template', 'Amount, such as 100 or {amount}', type === 'points.remove' ? {} : { hint: 'Variables such as {amount} work here. Skipped for YouTube viewers: YouTube\'s API rules do not allow giving them points.' }),
        ],
        templates: ['viewer', 'amount'],
        validate(s, out, err) {
            out.who = s.who === 'named' ? 'named' : 'event';
            out.viewer = String(s.viewer ?? '').slice(0, 200).trim();
            out.amount = String(s.amount ?? '').slice(0, 200).trim();
            if (out.who === 'named' && !out.viewer) err('enter the viewer name, or a variable such as {arg1}.');
            if (!out.amount) err('enter the amount, or a variable such as {amount}.');
            else if (!out.amount.includes('{') && !/^\d{1,10}$/.test(out.amount.replace(/,/g, ''))) err('the amount is a whole number of 0 or more, or a variable.');
        },
        async execute(step, ctx) {
            const svc = ref.current;
            if (!svc) return { status: 'failed', detail: 'viewer stats are not running yet (restart needed)' };
            const raw = String(await ctx.render(step.amount)).trim().replace(/,/g, '');
            const n = /^\d{1,12}(\.\d+)?$/.test(raw) ? Math.min(AMOUNT_MAX, Math.floor(Number(raw))) : NaN;
            if (!Number.isFinite(n)) return { status: 'failed', detail: `the amount "${raw.slice(0, 40)}" is not a number` };
            if (type !== 'points.remove' && noRewards(ctx.ev?.platform)) return { status: 'skipped', detail: 'YouTube viewers cannot be given points (YouTube API policy)' };
            const who = await stepViewer(svc, step, ctx);
            if (who.error) return { status: 'skipped', detail: who.error };
            if (type !== 'points.remove' && noRewards(who.row.platform)) return { status: 'skipped', detail: 'YouTube viewers cannot be given points (YouTube API policy)' };
            if (ctx.dryRun) return { status: 'dry', detail: `would ${verb} ${formatPoints(n)} for ${who.row.name}` };
            const r = await svc.changePoints(ctx.profile.id, who.row.id, type === 'points.remove' ? -n : n, {
                mode: type === 'points.set' ? 'set' : 'add', kind: 'automation', note: `${ctx.automation?.name ? `Automation: ${ctx.automation.name}` : 'Automation'}`.slice(0, 200), actor: 'automation',
            });
            if (!r.ok && r.error === 'youtube') return { status: 'skipped', detail: 'YouTube viewers cannot be given points (YouTube API policy)' };
            if (!r.ok) return { status: 'failed', detail: r.error || 'could not change the points' };
            return { status: 'ok', detail: `${who.row.name}: ${formatPoints(r.before)} → ${formatPoints(r.balance)}` };
        },
    };
}

export function viewerActions(ref) {
    return [
        pointsAction(ref, 'points.add', 'Give points to a viewer', 'give'),
        pointsAction(ref, 'points.remove', 'Take points from a viewer', 'take'),
        pointsAction(ref, 'points.set', 'Set a viewer\'s points', 'set the points to'),
        {
            type: 'viewers.command', label: 'Viewers: run a command', target: 'server', group: 'Viewers and points',
            fields: [
                f('command', 'select', 'Command', { options: [...COMMAND_KEYS], default: 'points', optionLabels: COMMAND_LABELS }),
                f('reply', 'select', 'Answer in chat', { options: ['yes', 'no'], default: 'yes', optionLabels: { yes: 'Yes', no: 'No' } }),
            ],
            templates: [],
            validate(s, out, err) {
                out.command = COMMAND_KEYS.includes(s.command) ? s.command : null;
                if (!out.command) err('pick a command.');
                out.reply = s.reply === 'no' ? 'no' : 'yes';
            },
            async execute(step, ctx) {
                const svc = ref.current;
                if (ctx.dryRun) return { status: 'dry', detail: `would run the ${step.command} command` };
                if (!svc) return { status: 'failed', detail: 'viewer stats are not running yet (restart needed)' };
                const r = await svc.commands.run(ctx.profile, step.command, { ev: ctx.ev, input: commandInput(ctx.ev) });
                if (!r.reply || step.reply === 'no') return { status: r.reply ? 'ok' : 'skipped', detail: String(r.reply || r.detail || 'no answer').slice(0, 480) };
                const sent = await replyInEventChat(ctx.io, ctx.profile.id, ctx.ev, r.reply);
                return sent.ok ? { status: 'ok', detail: `${sent.where}: ${r.reply}`.slice(0, 480) } : { status: 'partial', detail: `${r.reply} (not sent: ${sent.error})`.slice(0, 480) };
            },
        },
    ];
}

export const RANK_UP = Object.freeze({
    type: 'viewer.rank_up', label: 'Viewer reached a new rank', group: 'Viewers', platforms: ['twitch', 'kick', 'youtube'], fields: ['user', 'rank'],
    sample: Object.freeze({ user: { id: '100000001', login: 'maplefan_88', name: 'MapleFan_88', roles: ['subscriber'] }, message: 'Regular', metadata: { rank: 'Regular', previous: 'Newcomer', basis: 'watch' } }),
});

export const VIEWER_VARS = Object.freeze([
    { token: '{user.points}', description: 'The viewer\'s points (with their linked account, if any)' },
    { token: '{user.watchtime}', description: 'How long they have watched, such as 12h 05m' },
    { token: '{user.messages}', description: 'How many chat messages they have sent' },
    { token: '{user.rank}', description: 'Their rank (empty when you have no ranks or they have not reached one)' },
    { token: '{points.name}', description: 'What you call your points, such as points or coins' },
    { token: '{rank.name}', description: 'Viewer reached a new rank: the new rank' },
    { token: '{rank.previous}', description: 'Viewer reached a new rank: the rank before (empty for the first)' },
]);
const VAR_NAMES = ['user.points', 'user.watchtime', 'user.messages', 'user.rank', 'points.name', 'rank.name', 'rank.previous'];

/** Conditions on the viewer's totals. `min` is a whole number; watch time in minutes. */
const STATS = Object.freeze({
    'viewer.points': { key: 'points', label: 'Has at least N points', help: 'Only when the viewer has at least this many points (their linked account counts too).', unit: 'points', fieldLabel: 'At least (points)', show: formatPoints },
    'viewer.watch': { key: 'watchMinutes', label: 'Watch time at least', help: 'Only when the viewer has watched for at least this many minutes in total.', unit: 'minutes', fieldLabel: 'At least (minutes watched)', show: formatWatch },
    'viewer.messages': { key: 'messages', label: 'Message count at least', help: 'Only when the viewer has sent at least this many chat messages.', unit: 'messages', fieldLabel: 'At least (messages)', show: formatPoints },
});

export function viewerConditions(ref) {
    return Object.entries(STATS).map(([type, d]) => ({
        type, label: d.label, help: d.help,
        fields: [{ name: 'min', kind: 'number', label: d.fieldLabel, min: 0, max: 1_000_000_000, step: 1, default: 1 }],
        load: { key: 'viewer', fn: (ctx) => (ref.current ? ref.current.conditionData(ctx) : { found: false, points: 0, watchMinutes: 0, messages: 0 }) },
        check(c, ev, ctx) {
            const data = ctx?.loaded?.viewer || { found: false, points: 0, watchMinutes: 0, messages: 0 };
            const have = Number(data[d.key]) || 0;
            const ok = have >= Number(c.min);
            const who = ev?.user?.name || 'the viewer';
            return { ok, detail: `${who} has ${d.show(have)}${d.unit === 'minutes' ? ' watched' : ` ${d.unit}`}; needs ${d.show(c.min)}` };
        },
        validate(c, err) {
            const n = Number(c.min);
            if (c.min === '' || c.min == null || !Number.isFinite(n) || n < 0) err(`${d.label}: enter a number of 0 or more.`);
            return { type, min: Number.isFinite(n) ? Math.min(1_000_000_000, Math.max(0, Math.round(n))) : 0 };
        },
    }));
}

/** Call once at start-up with the engine modules. Returns what was registered (false when a hook is missing). */
export function registerViewers({ ref, actions, events, render, conditions }) {
    const out = { actions: false, event: false, vars: false, conditions: false };
    if (typeof actions?.registerActionType === 'function') out.actions = viewerActions(ref).map((a) => actions.registerActionType(a)).every((x) => x !== false);
    if (typeof events?.registerEventType === 'function') out.event = events.registerEventType(RANK_UP) !== false;
    if (typeof render?.registerTemplateVars === 'function') {
        out.vars = render.registerTemplateVars({
            names: VAR_NAMES, vars: VIEWER_VARS,
            values: async ({ ev, profileId, template }) => {
                const base = ev?.type === 'viewer.rank_up' ? { 'rank.name': String(ev.metadata?.rank ?? ''), 'rank.previous': String(ev.metadata?.previous ?? '') } : { 'rank.name': '', 'rank.previous': '' };
                const svc = ref.current;
                return { ...base, ...(svc ? await svc.templateValues({ ev, profileId, template }) : {}) };
            },
        }) !== false;
    }
    if (typeof conditions?.registerConditionType === 'function') out.conditions = viewerConditions(ref).map((c) => conditions.registerConditionType(c)).every((x) => x !== false);
    return out;
}

export default { registerViewers, viewerActions, viewerConditions, RANK_UP, VIEWER_VARS, COMMANDS, COMMAND_KEYS };
