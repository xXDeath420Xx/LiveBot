/*
 * The one-click switchover from Firebot / Streamer.bot (design §12, migration 466). For every streamer, not only the owner.
 *
 *   createSwitchover({ db, store, importStore, hub, media, sounds, prefix, channelTables, now, ackWaitMs })
 *     .preview(profileId)                 → plan (below). Reads Studio's OBS scenes live (obs.scene_items) when Studio is connected.
 *     .apply(profileId, { include, obs, closeApps })   does it: include = ids of "needs attention" items the streamer ticked
 *                                                      (strings 'a:<id>'); obs: show/hide in OBS (default true); closeApps:
 *                                                      ask Studio to close Firebot and Streamer.bot (only when ticked)
 *     .undo(profileId)                     the last applied switchover, put back exactly as it was before
 *     .history(profileId)                  the last switchovers
 *   buildPlan({ … })                       pure: what the switchover would do (tested on its own)
 *   attentionFor(automation, ctx)          why an imported automation should be checked before it is turned on
 *
 * What it turns on: the profile's imported automations (stream_bot_import_items target automation), imported channel commands
 * (cc:) and timers (timer:), and the song request automations (a music.command step). Left alone: anything already on,
 * anything the streamer changed after the import (automation hash differs from the one the importer wrote; a channel command
 * whose updated_at moved, unless only a switchover moved it), items that need attention (off unless ticked), and items that
 * were switched off in Firebot / Streamer.bot (import item data.sourceOn === false: state 'source_off', off unless ticked,
 * 2026-11-20). Items the streamer removed (target_kind 'dismissed') are not in it at all.
 *
 * OBS (through CertiFried Studio): every CertiFried browser source that says which source it replaces (Studio 0.2.7 stores
 * certifried_replaces in its settings) is shown where the replaced one is showing, and the replaced one is hidden. Sound
 * Alerts and Blerp are never hidden (viewer-paid sounds CertiFried cannot replace until the Bits extension). OBS is
 * never asked to switch scenes, delete or change sources, or touch audio.
 *
 * Voice (2026-11-20): when any voice command (voice.phrase automation) will be on, apply asks Studio to turn voice commands on
 * (voice.enable, capability 'voice', Studio 0.2.8: sets the switch, fetches the phrases, starts listening, answers with where it
 * got to; an optional confidence threshold from Streamer.bot's speech setting). Studio offline or too old: a blocking line in the plan.
 * "Close Firebot and Streamer.bot" is refused while Studio's voice state is not 'listening' and a voice command is on: Streamer.bot
 * is then the only thing listening.
 *
 * Chat commands: for each channel that gets an imported channel command turned on, the channel's "Chat commands" switch
 * (tokes_channels.features_enabled.commands, the same write as the Commands tab) goes on too; Undo puts the old value back.
 *
 * Firebot source in steps: an obs.source step on an untouched imported automation that names a source CertiFried replaces
 * (certifried.replaces) is rewritten to the replacing source; the old steps are kept in `previous` for Undo.
 *
 * Apply writes its switchover record first (status 'applying') and saves `previous` after every change, so Undo always has what was done,
 * including after a failure ('partial'). Steps are only rewritten once Studio confirms the whole OBS swap. Undo also puts Studio's voice
 * switch and confidence back (voice.set); if Studio is offline it says so and keeps that part for the next Undo.
 *
 * Undo restores the enabled flags it stored and the visibility each OBS item had (Studio reports it with every change). Closed
 * apps are not reopened (the page says so).
 */
import { automationHash } from './import/apply.js';

export const NEVER_HIDE = /^(sound\s*alerts?|blerp)\b/i;
export const SONG_STEP = 'music.command';
export const UNDO_VOICE_OFFLINE = 'Turn voice commands off in Studio, or reconnect Studio and press Undo again.';
export const VOICE_NOT_LISTENING = 'Firebot and Streamer.bot were not closed. Streamer.bot is the only thing listening for your voice commands until CertiFried Studio says it is listening. Turn on Voice commands in Studio (Voice tab), check it shows Listening, then press Switch over again with the box ticked.';
const MAX_ITEMS = 600;
const T_OK = (p) => /^[a-z0-9_]{1,30}$/.test(p);
const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (v, d) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };
const clip = (s, n = 200) => String(s ?? '').slice(0, n);

/** Every step of an automation, including those inside random choices and other nested lists. */
export function stepsOf(actions, out = []) {
    for (const s of Array.isArray(actions) ? actions : []) {
        if (!s || typeof s !== 'object') continue;
        if (s.type) out.push(s);
        for (const k of ['actions', 'then', 'else', 'steps']) if (Array.isArray(s[k])) stepsOf(s[k], out);
        if (Array.isArray(s.branches)) for (const b of s.branches) stepsOf(b?.actions, out);
    }
    return out;
}
export const isSongRequest = (a) => stepsOf(a?.actions).some((s) => s.type === SONG_STEP);

const NOTE_ATTENTION = [
    { re: /check that is what you want|check it before|before turning it on/i, why: (n) => n },
    { re: /voice phrase is not in the file/i, why: () => 'Its voice phrase was guessed from the action name; check the phrase.', phrase: true },
];

/**
 * Why an automation needs a look before it is turned on (empty: it can go on). ctx = { notes: [import notes], mediaNames: Set,
 * soundNames: Set, obs: { known, scenes: Set, sources: Set, inputs: Set }, grantScopes: Set | null (the Stream bot grant's) }.
 */
export function attentionFor(a, ctx = {}) {
    const why = [];
    const named = new Set();   // media already reported from an import note
    // The importer's "add a role condition" note (Firebot !clear for anyone) is answered once the automation has a role condition
    // that leaves out everyone (2026-11-20); the note stays in the import report because the source still has no restriction.
    const roleLimited = (a?.conditions || []).some((c) => c?.type === 'role' && c.mode !== 'none' && Array.isArray(c.roles) && c.roles.length && !c.roles.includes('everyone'));
    for (const n of ctx.notes || []) {
        if (roleLimited && /add a role condition/i.test(n)) continue;
        for (const r of NOTE_ATTENTION) if (r.re.test(n) && !(r.phrase && ctx.phraseChecked)) why.push(r.why(n));
        const up = String(n).match(/Upload the image as "([^"]+)"/);
        if (up && !(ctx.mediaNames || new Set()).has(up[1].toLowerCase())) { named.add(up[1].toLowerCase()); why.push(`It shows the image "${up[1]}", which is not in your overlay media yet.`); }
    }
    const o = ctx.obs || {};
    const tmpl = (v) => /\{[^}]+\}/.test(String(v || ''));
    for (const s of stepsOf(a?.actions)) {
        const p = s;
        if (s.type === 'overlay.media' && p.media && !tmpl(p.media) && ctx.mediaNames && !ctx.mediaNames.has(String(p.media).toLowerCase()) && !named.has(String(p.media).toLowerCase())) why.push(`It shows "${clip(p.media, 60)}", which is not in your overlay media.`);
        if (s.type === 'sound.play' && p.sound && !/^https?:|[\\/]|\.[a-z0-9]{2,4}$/i.test(String(p.sound)) && !tmpl(p.sound) && ctx.soundNames && !ctx.soundNames.has(String(p.sound).toLowerCase())) why.push(`It plays the sound "${clip(p.sound, 60)}", which is not in your Sounds.`);
        if (s.type === 'obs.stream' && ['stop', 'toggle'].includes(String(p.state || 'toggle'))) why.push(p.state === 'stop' ? 'It stops your stream.' : 'It starts or stops your stream (toggle).');
        if (s.type === 'stream.say' && ctx.grantScopes && !ctx.grantScopes.has('user:write:chat')) why.push('It sends chat as you: re-approve Twitch on Connections first ("Send chat messages as you").');
        if (o.known) {
            if (['obs.scene', 'obs.preview'].includes(s.type) && p.scene && !tmpl(p.scene) && !o.scenes.has(p.scene)) why.push(`OBS has no scene called "${clip(p.scene, 60)}".`);
            if (['obs.source', 'obs.text', 'obs.browser_url', 'obs.browser_refresh', 'obs.filter'].includes(s.type) && p.source && !tmpl(p.source) && !o.sources.has(p.source)) why.push(`OBS has no source called "${clip(p.source, 60)}".`);
            if (['obs.mute', 'obs.volume'].includes(s.type) && p.input && !tmpl(p.input) && o.inputs.size && !o.inputs.has(p.input)) why.push(`OBS has no audio source called "${clip(p.input, 60)}".`);
        }
    }
    return [...new Set(why)].slice(0, 6);
}

const SOURCE_STEPS = ['obs.source', 'obs.text', 'obs.browser_url', 'obs.browser_refresh', 'obs.filter'];
const isTemplate = (v) => /\{[^}]+\}/.test(String(v || ''));

/** OBS source names an automation uses that OBS does not have (empty when OBS was not read). */
export function unknownObsSources(a, o = {}) {
    if (!o.known) return [];
    const out = [];
    for (const s of stepsOf(a?.actions)) if (SOURCE_STEPS.includes(s.type) && s.source && !isTemplate(s.source) && !o.sources.has(s.source) && !out.includes(s.source)) out.push(s.source);
    return out.slice(0, 6);
}

/** The CertiFried source that replaces `source` in `scene` (any scene when the step names none), or null (none, or two different ones). */
export function replacementFor(pairs, scene, source) {
    const own = (pairs || []).filter((p) => p.oldSource === source);
    if (!own.length) return null;
    if (scene && !isTemplate(scene)) return own.find((p) => p.scene === scene)?.newSource || null;
    const names = [...new Set(own.map((p) => p.newSource))];
    return names.length === 1 ? names[0] : null;
}

/**
 * Streamer.bot's speech confidence (0 to 1) rounded to Studio's slider steps (0.05 from 0.2 to 0.95). Shown for information
 * only since 2026-11-20: Studio's recogniser scores differently, and applying Streamer.bot's usual 0.2 made Studio fire
 * commands nobody said (BRB five times in ten minutes). The switchover never suggests or applies it; Studio keeps its own
 * setting (default 0.7).
 */
export const STUDIO_VOICE_DEFAULT = 0.7;
export function suggestThreshold(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.max(0.2, Math.min(0.95, Math.round(n * 20) / 20));
}

/** OBS show/hide pairs from Studio's obs.scene_items answer: { scenes: { <scene>: [{ source, enabled, certifried: { replaces } }] } }. */
export function obsPairs(sceneItems) {
    const pairs = [];
    const kept = new Set();
    for (const [scene, items] of Object.entries(sceneItems?.scenes || {})) {
        if (!Array.isArray(items)) continue;
        for (const it of items) {
            const old = it?.certifried?.replaces;
            if (!old) continue;
            if (NEVER_HIDE.test(old)) { kept.add(old); continue; }
            const was = items.find((x) => x.source === old);
            if (!was) continue;
            pairs.push({ scene, newSource: it.source, oldSource: old, newVisible: !!it.enabled, oldVisible: !!was.enabled,
                change: was.enabled ? (it.enabled ? 'hide_old' : 'swap') : 'none' });
        }
        for (const it of items) if (NEVER_HIDE.test(it.source)) kept.add(it.source);
    }
    return { pairs, kept: [...kept].sort() };
}

/**
 * What a switchover would do (pure). Inputs: automations (the profile's), importItems (stream_bot_import_items), notes (Map
 * source|kind|sourceId → why[]), commands (Map id → { id, is_enabled, updated_at, command_name, channel_id, platform }),
 * timers (Map id → { id, is_enabled, name, message }), touched ({ commands: Set }) ids a switchover changed before, mediaNames,
 * soundNames, obs ({ known, scenes, sources, inputs }), sceneItems (Studio's answer or null), studio ({ connected, apps, voice
 * (has the voice capability), voiceState, voiceEnabled, voiceThreshold }), channels (Map tokes_channels id → { id, platform, name,
 * commandsOn }), speech (Streamer.bot's speech confidence 0 to 1, or null).
 */
export function buildPlan({ automations = [], importItems = [], notes = new Map(), commands = new Map(), timers = new Map(), touched = { commands: new Set() },
    mediaNames = new Set(), soundNames = new Set(), obs = { known: false }, sceneItems = null, studio = { connected: false, apps: false }, grantScopes = null, channels = new Map(), speech = null } = {}) {
    const byId = new Map(automations.map((a) => [Number(a.id), a]));
    const out = { automations: [], commands: [], timers: [], channelSwitches: [], rewrites: [], obs: null, apps: null, voice: null, counts: {} };
    const seen = new Set();
    const ctx = { mediaNames, soundNames, obs, grantScopes };
    const OFF_WHY = (it) => `It was switched off in ${it.source === 'firebot' ? 'Firebot' : it.source === 'streamerbot' ? 'Streamer.bot' : 'the app it came from'}, so it stays off unless you tick it.`;
    const offThere = (it) => it?.data?.sourceOn === false;
    for (const it of importItems) {
        if (it.target_kind !== 'automation') continue;
        const id = Number(String(it.target_ref || '').replace(/^automation:/, ''));
        const a = byId.get(id);
        if (!a || seen.has(id)) continue;
        seen.add(id);
        const songs = isSongRequest(a);
        const row = { key: `a:${id}`, id, itemId: it.id ?? null, name: a.name, source: it.source, songs, enabled: !!a.enabled, reasons: [], state: 'turn_on',
            voice: a.trigger_type === 'voice.phrase', phrases: a.trigger_type === 'voice.phrase' ? (Array.isArray(a.trigger_config?.phrases) ? a.trigger_config.phrases.map((x) => clip(x, 100)).slice(0, 20) : []) : [],
            unknownSources: [], streamStop: stepsOf(a.actions).some((x) => x.type === 'obs.stream' && x.state === 'stop') };
        const edited = it.data?.hash && !it.data?.keep ? automationHash(a) !== it.data.hash : false;
        row.rewritable = !edited && !it.data?.keep && !!it.data?.hash;
        if (a.enabled) row.state = 'already_on';
        else if (edited) row.state = 'edited';
        else if (offThere(it)) { row.state = 'source_off'; row.reasons = [OFF_WHY(it)]; }
        else {
            row.reasons = attentionFor(a, { ...ctx, notes: notes.get(`${it.source}|${it.kind}|${it.source_id}`) || [], phraseChecked: !!it.data?.phraseChecked });
            row.unknownSources = unknownObsSources(a, obs);
            if (row.reasons.length) row.state = 'attention';
        }
        out.automations.push(row);
    }
    // Song request automations made on the Music page (Add commands) rather than by the import.
    for (const a of automations) {
        if (seen.has(Number(a.id)) || !isSongRequest(a)) continue;
        seen.add(Number(a.id));
        out.automations.push({ key: `a:${a.id}`, id: Number(a.id), itemId: null, name: a.name, source: 'music', songs: true, enabled: !!a.enabled, reasons: [], state: a.enabled ? 'already_on' : 'turn_on',
            voice: false, phrases: [], unknownSources: [], streamStop: false, rewritable: false });
    }
    for (const it of importItems) {
        const refs = String(it.target_ref || '').split(',').filter(Boolean);
        if (it.target_kind === 'channel_command') {
            for (const r of refs) {
                const c = commands.get(Number(r.replace(/^cc:/, '')));
                if (!c) continue;
                const edited = !!c.updated_at && !touched.commands.has(c.id);
                const off = !c.is_enabled && !edited && offThere(it);
                out.commands.push({ key: `c:${c.id}`, id: c.id, channelId: c.channel_id != null ? Number(c.channel_id) : null, name: `!${c.command_name}`, platform: c.platform || null, source: it.source, enabled: !!c.is_enabled,
                    state: c.is_enabled ? 'already_on' : edited ? 'edited' : off ? 'source_off' : 'turn_on', reasons: off ? [OFF_WHY(it)] : [] });
            }
        } else if (it.target_kind === 'channel_timer' || it.target_kind === 'bot_timer') {
            for (const r of refs) {
                const t = timers.get(Number(r.replace(/^timer:/, '')));
                if (!t) continue;
                const off = !t.is_enabled && offThere(it);
                out.timers.push({ key: `t:${t.id}`, id: t.id, name: t.name || clip(t.message, 60) || it.name, source: it.source, enabled: !!t.is_enabled,
                    state: t.is_enabled ? 'already_on' : off ? 'source_off' : 'turn_on', reasons: off ? [OFF_WHY(it)] : [] });
            }
        }
    }
    out.automations = out.automations.slice(0, MAX_ITEMS);
    if (!studio.connected) out.obs = { available: false, reason: 'studio_offline', pairs: [], kept: [] };
    else if (!sceneItems) out.obs = { available: false, reason: 'studio_no_answer', pairs: [], kept: [] };
    else out.obs = { available: true, ...obsPairs(sceneItems) };
    out.apps = { canClose: !!(studio.connected && studio.apps) };

    // The channel "Chat commands" master switch: off, imported commands stay silent (command-handler). One item per channel.
    const sw = new Map();
    for (const c of out.commands) {
        const ch = channels.get(c.channelId);
        if (!ch || ch.commandsOn || !['turn_on', 'source_off'].includes(c.state)) continue;
        const e = sw.get(ch.id) || { ch, keys: [], turnOn: false };
        e.keys.push(c.key);
        if (c.state === 'turn_on') e.turnOn = true;
        sw.set(ch.id, e);
    }
    for (const e of sw.values()) {
        out.channelSwitches.push({ key: `f:${e.ch.id}`, channelId: e.ch.id, platform: e.ch.platform || null, channel: e.ch.name || null,
            name: `Turn on Chat commands for #${e.ch.name || e.ch.id}`, state: e.turnOn ? 'turn_on' : 'held', commandKeys: e.keys, enabled: false });
    }

    // Steps that show or hide a source the switchover replaces (Firebot, StreamLabs, ...): point them at the CertiFried source.
    if (out.obs.available) {
        for (const row of out.automations) {
            const a = byId.get(row.id);
            if (!a || !row.rewritable) continue;
            const hits = [];
            for (const s of stepsOf(a.actions)) {
                if (s.type !== 'obs.source' || !s.source || isTemplate(s.source)) continue;
                const to = replacementFor(out.obs.pairs, s.scene, s.source);
                if (to) hits.push({ scene: s.scene || null, from: s.source, to });
            }
            if (hits.length) out.rewrites.push({ key: row.key, id: row.id, itemId: row.itemId, name: row.name, hits: hits.slice(0, 20) });
        }
    }

    // Voice commands: Studio has to be listening, or Streamer.bot (the only listener) must stay open.
    const voiceRows = out.automations.filter((a) => a.voice);
    const voiceOn = voiceRows.filter((a) => a.state === 'turn_on' || a.state === 'already_on').length;
    const capable = !!(studio.connected && studio.voice);
    out.voice = {
        on: voiceOn, held: voiceRows.filter((a) => a.state === 'attention' || a.state === 'source_off').length,
        studio: { connected: !!studio.connected, capable, state: studio.voiceState ?? null, enabled: studio.voiceEnabled ?? null, threshold: studio.voiceThreshold ?? null },
        step: voiceOn && capable ? 'enable' : null,
        blocking: !voiceOn ? null : !studio.connected
            ? 'Voice commands: CertiFried Studio is not connected, so they cannot be turned on. Open Studio, then press Look again. Until then Streamer.bot is the only thing listening: leave it open.'
            : !capable ? 'Voice commands: this CertiFried Studio is too old to turn them on from here. Update to 0.2.8 or later, or turn on Voice commands in Studio yourself, then press Look again. Leave Streamer.bot open until Studio says it is listening.' : null,
        // Never a suggestion (see suggestThreshold): what Streamer.bot used, for the explanation on the page, and Studio's default.
        suggestedThreshold: null,
        streamerbotThreshold: suggestThreshold(speech),
        studioDefault: STUDIO_VOICE_DEFAULT,
        obsSources: [...(obs.sources || [])].sort((x, y) => String(x).localeCompare(String(y))).slice(0, 300),
    };
    const count = (list) => list.reduce((m, x) => { m[x.state] = (m[x.state] || 0) + 1; return m; }, {});
    out.counts = { automations: count(out.automations), commands: count(out.commands), timers: count(out.timers),
        channelSwitches: count(out.channelSwitches), rewrites: out.rewrites.length, voice: voiceOn,
        songs: out.automations.filter((a) => a.songs && a.state === 'turn_on').length, obsChanges: out.obs.pairs.filter((p) => p.change !== 'none').length,
        sourceOff: [...out.automations, ...out.commands, ...out.timers].filter((x) => x.state === 'source_off').length };
    return out;
}

/** The OBS changes a plan makes: show the CertiFried source where the old one showed, hide the old one. */
export function obsChanges(plan) {
    const out = [];
    for (const p of plan.obs?.pairs || []) {
        if (p.change === 'swap') out.push({ scene: p.scene, source: p.newSource, enabled: true }, { scene: p.scene, source: p.oldSource, enabled: false });
        if (p.change === 'hide_old') out.push({ scene: p.scene, source: p.oldSource, enabled: false });
    }
    return out;
}

export function createSwitchover({ db, store, importStore, hub = null, media = null, sounds = null, prefix = 'stream_bot_', channelTables = {}, now = () => Date.now(), ackWaitMs = 20_000, logger = null, invalidateChannel = null } = {}) {
    if (!T_OK(prefix)) throw new Error('bad table prefix');
    const T = (n) => `\`${prefix}${n}\``;
    const CC = `\`${channelTables.commands || 'tokes_custom_commands'}\``;
    const TM = `\`${channelTables.timers || 'tokes_timers'}\``;
    const CH = `\`${channelTables.channels || 'tokes_channels'}\``;
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[StreamBotSwitchover] ${m}`, meta); } catch { /* ignore */ } };
    const bust = (channelRowId) => { try { invalidateChannel?.(channelRowId); } catch { /* the chat bot cache is best effort */ } };

    const studioConn = (profileId) => (hub?.connected?.(profileId) || []).find((d) => d.kind === 'studio') || null;

    /** Dispatch one Studio action and wait for its answer (hub.onAck, H-758). */
    function ask(profileId, actionType, params, capability = 'obs') {
        return new Promise((resolve) => {
            let off = null;
            const timer = setTimeout(() => { off?.(); resolve({ status: 'timeout', result: null, error: 'Studio did not answer in time' }); }, ackWaitMs);
            timer.unref?.();
            Promise.resolve(hub.dispatch({ profileId, target: 'studio', capability, actionType, params, queueSeconds: 0 })).then((d) => {
                if (d.status === 'none') { clearTimeout(timer); resolve({ status: 'none', result: null, error: 'CertiFried Studio is not connected' }); return; }
                off = hub.onAck(d.id, (r) => { clearTimeout(timer); resolve(r); });
            }).catch((err) => { clearTimeout(timer); resolve({ status: 'failed', result: null, error: clip(err?.message, 120) }); });
        });
    }

    /**
     * Import notes per item, from the last five import reports, oldest first so the newest report that lists an item wins, also
     * when it has no notes left (a re-import with a fixed mapping clears an old note, e.g. Streamer.bot's inverted streaming
     * state, 2026-11-20). An item a newer report does not list keeps its older notes.
     */
    async function notesMap(profileId) {
        const map = new Map();
        const list = await importStore.listImports(profileId, 5);
        for (const imp of [...list].reverse()) {
            const full = await importStore.getImport(profileId, imp.id);
            for (const group of Object.values(full?.report?.groups || {})) {
                for (const it of group || []) if (it?.source && it.kind && it.sourceId != null) map.set(`${it.source}|${it.kind}|${it.sourceId}`, Array.isArray(it.why) ? it.why : []);
            }
        }
        return map;
    }
    /** Streamer.bot's speech confidence kept in the newest import report that has one (0 to 1), or null. */
    async function speechThreshold(profileId) {
        try {
            const list = await importStore.listImports(profileId, 5);
            for (const imp of list) {
                const full = await importStore.getImport(profileId, imp.id);
                const hit = (full?.report?.speech || []).find((x) => x?.source === 'streamerbot' && Number.isFinite(Number(x.confidenceThreshold)));
                if (hit) return Number(hit.confidenceThreshold);
            }
        } catch { /* no import report */ }
        return null;
    }
    async function rowsByIds(table, ids, cols) {
        if (!ids.length) return [];
        return q(`SELECT ${cols} FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    }
    async function previousTouched(profileId) {
        const set = new Set();
        try {
            for (const r of await q(`SELECT previous FROM ${T('switchovers')} WHERE profile_id = ? ORDER BY id DESC LIMIT 20`, [profileId])) {
                for (const c of parse(r.previous, {})?.commands || []) set.add(Number(c.id));
            }
        } catch { /* migration 466 not applied */ }
        return set;
    }

    async function inputs(profileId) {
        const automations = await store.listAutomations(profileId);
        const importItems = await importStore.listItems(profileId);
        const ref = (kind, pre) => [...new Set(importItems.filter((i) => i.target_kind === kind || (Array.isArray(kind) && kind.includes(i.target_kind)))
            .flatMap((i) => String(i.target_ref || '').split(',')).filter((r) => r.startsWith(pre)).map((r) => Number(r.slice(pre.length))).filter(Number.isInteger))];
        const ccIds = ref('channel_command', 'cc:');
        const tmIds = ref(['channel_timer', 'bot_timer'], 'timer:');
        // Only rows that belong to this profile: commands on its own linked channels, timers with its profile id or on its channels.
        const own = await store.listChannels(profileId);
        const chanIds = [];
        for (const c of own) {
            const r = (await q(`SELECT id, platform, channel_name, features_enabled FROM ${CH} WHERE platform = ? AND channel_id = ?`, [c.platform, String(c.platform_user_id ?? c.platformUserId)]))[0];
            if (r) chanIds.push({ id: Number(r.id), platform: r.platform, name: r.channel_name || null, commandsOn: (parse(r.features_enabled, {}) || {}).commands === true });
        }
        const chanPlat = new Map(chanIds.map((c) => [c.id, c.platform]));
        const channels = new Map(chanIds.map((c) => [c.id, c]));
        const commands = new Map((await rowsByIds(CC, ccIds, 'id, channel_id, command_name, is_enabled, updated_at')).filter((c) => chanPlat.has(Number(c.channel_id)))
            .map((c) => [Number(c.id), { ...c, id: Number(c.id), platform: chanPlat.get(Number(c.channel_id)) }]));
        const timers = new Map((await rowsByIds(TM, tmIds, 'id, channel_id, profile_id, name, message, is_enabled')).filter((t) => Number(t.profile_id) === Number(profileId) || chanPlat.has(Number(t.channel_id)))
            .map((t) => [Number(t.id), { ...t, id: Number(t.id) }]));
        const mediaNames = new Set((media ? await media.list(profileId).catch(() => []) : []).map((m) => String(m.name).toLowerCase()));
        const soundNames = new Set((sounds ? await sounds.list(profileId).catch(() => []) : []).map((s) => String(s.name).toLowerCase()));
        const grant = store.getTwitchGrant ? await store.getTwitchGrant(profileId).catch(() => null) : null;
        const grantScopes = grant && grant.status === 'active' ? new Set(grant.scopes || []) : null;
        return { automations, importItems, commands, timers, mediaNames, soundNames, grantScopes, channels };
    }

    async function obsState(profileId) {
        const conn = studioConn(profileId);
        const vs = conn?.state?.voice || null;
        const studio = { connected: !!conn, apps: !!conn?.capabilities?.includes('apps'), voice: !!conn?.capabilities?.includes('voice'),
            voiceState: vs?.state ?? null, voiceEnabled: vs ? !!vs.enabled : null, voiceThreshold: vs?.threshold ?? null };
        let sceneItems = null;
        if (conn) {
            const r = await ask(profileId, 'obs.scene_items', {});
            if (r.status === 'acked' && r.result?.scenes) sceneItems = r.result;
        }
        const reported = conn?.state?.obs || (await store.getSettingsKey(profileId, 'studio').catch(() => null))?.obs || null;
        const scenes = new Set(Object.keys(sceneItems?.scenes || {}).concat(reported?.scenes || []));
        const sources = new Set(Object.values(sceneItems?.scenes || {}).flatMap((l) => (l || []).map((i) => i.source)).concat(Object.values(reported?.sources || {}).flat()));
        const inputsSet = new Set((reported?.inputs || []).map((i) => (typeof i === 'string' ? i : i?.name)).filter(Boolean));
        return { studio, sceneItems, obs: { known: !!sceneItems, scenes, sources, inputs: inputsSet } };
    }

    async function preview(profileId, { sceneItems: given = undefined } = {}) {
        const inp = await inputs(profileId);
        const st = given === undefined ? await obsState(profileId) : { studio: { connected: !!given, apps: false }, sceneItems: given, obs: { known: !!given, scenes: new Set(Object.keys(given?.scenes || {})), sources: new Set(Object.values(given?.scenes || {}).flatMap((l) => (l || []).map((i) => i.source))), inputs: new Set() } };
        return buildPlan({ ...inp, notes: await notesMap(profileId), touched: { commands: await previousTouched(profileId) }, obs: st.obs, sceneItems: st.sceneItems, studio: st.studio, speech: await speechThreshold(profileId) });
    }

    /**
     * Point obs.source steps at the CertiFried source that replaces theirs (plan.rewrites: untouched imported automations only).
     * The old steps and both hashes go to `previous` so Undo can put them back, and the import item's hash follows the new steps so
     * the automation does not look like the streamer's own edit afterwards.
     */
    async function rewriteSteps(profileId, plan, prev, save = async () => {}) {
        let n = 0;
        for (const rw of plan.rewrites || []) {
            const a = await store.getAutomation(profileId, rw.id);
            if (!a) continue;
            const item = rw.itemId != null ? await importStore.getItemById(profileId, rw.itemId) : null;
            if (!item?.data?.hash || item.data.keep || automationHash(a) !== item.data.hash) continue;   // changed since the plan: leave it
            const oldActions = JSON.parse(JSON.stringify(a.actions || []));
            const actions = JSON.parse(JSON.stringify(a.actions || []));
            let changed = 0;
            for (const s of stepsOf(actions)) {
                if (s.type !== 'obs.source' || !s.source || isTemplate(s.source)) continue;
                const to = replacementFor(plan.obs.pairs, s.scene, s.source);
                if (to) { s.source = to; changed++; }
            }
            if (!changed) continue;
            // Written down before the write: Undo only puts the steps back while the automation still has the hash recorded here.
            const newHash = automationHash({ ...a, actions });
            prev.steps.push({ id: rw.id, itemId: item.id, oldHash: item.data.hash, newHash, actions: oldActions });
            await save();
            await store.updateAutomation(profileId, rw.id, { ...a, enabled: !!a.enabled, actions });
            await importStore.setItemData(profileId, item.id, { ...item.data, hash: automationHash(await store.getAutomation(profileId, rw.id)) });
            n += changed;
        }
        return n;
    }

    /**
     * Apply, written down as it goes: the switchover row is inserted first (status 'applying') and `previous` is saved after every
     * change, so whatever happens next (an error, a crash) Undo has exactly what was done. It ends 'applied' or 'partial' (with the
     * error in the result). A row that cannot be stored stops the switchover before anything is changed.
     */
    async function apply(profileId, { include = [], obs = true, closeApps = false, voiceThreshold = false } = {}) {
        const plan = await preview(profileId);
        const ticked = new Set((Array.isArray(include) ? include : []).map(String));
        const on = (x) => x.state === 'turn_on' || ((x.state === 'attention' || x.state === 'source_off') && ticked.has(x.key));
        const prev = { automations: [], commands: [], timers: [], channels: [], steps: [], voice: null, obs: [] };
        const result = { automations: 0, commands: 0, timers: 0, channels: 0, steps: 0, stepsSkipped: null, voice: null, obs: null, apps: null, error: null };
        const planJson = json({ counts: plan.counts, included: [...ticked].slice(0, 200), obs: !!obs, closeApps: !!closeApps, voiceThreshold: !!voiceThreshold });
        let id;
        try {
            id = Number((await q(`INSERT INTO ${T('switchovers')} (profile_id, status, plan, previous, result) VALUES (?, 'applying', ?, ?, ?)`, [profileId, planJson, json(prev), json(result)])).insertId);
        } catch (err) {
            log('error', 'could not start the switchover record; nothing was changed', { error: err?.message });
            throw new Error('The switchover could not be recorded, so nothing was changed.');
        }
        const save = (status = null) => q(`UPDATE ${T('switchovers')} SET ${status ? 'status = ?, ' : ''}previous = ?, result = ? WHERE id = ?`,
            [...(status ? [status] : []), json(prev), json(result), id]);
        let status = 'applied';
        try {
            const onAutomations = plan.automations.filter(on);
            for (const a of onAutomations) {
                prev.automations.push({ id: a.id, enabled: false });   // written down first: putting it off again is harmless if the write did not happen
                await save();
                if (await store.setAutomationEnabled(profileId, a.id, true)) result.automations++;
            }
            const onCommands = plan.commands.filter(on);
            for (const c of onCommands) {
                prev.commands.push({ id: c.id, enabled: false });
                await save();
                await q(`UPDATE ${CC} SET is_enabled = 1 WHERE id = ?`, [c.id]);
                result.commands++;
            }
            for (const t of plan.timers.filter(on)) {
                prev.timers.push({ id: t.id, enabled: false });
                await save();
                await q(`UPDATE ${TM} SET is_enabled = 1 WHERE id = ?`, [t.id]);
                result.timers++;
            }
            // The channel's Chat commands switch: the same write as the Commands tab. The old value is kept for Undo.
            const onKeys = new Set(onCommands.map((c) => c.key));
            for (const sw of plan.channelSwitches || []) {
                if (!sw.commandKeys.some((k) => onKeys.has(k))) continue;
                const row = (await q(`SELECT features_enabled FROM ${CH} WHERE id = ?`, [sw.channelId]))[0];
                if (!row) continue;
                const feats = parse(row.features_enabled, {}) || {};
                if (feats.commands === true) continue;
                const existed = Object.prototype.hasOwnProperty.call(feats, 'commands');
                prev.channels.push({ id: sw.channelId, existed, value: existed ? feats.commands : null });
                await save();
                await q(`UPDATE ${CH} SET features_enabled = JSON_SET(COALESCE(features_enabled, '{}'), '$.commands', JSON_EXTRACT(?, '$')) WHERE id = ?`, ['true', sw.channelId]);
                result.channels++;
                bust(sw.channelId);
            }
            for (const c of onCommands) if (c.channelId != null) bust(c.channelId);
            await save();
            if (result.automations) { try { hub?.notify?.(profileId, 'studio', { type: 'automations_changed' }); } catch { /* not attached */ } }

            // Voice commands: Studio turns them on and reports where it got to (after the notice above, so it fetches the new phrase list).
            const voiceWanted = plan.automations.some((a) => a.voice && (on(a) || a.state === 'already_on'));
            if (voiceWanted && plan.voice?.studio?.capable) {
                // No threshold is sent: Studio keeps the confidence it has (never Streamer.bot's number; see suggestThreshold).
                const params = {};
                // What Studio had before, so Undo can put it back (Studio 0.2.8 and later report both).
                prev.voice = { enabled: plan.voice.studio.enabled, threshold: plan.voice.studio.threshold };
                await save();
                const r = await ask(profileId, 'voice.enable', params, 'voice');
                result.voice = { status: r.status, error: r.error || null, state: r.result?.state || null, phrases: r.result?.phrases ?? null, threshold: r.result?.threshold ?? null,
                    detail: r.result?.error || null };
                if (r.status !== 'acked') status = 'partial';
            } else if (voiceWanted) {
                result.voice = { status: 'unavailable', error: plan.voice?.blocking || 'Studio cannot turn on voice commands.', state: plan.voice?.studio?.state || null, phrases: null, threshold: null, detail: null };
                status = 'partial';
            }
            await save();

            // OBS swap. The steps are only pointed at the CertiFried source once Studio confirms every change of the swap.
            const changes = obs && plan.obs.available ? obsChanges(plan) : [];
            let swapOk = true;
            if (changes.length) {
                const r = await ask(profileId, 'obs.set_scene_items', { changes });
                result.obs = { status: r.status, error: r.error || null, changes: (r.result?.changes || []).map((c) => ({ scene: c.scene, source: c.source, enabled: c.enabled, ok: !!c.ok, error: c.error || null })) };
                if (r.status === 'acked') {
                    for (const c of r.result?.changes || []) if (c.ok && c.changed) prev.obs.push({ scene: c.scene, source: c.source, enabled: !!c.previous });
                    swapOk = (r.result?.changes || []).length === changes.length && (r.result?.changes || []).every((c) => c.ok);
                } else {
                    swapOk = false;
                }
                if (!swapOk) status = 'partial';
                await save();
            }
            if (obs && plan.obs.available && (plan.rewrites || []).length) {
                if (swapOk) result.steps = await rewriteSteps(profileId, plan, prev, save);
                else result.stepsSkipped = 'swap_failed';
                await save();
                if (result.steps) { try { hub?.notify?.(profileId, 'studio', { type: 'automations_changed' }); } catch { /* not attached */ } }
            }

            if (closeApps) {
                // Streamer.bot is the one working listener until Studio says it is listening: do not close it before that.
                const listening = (result.voice ? result.voice.state : plan.voice?.studio?.state) === 'listening';
                if (voiceWanted && !listening) {
                    result.apps = { status: 'refused', error: VOICE_NOT_LISTENING, apps: [] };
                    status = 'partial';
                } else {
                    const r = await ask(profileId, 'studio.close_apps', { apps: ['firebot', 'streamerbot'] }, 'apps');
                    result.apps = { status: r.status, error: r.error || null, apps: r.result?.apps || [] };
                    if (r.status !== 'acked') status = 'partial';
                }
            }
        } catch (err) {
            status = 'partial';
            result.error = clip(err?.message || 'The switchover stopped part way.', 200);
            log('error', 'switchover stopped part way', { profileId, id, error: err?.message });
        }
        try { await save(status); } catch (err) { log('error', 'could not finish the switchover record', { error: err?.message }); }
        log('info', 'switchover applied', { profileId, status, automations: result.automations, commands: result.commands, timers: result.timers, channels: result.channels, steps: result.steps, obs: prev.obs.length });
        return { id, status, result, undoable: true };
    }

    /** Undo the newest switchover that is not undone (finished, partial or still applying): exactly what its record says it changed. */
    async function undo(profileId) {
        const row = (await q(`SELECT * FROM ${T('switchovers')} WHERE profile_id = ? AND status IN ('applying', 'applied', 'partial') ORDER BY id DESC LIMIT 1`, [profileId]))[0];
        if (!row) return { ok: false, error: 'There is no switchover to undo.' };
        const prev = parse(row.previous, {});
        const out = { automations: 0, commands: 0, timers: 0, channels: 0, steps: 0, stepsSkipped: 0, voice: null, obs: null };
        for (const a of prev.automations || []) if (await store.setAutomationEnabled(profileId, a.id, !!a.enabled)) out.automations++;
        for (const c of prev.commands || []) { await q(`UPDATE ${CC} SET is_enabled = ? WHERE id = ?`, [c.enabled ? 1 : 0, c.id]); out.commands++; }
        for (const t of prev.timers || []) { await q(`UPDATE ${TM} SET is_enabled = ? WHERE id = ?`, [t.enabled ? 1 : 0, t.id]); out.timers++; }
        // Chat commands switches: put the old value back, unless the streamer changed the switch since (then it is theirs).
        for (const c of prev.channels || []) {
            const r = (await q(`SELECT features_enabled FROM ${CH} WHERE id = ?`, [c.id]))[0];
            if (!r || (parse(r.features_enabled, {}) || {}).commands !== true) continue;
            if (c.existed) await q(`UPDATE ${CH} SET features_enabled = JSON_SET(COALESCE(features_enabled, '{}'), '$.commands', JSON_EXTRACT(?, '$')) WHERE id = ?`, [JSON.stringify(c.value), c.id]);
            else await q(`UPDATE ${CH} SET features_enabled = JSON_REMOVE(COALESCE(features_enabled, '{}'), '$.commands') WHERE id = ?`, [c.id]);
            out.channels++;
            bust(c.id);
        }
        for (const c of prev.commands || []) { try { const r = (await q(`SELECT channel_id FROM ${CC} WHERE id = ?`, [c.id]))[0]; if (r) bust(Number(r.channel_id)); } catch { /* best effort */ } }
        // Rewritten steps: back to the old ones, unless the automation was edited after the switchover.
        for (const st of prev.steps || []) {
            const a = await store.getAutomation(profileId, st.id);
            if (!a || automationHash(a) !== st.newHash) { out.stepsSkipped++; continue; }
            await store.updateAutomation(profileId, st.id, { ...a, enabled: !!a.enabled, actions: st.actions });
            const item = await importStore.getItemById(profileId, st.itemId);
            if (item) await importStore.setItemData(profileId, item.id, { ...(item.data || {}), hash: st.oldHash });
            out.steps++;
        }
        if (out.automations || out.steps) { try { hub?.notify?.(profileId, 'studio', { type: 'automations_changed' }); } catch { /* not attached */ } }
        // What is left to do (OBS, Studio voice) stays in the record if it cannot be done now, so pressing Undo again finishes it.
        const left = { automations: [], commands: [], timers: [], channels: [], steps: [], voice: null, obs: [] };
        let status = 'undone';
        let error = null;
        if ((prev.obs || []).length) {
            const r = await ask(profileId, 'obs.set_scene_items', { changes: prev.obs });
            out.obs = { status: r.status, error: r.error || null };
            if (r.status !== 'acked') { status = 'partial'; left.obs = prev.obs; error = 'OBS was not put back: open CertiFried Studio with OBS connected and press Undo again.'; }
        }
        if (prev.voice && prev.voice.enabled != null) {
            const params = { enabled: !!prev.voice.enabled };
            if (prev.voice.threshold != null) params.threshold = prev.voice.threshold;
            const r = await ask(profileId, 'voice.set', params, 'voice');
            out.voice = { status: r.status, error: r.error || null };
            if (r.status !== 'acked') {
                status = 'partial';
                left.voice = prev.voice;
                error = (error ? `${error} ` : '') + UNDO_VOICE_OFFLINE;
            }
        }
        if (status === 'undone') await q(`UPDATE ${T('switchovers')} SET status = 'undone', undone_at = ? WHERE id = ?`, [new Date(now()), row.id]);
        else await q(`UPDATE ${T('switchovers')} SET previous = ? WHERE id = ?`, [json(left), row.id]);
        log('info', 'switchover undone', { profileId, id: Number(row.id), status });
        return { ok: status === 'undone', status, result: out, error };
    }

    /**
     * The streamer fixed an imported automation on this page (phrase, OBS source, Go Live) through the automation PUT: the import item
     * follows the saved automation, so it is not read as "changed after the import" and left off, and a checked phrase stops being flagged.
     */
    async function markFixed(profileId, automationId, { phrase = false } = {}) {
        const a = await store.getAutomation(profileId, automationId);
        if (!a) return { ok: false, error: 'That automation does not exist.' };
        const item = (await importStore.listItems(profileId)).find((i) => i.target_kind === 'automation' && i.target_ref === `automation:${automationId}`);
        if (!item) return { ok: false, error: 'That automation was not imported.' };
        await importStore.setItemData(profileId, item.id, { ...(item.data || {}), hash: automationHash(a), ...(phrase ? { phraseChecked: true } : {}) });
        return { ok: true };
    }

    async function history(profileId, limit = 10) {
        try {
            return (await q(`SELECT id, status, plan, result, created_at, undone_at FROM ${T('switchovers')} WHERE profile_id = ? ORDER BY id DESC LIMIT ${Math.min(50, Math.max(1, Number(limit) || 10))}`, [profileId]))
                .map((r) => ({ id: Number(r.id), status: r.status, plan: parse(r.plan, {}), result: parse(r.result, {}), createdAt: r.created_at, undoneAt: r.undone_at }));
        } catch { return []; }
    }

    return { preview, apply, undo, history, ask, markFixed };
}

export default { createSwitchover, buildPlan, attentionFor, obsPairs, obsChanges, stepsOf, isSongRequest, unknownObsSources, replacementFor, suggestThreshold, NEVER_HIDE, VOICE_NOT_LISTENING, UNDO_VOICE_OFFLINE };
