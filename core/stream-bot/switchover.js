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
 * whose updated_at moved, unless only a switchover moved it), and items that need attention (off unless ticked).
 *
 * OBS (through CertiFried Studio): every CertiFried browser source that says which source it replaces (Studio 0.2.7 stores
 * certifried_replaces in its settings) is shown where the replaced one is showing, and the replaced one is hidden. Sound
 * Alerts and Blerp are never hidden (viewer-paid sounds CertiFried cannot replace until the Bits extension). OBS is
 * never asked to switch scenes, delete or change sources, or touch audio.
 *
 * Undo restores the enabled flags it stored and the visibility each OBS item had (Studio reports it with every change). Closed
 * apps are not reopened (the page says so).
 */
import { automationHash } from './import/apply.js';

export const NEVER_HIDE = /^(sound\s*alerts?|blerp)\b/i;
export const SONG_STEP = 'music.command';
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
    { re: /voice phrase is not in the file/i, why: () => 'Its voice phrase was guessed from the action name; check the phrase.' },
];

/**
 * Why an automation needs a look before it is turned on (empty: it can go on). ctx = { notes: [import notes], mediaNames: Set,
 * soundNames: Set, obs: { known, scenes: Set, sources: Set, inputs: Set } }.
 */
export function attentionFor(a, ctx = {}) {
    const why = [];
    const named = new Set();   // media already reported from an import note
    for (const n of ctx.notes || []) {
        for (const r of NOTE_ATTENTION) if (r.re.test(n)) why.push(r.why(n));
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
        if (o.known) {
            if (['obs.scene', 'obs.preview'].includes(s.type) && p.scene && !tmpl(p.scene) && !o.scenes.has(p.scene)) why.push(`OBS has no scene called "${clip(p.scene, 60)}".`);
            if (['obs.source', 'obs.text', 'obs.browser_url', 'obs.browser_refresh', 'obs.filter'].includes(s.type) && p.source && !tmpl(p.source) && !o.sources.has(p.source)) why.push(`OBS has no source called "${clip(p.source, 60)}".`);
            if (['obs.mute', 'obs.volume'].includes(s.type) && p.input && !tmpl(p.input) && o.inputs.size && !o.inputs.has(p.input)) why.push(`OBS has no audio source called "${clip(p.input, 60)}".`);
        }
    }
    return [...new Set(why)].slice(0, 6);
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
 * soundNames, obs ({ known, scenes, sources, inputs }), sceneItems (Studio's answer or null), studio ({ connected, apps }).
 */
export function buildPlan({ automations = [], importItems = [], notes = new Map(), commands = new Map(), timers = new Map(), touched = { commands: new Set() },
    mediaNames = new Set(), soundNames = new Set(), obs = { known: false }, sceneItems = null, studio = { connected: false, apps: false } } = {}) {
    const byId = new Map(automations.map((a) => [Number(a.id), a]));
    const out = { automations: [], commands: [], timers: [], obs: null, apps: null, counts: {} };
    const seen = new Set();
    const ctx = { mediaNames, soundNames, obs };
    for (const it of importItems) {
        if (it.target_kind !== 'automation') continue;
        const id = Number(String(it.target_ref || '').replace(/^automation:/, ''));
        const a = byId.get(id);
        if (!a || seen.has(id)) continue;
        seen.add(id);
        const songs = isSongRequest(a);
        const row = { key: `a:${id}`, id, name: a.name, source: it.source, songs, enabled: !!a.enabled, reasons: [], state: 'turn_on' };
        const edited = it.data?.hash && !it.data?.keep ? automationHash(a) !== it.data.hash : false;
        if (a.enabled) row.state = 'already_on';
        else if (edited) row.state = 'edited';
        else {
            row.reasons = attentionFor(a, { ...ctx, notes: notes.get(`${it.source}|${it.kind}|${it.source_id}`) || [] });
            if (row.reasons.length) row.state = 'attention';
        }
        out.automations.push(row);
    }
    // Song request automations made on the Music page (Add commands) rather than by the import.
    for (const a of automations) {
        if (seen.has(Number(a.id)) || !isSongRequest(a)) continue;
        seen.add(Number(a.id));
        out.automations.push({ key: `a:${a.id}`, id: Number(a.id), name: a.name, source: 'music', songs: true, enabled: !!a.enabled, reasons: [], state: a.enabled ? 'already_on' : 'turn_on' });
    }
    for (const it of importItems) {
        const refs = String(it.target_ref || '').split(',').filter(Boolean);
        if (it.target_kind === 'channel_command') {
            for (const r of refs) {
                const c = commands.get(Number(r.replace(/^cc:/, '')));
                if (!c) continue;
                const edited = !!c.updated_at && !touched.commands.has(c.id);
                out.commands.push({ key: `c:${c.id}`, id: c.id, name: `!${c.command_name}`, platform: c.platform || null, source: it.source, enabled: !!c.is_enabled,
                    state: c.is_enabled ? 'already_on' : edited ? 'edited' : 'turn_on', reasons: [] });
            }
        } else if (it.target_kind === 'channel_timer' || it.target_kind === 'bot_timer') {
            for (const r of refs) {
                const t = timers.get(Number(r.replace(/^timer:/, '')));
                if (!t) continue;
                out.timers.push({ key: `t:${t.id}`, id: t.id, name: t.name || clip(t.message, 60) || it.name, source: it.source, enabled: !!t.is_enabled, state: t.is_enabled ? 'already_on' : 'turn_on', reasons: [] });
            }
        }
    }
    out.automations = out.automations.slice(0, MAX_ITEMS);
    if (!studio.connected) out.obs = { available: false, reason: 'studio_offline', pairs: [], kept: [] };
    else if (!sceneItems) out.obs = { available: false, reason: 'studio_no_answer', pairs: [], kept: [] };
    else out.obs = { available: true, ...obsPairs(sceneItems) };
    out.apps = { canClose: !!(studio.connected && studio.apps) };
    const count = (list) => list.reduce((m, x) => { m[x.state] = (m[x.state] || 0) + 1; return m; }, {});
    out.counts = { automations: count(out.automations), commands: count(out.commands), timers: count(out.timers),
        songs: out.automations.filter((a) => a.songs && a.state === 'turn_on').length, obsChanges: out.obs.pairs.filter((p) => p.change !== 'none').length };
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

export function createSwitchover({ db, store, importStore, hub = null, media = null, sounds = null, prefix = 'stream_bot_', channelTables = {}, now = () => Date.now(), ackWaitMs = 20_000, logger = null } = {}) {
    if (!T_OK(prefix)) throw new Error('bad table prefix');
    const T = (n) => `\`${prefix}${n}\``;
    const CC = `\`${channelTables.commands || 'tokes_custom_commands'}\``;
    const TM = `\`${channelTables.timers || 'tokes_timers'}\``;
    const CH = `\`${channelTables.channels || 'tokes_channels'}\``;
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[StreamBotSwitchover] ${m}`, meta); } catch { /* ignore */ } };

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

    async function notesMap(profileId) {
        const map = new Map();
        const list = await importStore.listImports(profileId, 5);
        for (const imp of [...list].reverse()) {
            const full = await importStore.getImport(profileId, imp.id);
            for (const group of Object.values(full?.report?.groups || {})) for (const it of group || []) if (it?.why?.length) map.set(`${it.source}|${it.kind}|${it.sourceId}`, it.why);
        }
        return map;
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
            const r = (await q(`SELECT id, platform FROM ${CH} WHERE platform = ? AND channel_id = ?`, [c.platform, String(c.platform_user_id ?? c.platformUserId)]))[0];
            if (r) chanIds.push({ id: Number(r.id), platform: r.platform });
        }
        const chanPlat = new Map(chanIds.map((c) => [c.id, c.platform]));
        const commands = new Map((await rowsByIds(CC, ccIds, 'id, channel_id, command_name, is_enabled, updated_at')).filter((c) => chanPlat.has(Number(c.channel_id)))
            .map((c) => [Number(c.id), { ...c, id: Number(c.id), platform: chanPlat.get(Number(c.channel_id)) }]));
        const timers = new Map((await rowsByIds(TM, tmIds, 'id, channel_id, profile_id, name, message, is_enabled')).filter((t) => Number(t.profile_id) === Number(profileId) || chanPlat.has(Number(t.channel_id)))
            .map((t) => [Number(t.id), { ...t, id: Number(t.id) }]));
        const mediaNames = new Set((media ? await media.list(profileId).catch(() => []) : []).map((m) => String(m.name).toLowerCase()));
        const soundNames = new Set((sounds ? await sounds.list(profileId).catch(() => []) : []).map((s) => String(s.name).toLowerCase()));
        return { automations, importItems, commands, timers, mediaNames, soundNames };
    }

    async function obsState(profileId) {
        const conn = studioConn(profileId);
        const studio = { connected: !!conn, apps: !!conn?.capabilities?.includes('apps') };
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
        return buildPlan({ ...inp, notes: await notesMap(profileId), touched: { commands: await previousTouched(profileId) }, obs: st.obs, sceneItems: st.sceneItems, studio: st.studio });
    }

    async function apply(profileId, { include = [], obs = true, closeApps = false } = {}) {
        const plan = await preview(profileId);
        const ticked = new Set((Array.isArray(include) ? include : []).map(String));
        const on = (x) => x.state === 'turn_on' || (x.state === 'attention' && ticked.has(x.key));
        const prev = { automations: [], commands: [], timers: [], obs: [] };
        const result = { automations: 0, commands: 0, timers: 0, obs: null, apps: null };
        for (const a of plan.automations.filter(on)) {
            if (await store.setAutomationEnabled(profileId, a.id, true)) { prev.automations.push({ id: a.id, enabled: false }); result.automations++; }
        }
        for (const c of plan.commands.filter(on)) {
            await q(`UPDATE ${CC} SET is_enabled = 1 WHERE id = ?`, [c.id]);
            prev.commands.push({ id: c.id, enabled: false }); result.commands++;
        }
        for (const t of plan.timers.filter(on)) {
            await q(`UPDATE ${TM} SET is_enabled = 1 WHERE id = ?`, [t.id]);
            prev.timers.push({ id: t.id, enabled: false }); result.timers++;
        }
        if (result.automations) { try { hub?.notify?.(profileId, 'studio', { type: 'automations_changed' }); } catch { /* not attached */ } }
        let status = 'applied';
        const changes = obs && plan.obs.available ? obsChanges(plan) : [];
        if (changes.length) {
            const r = await ask(profileId, 'obs.set_scene_items', { changes });
            result.obs = { status: r.status, error: r.error || null, changes: (r.result?.changes || []).map((c) => ({ scene: c.scene, source: c.source, enabled: c.enabled, ok: !!c.ok, error: c.error || null })) };
            if (r.status === 'acked') {
                for (const c of r.result?.changes || []) if (c.ok && c.changed) prev.obs.push({ scene: c.scene, source: c.source, enabled: !!c.previous });
            } else {
                status = 'partial';
            }
        }
        if (closeApps) {
            const r = await ask(profileId, 'studio.close_apps', { apps: ['firebot', 'streamerbot'] }, 'apps');
            result.apps = { status: r.status, error: r.error || null, apps: r.result?.apps || [] };
            if (r.status !== 'acked') status = 'partial';
        }
        let id = null;
        try {
            const ins = await q(`INSERT INTO ${T('switchovers')} (profile_id, status, plan, previous, result) VALUES (?, ?, ?, ?, ?)`,
                [profileId, status, json({ counts: plan.counts, included: [...ticked].slice(0, 200), obs: !!obs, closeApps: !!closeApps }), json(prev), json(result)]);
            id = Number(ins.insertId);
        } catch (err) { log('error', 'could not store the switchover', { error: err?.message }); }
        log('info', 'switchover applied', { profileId, status, automations: result.automations, commands: result.commands, timers: result.timers, obs: prev.obs.length });
        return { id, status, result, undoable: id != null };
    }

    async function undo(profileId) {
        const row = (await q(`SELECT * FROM ${T('switchovers')} WHERE profile_id = ? AND status IN ('applied', 'partial') ORDER BY id DESC LIMIT 1`, [profileId]))[0];
        if (!row) return { ok: false, error: 'There is no switchover to undo.' };
        const prev = parse(row.previous, {});
        const out = { automations: 0, commands: 0, timers: 0, obs: null };
        for (const a of prev.automations || []) if (await store.setAutomationEnabled(profileId, a.id, !!a.enabled)) out.automations++;
        for (const c of prev.commands || []) { await q(`UPDATE ${CC} SET is_enabled = ? WHERE id = ?`, [c.enabled ? 1 : 0, c.id]); out.commands++; }
        for (const t of prev.timers || []) { await q(`UPDATE ${TM} SET is_enabled = ? WHERE id = ?`, [t.enabled ? 1 : 0, t.id]); out.timers++; }
        if (out.automations) { try { hub?.notify?.(profileId, 'studio', { type: 'automations_changed' }); } catch { /* not attached */ } }
        let status = 'undone';
        if ((prev.obs || []).length) {
            const r = await ask(profileId, 'obs.set_scene_items', { changes: prev.obs });
            out.obs = { status: r.status, error: r.error || null };
            if (r.status !== 'acked') status = 'partial';
        }
        if (status === 'undone') await q(`UPDATE ${T('switchovers')} SET status = 'undone', undone_at = ? WHERE id = ?`, [new Date(now()), row.id]);
        log('info', 'switchover undone', { profileId, id: Number(row.id), status });
        return { ok: status === 'undone', status, result: out, error: status === 'undone' ? null : 'OBS was not put back: open CertiFried Studio with OBS connected and press Undo again.' };
    }

    async function history(profileId, limit = 10) {
        try {
            return (await q(`SELECT id, status, plan, result, created_at, undone_at FROM ${T('switchovers')} WHERE profile_id = ? ORDER BY id DESC LIMIT ${Math.min(50, Math.max(1, Number(limit) || 10))}`, [profileId]))
                .map((r) => ({ id: Number(r.id), status: r.status, plan: parse(r.plan, {}), result: parse(r.result, {}), createdAt: r.created_at, undoneAt: r.undone_at }));
        } catch { return []; }
    }

    return { preview, apply, undo, history, ask };
}

export default { createSwitchover, buildPlan, attentionFor, obsPairs, obsChanges, stepsOf, isSongRequest, NEVER_HIDE };
