/*
 * Stream bot import: bundles (firebot.js, streamerbot.js) → a plan of what goes where, before anything is written.
 *
 * Where things go (existing systems first; stream bot automations only for event → action work):
 *   chat commands   a plain reply whose variables all exist in the channel-command syntax, open to everyone or to
 *                   moderators / the broadcaster, with a !name the channel bot accepts → the Twitch/Kick channel
 *                   commands (tokes_custom_commands, one row per linked channel the channel bot serves; the
 *                   /kick/channel/<id>/commands page). Anything more (counters, OBS, sounds, several steps, VIP or
 *                   subscriber limits, aliases on a pattern, {arg1} …) → a stream bot automation on the chat trigger.
 *   events, rewards with actions, voice commands, power-ups, OBS events → stream bot automations.
 *   timers          one chat line with no variables except the channel name → Kick timed messages (tokes_timers;
 *                   the timer job sends on Kick only); anything else is reported.
 *   counters        stream bot channel values ({sdb:get:<name>}, stream_bot_variables owner 'server').
 *   rewards         definitions are kept with the import record; "Recreate under CertiFried" is the owner's choice.
 *   quotes, moderation word lists, hotkeys       reported (no home that would not change behaviour at once).
 *   viewer stats    only when asked: viewer records on Viewers (core/stream-bot/viewers, H-747): Firebot watch time, messages,
 *                   points, first and last seen, and its currency and rank settings; Streamer.bot names and last seen.
 * Everything is created switched off.
 *
 * Bundle (both parsers): { source, format, version, commands[], automations[], timers[], counters[], quotes[],
 *   rewards[], moderation, hotkeys[], integrations[], obs, viewers, media[], dropped[], stripped }
 *
 *   buildPlan(bundles, ctx) → { items: [PlanItem], checklist, obs, media, gaps, counts }
 *   PlanItem: { category, source, kind, sourceId, name, status: 'as_is'|'changed'|'skipped', why: [], gaps: [],
 *               target: { system, … } | null }
 *   ctx: { channels: [{ platform, platformUserId }], channelBots: [{ id, platform, channelId }] (tokes_channels rows
 *          for those channels), builtins: Set<name>, wantViewers }
 *
 * Tested in tests/stream-bot-import.test.js.
 */
import { validateActions, countSteps, LIMITS as ACTION_LIMITS, registerActionType } from '../actions.js';
import { registerYouTubeActions } from '../youtube/register.js';
import { overlayActionDefs } from '../overlays/actions.js';
import { LIGHT_ACTIONS } from '../devices/catalog.js';
import { validateTrigger, validateConditions } from '../conditions.js';
import { toChannelCommand } from './variables.js';
import { gapInfo, INTEGRATIONS } from './catalog.js';
import { COMMANDS as MUSIC_COMMANDS } from '../music/text.js';
import { NAME_PREFIX as MUSIC_PREFIX } from '../music/seed.js';

export const SOURCE_LABEL = Object.freeze({ firebot: 'Firebot', streamerbot: 'Streamer.bot' });

// The overlay text and media steps (design doc §9) are registered when the stream bot starts; a command-line re-run or a
// test validates imported steps without it, so register those two here (registerActionType leaves an existing type alone).
// Both are client steps whose server side never runs; overlay.goal, which needs the running overlay service, is not touched.
for (const def of overlayActionDefs()) if (def.type === 'overlay.text' || def.type === 'overlay.media') registerActionType(def);
// The light steps (Phase 5, core/stream-bot/devices) likewise: client steps, registered here so a command-line re-run validates them.
for (const def of LIGHT_ACTIONS) registerActionType({ ...def });
// YouTube's Time out and Ban steps (H-741) register in the running bot (core/stream-bot/youtube); likewise here.
registerYouTubeActions({ registerActionType });
const CHANNEL_NAME = /^[a-z0-9_-]{1,50}$/;
const RESERVED = new Set(['eval', 'exec', 'script', 'function', 'constructor', '__proto__']);
const RESPONSE_MAX = 500;
const uniq = (a) => [...new Set(a.filter(Boolean))];

/** Banned words for a pending automod list: trimmed, one copy each (ignoring case), at most 500; a word with a comma cannot go in Kick's comma-separated list. */
export function pendingWords(words) {
    const seen = new Set();
    const list = [];
    let dropped = 0;
    for (const raw of words || []) {
        const w = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!w) continue;
        if (w.includes(',')) { dropped++; continue; }
        const k = w.toLowerCase();
        if (seen.has(k) || list.length >= 500) continue;
        seen.add(k);
        list.push(w);
    }
    return { list, dropped };
}
/** Steps whose absence makes the rest of the command misleading. */
const PRIMARY_GAPS = new Set(['stream.clip', 'stream.title', 'stream.category', 'stream.raid', 'stream.ad', 'stream.shoutout', 'chat.clear', 'chat.delete', 'mod.timeout', 'currency.change']);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Automation name with the source in front ("Firebot: !dab+"), within the 100-character limit. */
export const automationName = (source, name) => `${SOURCE_LABEL[source] || source}: ${String(name || 'Imported').trim()}`.slice(0, 100);

/** A Streamer.bot Spotify song request extension (tawmae "SPOTIFY & SB" and its "Song Requests" gate) group or action name. */
export const isSpotifyGroup = (s) => /spotify|song ?requests?/i.test(String(s || ''));
const COVERED = 'Covered by song requests: part of the Spotify song request extension, which CertiFried\'s song requests replace (Music page)';

/**
 * A Streamer.bot Spotify extension command → the song request command automation the Music page would make
 * (core/stream-bot/music/seed.js commandDrafts: same name, "Song requests: run a command"), switched off. Matched by
 * the command's names against core/stream-bot/music/text.js COMMANDS. null when it is not one of those commands.
 */
export function musicCommandDraft(cmd, source) {
    if (source !== 'streamerbot' || !isSpotifyGroup(cmd.group)) return null;
    const names = (cmd.triggers || []).map((t) => String(t).trim().replace(/^!/, '').toLowerCase()).filter(Boolean);
    const def = MUSIC_COMMANDS.find((c) => c.names.some((n) => names.includes(n.toLowerCase())));
    if (!def) return null;
    const triggers = cmd.triggers.map((t) => String(t).trim()).filter(Boolean);
    const match = triggers.length > 1
        ? { mode: 'regex', text: `^(?:${triggers.map(escapeRe).join('|')})(?:\\s|$)`.slice(0, 200), caseSensitive: false }
        : { mode: 'command', text: triggers[0], caseSensitive: false };
    const roles = def.mod ? ['broadcaster', 'moderator'] : (cmd.roles || []);
    return {
        name: `${MUSIC_PREFIX}!${def.names[0]}`, enabled: false, trigger_type: 'chat',
        trigger_config: { platforms: ['twitch', 'kick'], match },
        conditions: roles.length ? [{ type: 'role', roles: uniq(roles), mode: 'any' }] : [],
        actions: [{ type: 'music.command', command: def.key, input: '', reply: 'yes' }],
        adoptByName: true,
    };
}

function strip(actions) {
    // Remove the parser's private fields (_commandText, _link) after linking.
    return JSON.parse(JSON.stringify(actions, (k, v) => (k.startsWith('_') ? undefined : v)));
}

function gapKeys(list) { return uniq((list || []).map((g) => g.gap)); }

/** Chat trigger for a command's triggers. */
function commandTrigger(cmd) {
    const triggers = (cmd.triggers || []).filter(Boolean);
    if (cmd.regex) return { mode: 'regex', text: String(triggers[0] || '').slice(0, 200), caseSensitive: false };
    if (triggers.length === 1) return { mode: cmd.anywhere ? 'contains' : 'command', text: triggers[0], caseSensitive: false };
    const re = `^(?:${triggers.map(escapeRe).join('|')})(?:\\s|$)`;
    return re.length <= 200 ? { mode: 'regex', text: re, caseSensitive: false } : { mode: 'command', text: triggers[0], caseSensitive: false };
}

/** Command conditions: roles and cooldowns. */
function commandConditions(cmd) {
    const out = [];
    if (cmd.roles?.length) out.push({ type: 'role', roles: uniq(cmd.roles), mode: 'any' });
    if (cmd.cooldown?.global > 0) out.push({ type: 'cooldown', scope: 'global', seconds: Math.min(86400, Math.round(cmd.cooldown.global)) });
    if (cmd.cooldown?.user > 0) out.push({ type: 'cooldown', scope: 'user', seconds: Math.min(86400, Math.round(cmd.cooldown.user)) });
    return out;
}

/** Can this command be a channel command? Returns { ok, response, names, modOnly, broadcasterOnly, cooldown, why } */
function channelCommandFit(cmd, ctx) {
    const why = [];
    if (!ctx.channelBots?.length) return { ok: false, reason: 'no channel bot' };
    if (cmd.regex || cmd.anywhere) return { ok: false, reason: 'pattern trigger' };
    const steps = cmd.actions || [];
    if (steps.length !== 1 || !['chat.send', 'stream.announce'].includes(steps[0].type)) return { ok: false, reason: 'not one reply' };
    if (steps[0].type === 'stream.announce') why.push('Its announcement is sent as a normal reply, so the command also works on Kick');
    const roles = new Set(cmd.roles || []);
    if (roles.has('vip') || roles.has('subscriber')) return { ok: false, reason: 'roles' };
    const names = [];
    for (const t of cmd.triggers || []) {
        const n = String(t).trim();
        if (!n.startsWith('!')) return { ok: false, reason: 'prefix' };
        const bare = n.slice(1).toLowerCase();
        if (!CHANNEL_NAME.test(bare) || RESERVED.has(bare)) return { ok: false, reason: 'name' };
        names.push(bare);
    }
    if (!names.length) return { ok: false, reason: 'name' };
    const conv = toChannelCommand(steps[0].text);
    if (!conv.ok) return { ok: false, reason: 'variables' };
    if (conv.text.length > RESPONSE_MAX) return { ok: false, reason: 'length' };
    if (names.length > 1) why.push(`Its aliases (${names.slice(1).map((n) => `!${n}`).join(', ')}) became separate commands with the same reply`);
    const cooldown = Math.max(cmd.cooldown?.global || 0, cmd.cooldown?.user || 0);
    if (cmd.cooldown?.global > 0 && cmd.cooldown?.user > 0) why.push('Its two cooldowns became one (the longer)');
    return {
        ok: true, response: conv.text, names: uniq(names), modOnly: roles.has('moderator'), broadcasterOnly: roles.has('broadcaster') && !roles.has('moderator'),
        cooldown: Math.min(3600, Math.round(cooldown)), why,
    };
}

/** Validate an automation draft; returns { ok, value, errors }. */
export function checkAutomation(draft) {
    const errors = [];
    const trig = validateTrigger(draft.trigger_type, draft.trigger_config || {});
    if (!trig.ok) errors.push(...trig.errors);
    const cond = validateConditions(draft.conditions || []);
    if (!cond.ok) errors.push(...cond.errors);
    // automation.run steps point at automations that do not exist yet: validate with a placeholder id.
    const acts = validateActions(draft.actions || [], {});
    if (!acts.ok) errors.push(...acts.errors);
    if (countSteps(draft.actions) > ACTION_LIMITS.steps) errors.push('Too many steps');
    return { ok: !errors.length, errors, value: { ...draft, trigger_config: trig.value || {}, conditions: cond.value, actions: acts.value } };
}

export function buildPlan(bundles, ctx = {}) {
    const items = [];
    const media = [];
    const checklist = [];
    const obs = [];
    const builtins = ctx.builtins || new Set();
    const covered = new Set(); // `${source}|${sourceId}` of items covered by song requests (no gap counted)
    const platformsLinked = new Set((ctx.channels || []).map((c) => c.platform));

    // Every command trigger across all bundles, for linking "send !cmd to chat" steps to the imported command.
    const commandByTrigger = new Map();
    const commandItems = [];
    for (const b of bundles) for (const cmd of b.commands || []) for (const t of cmd.triggers || []) {
        const k = String(t).trim().toLowerCase();
        if (k && !commandByTrigger.has(k)) commandByTrigger.set(k, { source: b.source, cmd });
    }

    // ── commands ──
    for (const b of bundles) {
        for (const cmd of b.commands || []) {
            const base = { category: 'commands', source: b.source, kind: 'command', sourceId: cmd.sourceId, name: cmd.name };
            const gaps = gapKeys(cmd.gaps);
            const why = [...uniq(cmd.notes || [])];
            if (cmd.vars?.length) why.push(`These variables have no CertiFried equivalent and were kept as written: ${cmd.vars.join(', ')}`);
            const bare = String(cmd.name || '').replace(/^!/, '').toLowerCase();
            if (builtins.has(bare)) {
                items.push({ ...base, status: 'skipped', why: [`CertiFried's channel bot has a built-in !${bare}. Turn it on on your channel's Commands page instead.`], gaps, target: null });
                continue;
            }
            const music = gaps.includes('code') ? musicCommandDraft(cmd, b.source) : null;
            if (music) {
                covered.add(`${b.source}|${cmd.sourceId}`);
                items.push({ ...base, status: 'changed', why: [`Covered by song requests: becomes "${music.name}" (Song requests: run a command), the Music page's command for it`],
                    gaps: [], target: { system: 'automation', trusted: true, draft: music } });
                continue;
            }
            if (gaps.includes('code')) {
                items.push({ ...base, status: 'skipped', why: ['Its work is done by custom code (C#), which CertiFried never runs; the steps around it would do nothing useful on their own', ...why], gaps, target: null });
                continue;
            }
            if (!(cmd.actions || []).length) {
                const reason = gaps.length ? gaps.map((g) => gapInfo(g).label).join('; ') : 'It does nothing CertiFried can run';
                items.push({ ...base, status: 'skipped', why: [`Not supported yet: ${reason}`, ...why], gaps, target: null });
                continue;
            }
            // The reply alone would be wrong when the step it reported on (a clip, a title change …) is not supported.
            const primary = gaps.find((g) => PRIMARY_GAPS.has(g));
            if (primary && (cmd.actions || []).every((s) => s.type === 'chat.send')) {
                items.push({ ...base, status: 'skipped', why: [`Not supported yet: ${gapInfo(primary).label}. Its chat reply alone would say something happened when it did not`, ...why], gaps, target: null });
                continue;
            }
            // A command that also answered on YouTube becomes an automation: CertiFried's channel bot does not serve YouTube (H-741).
            const fit = cmd.platforms?.includes('youtube') ? { ok: false, reason: 'youtube', why: [] } : channelCommandFit(cmd, ctx);
            if (fit.ok) {
                const allWhy = [...why, ...fit.why, ...gaps.map((g) => `Left out: ${gapInfo(g).label}`)];
                const bots = ctx.channelBots.filter((c) => !cmd.platforms || cmd.platforms.includes(c.platform));
                if (bots.length) {
                    items.push({
                        ...base, status: allWhy.length ? 'changed' : 'as_is', why: allWhy, gaps,
                        target: { system: 'channel_command', names: fit.names, response: fit.response, cooldown: fit.cooldown, modOnly: fit.modOnly,
                            broadcasterOnly: fit.broadcasterOnly, channels: bots.map((c) => ({ id: c.id, platform: c.platform })) },
                    });
                    commandItems.push({ cmd, item: items[items.length - 1] });
                    continue;
                }
            }
            if (fit.reason === 'roles') gaps.push('command.roles');
            const draft = {
                name: automationName(b.source, cmd.name), enabled: false, trigger_type: 'chat',
                trigger_config: { match: commandTrigger(cmd), ...(cmd.platforms ? { platforms: cmd.platforms } : {}) },
                conditions: commandConditions(cmd), actions: cmd.actions,
            };
            const allWhy = [...why, ...gaps.map((g) => `Left out: ${gapInfo(g).label}`)];
            if (fit.reason && !['no channel bot', 'youtube'].includes(fit.reason)) allWhy.push(automationReason(fit.reason));
            if (fit.reason === 'youtube') allWhy.push('It also answers on YouTube, where CertiFried\'s channel bot is not, so it is an automation');
            items.push({ ...base, status: allWhy.length ? 'changed' : 'as_is', why: uniq(allWhy), gaps: uniq(gaps), target: { system: 'automation', draft } });
            commandItems.push({ cmd, item: items[items.length - 1] });
        }
    }

    // ── automations (events, rewards, voice commands, power-ups, OBS) ──
    for (const b of bundles) {
        for (const a of b.automations || []) {
            const base = { category: 'automations', source: b.source, kind: a.kind === 'reward' ? 'reward_action' : (a.kind || 'event'), sourceId: a.sourceId, name: a.name };
            const gaps = gapKeys(a.gaps);
            const why = [...uniq(a.notes || [])];
            if (a.vars?.length) why.push(`These variables have no CertiFried equivalent and were kept as written: ${a.vars.join(', ')}`);
            if (gaps.includes('code') && b.source === 'streamerbot' && (isSpotifyGroup(a.group) || isSpotifyGroup(a.name))) {
                covered.add(`${b.source}|${a.sourceId}`);
                items.push({ ...base, status: 'skipped', why: [COVERED], gaps: [], target: null });
                continue;
            }
            if (!a.trigger) {
                items.push({ ...base, status: 'skipped', why: ['It has no trigger, so nothing would run it', ...why], gaps, target: null });
                continue;
            }
            if (gaps.includes('code')) {
                items.push({ ...base, status: 'skipped', why: ['Its work is done by custom code (C#), which CertiFried never runs; the steps around it would do nothing useful on their own', ...why], gaps, target: null });
                continue;
            }
            if (!(a.actions || []).length) {
                const reason = gaps.length ? gaps.map((g) => gapInfo(g).label).join('; ') : 'It has no steps CertiFried can run';
                items.push({ ...base, status: 'skipped', why: [`Not supported yet: ${reason}`, ...why], gaps, target: null });
                continue;
            }
            const draft = { name: automationName(b.source, a.name), enabled: false, trigger_type: a.trigger.type, trigger_config: a.trigger.config || {}, conditions: a.trigger.conditions || [], actions: a.actions };
            const allWhy = [...why, ...gaps.filter((g) => !g.startsWith('trigger.')).map((g) => `Left out: ${gapInfo(g).label}`)];
            items.push({ ...base, status: allWhy.length || gaps.length ? 'changed' : 'as_is', why: uniq(allWhy), gaps, target: { system: 'automation', draft } });
        }
        for (const d of b.dropped || []) {
            if (b.source === 'streamerbot' && isSpotifyGroup(d.name)) {
                covered.add(`${b.source}|dropped:${d.name}`);
                items.push({ category: d.category, source: b.source, kind: 'dropped', sourceId: `dropped:${d.category}:${d.name}:${d.detail || ''}`, name: d.name, status: 'skipped', why: [COVERED], gaps: [], target: null });
                continue;
            }
            items.push({ category: d.category, source: b.source, kind: 'dropped', sourceId: `dropped:${d.category}:${d.name}:${d.detail || ''}`, name: d.name, status: 'skipped',
                why: [d.reason, ...(d.gap ? [gapInfo(d.gap).why] : [])].filter(Boolean), gaps: d.gap ? [d.gap] : [], target: null });
        }
    }

    // ── timers → stream bot timers (tokes_timers with profile_id; core/stream-bot/timers.js, design doc §7.6) ──
    const linked = [...platformsLinked];
    for (const b of bundles) {
        for (const t of b.timers || []) {
            const base = { category: 'timers', source: b.source, kind: 'timer', sourceId: t.sourceId, name: t.name };
            const gaps = gapKeys(t.gaps);
            const why = [...uniq(t.notes || [])];
            const acts = t.actions || [];
            if (!acts.length) {
                items.push({ ...base, status: 'skipped', why: [`Not supported yet: ${gaps.map((g) => gapInfo(g).label).join('; ') || 'nothing to send'}`, ...why], gaps, target: null });
                continue;
            }
            if (!linked.length) {
                items.push({ ...base, status: 'skipped', why: ['Link a Twitch or Kick channel first (Connections)', ...why], gaps, target: null });
                continue;
            }
            // Firebot is a Twitch bot; Streamer.bot timers posted wherever the action sent its messages.
            const platforms = b.source === 'firebot' ? (linked.includes('twitch') ? 'twitch' : 'all') : 'all';
            const minutes = Math.min(1440, Math.max(1, Math.ceil((t.intervalSeconds || 60) / 60)));
            if (t.intervalSeconds % 60) why.push(`Every ${t.intervalSeconds} seconds became every ${minutes} minute${minutes === 1 ? '' : 's'}`);
            const timer = { name: String(t.name || 'Timer').slice(0, 100), intervalMin: minutes, onlyLive: !!t.liveOnly, minChatLines: Math.min(1000, Math.max(0, Math.round(t.chatLines || 0))), platforms, rotation: 'rotate', messages: [], automationRef: null };
            const isChat = (x) => x.type === 'chat.send' && x.text && x.text.length <= 500;
            if (acts.length === 1 && isChat(acts[0])) {
                timer.messages = [acts[0].text];
            } else if (acts.length === 1 && acts[0].type === 'random' && acts[0].branches.every((br) => br.actions.length === 1 && isChat(br.actions[0])) && acts[0].branches.length <= 10) {
                timer.messages = acts[0].branches.map((br) => br.actions[0].text);
                timer.rotation = 'random';
                why.push('Its random messages became one timer that picks a message at random');
            } else {
                // More than one step per firing: an automation the timer runs (it can also be run with !timer-<name> by you).
                const slug = String(t.name || 'timer').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'timer';
                const draft = { name: automationName(b.source, `Timer: ${t.name}`), enabled: false, trigger_type: 'chat',
                    trigger_config: { match: { mode: 'command', text: `!timer-${slug}`, caseSensitive: false } },
                    conditions: [{ type: 'role', roles: ['broadcaster'], mode: 'any' }], actions: acts };
                items.push({ category: 'timers', source: b.source, kind: 'timer_action', sourceId: t.sourceId, name: `Timer: ${t.name}`, status: 'changed',
                    why: [`Runs from the "${t.name}" timer; you can also run it with !timer-${slug} (broadcaster only)`], gaps: [], target: { system: 'automation', draft } });
                timer.automationRef = { source: b.source, kind: 'timer_action', sourceId: t.sourceId };
                why.push('It does more than send one line, so the timer runs an automation');
            }
            if (t.chatLines > 0) why.push(`Only after ${t.chatLines} chat lines (counted from the restart onwards)`);
            items.push({ ...base, status: why.length ? 'changed' : 'as_is', why: uniq(why), gaps, target: { system: 'bot_timer', timer } });
        }
    }

    // Power-up automations (bits.used, kind power_up): Twitch reports a power-up by kind, not by the custom power-up id
    // Streamer.bot keyed it on, so match it by its Bits cost when the definition is in the import.
    const powerUps = new Map();
    for (const b of bundles) for (const r of b.rewards || []) if (r.kind === 'power_up' && r.twitchId) powerUps.set(String(r.twitchId), r);
    for (const it of items) {
        if (it.kind !== 'power_up' || it.target?.system !== 'automation') continue;
        const src = bundles.find((b) => b.source === it.source)?.automations.find((a) => a.sourceId === it.sourceId);
        const def = src?.rewardId ? powerUps.get(String(src.rewardId)) : null;
        if (def && def.cost > 0) {
            it.target.draft.conditions = [...(it.target.draft.conditions || []), { type: 'amount', min: def.cost, max: def.cost, currency: 'bits' }];
            it.why = uniq([...it.why, `Matched by its Bits cost (${def.cost}): Twitch reports power-ups by kind, not by the "${def.title}" power-up's id`]);
        } else {
            it.why = uniq([...it.why, 'Its power-up is not in the import, so this runs on every power-up; add an amount condition with its Bits cost']);
        }
        if (it.status === 'as_is') it.status = 'changed';
    }

    // Link "send !cmd to chat" steps to what the command became.
    const linkSteps = (actions, notes) => actions.map((s) => {
        if (s.type === 'random') return { ...s, branches: s.branches.map((br) => ({ ...br, actions: linkSteps(br.actions, notes) })) };
        if (s.type === 'automation.run' && s._link) {
            const hit = commandItems.find((ci) => ci.item.source === s._link.source && ci.cmd.sourceId === s._link.sourceId);
            if (hit?.item.target?.system === 'automation') return { type: 'automation.run', _ref: { source: hit.item.source, kind: 'command', sourceId: hit.cmd.sourceId } };
            notes.push('A "run command" step pointed at a command that is not an automation here, so it was left out');
            return null;
        }
        if (s.type !== 'chat.send' || !s._commandText) return s;
        const hit = commandByTrigger.get(s._commandText.toLowerCase());
        if (!hit) return s;
        const ci = commandItems.find((x) => x.cmd === hit.cmd);
        if (!ci) return s;
        if (ci.item.target?.system === 'automation') {
            notes.push(`Sending ${s._commandText} to chat became "Run another automation" (${ci.item.target.draft.name}), because CertiFried does not answer its own messages`);
            return { type: 'automation.run', _ref: { source: ci.item.source, kind: 'command', sourceId: hit.cmd.sourceId } };
        }
        if (ci.item.target?.system === 'channel_command') {
            notes.push(`Sending ${s._commandText} to chat became that command's reply, because CertiFried does not answer its own messages`);
            return { type: 'chat.send', platform: s.platform, text: hit.cmd.actions[0].text };
        }
        return s;
    }).filter(Boolean);
    for (const it of items) {
        if (it.target?.system !== 'automation') continue;
        if (it.target.trusted) continue; // built here like the Music page builds it (musicCommandDraft)
        const notes = [];
        it.target.draft.actions = linkSteps(it.target.draft.actions, notes);
        if (notes.length) { it.why = uniq([...it.why, ...notes]); if (it.status === 'as_is') it.status = 'changed'; }
        const refs = [];
        const collect = (acts) => acts.forEach((s) => { if (s._ref) refs.push(s._ref); if (s.type === 'random') s.branches.forEach((br) => collect(br.actions)); });
        collect(it.target.draft.actions);
        it.target.refs = refs;
        const forCheck = JSON.parse(JSON.stringify(it.target.draft, (k, v) => (k === '_ref' ? undefined : v)));
        const placeholder = (acts) => acts.forEach((s) => { if (s.type === 'automation.run' && !s.automationId) s.automationId = 1; if (s.type === 'random') s.branches.forEach((br) => placeholder(br.actions)); });
        placeholder(forCheck.actions);
        const check = checkAutomation(forCheck);
        if (!check.ok) {
            it.status = 'skipped';
            it.why = uniq([`It could not be converted: ${check.errors.slice(0, 3).join(' ')}`, ...it.why]);
            it.target = null;
            continue;
        }
        it.target.draft = { ...check.value, actions: restoreRefs(check.value.actions, it.target.draft.actions), name: it.target.draft.name, enabled: false };
    }

    // ── counters ──
    for (const b of bundles) {
        for (const c of b.counters || []) {
            const gaps = gapKeys(c.gaps);
            const why = gaps.map((g) => `Left out: ${gapInfo(g).label}`);
            if (c.min != null || c.max != null) why.push('Its minimum and maximum are not kept');
            items.push({ category: 'counters', source: b.source, kind: 'counter', sourceId: c.sourceId, name: c.name, status: why.length ? 'changed' : 'as_is',
                why: [`Use it as {sdb:get:${c.key}}`, ...why], gaps, target: { system: 'variable', key: c.key, value: String(c.value) } });
        }
    }

    // ── rewards (definitions; deduplicated by Twitch id across sources) ──
    const seenRewards = new Map();
    for (const b of bundles) {
        for (const r of b.rewards || []) {
            const dupKey = r.twitchId || `${r.kind}:${r.title.toLowerCase()}`;
            if (seenRewards.has(dupKey)) { seenRewards.get(dupKey).why.push(`Also set up in ${SOURCE_LABEL[b.source]}`); continue; }
            const base = { category: 'rewards', source: b.source, kind: 'reward', sourceId: r.sourceId, name: r.title };
            let item;
            if (r.kind === 'auto') item = { ...base, status: 'skipped', why: ['A Twitch built-in reward: nothing to import'], gaps: [], target: null };
            else if (r.kind === 'power_up') item = { ...base, status: 'changed', why: ['Saved with the import. Power-ups cannot be recreated by an app; automations for it match power-ups by its Bits cost'], gaps: [], target: { system: 'reward_definition', definition: r } };
            else item = { ...base, status: 'changed', why: [`Saved with the import. It was made by ${r.createdBy}, so only that app can change it on Twitch; you can recreate it under CertiFried from this page`], gaps: ['rewards.manage'], target: { system: 'reward_definition', definition: r } };
            seenRewards.set(dupKey, item);
            items.push(item);
        }
    }

    // ── quotes, moderation, hotkeys, viewers ──
    for (const b of bundles) {
        if (b.quotes?.length) items.push({ category: 'quotes', source: b.source, kind: 'quotes', sourceId: 'quotes', name: `${b.quotes.length} quotes`, status: 'skipped', why: [gapInfo('quotes').why], gaps: ['quotes'], target: null, data: { quotes: b.quotes } });
        const m = b.moderation;
        if (m && (m.bannedWords.length || m.bannedRegex || m.urlModeration || m.emoteLimit != null)) {
            const why = [];
            const gaps = [];
            const words = pendingWords(m.bannedWords);
            if (words.list.length) {
                why.push(`${words.list.length} banned word${words.list.length === 1 ? '' : 's'}${m.bannedWordsOn ? ' (on in ' + (SOURCE_LABEL[b.source] || b.source) + ')' : ''}: saved as a pending list, not applied. Kick automod turns its word rule on as soon as it has words, so nothing is added until you press "Apply to Kick automod" on this page; Twitch blocked terms are not changed`);
            }
            if (words.dropped) why.push(`${words.dropped} banned word${words.dropped === 1 ? '' : 's'} with a comma left out: Kick automod's list is separated by commas`);
            if (m.bannedRegex) { why.push(`${m.bannedRegex} banned patterns: not supported`); gaps.push('moderation.patterns'); }
            if (m.urlModeration || m.urlAllowlist) { why.push('Link moderation with an allow-list: Kick automod can block all links, without an allow-list'); gaps.push('moderation.urls'); }
            if (m.emoteLimit != null) { why.push(`Emote limit (${m.emoteLimit}): not supported`); gaps.push('moderation.emotes'); }
            items.push({ category: 'moderation', source: b.source, kind: 'moderation', sourceId: 'moderation', name: 'Chat moderation', status: words.list.length ? 'changed' : 'skipped', why, gaps: uniq(gaps),
                target: words.list.length ? { system: 'pending_words', words: words.list, wasOn: !!m.bannedWordsOn } : null, data: { bannedWords: m.bannedWords } });
        }
        for (const h of b.hotkeys || []) {
            items.push({ category: 'hotkeys', source: b.source, kind: 'hotkey', sourceId: h.sourceId, name: h.name || h.keys, status: 'skipped', why: [gapInfo('trigger.hotkey').why], gaps: ['trigger.hotkey'], target: null });
        }
        if (b.viewers?.count) {
            const rows = b.viewers.rows || [];
            if (ctx.wantViewers && rows.length) {
                const why = b.source === 'firebot'
                    ? ['Watch time, chat messages, points and first and last seen go to Viewers. Viewers not seen for over 400 days are left out (they would be deleted at once)']
                    : ['Names and last-seen dates go to Viewers (Streamer.bot keeps no watch time or message counts)'];
                if (b.viewers.settings) why.push('Your points name, earning and ranks are taken from Firebot unless you already saved Viewers settings');
                why.push(...(b.viewers.notes || []), 'Viewers can see and delete their records through /privacy');
                // A viewer the other upload saw more recently is kept even when this one last saw them long ago.
                const elsewhere = new Map();
                for (const ob of bundles) if (ob !== b) for (const r of ob.viewers?.rows || []) {
                    const t = r.lastSeen ? new Date(r.lastSeen).getTime() : 0;
                    if (t > (elsewhere.get(`${r.platform}:${r.id}`) || 0)) elsewhere.set(`${r.platform}:${r.id}`, t);
                }
                const out = elsewhere.size ? rows.map((r) => (elsewhere.has(`${r.platform}:${r.id}`) ? { ...r, seenElsewhere: elsewhere.get(`${r.platform}:${r.id}`) } : r)) : rows;
                items.push({ category: 'viewers', source: b.source, kind: 'viewers', sourceId: 'viewers', name: `${rows.length} viewers`, status: 'changed',
                    why, gaps: [], target: { system: 'viewer_records', rows: out, settings: b.viewers.settings || null } });
            } else {
                items.push({ category: 'viewers', source: b.source, kind: 'viewers', sourceId: 'viewers', name: `${b.viewers.count} viewers`, status: 'skipped',
                    why: ['Not imported unless you tick Viewer stats'], gaps: [], target: null });
            }
        }
        for (const m2 of b.media || []) media.push({ ...m2, source: b.source });
        if (b.obs) obs.push({ source: b.source, host: b.obs.host, port: b.obs.port });
        for (const i of b.integrations || []) {
            const def = INTEGRATIONS[i.service] || { label: i.service, todo: 'Not available in CertiFried.', have: false };
            if (!checklist.some((c) => c.service === i.service)) checklist.push({ service: i.service, label: def.label, todo: def.todo, have: def.have, from: [SOURCE_LABEL[b.source]] });
            else checklist.find((c) => c.service === i.service).from.push(SOURCE_LABEL[b.source]);
        }
    }

    // Gap counts (owner's parity list): how often each unsupported feature was used, by source.
    const gaps = {};
    const bump = (key, source, name) => {
        const g = (gaps[key] ||= { key, ...gapInfo(key), count: 0, bySource: {}, examples: [] });
        g.count++;
        g.bySource[source] = (g.bySource[source] || 0) + 1;
        if (name && g.examples.length < 6 && !g.examples.includes(name)) g.examples.push(name);
    };
    for (const b of bundles) {
        for (const x of [...(b.commands || []), ...(b.automations || []), ...(b.timers || []), ...(b.counters || [])]) {
            if (covered.has(`${b.source}|${x.sourceId}`)) continue;
            for (const g of x.gaps || []) bump(g.gap, b.source, x.name);
        }
        for (const d of b.dropped || []) if (d.gap && !covered.has(`${b.source}|dropped:${d.name}`)) bump(d.gap, b.source, d.name);
        for (const x of [...(b.commands || []), ...(b.automations || []), ...(b.timers || [])]) for (const v of x.vars || []) {
            const key = /streamTitle|category|game/i.test(v) ? 'variable.stream_info' : /count|counter/i.test(v) ? 'command.use_count' : 'variable.other';
            bump(key, b.source, `${x.name} (${v})`);
        }
    }
    for (const it of items) for (const g of it.gaps || []) {
        if (['command.roles', 'rewards.manage', 'quotes', 'moderation.words', 'moderation.urls', 'moderation.emotes', 'trigger.hotkey'].includes(g)) bump(g, it.source, it.name);
    }

    const counts = {};
    for (const it of items) {
        const c = (counts[it.category] ||= { as_is: 0, changed: 0, skipped: 0 });
        c[it.status]++;
    }
    return { items, checklist, obs, media, gaps: Object.values(gaps).sort((a, b) => b.count - a.count), counts };
}

function automationReason(reason) {
    switch (reason) {
        case 'pattern trigger': return 'It is a stream bot automation because it is triggered by a pattern';
        case 'not one reply': return 'It is a stream bot automation because it does more than send one reply';
        case 'roles': return 'It is a stream bot automation because only VIPs or subscribers may use it';
        case 'prefix': return 'It is a stream bot automation because it does not start with !';
        case 'name': return 'It is a stream bot automation because its name has characters channel commands do not allow';
        case 'variables': return 'It is a stream bot automation because it uses variables channel commands do not have';
        case 'length': return 'It is a stream bot automation because its reply is longer than 500 characters';
        default: return '';
    }
}

/** checkAutomation() drops unknown fields; put the _ref markers of automation.run steps back by position. */
function restoreRefs(validated, original) {
    return validated.map((s, i) => {
        const o = original[i] || {};
        if (s.type === 'automation.run' && o._ref) return { type: 'automation.run', automationId: null, _ref: o._ref };
        if (s.type === 'random') return { ...s, branches: s.branches.map((br, j) => ({ ...br, actions: restoreRefs(br.actions, o.branches?.[j]?.actions || []) })) };
        return s;
    });
}

export { strip as stripPrivate };
export default { buildPlan, checkAutomation, automationName, SOURCE_LABEL };
