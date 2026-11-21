/*
 * Stream bot: action text through the custom-command template engine (core/custom-command-vars.js).
 *
 * The event's values are passed as variables, never spliced into the template, so a viewer's message or
 * name cannot add tokens. Stream-bot names are added with renderTemplate's `extraVars` option.
 *   {db:…}  per viewer   owner '<platform>:<viewer id>' (disabled when the event has no viewer id)
 *   {sdb:…} per channel  owner 'server'
 * in stream_bot_variables through store.variableStore. {api:…} goes through utils/safe-fetch.js with the
 * shared limiter keyed 'sb:<profile id>'.
 *
 * Also (2026-11-19): {stream.title} {stream.category} {stream.uptime} {stream.viewers} (stream-info.js, read only when the
 * text uses one, cached 60 s), {args.<name>} and step outputs such as {clip.url} (the run's own values), and the
 * Power-up and Counter changed details ({powerup}, {counter.name}, {counter.value}, {counter.old}).
 */
import { renderTemplate, validateTemplate } from '../custom-command-vars.js';
import { streamValues } from './stream-info.js';

export const STREAM_VARS = [   // not frozen: registerTemplateVars() adds feature variables (core/stream-bot/music)
    { token: '{user.name}', description: 'Name of the person behind the event (the follower, subscriber, tipper, chatter)' },
    { token: '{event.type}', description: 'The event type, such as follow or cheer' },
    { token: '{event.platform}', description: 'Where it came from: twitch, kick, streamelements, kofi …' },
    { token: '{amount}', description: 'Bits, viewers, months, gift count, points or tip amount' },
    { token: '{currency}', description: 'USD, bits, viewers, months, subs or points' },
    { token: '{message}', description: 'The message that came with it (chat text, cheer or tip message)' },
    { token: '{reward}', description: 'Channel points reward title' },
    { token: '{tier}', description: 'Sub tier: 1, 2 or 3 (Prime shows as Prime)' },
    { token: '{months}', description: 'Total months subscribed' },
    { token: '{viewers}', description: 'Raid size' },
    { token: '{count}', description: 'Number of gift subs' },
    { token: '{title}', description: 'Poll or prediction title' },
    { token: '{winner}', description: 'Winning poll choice or prediction outcome' },
    { token: '{channel.name}', description: 'Your channel name on that platform' },
    { token: '{stream.title}', description: 'Your current stream title (read from Twitch or Kick, at most a minute old)' },
    { token: '{stream.category}', description: 'Your current category or game' },
    { token: '{stream.uptime}', description: 'How long you have been live, such as 2h 05m (offline when you are not live)' },
    { token: '{stream.viewers}', description: 'Viewers watching now' },
    { token: '{args.name}', description: 'An argument set earlier in this run with "Set an argument"' },
    { token: '{clip.url}', description: 'The link of the clip a "Create a clip" step made earlier in this run' },
    { token: '{powerup}', description: 'The power-up used: message effect, celebration, giant emote, or the title of your own custom power-up' },
    { token: '{counter.name}', description: 'Counter changed: which value changed' },
    { token: '{counter.value}', description: 'Counter changed: the new value' },
    { token: '{counter.old}', description: 'Counter changed: the value before' },
    { token: '{sdb:incr:deaths}', description: 'A counter for your channel (also get, set, del)' },
    { token: '{db:get:points}', description: 'A value stored for this viewer' },
    { token: '{random:1-100}', description: 'A random number' },
    { token: '{choice:a|b|c}', description: 'One of the options at random' },
];

const BASE_EXTRA = new Set(['event.type', 'event.platform', 'amount', 'currency', 'message', 'reward', 'tier', 'months', 'viewers', 'count', 'level', 'title', 'winner',
    'powerup', 'counter.name', 'counter.value', 'counter.old', 'stream.title', 'stream.category', 'stream.uptime', 'stream.viewers', 'stream.live',
    'clip.url', 'clip.id', 'poll.id', 'prediction.id']);
/** renderTemplate's extraVars: the fixed names plus any {args.<name>} (names are lower-cased by the parser). */
const REGISTERED_VARS = new Set();
const VAR_PROVIDERS = [];
const EXTRA = Object.freeze({ has: (n) => BASE_EXTRA.has(n) || REGISTERED_VARS.has(n) || /^args\.[a-z0-9_]{1,32}$/.test(n) });
/**
 * Registration hook for feature modules (core/stream-bot/music/register.js): plain variable names (lower case), their
 * descriptions for the editor, and values({ ev, profileId, template }) → { name: value } (or a promise of it) at render time.
 * A provider that reads the database looks at `template` and returns {} unless the text uses one of its names.
 */
export function registerTemplateVars({ names = [], vars = [], values } = {}) {
    if (typeof values !== 'function') return false;
    for (const n of names) REGISTERED_VARS.add(String(n).toLowerCase());
    for (const v of vars) if (!STREAM_VARS.some((x) => x.token === v.token)) STREAM_VARS.push(v);
    VAR_PROVIDERS.push(values);
    return true;
}
const POWER_UP = Object.freeze({ message_effect: 'message effect', celebration: 'celebration', gigantify_an_emote: 'giant emote' });

const fmtAmount = (n) => (n == null ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const tierLabel = (t) => (t == null ? '' : String(t) === 'prime' ? 'Prime' : /^\d000$/.test(String(t)) ? String(Number(t) / 1000) : String(t));

/** Template variables for an event. */
export function templateValues(ev, { channelName = '' } = {}) {
    const name = ev?.user?.name || ev?.user?.login || '';
    const m = ev?.metadata || {};
    return {
        'user.name': name, 'user.id': ev?.user?.id || '', 'user.tag': ev?.user?.login || name, 'user.mention': name ? `@${name}` : '',
        sender: name, 'sender.mention': name ? `@${name}` : '', touser: name,
        'channel.name': channelName || '', 'channel.mention': channelName || '', 'channel.id': ev?.channelId || '',
        'server.name': channelName || '', 'server.id': '',
        'event.type': ev?.type || '', 'event.platform': ev?.platform || '',
        amount: fmtAmount(ev?.amount), currency: ev?.currency || '', message: ev?.message || '',
        reward: m.reward || '', tier: tierLabel(m.tier), months: m.months != null ? String(m.months) : '',
        viewers: m.viewers != null ? String(m.viewers) : (ev?.type === 'raid' ? fmtAmount(ev.amount) : ''),
        count: m.count != null ? String(m.count) : '', level: m.level != null ? String(m.level) : '',
        title: m.title || '', winner: m.winner || '',
        powerup: POWER_UP[m.powerUp] || (ev?.type === 'bits.used' && m.kind === 'custom_power_up' && m.powerUpTitle ? String(m.powerUpTitle) : '')
            || (ev?.type === 'bits.used' && m.kind ? String(m.kind).replace(/_/g, ' ') : ''),
        'counter.name': ev?.type === 'variable.changed' ? String(m.key ?? '') : '',
        'counter.value': ev?.type === 'variable.changed' ? String(m.value ?? '') : '',
        'counter.old': ev?.type === 'variable.changed' ? String(m.oldValue ?? '') : '',
    };
}

/** Owner key for {db:} values of the event's viewer, or null when there is no stable id. */
export function viewerOwner(ev) {
    const id = ev?.user?.id;
    if (!id || !ev.platform) return null;
    return `${ev.platform}:${String(id).slice(0, 64)}`;
}

/**
 * @param {object} deps { variableStore, fetcher?(url), onError?(err) }
 * @returns {(template, { ev, profileId, automationId, channelName }) => Promise<string>}
 */
export function createRenderer({ variableStore, fetcher = null, onError = () => {} } = {}) {
    return async function render(template, { ev, profileId, automationId = 0, channelName = '', vars = null, stream = null } = {}) {
        if (!template) return '';
        const values = templateValues(ev, { channelName });
        for (const p of VAR_PROVIDERS) { try { Object.assign(values, (await p({ ev, profileId, template: String(template) })) || {}); } catch { /* a feature's values never break a run */ } }
        // Unset outputs and arguments render empty rather than as the literal token.
        for (const k of ['clip.url', 'clip.id', 'poll.id', 'prediction.id']) values[k] = '';
        for (const [k, v] of Object.entries(vars || {})) values[String(k).toLowerCase()] = String(v ?? '');
        const text0 = String(template);
        for (const m of text0.matchAll(/\{args\.([a-z0-9_]{1,32})\}/gi)) { const k = `args.${m[1].toLowerCase()}`; if (values[k] === undefined) values[k] = ''; }
        if (/\{stream\./i.test(text0)) {
            let info = null;
            try { info = stream ? await stream() : null; } catch { info = null; }
            Object.assign(values, streamValues(info));
        }
        const args = String(ev?.message || '').trim().split(/\s+/).filter(Boolean).slice(1, 10);
        const api = fetcher ? { guildId: `sb:${profileId}`, commandKey: `automation:${automationId}`, deps: { fetcher, onError: (code) => onError(new Error(code)) } } : null;
        const storage = variableStore ? { store: variableStore, guildId: profileId, userId: viewerOwner(ev), onError } : null;
        const { text } = await renderTemplate(String(template), { values, args }, api, storage, { extraVars: EXTRA });
        return text;
    };
}

/** Save-time warnings for a template (unknown variables and so on). */
export function templateWarnings(text) {
    return validateTemplate(String(text || ''), { extraVars: EXTRA }).warnings;
}

export default { STREAM_VARS, templateValues, viewerOwner, createRenderer, templateWarnings };
