/*
 * Stream bot import: Streamer.bot (0.2.x and 1.x) → a source-neutral bundle (see mapper.js for the bundle shape).
 *
 * Reads either an export (Streamer.bot: Actions → right-click → Export, which gives an import string, or the
 * `.sb` file of that string) or the files of the data folder (<Streamer.bot folder>\data\, zipped):
 * actions.json, commands.json, twitch_rewards.json, quotes.dat, users.dat, hotkeys.json, settings.json (timed
 * actions, speech-to-text phrases and which integrations start; credentials stripped before reading), obs.json
 * (host and port only). LiteDB files (*.db: globals, command use history) cannot be read on the server and are
 * listed as skipped.
 *
 * An import string is base64 of "SBAE" + a gzip stream of JSON ({ meta, data: { actions, commands, queues,
 * timers … } }); plain gzip and plain JSON are accepted too.
 *
 * Sub-action and trigger types are numbers. Triggers use Streamer.bot's EventType values (read from
 * Streamer.bot.Common.dll); sub-action numbers are not published, so only the ones identified from real files are
 * mapped (by number and by their fields), and any other number is reported as not supported with that number.
 *
 *   decodeImportString(text) → object (throws ImportError)
 *   parseStreamerbot({ files?: Map<path, Buffer>, exported?: object, wantViewers?: boolean }) → bundle
 *
 * Tested in tests/stream-bot-import.test.js with small invented fixtures.
 */
import zlib from 'node:zlib';
import { stripSecrets } from './secrets.js';
import { translateStreamerbot, slugKey } from './variables.js';
import { ImportError } from './zip.js';
import { sbSubActionName } from './streamerbot-types.js';
import { sbLumia } from './lights.js';

/** Streamer.bot EventType → stream bot trigger type (null: no equivalent; the gap key says why). */
export const SB_TRIGGERS = Object.freeze({
    101: ['TwitchFollow', 'follow'], 102: ['TwitchCheer', 'cheer'], 103: ['TwitchSub', 'sub'], 104: ['TwitchReSub', 'resub'],
    105: ['TwitchGiftSub', 'gift_sub'], 106: ['TwitchGiftBomb', 'gift_sub'], 107: ['TwitchRaid', 'raid'],
    108: ['TwitchHypeTrainStart', 'hype_train.begin'], 109: ['TwitchHypeTrainUpdate', 'hype_train.progress'], 110: ['TwitchHypeTrainLevelUp', 'hype_train.progress'],
    111: ['TwitchHypeTrainEnd', 'hype_train.end'], 112: ['TwitchRewardRedemption', 'redemption'], 120: ['TwitchFirstWord', null, 'trigger.first_words'],
    125: ['TwitchPollCreated', 'poll.begin'], 126: ['TwitchPollUpdated', 'poll.progress'], 127: ['TwitchPollCompleted', 'poll.end'],
    128: ['TwitchPredictionCreated', 'prediction.begin'], 129: ['TwitchPredictionUpdated', 'prediction.progress'], 130: ['TwitchPredictionCompleted', 'prediction.end'],
    132: ['TwitchPredictionLocked', 'prediction.lock'], 133: ['TwitchChatMessage', 'chat'], 139: ['TwitchAdRun', 'ad_break'],
    154: ['TwitchStreamOnline', 'stream.online'], 155: ['TwitchStreamOffline', 'stream.offline'], 196: ['TwitchPowerUpRedemption', 'bits.used'],
    496: ['TwitchCustomPowerUpRedemption', 'bits.used'],
    201: ['StreamlabsDonation', 'tip'], 1201: ['StreamElementsTip', 'tip'], 7001: ['KofiDonation', 'tip'], 7002: ['KofiSubscription', 'membership'],
    24006: ['FourthwallDonation', 'tip'], 24007: ['FourthwallSubscriptionPurchased', 'membership'], 37001: ['ThroneGiftPurchased', 'tip'],
    302: ['SpeechToTextCommand', 'voice.phrase', null], 401: ['CommandTriggered', 'command'], 701: ['TimedAction', 'timer'],
    702: ['Test', null, 'trigger.test'], 706: ['StreamerbotStarted', 'studio.connected'],
    14004: ['ObsSceneChanged', 'obs.scene_changed'], 14005: ['ObsStreamingStarted', 'obs.stream_started'], 14006: ['ObsStreamingStopped', 'obs.stream_stopped'],
    14007: ['ObsRecordingStarted', 'obs.recording_started'], 14008: ['ObsRecordingStopped', 'obs.recording_stopped'],
    35010: ['KickChatMessage', 'chat'], 35011: ['KickFollow', 'follow'], 35012: ['KickStreamOnline', 'stream.online'], 35013: ['KickStreamOffline', 'stream.offline'],
    35014: ['KickSubscription', 'sub'], 35016: ['KickGiftSubscription', 'gift_sub'], 35017: ['KickMassGiftSubscription', 'gift_sub'],
    35008: ['KickFirstWords', null, 'trigger.first_words'],
    // YouTube Live (H-741). EventType values read from Streamer.bot.Common.dll 1.0.7 (metadata tables) on 2026-11-20. Super Chats,
    // Super Stickers and Jewels are tips; new members, milestones and gifted memberships are memberships (YT_KIND tells them apart).
    4001: ['YouTubeBroadcastStarted', 'stream.online'], 4002: ['YouTubeBroadcastEnded', 'stream.offline'], 4003: ['YouTubeMessage', 'chat'],
    4004: ['YouTubeMessageDeleted', null, 'trigger.youtube_other'], 4005: ['YouTubeUserBanned', null, 'trigger.youtube_other'],
    4006: ['YouTubeSuperChat', 'tip'], 4007: ['YouTubeSuperSticker', 'tip'], 4008: ['YouTubeNewSponsor', 'membership'], 4009: ['YouTubeMemberMileStone', 'membership'],
    4010: ['YouTubeNewSponsorOnlyStarted', null, 'trigger.youtube_other'], 4011: ['YouTubeNewSponsorOnlyEnded', null, 'trigger.youtube_other'],
    4012: ['YouTubeStatisticsUpdated', null, 'trigger.youtube_other'], 4013: ['YouTubeBroadcastUpdated', null, 'trigger.youtube_other'],
    4014: ['YouTubeMembershipGift', 'gift_sub'], 4015: ['YouTubeGiftMembershipReceived', 'membership'], 4016: ['YouTubeFirstWords', 'chat'],
    4017: ['YouTubePresentViewers', null, 'trigger.youtube_other'], 4018: ['YouTubeNewSubscriber', null, 'trigger.youtube_other'],
    4019: ['YouTubeBroadcastMonitoringStarted', null, 'trigger.youtube_other'], 4020: ['YouTubeBroadcastMonitoringEnded', null, 'trigger.youtube_other'],
    4021: ['YouTubeBroadcastAdded', null, 'trigger.youtube_other'], 4022: ['YouTubeBroadcastRemoved', null, 'trigger.youtube_other'],
    4023: ['YouTubeSevenTVEmoteAdded', null, 'trigger.youtube_other'], 4024: ['YouTubeSevenTVEmoteRemoved', null, 'trigger.youtube_other'],
    4025: ['YouTubeBetterTTVEmoteAdded', null, 'trigger.youtube_other'], 4026: ['YouTubeBetterTTVEmoteRemoved', null, 'trigger.youtube_other'],
    4027: ['YouTubePollClosed', null, 'trigger.youtube_other'], 4028: ['YouTubePollStarted', null, 'trigger.youtube_other'], 4029: ['YouTubePollUpdated', null, 'trigger.youtube_other'],
    4030: ['YouTubeJewelsGifted', 'tip'], 4031: ['YouTubeUserTimedout', null, 'trigger.youtube_other'],
});
/** YouTube triggers that share a stream bot event type, told apart by metadata.kind (core/stream-bot/youtube/normalise.js). */
export const YT_KIND = Object.freeze({ 4006: 'super_chat', 4007: 'super_sticker', 4030: 'jewels', 4008: 'new', 4009: 'milestone', 4015: 'gift' });
const TRIGGER_PLATFORM = (code) => (code >= 4000 && code < 5000 ? ['youtube'] : code >= 35000 && code < 36000 ? ['kick'] : code >= 100 && code < 500 && code !== 302 && code !== 401 ? ['twitch']
    : code === 201 ? ['streamlabs'] : code === 1201 ? ['streamelements'] : code >= 7000 && code < 8000 ? ['kofi'] : code >= 24000 && code < 25000 ? ['fourthwall']
        : code >= 37000 && code < 38000 ? ['throne'] : null);
/** Speech command phrases: split on new lines and ;, trimmed, at most 20 of at most 100 characters each. */
export function voicePhrases(text) {
    const out = [];
    for (const p of String(text ?? '').split(/\r?\n|;/)) {
        const t = p.replace(/\s+/g, ' ').trim().slice(0, 100);
        if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
        if (out.length >= 20) break;
    }
    return out;
}

export function sbTriggerName(code) {
    const t = SB_TRIGGERS[code];
    if (t) return t[0];
    if (code >= 4000 && code < 5000) return `YouTube event ${code}`;
    return `trigger type ${code}`;
}

const STATE3 = (s, a, b, c) => (Number(s) === 0 ? a : Number(s) === 1 ? b : c);

const asText = (buf) => (Buffer.isBuffer(buf) ? buf.toString('utf8').replace(/^﻿/, '') : String(buf ?? ''));
function json(files, path) {
    const b = files?.get(path);
    if (!b) return null;
    try { return JSON.parse(asText(b)); } catch { return undefined; }
}
const list = (x) => (Array.isArray(x) ? x : []);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, max = 500) => String(v ?? '').slice(0, max);

/** Decode a Streamer.bot import string (or the text of an .sb file). */
export function decodeImportString(text, { maxBytes = 16 * 1024 * 1024 } = {}) {
    const s = String(text ?? '').trim();
    if (s.startsWith('{')) {
        try { return JSON.parse(s); } catch { throw new ImportError('bad_string', 'That text is not a Streamer.bot export.'); }
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(s) || s.length < 8) throw new ImportError('bad_string', 'That text is not a Streamer.bot import string.');
    let buf = Buffer.from(s.replace(/\s+/g, ''), 'base64');
    if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'SBAE') buf = buf.subarray(4);
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try { buf = zlib.gunzipSync(buf, { maxOutputLength: maxBytes }); } catch { throw new ImportError('bad_string', 'The import string could not be unpacked (too large or damaged).'); }
    }
    try { return JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw new ImportError('bad_string', 'That text is not a Streamer.bot import string.'); }
}

/** Find the data folder root inside a zip (the folder that holds actions.json). */
export function dataRoot(files) {
    for (const p of files.keys()) {
        const m = p.match(/^(.*?)(actions\.json|commands\.json|twitch_rewards\.json)$/i);
        if (m) return m[1];
    }
    return null;
}

// ── sub-actions ─────────────────────────────────────────────────────────────────────────────

/** Convert a sub-action list. Returns { actions, gaps, notes, vars, media, comments }. */
export function convertSubActions(subs, ctx = {}, depth = 0, randomPick = false) {
    const out = { actions: [], gaps: [], notes: [], vars: [], media: [], comments: 0 };
    const tr = (t) => {
        const r = translateStreamerbot(t, ctx);
        out.vars.push(...r.unsupported);
        out.notes.push(...r.changes);
        return r.text;
    };
    const gap = (key, type, extra = '') => out.gaps.push({ gap: key, detail: `Streamer.bot sub-action ${type}${extra}` });
    const ordered = list(subs).filter((s) => s && typeof s === 'object').sort((a, b) => num(a.index) - num(b.index));
    const branches = [];
    for (const s of ordered) {
        const before = out.actions.length;
        const type = num(s.type, -1);
        if (s.enabled === false) { out.notes.push('A turned-off sub-action was left out'); continue; }
        // Type numbers and names: Streamer.bot.exe's sub-action enum (streamerbot-types.js). State numbers follow the order
        // of each sub-action's dropdown in Streamer.bot's documentation (docs.streamer.bot/api/sub-actions/…):
        //   visibility  0 Visible, 1 Hidden, 2 Toggle        mute  0 Muted, 1 Not muted, 2 Toggle        streaming  0 Start, 1 Stop
        const name = sbSubActionName(type);
        const label = `${name} (${type})`;
        const slobs = () => out.notes.push('A Streamlabs Desktop step became an OBS step with the same scene and source names (CertiFried Studio controls OBS)');
        switch (name) {
            case 'Comment': out.comments++; break;
            case 'Message': { // Twitch: send message to channel
                const text = tr(str(s.text, 2000));
                if (/^\s*\/clear\b/i.test(text)) { out.actions.push({ type: 'chat.clear' }); break; }
                if (text.trim()) out.actions.push({ type: 'chat.send', platform: 'twitch', text, ...(/^![^\s]+$/.test(text.trim()) ? { _commandText: text.trim() } : {}) });
                break;
            }
            case 'TwitchAnnounce': {
                const text = tr(str(s.text, 2000));
                // colour: 0 Primary, 1 Blue, 2 Green, 3 Orange, 4 Purple (the dropdown order on docs.streamer.bot)
                if (text.trim()) out.actions.push({ type: 'stream.announce', text, color: ['primary', 'blue', 'green', 'orange', 'purple'][num(s.color, 0)] || 'primary' });
                break;
            }
            // Phase 5 lights (core/stream-bot/import/lights.js): Lumia Stream colour and brightness become light steps.
            case 'LumiaStreamSendCommand': case 'LumiaStreamSetColor': case 'LumiaStreamSetBrightness': case 'LumiaStreamSetToDefault': {
                const r = sbLumia(name, s);
                out.actions.push(...r.actions);
                out.notes.push(...r.notes);
                for (const g of r.gaps) gap(g.gap, label, ` (${g.what})`);
                break;
            }
            case 'ObsSetActiveScene': case 'SlobsSetActiveScene':
                if (s.sceneName) out.actions.push({ type: 'obs.scene', scene: str(s.sceneName, 200) });
                if (name.startsWith('Slobs')) slobs();
                break;
            case 'ObsSourceVisbility': case 'SlobsSourceVisibility':
                if (!s.sourceName) break;
                out.actions.push({ type: 'obs.source', scene: str(s.sceneName || '', 200), source: str(s.sourceName, 200), visible: STATE3(s.state, 'show', 'hide', 'toggle') });
                if (name.startsWith('Slobs')) slobs();
                break;
            case 'ObsSourceMuteState': case 'SlobsSourceMuteState':
                if (!s.sourceName) break;
                out.actions.push({ type: 'obs.mute', input: str(s.sourceName, 200), state: STATE3(s.state, 'mute', 'unmute', 'toggle') });
                if (name.startsWith('Slobs')) slobs();
                break;
            case 'ObsStreaming': {
                const state = Number(s.state) === 1 ? 'stop' : 'start';
                out.actions.push({ type: 'obs.stream', state });
                out.notes.push(`Streamer.bot had this set to ${state === 'stop' ? 'Stop' : 'Start'} streaming; check that is what you want before turning it on`);
                break;
            }
            case 'ObsSetBrowserSourceUrl':
                if (s.sourceName && s.url) out.actions.push({ type: 'obs.browser_url', source: str(s.sourceName, 200), url: tr(str(s.url, 2000)) });
                else gap('unknown.effect', label, fieldHint(s));
                break;
            case 'ObsSetGdiText':
                if (s.sourceName && typeof s.text === 'string') out.actions.push({ type: 'obs.text', source: str(s.sourceName, 200), text: tr(str(s.text, 2000)) });
                else gap('unknown.effect', label, fieldHint(s));
                break;
            case 'ObsTakeScreenshot': out.actions.push({ type: 'obs.screenshot', source: str(s.sourceName || s.sceneName || '', 200) }); break;
            case 'Group': { // group of sub-actions (random: pick one)
                if (depth >= 3) { gap('flow.conditional', label, ' (nested too deep)'); break; }
                const inner = convertSubActions(s.subActions, ctx, depth + 1, !!s.random);
                merge(out, inner);
                out.actions.push(...inner.actions);
                break;
            }
            case 'ExecuteCode': case 'ExecuteMethod': case 'RunExecutable': gap('code', label); break;
            case 'SetArgument': {
                const argName = String(s.variableName ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
                if (argName) { out.actions.push({ type: 'args.set', name: argName, value: tr(str(s.value ?? '', 2000)) }); out.notes.push(`Arguments are {args.${argName}} in later steps`); }
                else gap('variable.argument', label);
                break;
            }
            case 'GlobalSet': case 'GlobalGet': gap('variable.argument', label); break;
            case 'LogicIf': case 'LogicSwitch': case 'LogicWhile': gap('flow.conditional', label); break;
            // Phase 4 stream actions (design doc §7.3)
            case 'TwitchClearChatMessages': out.actions.push({ type: 'chat.clear' }); break;
            // YouTube Live (H-741): send a message (as the linked channel), ban or time out the viewer behind the event.
            case 'YouTubeMessage': {
                const text = tr(str(s.text, 2000));
                if (text.trim()) out.actions.push({ type: 'chat.send', platform: 'youtube', text });
                break;
            }
            case 'YouTubeBanUser':
                out.actions.push({ type: 'chat.ban' });
                out.notes.push('The YouTube ban acts on the viewer behind the event');
                break;
            case 'YoUTubeTimeoutUser': {   // (sic: Streamer.bot's own spelling)
                const want = num(s.duration ?? s.timeout ?? s.seconds ?? s.length, 300);
                const seconds = [10, 60, 300, 600, 1800, 3600, 86400].reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a), 300);
                out.actions.push({ type: 'chat.timeout', seconds: String(seconds) });
                out.notes.push(`The YouTube time-out acts on the viewer behind the event, for ${seconds} seconds${seconds !== want ? ` (the nearest choice to ${want})` : ''}`);
                break;
            }
            case 'CreateClip': out.actions.push({ type: 'stream.clip' }); break;
            case 'SetChannelTitle': {
                const title = tr(str(s.title ?? s.value ?? '', 300));
                if (title.trim()) out.actions.push({ type: 'stream.title', platform: 'twitch', title }); else gap('unknown.effect', label, fieldHint(s));
                break;
            }
            case 'SetChannelGame': {
                const category = tr(str(s.gameName ?? s.game ?? s.category ?? '', 200));
                if (category.trim()) out.actions.push({ type: 'stream.category', platform: 'twitch', category }); else gap('unknown.effect', label, fieldHint(s));
                break;
            }
            case 'RunCommercial': {
                const n = num(s.length ?? s.duration, 30);
                out.actions.push({ type: 'stream.ad', length: [30, 60, 90, 120, 150, 180].reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), 30) });
                break;
            }
            case 'TwitchTimeoutUser': gap('mod.timeout', label); break;
            case 'TwitchSendShoutout': {
                const target = tr(str(s.userLogin ?? s.targetUser ?? s.userName ?? s.user ?? '', 200));
                if (target.trim()) out.actions.push({ type: 'stream.shoutout', platform: 'twitch', target }); else gap('unknown.effect', label, fieldHint(s));
                break;
            }
            case 'PlaySoundFromFolder': gap('sound.folder', label); break;
            default: gap(/speak|tts/i.test(name) ? 'tts.speak' : 'unknown.effect', label, fieldHint(s));
        }
        if (randomPick && out.actions.length > before) branches.push({ weight: num(s.weight, 0) > 0 ? num(s.weight) : 1, actions: out.actions.splice(before) });
    }
    if (randomPick) {
        if (branches.length >= 2) out.actions.push({ type: 'random', branches });
        else if (branches.length === 1) out.actions.push(...branches[0].actions);
    }
    return out;
}

function fieldHint(s) {
    const f = Object.keys(s).filter((k) => !['id', 'weight', 'type', 'parentId', 'enabled', 'index', 'connectionId'].includes(k)).slice(0, 6);
    return f.length ? ` (fields: ${f.join(', ')})` : ' (no settings)';
}

function merge(into, from) {
    into.gaps.push(...from.gaps);
    into.notes.push(...from.notes);
    into.vars.push(...from.vars);
    into.media.push(...from.media);
    into.comments += from.comments;
}

// ── the parser ──────────────────────────────────────────────────────────────────────────────

export function parseStreamerbot({ files = null, exported = null, wantViewers = false } = {}) {
    const stripped = { fields: 0, values: 0 };
    const clean = (v) => {
        const r = stripSecrets(v);
        stripped.fields += r.stripped.fields;
        stripped.values += r.stripped.values;
        return r.value;
    };
    let fm = new Map();
    if (files) {
        const root = dataRoot(files) ?? '';
        for (const [p, b] of files) if (p.startsWith(root)) fm.set(p.slice(root.length), b);
    }
    const ex = exported ? clean(exported) : null;
    const data = ex ? (ex.data || ex) : null;
    const actionsFile = data ? null : clean(json(fm, 'actions.json'));
    const commandsFile = data ? null : clean(json(fm, 'commands.json'));
    const settings = data ? null : clean(json(fm, 'settings.json'));
    const actions = data ? list(data.actions) : list(actionsFile?.actions);
    const commands = data ? list(data.commands) : list(commandsFile?.commands);
    const timers = data ? list(data.timers) : list(settings?.timedActions?.timers);
    const sttCommands = new Map(list(settings?.speechToText?.commands).map((c) => [String(c.id), c]));

    const bundle = {
        source: 'streamerbot', format: data ? 'export' : 'data',
        version: str(ex?.exportedFrom || ex?.meta?.minimumVersion || '', 40) || (actionsFile?.version != null ? `actions.json v${actionsFile.version}` : null),
        name: ex?.meta?.name ? str(ex.meta.name, 100) : null,
        commands: [], automations: [], timers: [], counters: [], quotes: [], rewards: [], moderation: null, hotkeys: [],
        integrations: [], obs: null, viewers: null, media: [], dropped: [], files: [...fm.keys()].sort(), stripped,
    };

    const cmdById = new Map(commands.map((c) => [String(c.id), c]));
    const timerById = new Map(timers.map((t) => [String(t.id), t]));
    const usedCommands = new Set();
    const usedTimers = new Set();

    for (const a of actions) {
        if (!a || typeof a !== 'object') continue;
        const name = str(a.name || 'Action', 100);
        const conv = convertSubActions(a.subActions, {}, 0, !!a.randomAction);
        const base = { actions: conv.actions, gaps: [...conv.gaps], notes: [...new Set(conv.notes)], vars: [...new Set(conv.vars)] };
        const triggers = list(a.triggers).filter((t) => t && t.enabled !== false);
        if (!triggers.length) {
            bundle.automations.push({ sourceId: String(a.id), kind: 'action', name, enabled: a.enabled !== false, trigger: null, group: str(a.group, 60), ...base,
                notes: [...base.notes, 'It has no trigger in Streamer.bot (it is run by other actions or by hand)'] });
            continue;
        }
        for (const t of triggers) {
            const code = num(t.type, -1);
            const def = SB_TRIGGERS[code];
            const sid = triggers.length > 1 ? `${a.id}:${t.id}` : String(a.id);
            if (def?.[1] === 'command') {
                const c = cmdById.get(String(t.commandId));
                if (!c) { bundle.dropped.push({ category: 'commands', name, reason: 'Its command is not in the file', gap: null }); continue; }
                usedCommands.add(String(c.id));
                bundle.commands.push(commandEntry(c, a, base));
                continue;
            }
            if (def?.[1] === 'timer') {
                const tm = timerById.get(String(t.timerId));
                if (!tm) { bundle.dropped.push({ category: 'timers', name, reason: 'Its timed action is not in the file', gap: null }); continue; }
                usedTimers.add(String(tm.id));
                bundle.timers.push({ sourceId: String(tm.id), name: str(tm.name || name, 100), enabled: tm.enabled !== false && a.enabled !== false,
                    intervalSeconds: num(tm.interval, 0), chatLines: num(tm.lines, 0), liveOnly: false, ...base });
                continue;
            }
            const trig = triggerOf(code, { ...t, _actionName: name }, sttCommands);
            if (!trig.trigger) {
                bundle.dropped.push({ category: 'automations', name, reason: `${sbTriggerName(code)} has no CertiFried trigger`, gap: trig.gap || 'trigger.other', detail: sbTriggerName(code) });
                continue;
            }
            bundle.automations.push({
                sourceId: sid, kind: trig.kind, name, enabled: a.enabled !== false, trigger: trig.trigger, group: str(a.group, 60),
                ...base, gaps: [...base.gaps, ...(trig.gap ? [{ gap: trig.gap, detail: `Streamer.bot trigger ${sbTriggerName(code)}` }] : [])],
                notes: [...base.notes, ...trig.notes], ...(trig.rewardId ? { rewardId: trig.rewardId } : {}),
            });
        }
    }
    // Commands with no action: nothing to run, listed.
    for (const c of commands) {
        if (usedCommands.has(String(c.id))) continue;
        bundle.dropped.push({ category: 'commands', name: str(String(c.command || c.name).split(/\r?\n/)[0], 100), reason: 'No action uses this command', gap: null });
    }
    for (const t of timers) {
        if (usedTimers.has(String(t.id))) continue;
        bundle.dropped.push({ category: 'timers', name: str(t.name, 100), reason: 'No action uses this timed action', gap: null });
    }

    // channel point rewards (definitions) and automatic rewards
    const rw = data ? null : clean(json(fm, 'twitch_rewards.json'));
    for (const r of list(rw?.rewards)) {
        if (!r?.id) continue;
        bundle.rewards.push({
            sourceId: String(r.id), kind: 'channel_points', twitchId: str(r.id, 64), title: str(r.title || r.name, 45), prompt: str(r.prompt, 200), cost: num(r.cost),
            costUnit: 'points', enabled: r.enabled !== false, userInput: !!r.userInput, color: /^#[0-9a-f]{6}$/i.test(String(r.backgroundColor || '')) ? r.backgroundColor : null,
            cooldownSeconds: num(r.globalCooldown ?? r.cooldown, 0), maxPerStream: num(r.maxPerStream, 0), maxPerUserPerStream: num(r.maxPerUserPerStream, 0),
            skipQueue: !!r.skipQueue, createdBy: 'Streamer.bot',
        });
    }
    for (const r of list(rw?.autoRewards)) {
        bundle.rewards.push({ sourceId: `auto:${str(r.type, 60)}`, kind: 'auto', twitchId: null, title: str(r.type, 60).replace(/_/g, ' '), prompt: '', cost: num(r.cost),
            costUnit: 'points', enabled: true, userInput: !!r.userInput, color: null, cooldownSeconds: 0, maxPerStream: 0, maxPerUserPerStream: 0, skipQueue: false, createdBy: 'Twitch' });
    }

    // quotes
    const q = data ? null : clean(json(fm, 'quotes.dat'));
    for (const x of list(q?.quotes ?? (data ? data.quotes : null))) {
        if (!x?.quote && !x?.text) continue;
        bundle.quotes.push({ sourceId: String(x.id ?? bundle.quotes.length + 1), text: str(x.quote || x.text, 500), author: str(x.userName || x.user || '', 100), game: str(x.gameName || x.game || '', 100), createdAt: x.timestamp || null });
    }

    // hotkeys
    const hk = data ? null : clean(json(fm, 'hotkeys.json'));
    for (const h of list(hk?.hotKeys)) {
        bundle.hotkeys.push({ sourceId: String(h.id || h.name), name: str(h.name, 100), keys: str(h.keys || h.hotkey || '', 60), enabled: h.enabled !== false, actionCount: h.actionId ? 1 : 0 });
    }

    // integrations: which services start, by name; OBS host and port
    const used = new Set();
    for (const a of bundle.automations) for (const p of a.trigger?.config?.platforms || []) used.add(p);
    if ([...bundle.commands, ...bundle.automations].some((x) => (x.actions || []).some((s) => s.platform === 'twitch'))) used.add('twitch');
    if ([...bundle.commands, ...bundle.automations].some((x) => JSON.stringify(x.actions || []).includes('"obs.'))) used.add('obs');
    if (settings) {
        const on = (o) => !!(o && (o.autoConnect || o.autoStart));
        const map = { twitch: settings.twitch, kick: settings.kick, youtube: settings.youTube, pulsoid: settings.pulsoid, hyperate: settings.hypeRate,
            lumia: settings.lumiaStream, voicemod: settings.voiceModSettings, vtubestudio: settings.vTubeStudioSettings, crowdcontrol: settings.crowdcontrol,
            websocket: settings.websockets, streamdeck: settings.streamDeckSettings };
        for (const [k, v] of Object.entries(map)) if (on(v)) used.add(k);
        if (list(settings.speechToText?.commands).length) used.add('speech');
    }
    if (bundle.automations.some((a) => /spotify/i.test(a.group || a.name)) || bundle.dropped.some((d) => /spotify/i.test(d.name))) used.add('spotify');
    for (const s of [...used].sort()) if (s !== 'speech') bundle.integrations.push({ service: s, detail: '' });
    const obs = data ? null : clean(json(fm, 'obs.json'));
    const conn = list(obs?.connections).find((c) => c?.default) || list(obs?.connections)[0];
    if (conn) bundle.obs = { host: str(conn.host || '127.0.0.1', 100), port: num(conn.port, 4455) };

    // viewers (users.dat: id, name, role, platform, last active; no watch time)
    const users = data ? null : json(fm, 'users.dat');
    if (users && Array.isArray(users.users)) {
        const fields = new Set();
        for (const u of users.users) for (const k of Object.keys(u || {})) fields.add(k);
        // H-747: names and the last time Streamer.bot saw them (no watch time or messages: it keeps none). Twitch only.
        const seenAt = (...v) => v.map((x) => Date.parse(String(x || ''))).filter((t) => Number.isFinite(t) && t > Date.UTC(2005, 0, 1)).sort((a, b) => b - a)[0] || null;
        const rows = wantViewers ? users.users.filter((u) => u && String(u.type || 'twitch').toLowerCase() === 'twitch' && /^\d{1,20}$/.test(String(u.id)))
            .map((u) => ({ platform: 'twitch', id: String(u.id), login: str(u.name, 40), name: u.display ? str(u.display, 100) : null, lastSeen: seenAt(u.lastActive, u.previousActive) })) : [];
        bundle.viewers = { count: users.users.length, fields: [...fields].sort(), rows };
    }

    // LiteDB files are listed as skipped
    bundle.skippedFiles = [...fm.keys()].filter((p) => /\.db$/i.test(p)).map((p) => ({ path: p, reason: 'LiteDB database (global variables and history); not read' }));
    return bundle;
}

function commandEntry(c, a, base) {
    const triggers = String(c.command || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
    const roles = [];
    for (const g of list(c.permittedGroups)) {
        const k = String(g).toLowerCase();
        if (/^mod/.test(k)) roles.push('moderator');
        else if (/^vip/.test(k)) roles.push('vip');
        else if (/^sub/.test(k)) roles.push('subscriber');
        else if (/^broad/.test(k)) roles.push('broadcaster');
    }
    if (roles.includes('moderator') && !roles.includes('broadcaster')) roles.push('broadcaster');
    const notes = [...base.notes];
    if (list(c.permittedUsers).length) notes.push('The list of named users allowed to run it was not kept');
    const gaps = [...base.gaps];
    if (num(c.mode) === 1) gaps.push({ gap: 'command.regex_trigger', detail: 'Streamer.bot command in regex mode' });
    if (num(c.location) !== 0) notes.push('It matched anywhere in the message; here it matches the first word');
    // CommandSource flags (Streamer.bot.exe): Message 1 (Twitch chat), Whisper 2, BotWhisper 4, Resub 8,
    // TwitchSharedChat 16, YouTubeMessage 1024, KickMessage 2097152.
    const platforms = [];
    const src = num(c.sources, 1);
    if (src & 1 || src & 16) platforms.push('twitch');
    if (src & 2097152) platforms.push('kick');
    if (src & 1024) platforms.push('youtube');   // YouTube Live (H-741)
    return {
        sourceId: String(c.id), name: str(triggers[0] || c.name, 100), triggers, regex: num(c.mode) === 1, anywhere: num(c.location) !== 0,
        enabled: c.enabled !== false && a.enabled !== false, cooldown: { global: num(c.globalCooldown), user: num(c.userCooldown) }, roles: [...new Set(roles)],
        platforms: platforms.length ? platforms : null, group: str(c.group || a.group, 60), actionName: str(a.name, 100),
        actions: base.actions, gaps, notes, vars: base.vars, uses: null,
    };
}

function triggerOf(code, t, stt) {
    const def = SB_TRIGGERS[code];
    if (!def || !def[1]) return { trigger: null, gap: def?.[2] || (code >= 4000 && code < 5000 ? 'trigger.youtube_other' : 'trigger.other') };
    const type = def[1];
    const trigger = { type, config: {}, conditions: [] };
    const notes = [];
    const platforms = TRIGGER_PLATFORM(code);
    if (platforms) trigger.config.platforms = platforms;
    let kind = 'event';
    let gap = def[2] || null;
    let rewardId = null;
    if (code === 302) {
        // CertiFried Studio's voice commands (trigger voice.phrase, config { phrases }): Streamer.bot keeps one or more
        // phrases per speech command, one per line (some setups separate them with ;).
        kind = 'speech';
        const c = stt.get(String(t.commandId));
        let phrases = voicePhrases(c?.command);
        if (!phrases.length) {
            phrases = voicePhrases(t._actionName || 'voice command');
            notes.push(`The voice phrase is not in the file (settings.json), so the action name "${phrases[0]}" became the phrase`);
        }
        trigger.config = { phrases };
    } else if (code === 196 || code === 496) {
        // Power-ups come through "Power-up or Bits used" (bits.used, EventSub channel.bits.use). Twitch reports a power-up
        // by kind, not by Streamer.bot's custom power-up id, so the mapper matches it by its Bits cost when the power-up's
        // definition is in the import (Firebot power-ups.json), and says so.
        kind = 'power_up';
        rewardId = str(t.customPowerUpId || '', 64) || null;
        trigger.config.bitsKind = 'power_up';
    } else if (code === 706) {
        kind = 'app_started';
        notes.push('Streamer.bot started → CertiFried Studio connected');
        delete trigger.config.platforms;
    } else if (code === 112) {
        kind = 'reward';
        rewardId = str(t.rewardId || '', 64);
        if (rewardId) trigger.conditions.push({ type: 'metadata', path: 'rewardId', op: 'eq', value: rewardId });
    } else if (code === 4016) {
        // First words: a viewer's first chat line in the current YouTube broadcast (normalise.js metadata.firstWords).
        trigger.config.match = { mode: 'regex', text: '.', caseSensitive: false };
        trigger.conditions.push({ type: 'metadata', path: 'firstWords', op: 'eq', value: 'true' });
        notes.push('First words: a viewer\'s first chat line in the current YouTube broadcast (counted afresh after a CertiFried restart)');
    } else if (code === 4003) {
        trigger.config.match = { mode: 'regex', text: '.', caseSensitive: false };
        notes.push('It ran on every YouTube chat message; it matches every message here too');
    } else if (YT_KIND[code]) {
        trigger.conditions.push({ type: 'metadata', path: 'kind', op: 'eq', value: YT_KIND[code] });
        if ((code === 4006 || code === 4007) && (num(t.min) || num(t.max))) trigger.conditions.push({ type: 'amount', min: num(t.min) || null, max: num(t.max) || null });
    } else if (code === 133 || code === 35010) {
        trigger.config.match = { mode: 'regex', text: '.', caseSensitive: false };
        notes.push('It ran on every chat message; it matches every message here too');
    } else if (code === 14004) {
        kind = 'obs';
        if (t.sceneName) trigger.conditions.push({ type: 'metadata', path: 'scene', op: 'eq', value: str(t.sceneName, 200) });
    } else if (code === 102 && (num(t.min) || num(t.max))) {
        trigger.conditions.push({ type: 'amount', min: num(t.min) || null, max: num(t.max) || null });
    }
    return { trigger, kind, gap, notes, rewardId };
}

export default { parseStreamerbot, decodeImportString, convertSubActions, SB_TRIGGERS, sbTriggerName, dataRoot };
