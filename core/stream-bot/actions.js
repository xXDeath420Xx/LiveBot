/*
 * Stream bot: the action catalogue and its validation (design §2.3).
 *
 * `target` says who carries an action out:
 *   server   this process (engine.js runs it)
 *   studio   CertiFried Studio on the streamer's PC, over the realtime channel (Phase 2 implements them)
 *   overlay  an OBS browser-source overlay, over the realtime channel (Phase 3)
 * `capability` is what a device must announce in its hello for the action to be sent to it.
 * `templates` are the fields rendered with the template engine before running or dispatching.
 *
 * A later phase adds an action by adding an entry here (and, for server actions, a case in engine.js).
 * Tested in tests/stream-bot-engine.test.js.
 */

import { validateConditions } from './conditions.js';

export const LIMITS = Object.freeze({
    steps: 25, nesting: 3, text: 500, template: 2000, delayMax: 600, delayTotal: 900, branches: 10, queueMax: 3600, queueDefault: 120,
});

const f = (name, kind, label, extra = {}) => ({ name, kind, label, ...extra });

export const ACTION_TYPES = [   // not frozen: registerActionType() adds feature actions (core/stream-bot/music)
    { type: 'chat.send', label: 'Send a chat message', target: 'server', group: 'Chat',
        fields: [f('platform', 'select', 'Where', { options: ['event', 'twitch', 'kick', 'youtube', 'all'], default: 'event' }), f('text', 'template', 'Message')], templates: ['text'] },
    { type: 'discord.post', label: 'Post in Discord', target: 'server', group: 'Discord',
        fields: [f('guildId', 'guild', 'Server'), f('channelId', 'channel', 'Channel'), f('text', 'template', 'Message')], templates: ['text'] },
    { type: 'delay', label: 'Wait', target: 'server', group: 'Flow', fields: [f('seconds', 'number', 'Seconds', { min: 0.1, max: LIMITS.delayMax })] },
    { type: 'variable.set', label: 'Set a variable', target: 'server', group: 'Variables',
        fields: [f('scope', 'select', 'For', { options: ['channel', 'user'], default: 'channel' }), f('key', 'key', 'Name'), f('value', 'template', 'Value')], templates: ['value'] },
    { type: 'variable.increment', label: 'Add to a counter', target: 'server', group: 'Variables',
        fields: [f('scope', 'select', 'For', { options: ['channel', 'user'], default: 'channel' }), f('key', 'key', 'Name'), f('by', 'number', 'Add', { min: -1000, max: 1000, default: 1 })] },
    { type: 'webhook.post', label: 'Send a webhook', target: 'server', group: 'Web',
        fields: [f('url', 'url', 'URL (https, on your allow-list)'), f('body', 'template', 'Body (empty sends the event as JSON)', { optional: true })], templates: ['body'] },
    { type: 'automation.run', label: 'Run another automation', target: 'server', group: 'Flow', fields: [f('automationId', 'automation', 'Automation')] },
    { type: 'random', label: 'Pick one at random', target: 'server', group: 'Flow', fields: [f('branches', 'branches', 'Choices')] },
    // Flow additions (2026-11-19): a step that branches on a check, and temporary arguments ({args.name}) for later steps.
    { type: 'if', label: 'If ... then ... otherwise', target: 'server', group: 'Flow', fields: [f('check', 'check', 'Check'), f('then', 'ifbranches', 'Then')] },
    { type: 'args.set', label: 'Set an argument for later steps', target: 'server', group: 'Flow',
        fields: [f('name', 'key', 'Argument name (use it as {args.name})'), f('value', 'template', 'Value')], templates: ['value'] },

    // Stream management (Phase 4 pulled forward). `executor: 'stream'` runs in core/stream-bot/stream-actions.js;
    // `platforms` is where the action works (the editor marks Twitch-only ones).
    { type: 'stream.title', label: 'Change the stream title', target: 'server', executor: 'stream', group: 'Stream', platforms: ['twitch', 'kick'],
        fields: [f('platform', 'select', 'Where', { options: ['event', 'twitch', 'kick', 'all'], default: 'event' }), f('title', 'template', 'New title')], templates: ['title'] },
    { type: 'stream.category', label: 'Change the stream category', target: 'server', executor: 'stream', group: 'Stream', platforms: ['twitch', 'kick'],
        fields: [f('platform', 'select', 'Where', { options: ['event', 'twitch', 'kick', 'all'], default: 'event' }), f('category', 'template', 'Category name, such as Just Chatting')], templates: ['category'] },
    { type: 'stream.clip', label: 'Create a clip', target: 'server', executor: 'stream', group: 'Stream', platforms: ['twitch'], fields: [],
        outputs: ['clip.url', 'clip.id'] },
    { type: 'stream.ad', label: 'Run an ad', target: 'server', executor: 'stream', group: 'Stream', platforms: ['twitch'],
        fields: [f('length', 'select', 'Length (seconds)', { options: ['30', '60', '90', '120', '150', '180'], default: '30' })] },
    { type: 'stream.raid', label: 'Start a raid', target: 'server', executor: 'stream', group: 'Stream', platforms: ['twitch'],
        fields: [f('target', 'template', 'Channel to raid, such as {arg1}')], templates: ['target'] },
    { type: 'stream.poll', label: 'Start a poll', target: 'server', executor: 'stream', group: 'Polls and predictions', platforms: ['twitch'],
        fields: [f('title', 'template', 'Question'), f('choices', 'lines', 'Choices, one per line (2 to 5)'), f('duration', 'number', 'Runs for (seconds)', { min: 15, max: 1800, default: 120 })],
        templates: ['title'], outputs: ['poll.id'] },
    { type: 'stream.poll_end', label: 'End the poll', target: 'server', executor: 'stream', group: 'Polls and predictions', platforms: ['twitch'],
        fields: [f('show', 'select', 'Result', { options: ['show', 'archive'], default: 'show' })] },
    { type: 'stream.prediction', label: 'Start a prediction', target: 'server', executor: 'stream', group: 'Polls and predictions', platforms: ['twitch'],
        fields: [f('title', 'template', 'Question'), f('outcomes', 'lines', 'Outcomes, one per line (2 to 10)'), f('window', 'number', 'Open for (seconds)', { min: 30, max: 1800, default: 120 })],
        templates: ['title'], outputs: ['prediction.id'] },
    { type: 'stream.prediction_end', label: 'Lock, resolve or cancel the prediction', target: 'server', executor: 'stream', group: 'Polls and predictions', platforms: ['twitch'],
        fields: [f('action', 'select', 'Do', { options: ['resolve', 'lock', 'cancel'], default: 'resolve' }), f('winner', 'template', 'Winning outcome (to resolve)', { optional: true })], templates: ['winner'] },
    { type: 'stream.announce', label: 'Send a chat announcement', target: 'server', executor: 'stream', group: 'Chat', platforms: ['twitch'],
        fields: [f('text', 'template', 'Announcement'), f('color', 'select', 'Colour', { options: ['primary', 'blue', 'green', 'orange', 'purple'], default: 'primary' })], templates: ['text'] },
    { type: 'stream.shoutout', label: 'Shout out a channel', target: 'server', executor: 'stream', group: 'Chat', platforms: ['twitch', 'kick'],
        fields: [f('platform', 'select', 'Where', { options: ['event', 'twitch', 'kick', 'all'], default: 'event' }), f('target', 'template', 'Channel, such as {arg1}')], templates: ['target'] },
    { type: 'chat.clear', label: 'Clear chat', target: 'server', executor: 'stream', group: 'Chat', platforms: ['twitch'], fields: [] },
    { type: 'chat.delete', label: 'Delete the message that triggered this', target: 'server', executor: 'stream', group: 'Chat', platforms: ['twitch', 'kick', 'youtube'], fields: [] },

    { type: 'obs.scene', label: 'OBS: switch scene', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('scene', 'text', 'Scene name', { suggest: 'scenes' })], templates: ['scene'] },
    { type: 'obs.preview', label: 'OBS: set the preview scene (Studio Mode)', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('scene', 'text', 'Scene name', { suggest: 'scenes' })], templates: ['scene'] },
    { type: 'obs.transition', label: 'OBS: transition preview to program', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('transition', 'text', 'Transition (empty: the current one)', { optional: true }), f('durationMs', 'number', 'Duration (ms, empty: the current one)', { min: 0, max: 20000, optional: true })] },
    { type: 'obs.source', label: 'OBS: show or hide a source', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('scene', 'text', 'Scene (empty: current)', { optional: true, suggest: 'scenes' }), f('source', 'text', 'Source name', { suggest: 'sources' }), f('visible', 'select', 'Make it', { options: ['show', 'hide', 'toggle'], default: 'toggle' })], templates: ['scene', 'source'] },
    { type: 'obs.mute', label: 'OBS: mute or unmute an audio source', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('input', 'text', 'Audio source', { suggest: 'inputs' }), f('state', 'select', 'Action', { options: ['mute', 'unmute', 'toggle'], default: 'toggle' })], templates: ['input'] },
    { type: 'obs.volume', label: 'OBS: set the volume of an audio source', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('input', 'text', 'Audio source', { suggest: 'inputs' }), f('volume', 'number', 'Volume (0-100)', { min: 0, max: 100, default: 100 })], templates: ['input'] },
    { type: 'obs.filter', label: 'OBS: turn a filter on or off', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('source', 'text', 'Source', { suggest: 'filterSources' }), f('filter', 'text', 'Filter', { suggest: 'filters' }), f('state', 'select', 'Action', { options: ['enable', 'disable', 'toggle'], default: 'toggle' })], templates: ['source', 'filter'] },
    { type: 'obs.stream', label: 'OBS: streaming', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('state', 'select', 'Action', { options: ['start', 'stop', 'toggle'], default: 'start' })] },
    { type: 'obs.record', label: 'OBS: recording', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('state', 'select', 'Action', { options: ['start', 'stop', 'toggle', 'pause', 'resume', 'toggle_pause'], default: 'toggle' })] },
    { type: 'obs.replay', label: 'OBS: replay buffer', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('state', 'select', 'Action', { options: ['save', 'start', 'stop'], default: 'save' })] },
    { type: 'obs.virtualcam', label: 'OBS: virtual camera', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('state', 'select', 'Action', { options: ['start', 'stop', 'toggle'], default: 'toggle' })] },
    { type: 'obs.screenshot', label: 'OBS: save a screenshot', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('source', 'text', 'Source or scene (empty: what is on air)', { optional: true, suggest: 'scenesAndSources' })], templates: ['source'] },
    { type: 'obs.text', label: 'OBS: set text source', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('source', 'text', 'Text source', { suggest: 'textSources' }), f('text', 'template', 'Text')], templates: ['source', 'text'] },
    { type: 'obs.browser_url', label: 'OBS: change a browser source URL', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('source', 'text', 'Browser source', { suggest: 'browserSources' }), f('url', 'template', 'URL (http or https)')], templates: ['source', 'url'] },
    { type: 'obs.browser_refresh', label: 'OBS: refresh a browser source', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('source', 'text', 'Browser source', { suggest: 'browserSources' })], templates: ['source'] },
    { type: 'obs.hotkey', label: 'OBS: trigger a hotkey by name', target: 'studio', capability: 'obs', group: 'OBS', phase: 2,
        fields: [f('name', 'text', 'Hotkey name, e.g. OBSBasic.StartStreaming')] },
    { type: 'sound.play', label: 'Play a sound', target: 'studio', capability: 'sound', group: 'Sound', phase: 2,
        fields: [f('sound', 'text', 'Sound name, file or https:// URL', { suggest: 'sounds' }), f('volume', 'number', 'Volume (0-100)', { min: 0, max: 100, default: 80 }),
            f('mode', 'select', 'If a sound is already playing', { options: ['overlap', 'queue'], default: 'overlap' })], templates: ['sound'] },
    { type: 'sound.stop', label: 'Stop all sounds', target: 'studio', capability: 'sound', group: 'Sound', phase: 2, fields: [] },
    { type: 'studio.hotkey', label: 'Press a hotkey', target: 'studio', capability: 'hotkey', group: 'Studio', phase: 2,
        fields: [f('keys', 'text', 'Keys, e.g. Ctrl+Shift+F1')] },
    { type: 'light.set', label: 'Set a light', target: 'studio', capability: 'light', group: 'Lights', phase: 5,
        // Phase 5: the device field is the light picker (Studio's lights and cloud lights; core/stream-bot/devices). More light actions register there.
        fields: [f('device', 'light', 'Light', { optional: true }), f('color', 'color', 'Colour', { default: '#9146ff' }), f('brightness', 'number', 'Brightness (0-100)', { min: 0, max: 100, default: 100 }), f('durationMs', 'number', 'For (ms, 0 = stay)', { min: 0, max: 600000, default: 0 })] },
    { type: 'overlay.alert', label: 'Show an overlay alert', target: 'overlay', capability: 'alert', group: 'Overlay', phase: 3,
        fields: [f('title', 'template', 'Title'), f('message', 'template', 'Message', { optional: true }), f('durationMs', 'number', 'Show for (ms)', { min: 1000, max: 60000, default: 6000 }), f('style', 'text', 'Style', { optional: true, default: 'default' })], templates: ['title', 'message'] },
];

const BY_TYPE = new Map(ACTION_TYPES.map((a) => [a.type, a]));
export const actionType = (t) => BY_TYPE.get(t) || null;
/**
 * Registration hook for feature modules (core/stream-bot/music/register.js): a server action that brings its own
 * validate(step, out, err, ctx) and execute(step, ctx). ctx is the engine's step context plus render, io and store.
 */
export function registerActionType(def) {
    if (!def?.type || BY_TYPE.has(def.type) || typeof def.execute !== 'function') return false;
    ACTION_TYPES.push(def);
    BY_TYPE.set(def.type, def);
    return true;
}
export const isClientAction = (t) => ['studio', 'overlay'].includes(BY_TYPE.get(t)?.target);
/** Server actions carried out by core/stream-bot/stream-actions.js (Twitch Helix / Kick API). */
export const isStreamAction = (t) => BY_TYPE.get(t)?.executor === 'stream';
/** Steps that hold nested step lists: random (branches[].actions) and if (then, else). */
export function childLists(s) {
    if (s?.type === 'random') return (s.branches || []).map((b) => b?.actions || []);
    if (s?.type === 'if') return [s.then || [], s.else || []];
    return [];
}

export const TARGET_LABEL = Object.freeze({ studio: 'Needs CertiFried Studio', overlay: 'Needs an overlay' });

const KEY = /^[a-z0-9_.-]{1,64}$/;
const ARG = /^[a-z0-9_]{1,32}$/;
/** What an If step can check (the per-run conditions; cooldowns and rate limits belong to the automation). */
export const IF_CHECKS = Object.freeze(['role', 'amount', 'text', 'metadata']);
const SNOWFLAKE = /^\d{17,20}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const num = (v) => (v === '' || v == null ? NaN : Number(v));
const txt = (v, max = LIMITS.text) => String(v ?? '').slice(0, max);
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);

/** Count every step, branch steps included. */
export function countSteps(list) {
    let n = 0;
    for (const s of list || []) {
        n++;
        for (const inner of childLists(s)) n += countSteps(inner);
    }
    return n;
}

/**
 * Validate an action list from the dashboard.
 * @param {object[]} list
 * @param {object} ctx  { automationIds: Set<number>, selfId, guildIds: Set<string>, allowHosts: string[] }
 *                      (guild and automation checks are skipped when the set is not given)
 * @returns {{ ok, errors[], value[] }}
 */
export function validateActions(list, ctx = {}, depth = 0) {
    const errors = [];
    const value = [];
    if (!Array.isArray(list)) return { ok: false, errors: ['Add at least one action.'], value };
    if (depth === 0) {
        if (!list.length) errors.push('Add at least one action.');
        if (countSteps(list) > LIMITS.steps) errors.push(`At most ${LIMITS.steps} actions, choices included.`);
    }
    for (const raw of list) {
        const s = raw || {};
        const def = BY_TYPE.get(s.type);
        if (!def) { errors.push(`Unknown action "${txt(s.type, 30)}".`); continue; }
        const out = { type: s.type };
        const err = (m) => errors.push(`${def.label}: ${m}`);
        switch (s.type) {
            case 'chat.send':
                out.platform = ['event', 'twitch', 'kick', 'youtube', 'all'].includes(s.platform) ? s.platform : 'event';
                out.text = txt(s.text, LIMITS.template).trim();
                if (!out.text) err('enter the message.');
                break;
            case 'discord.post':
                out.guildId = String(s.guildId || '');
                out.channelId = String(s.channelId || '');
                out.text = txt(s.text, LIMITS.template).trim();
                if (!SNOWFLAKE.test(out.guildId)) err('pick a server.');
                else if (ctx.guildIds && !ctx.guildIds.has(out.guildId)) err('you can only post in servers you manage.');
                if (!SNOWFLAKE.test(out.channelId)) err('pick a channel.');
                if (!out.text) err('enter the message.');
                break;
            case 'delay': {
                const n = num(s.seconds);
                if (!Number.isFinite(n) || n < 0.1 || n > LIMITS.delayMax) err(`between 0.1 and ${LIMITS.delayMax} seconds.`);
                out.seconds = Number.isFinite(n) ? Math.min(LIMITS.delayMax, Math.max(0.1, Math.round(n * 10) / 10)) : 1;
                break;
            }
            case 'variable.set':
            case 'variable.increment': {
                out.scope = s.scope === 'user' ? 'user' : 'channel';
                out.key = String(s.key || '').trim().toLowerCase();
                if (!KEY.test(out.key)) err('the name may use 1 to 64 letters, numbers, _ . or -.');
                if (s.type === 'variable.set') out.value = txt(s.value, 1000);
                else {
                    const by = num(s.by ?? 1);
                    if (!Number.isInteger(by) || Math.abs(by) > 1000) err('add a whole number from -1000 to 1000.');
                    out.by = Number.isInteger(by) ? by : 1;
                }
                break;
            }
            case 'webhook.post': {
                out.url = txt(s.url, 500).trim();
                out.body = txt(s.body, LIMITS.template);
                let u = null;
                try { u = new URL(out.url); } catch { err('enter a full https:// URL.'); break; }
                if (u.protocol !== 'https:') err('the URL must start with https://.');
                else if (ctx.allowHosts && !ctx.allowHosts.includes(u.hostname.toLowerCase())) err(`add ${u.hostname} to your webhook allow-list first.`);
                break;
            }
            case 'automation.run': {
                const id = Number(s.automationId);
                if (!Number.isInteger(id) || id <= 0) err('pick an automation.');
                else if (ctx.selfId && id === Number(ctx.selfId)) err('an automation cannot run itself.');
                else if (ctx.automationIds && !ctx.automationIds.has(id)) err('that automation does not exist.');
                out.automationId = id;
                break;
            }
            case 'random': {
                if (depth >= LIMITS.nesting) { err(`choices can be nested at most ${LIMITS.nesting} deep.`); break; }
                const branches = Array.isArray(s.branches) ? s.branches.slice(0, LIMITS.branches) : [];
                if (branches.length < 2) err('add at least two choices.');
                out.branches = [];
                for (const b of branches) {
                    const w = num(b?.weight ?? 1);
                    const inner = validateActions(Array.isArray(b?.actions) ? b.actions : [], ctx, depth + 1);
                    errors.push(...inner.errors);
                    out.branches.push({ weight: Number.isFinite(w) && w > 0 ? Math.min(1000, w) : 1, actions: inner.value });
                }
                break;
            }
            case 'if': {
                if (depth >= LIMITS.nesting) { err(`steps can be nested at most ${LIMITS.nesting} deep.`); break; }
                const c = s.check && typeof s.check === 'object' ? s.check : {};
                if (!IF_CHECKS.includes(c.type)) { err('pick what to check: role, amount, text or an event detail.'); out.check = { type: 'metadata', path: '', op: 'eq', value: '' }; }
                else {
                    const v = validateConditions([c]);
                    for (const e of v.errors) err(e.charAt(0).toLowerCase() + e.slice(1));
                    out.check = v.value[0];
                }
                const yes = validateActions(Array.isArray(s.then) ? s.then : [], ctx, depth + 1);
                const no = validateActions(Array.isArray(s.else) ? s.else : [], ctx, depth + 1);
                errors.push(...yes.errors, ...no.errors);
                out.then = yes.value;
                out.else = no.value;
                if (!out.then.length && !out.else.length) err('add an action to "then" or "otherwise".');
                break;
            }
            case 'args.set':
                out.name = String(s.name || '').trim().toLowerCase();
                if (!ARG.test(out.name)) err('the argument name may use 1 to 32 letters, numbers or _.');
                out.value = txt(s.value, LIMITS.template);
                break;
            case 'stream.title':
            case 'stream.category': {
                const k = s.type === 'stream.title' ? 'title' : 'category';
                out.platform = ['event', 'twitch', 'kick', 'all'].includes(s.platform) ? s.platform : 'event';
                out[k] = txt(s[k], LIMITS.template).trim();
                if (!out[k]) err(k === 'title' ? 'enter the title.' : 'enter the category name.');
                break;
            }
            case 'stream.clip':
            case 'chat.clear':
            case 'chat.delete':
                break;
            case 'stream.ad':
                out.length = ['30', '60', '90', '120', '150', '180'].includes(String(s.length)) ? Number(s.length) : 30;
                break;
            case 'stream.raid':
            case 'stream.shoutout':
                if (s.type === 'stream.shoutout') out.platform = ['event', 'twitch', 'kick', 'all'].includes(s.platform) ? s.platform : 'event';
                out.target = txt(s.target, 200).trim();
                if (!out.target) err('enter the channel name or a variable such as {arg1}.');
                break;
            case 'stream.poll':
            case 'stream.prediction': {
                const poll = s.type === 'stream.poll';
                const listKey = poll ? 'choices' : 'outcomes';
                const max = poll ? 5 : 10;
                out.title = txt(s.title, 300).trim();
                const items = String(s[listKey] ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
                out[listKey] = items.slice(0, max).map((x) => x.slice(0, 100)).join('\n');
                if (!out.title) err('enter the question.');
                if (items.length < 2 || items.length > max) err(`enter 2 to ${max} ${poll ? 'choices' : 'outcomes'}, one per line.`);
                const n = num(poll ? s.duration ?? 120 : s.window ?? 120);
                const lo = poll ? 15 : 30;
                if (!Number.isFinite(n) || n < lo || n > 1800) err(`${poll ? 'the poll runs' : 'the prediction is open'} ${lo} to 1800 seconds.`);
                out[poll ? 'duration' : 'window'] = Number.isFinite(n) ? Math.min(1800, Math.max(lo, Math.round(n))) : 120;
                break;
            }
            case 'stream.poll_end':
                out.show = s.show === 'archive' ? 'archive' : 'show';
                break;
            case 'stream.prediction_end':
                out.action = pick(s.action, ['resolve', 'lock', 'cancel'], 'resolve');
                out.winner = txt(s.winner, 200).trim();
                if (out.action === 'resolve' && !out.winner) err('enter the winning outcome (its title, or a variable).');
                break;
            case 'stream.announce':
                out.text = txt(s.text, LIMITS.template).trim();
                out.color = pick(s.color, ['primary', 'blue', 'green', 'orange', 'purple'], 'primary');
                if (!out.text) err('enter the announcement.');
                break;
            case 'obs.scene':
            case 'obs.preview': out.scene = txt(s.scene, 200).trim(); if (!out.scene) err('enter the scene name.'); break;
            case 'obs.transition': {
                out.transition = txt(s.transition, 200).trim();
                if (s.durationMs !== undefined && s.durationMs !== null && s.durationMs !== '') {
                    const d = num(s.durationMs);
                    if (!Number.isFinite(d) || d < 0 || d > 20000) err('the duration is 0 to 20000 ms, or empty.');
                    else out.durationMs = Math.round(d);
                }
                break;
            }
            case 'obs.source':
                out.scene = txt(s.scene, 200).trim();
                out.source = txt(s.source, 200).trim();
                out.visible = ['show', 'hide', 'toggle'].includes(s.visible) ? s.visible : 'toggle';
                if (!out.source) err('enter the source name.');
                break;
            case 'obs.mute':
                out.input = txt(s.input, 200).trim();
                out.state = pick(s.state, ['mute', 'unmute', 'toggle'], 'toggle');
                if (!out.input) err('enter the audio source name.');
                break;
            case 'obs.volume': {
                out.input = txt(s.input, 200).trim();
                const v = num(s.volume ?? 100);
                if (!Number.isFinite(v) || v < 0 || v > 100) err('the volume is 0 to 100.');
                out.volume = Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 100;
                if (!out.input) err('enter the audio source name.');
                break;
            }
            case 'obs.filter':
                out.source = txt(s.source, 200).trim();
                out.filter = txt(s.filter, 200).trim();
                out.state = pick(s.state, ['enable', 'disable', 'toggle'], 'toggle');
                if (!out.source) err('enter the source name.');
                if (!out.filter) err('enter the filter name.');
                break;
            case 'obs.stream': out.state = pick(s.state, ['start', 'stop', 'toggle'], 'start'); break;
            case 'obs.record': out.state = pick(s.state, ['start', 'stop', 'toggle', 'pause', 'resume', 'toggle_pause'], 'toggle'); break;
            case 'obs.replay': out.state = pick(s.state, ['save', 'start', 'stop'], 'save'); break;
            case 'obs.virtualcam': out.state = pick(s.state, ['start', 'stop', 'toggle'], 'toggle'); break;
            case 'obs.screenshot': out.source = txt(s.source, 200).trim(); break;
            case 'obs.text':
                out.source = txt(s.source, 200).trim();
                out.text = txt(s.text, LIMITS.template);
                if (!out.source) err('enter the text source name.');
                break;
            case 'obs.browser_url':
                out.source = txt(s.source, 200).trim();
                out.url = txt(s.url, LIMITS.template).trim();
                if (!out.source) err('enter the browser source name.');
                // A template may build the URL; when it is plain text it must already be http(s).
                if (!out.url) err('enter the URL.');
                else if (!out.url.includes('{') && !/^https?:\/\/[^\s]+$/i.test(out.url)) err('the URL must start with http:// or https://.');
                break;
            case 'obs.browser_refresh':
                out.source = txt(s.source, 200).trim();
                if (!out.source) err('enter the browser source name.');
                break;
            case 'obs.hotkey':
                out.name = txt(s.name, 200).trim();
                if (!/^[A-Za-z0-9_.: -]{1,200}$/.test(out.name)) err('enter the hotkey name as OBS lists it, such as OBSBasic.StartStreaming.');
                break;
            case 'sound.play': {
                out.sound = txt(s.sound, 300).trim();
                const v = num(s.volume ?? 80);
                out.volume = Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 80;
                out.mode = pick(s.mode, ['overlap', 'queue'], 'overlap');
                if (!out.sound) err('enter the sound.');
                break;
            }
            case 'sound.stop': break;
            case 'studio.hotkey':
                out.keys = txt(s.keys, 60).trim();
                if (!/^[A-Za-z0-9+ _-]{1,60}$/.test(out.keys)) err('write the keys like Ctrl+Shift+F1.');
                break;
            case 'light.set': {
                out.device = txt(s.device, 160).trim();
                if (out.device === 'all') out.device = '';
                out.color = COLOR.test(String(s.color || '')) ? String(s.color).toLowerCase() : '#9146ff';
                const b = num(s.brightness ?? 100);
                const d = num(s.durationMs ?? 0);
                out.brightness = Number.isFinite(b) ? Math.min(100, Math.max(0, Math.round(b))) : 100;
                out.durationMs = Number.isFinite(d) ? Math.min(600000, Math.max(0, Math.round(d))) : 0;
                break;
            }
            case 'overlay.alert': {
                out.title = txt(s.title, LIMITS.template).trim();
                out.message = txt(s.message, LIMITS.template);
                const d = num(s.durationMs ?? 6000);
                out.durationMs = Number.isFinite(d) ? Math.min(60000, Math.max(1000, Math.round(d))) : 6000;
                out.style = /^[a-z0-9_-]{1,40}$/i.test(String(s.style || '')) ? String(s.style) : 'default';
                if (!out.title) err('enter the title.');
                break;
            }
            default:
                if (typeof def.validate === 'function') def.validate(s, out, err, ctx);   // registered actions
                break;
        }
        if (isClientAction(s.type)) {
            const qs = num(s.queueSeconds ?? LIMITS.queueDefault);
            out.queueSeconds = Number.isFinite(qs) ? Math.min(LIMITS.queueMax, Math.max(0, Math.round(qs))) : LIMITS.queueDefault;
        }
        value.push(out);
    }
    return { ok: !errors.length, errors: [...new Set(errors)], value };
}

/** The params a client action sends (templates already rendered by the caller through `render`). */
export async function clientParams(step, render) {
    const def = BY_TYPE.get(step.type);
    const params = {};
    for (const fld of def?.fields || []) {
        if (step[fld.name] === undefined) continue;
        params[fld.name] = (def.templates || []).includes(fld.name) ? await render(String(step[fld.name] ?? '')) : step[fld.name];
    }
    return params;
}

export default { ACTION_TYPES, LIMITS, TARGET_LABEL, IF_CHECKS, actionType, isClientAction, isStreamAction, childLists, validateActions, countSteps, clientParams };
