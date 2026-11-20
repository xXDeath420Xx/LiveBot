/*
 * Stream bot import: write a plan (mapper.js) into CertiFried, switched off, without creating anything twice.
 *
 *   createImportStore({ db, prefix, channelTables }) → the SQL for stream_bot_imports / stream_bot_import_items
 *   applyPlan({ db, store, importStore, profileId, plan, categories, meta }) → { importId, results: [...], counts, links }
 *   recreateReward({ … })                         the owner's explicit "Recreate under CertiFried" (Helix POST)
 *   pendingWordsView(item, channelBots)           a saved banned word list and what is still pending per Kick channel
 *   applyPendingWords({ importStore, profileId, itemId, channelBot })   the owner's "Apply to Kick automod" (H-742)
 *
 * Idempotency: every created thing is recorded in import_items under (profile, source, kind, source id). On a
 * re-import an item whose target still exists is left alone ("already imported"), except that an automation nobody
 * has edited since it was imported is brought up to the current mapping ("updated"); one whose target was deleted is
 * created again, and items an earlier mapper could not handle are created once it can. Counters are never overwritten; viewer records
 * keep what an import added apart (core/stream-bot/viewers/store.js importRows), so importing again replaces it instead of adding it twice. Channel commands that already exist under the
 * same name (made by hand) are not touched.
 *
 * Nothing here sends chat, calls OBS or writes to Twitch, except recreateReward(), which only runs when the owner
 * presses its button. Banned words are only saved (a pending list in import_items): Kick automod turns its word rule on
 * as soon as it has words, so they reach a channel's automod only through applyPendingWords(), the owner's button.
 *
 * Tested in tests/stream-bot-import-apply.test.js on throwaway tables.
 */
import { SOURCE_LABEL } from './mapper.js';
import { reportOf } from './report.js';
import crypto from 'node:crypto';
import { createViewerStore } from '../viewers/store.js';
import { withDefaults as viewerSettings } from '../viewers/settings.js';

/** What an automation does (name, trigger, conditions, steps): compared to tell an untouched import from an edited one. */
export function automationHash(a) {
    const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
    return crypto.createHash('sha256').update(JSON.stringify(canon({ name: a.name, trigger_type: a.trigger_type, trigger_config: a.trigger_config || {}, conditions: a.conditions || [], actions: a.actions || [] }))).digest('hex').slice(0, 32);
}
const sameTime = (a, b) => a && b && Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 1500;

export const MAX_AUTOMATIONS = 200;
const IMPORTED_BY = (source) => `Imported from ${SOURCE_LABEL[source] || source}`;
const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (v, d) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };

export function createImportStore({ db, prefix = 'stream_bot_', channelTables = {} } = {}) {
    if (!/^[a-z0-9_]{1,30}$/.test(prefix)) throw new Error('bad table prefix');
    const T = (n) => `\`${prefix}${n}\``;
    const CC = `\`${channelTables.commands || 'tokes_custom_commands'}\``;
    const TM = `\`${channelTables.timers || 'tokes_timers'}\``;
    const CH = `\`${channelTables.channels || 'tokes_channels'}\``;
    const q = async (sql, params = []) => (await db.query(sql, params))[0];
    return {
        prefix,
        async createImport(profileId, { sources, fileNames, categories }) {
            const r = await q(`INSERT INTO ${T('imports')} (profile_id, sources, file_names, categories) VALUES (?, ?, ?, ?)`,
                [profileId, String(sources).slice(0, 60), fileNames ? String(fileNames).slice(0, 255) : null, json(categories || [])]);
            return Number(r.insertId);
        },
        async finishImport(id, { summary, report }) {
            await q(`UPDATE ${T('imports')} SET summary = ?, report = ? WHERE id = ?`, [json(summary), json(report), id]);
        },
        async listImports(profileId, limit = 20) {
            return (await q(`SELECT id, sources, file_names, categories, summary, created_at FROM ${T('imports')} WHERE profile_id = ? ORDER BY id DESC LIMIT ${Math.min(100, Math.max(1, Number(limit) || 20))}`, [profileId]))
                .map((r) => ({ id: Number(r.id), sources: r.sources, fileNames: r.file_names, categories: parse(r.categories, []), summary: parse(r.summary, null), createdAt: r.created_at }));
        },
        async getImport(profileId, id) {
            const r = (await q(`SELECT * FROM ${T('imports')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0];
            return r ? { id: Number(r.id), sources: r.sources, fileNames: r.file_names, categories: parse(r.categories, []), summary: parse(r.summary, null), report: parse(r.report, null), createdAt: r.created_at } : null;
        },
        async getItem(profileId, source, kind, sourceId) {
            const r = (await q(`SELECT * FROM ${T('import_items')} WHERE profile_id = ? AND source = ? AND kind = ? AND source_id = ?`, [profileId, source, kind, String(sourceId).slice(0, 191)]))[0];
            return r ? { ...r, id: Number(r.id), data: parse(r.data, null) } : null;
        },
        async getItemById(profileId, id) {
            const r = (await q(`SELECT * FROM ${T('import_items')} WHERE profile_id = ? AND id = ?`, [profileId, id]))[0];
            return r ? { ...r, id: Number(r.id), data: parse(r.data, null) } : null;
        },
        async upsertItem(profileId, { importId, source, kind, sourceId, name, status, targetKind = null, targetRef = null, data = null }) {
            await q(`INSERT INTO ${T('import_items')} (profile_id, import_id, source, kind, source_id, name, status, target_kind, target_ref, data)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE import_id = VALUES(import_id), name = VALUES(name), status = VALUES(status), target_kind = VALUES(target_kind),
                       target_ref = VALUES(target_ref), data = VALUES(data)`,
                [profileId, importId, source, kind, String(sourceId).slice(0, 191), String(name || '').slice(0, 150), status, targetKind, targetRef ? String(targetRef).slice(0, 255) : null, json(data)]);
        },
        async setItemData(profileId, id, data) {
            await q(`UPDATE ${T('import_items')} SET data = ? WHERE profile_id = ? AND id = ?`, [json(data), profileId, id]);
        },
        async listItems(profileId, { kind = null } = {}) {
            const rows = kind
                ? await q(`SELECT * FROM ${T('import_items')} WHERE profile_id = ? AND kind = ? ORDER BY id`, [profileId, kind])
                : await q(`SELECT * FROM ${T('import_items')} WHERE profile_id = ? ORDER BY id`, [profileId]);
            return rows.map((r) => ({ ...r, id: Number(r.id), data: parse(r.data, null) }));
        },
        // channel bot rows (tokes_*), only for channels the caller resolved as the profile's own
        async channelBotsFor(channels) {
            const out = [];
            for (const c of channels || []) {
                const r = (await q(`SELECT id, platform, channel_id, channel_name FROM ${CH} WHERE platform = ? AND channel_id = ?`, [c.platform, String(c.platformUserId)]))[0];
                if (r) out.push({ id: Number(r.id), platform: r.platform, channelId: String(r.channel_id), name: r.channel_name });
            }
            return out;
        },
        async channelCommandExists(id) { return (await q(`SELECT 1 FROM ${CC} WHERE id = ?`, [id])).length > 0; },
        async getChannelCommand(id) { return (await q(`SELECT id, is_enabled, use_count, created_by FROM ${CC} WHERE id = ?`, [id]))[0] || null; },
        async deleteChannelCommand(id) { await q(`DELETE FROM ${CC} WHERE id = ?`, [id]); },
        async channelCommandByName(channelId, name) { return (await q(`SELECT id, created_by FROM ${CC} WHERE channel_id = ? AND command_name = ?`, [channelId, name]))[0] || null; },
        async insertChannelCommand({ channelId, name, response, cooldown, modOnly, broadcasterOnly, createdBy }) {
            const r = await q(`INSERT INTO ${CC} (channel_id, command_name, response, is_enabled, cooldown, mod_only, broadcaster_only, created_by) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
                [channelId, name, response, cooldown, modOnly ? 1 : 0, broadcasterOnly ? 1 : 0, createdBy]);
            return Number(r.insertId);
        },
        /** A Kick channel's automod word list (tokes_channels.features_enabled.automod.words, comma-separated). */
        async channelAutomod(id) {
            const r = (await q(`SELECT id, platform, features_enabled FROM ${CH} WHERE id = ?`, [id]))[0];
            if (!r) return null;
            const feats = parse(r.features_enabled, {}) || {};
            return { id: Number(r.id), platform: r.platform, features: feats && typeof feats === 'object' ? feats : {} };
        },
        async setChannelAutomodWords(id, words) {
            const r = (await q(`SELECT features_enabled FROM ${CH} WHERE id = ?`, [id]))[0];
            const feats = parse(r?.features_enabled, {}) || {};
            const automod = feats.automod && typeof feats.automod === 'object' ? feats.automod : {};
            feats.automod = { ...automod, words };
            await q(`UPDATE ${CH} SET features_enabled = ? WHERE id = ?`, [JSON.stringify(feats), id]);
        },
        async channelTimerExists(id) { return (await q(`SELECT 1 FROM ${TM} WHERE id = ?`, [id])).length > 0; },
        async getTimer(id) { return (await q(`SELECT id, channel_id, profile_id, message, is_enabled, send_count, created_by FROM ${TM} WHERE id = ?`, [id]))[0] || null; },
        /** A stream bot timer (profile_id set, channel_id NULL), switched off. */
        async insertBotTimer(profileId, v, createdBy) {
            const r = await q(`INSERT INTO ${TM} (channel_id, profile_id, name, message, extra_messages, rotation, interval_min, is_enabled, only_live, min_chat_lines, automation_id, platforms, created_by)
                               VALUES (NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
                [profileId, v.name, v.message, JSON.stringify(v.extraMessages), v.rotation, v.intervalMin, v.onlyLive ? 1 : 0, v.minChatLines, v.automationId, v.platforms, createdBy]);
            return Number(r.insertId);
        },
        /** Turn an imported Kick channel timer into a stream bot timer, in place (still off). */
        async convertToBotTimer(id, profileId, v) {
            await q(`UPDATE ${TM} SET channel_id = NULL, profile_id = ?, name = ?, message = ?, extra_messages = ?, rotation = ?, next_index = 0, interval_min = ?, is_enabled = 0,
                     only_live = ?, min_chat_lines = ?, automation_id = ?, platforms = ? WHERE id = ?`,
                [profileId, v.name, v.message, JSON.stringify(v.extraMessages), v.rotation, v.intervalMin, v.onlyLive ? 1 : 0, v.minChatLines, v.automationId, v.platforms, id]);
        },
        async insertChannelTimer({ channelId, message, minutes, createdBy }) {
            const r = await q(`INSERT INTO ${TM} (channel_id, message, interval_min, is_enabled, created_by) VALUES (?, ?, ?, 0, ?)`, [channelId, message, minutes, createdBy]);
            return Number(r.insertId);
        },
        /**
         * Viewer records (H-747, migration 464). Rows last seen more than 400 days ago are left out: the retention sweep would
         * delete them that night. → { created, updated, unchanged, skippedOld }
         */
        async importViewers(profileId, rows, source, { now = Date.now() } = {}) {
            const vs = createViewerStore({ db, prefix });
            if (!(await vs.available())) throw new Error('Viewer records are not switched on yet (the database update for them has not run)');
            const cutoff = now - 400 * 86_400_000;
            const byPlatform = new Map();
            let skippedOld = 0;
            // Old rows stay when the viewer was seen since: in the other upload (seenElsewhere) or already in Viewers.
            const old = (rows || []).filter((r) => r.lastSeen && new Date(r.lastSeen).getTime() < cutoff && !(Number(r.seenElsewhere) >= cutoff));
            const recent = new Set();
            for (const p of ['twitch', 'kick']) {
                const ids = old.filter((r) => (r.platform === 'kick' ? 'kick' : 'twitch') === p).map((r) => String(r.id));
                for (const [id, at] of await vs.lastSeenFor(profileId, p, ids)) if (new Date(at).getTime() >= cutoff) recent.add(`${p}:${id}`);
            }
            for (const r of rows || []) {
                const last = r.lastSeen ? new Date(r.lastSeen).getTime() : null;
                const keep = Number(r.seenElsewhere) >= cutoff || recent.has(`${r.platform === 'kick' ? 'kick' : 'twitch'}:${r.id}`);
                if (last && last < cutoff && !keep) { skippedOld++; continue; }
                const p = r.platform === 'kick' ? 'kick' : 'twitch';
                if (!byPlatform.has(p)) byPlatform.set(p, []);
                byPlatform.get(p).push({ id: r.id, login: r.login || null, name: r.name || null, firstSeen: r.firstSeen || null, lastSeen: r.lastSeen || null,
                    minutes: r.watchMinutes, messages: r.chatMessages, points: r.points });
            }
            const out = { created: 0, updated: 0, unchanged: 0, skippedOld };
            for (const [p, list] of byPlatform) {
                const r = await vs.importRows(profileId, p, list, source);
                out.created += r.created; out.updated += r.updated; out.unchanged += r.unchanged;
            }
            return out;
        },
        /** Older imports (before H-747) stored {db:} values; kept for scripts that still call it. Returns rows written. */
        async insertViewerValues(profileId, rows) {
            let n = 0;
            for (let i = 0; i < rows.length; i += 200) {
                const chunk = rows.slice(i, i + 200);
                const values = [];
                const params = [];
                for (const r of chunk) {
                    const owner = `${r.platform}:${String(r.id).slice(0, 64)}`;
                    for (const [k, v] of [['watch_minutes', r.watchMinutes], ['chat_messages', r.chatMessages]]) {
                        if (!Number.isFinite(Number(v)) || Number(v) <= 0) continue;
                        values.push('(?, ?, ?, ?)');
                        params.push(profileId, owner, k, String(Math.round(Number(v))));
                    }
                }
                if (!values.length) continue;
                const r = await q(`INSERT IGNORE INTO ${T('variables')} (profile_id, owner, key_name, value_text) VALUES ${values.join(', ')}`, params);
                n += r.affectedRows || 0;
            }
            return n;
        },
    };
}

/**
 * Apply a plan. `categories` limits what is written (the page's checkboxes). Returns per-item results:
 * { source, kind, sourceId, name, category, result: 'created'|'updated'|'already'|'skipped'|'failed', detail, links: [{ label, href }] }
 * refresh: an imported automation nobody has edited since (still off, unchanged) is rewritten to the current mapping.
 */
export async function applyPlan({ store, importStore, profileId, plan, categories = null, meta = {}, channelPageHref = null, refresh = true } = {}) {
    const want = (it) => !categories || categories.includes(it.category);
    const importId = await importStore.createImport(profileId, { sources: meta.sources || 'import', fileNames: meta.fileNames || null, categories: categories || [] });
    const results = [];
    const created = new Map(); // `${source}|${kind}|${sourceId}` → automation id (for automation.run refs)
    const keyOf = (it) => `${it.source}|${it.kind}|${it.sourceId}`;
    // Automations imported earlier, so "run another automation" steps resolve even when this run imports only some
    // categories (e.g. --only automations, whose steps point at command automations).
    for (const row of await importStore.listItems(profileId)) {
        if (row.target_kind !== 'automation') continue;
        const id = Number(String(row.target_ref || '').split(':')[1]);
        if (id && await store.getAutomation(profileId, id)) created.set(`${row.source}|${row.kind}|${row.source_id}`, id);
    }
    const pendingRefs = [];
    let byName = null; // automation name → id, read once when a song request command needs it
    let automationCount = await store.countAutomations(profileId);
    const pageFor = (c) => (channelPageHref ? channelPageHref(c) : null);

    const record = (it, result, detail = '', links = []) => results.push({ source: it.source, kind: it.kind, sourceId: String(it.sourceId), name: it.name, category: it.category, result, detail, links });

    for (const it of plan.items) {
        if (!want(it) || !it.target) continue;
        const t = it.target;
        const prev = await importStore.getItem(profileId, it.source, it.kind, it.sourceId);
        try {
            switch (t.system) {
                case 'automation': {
                    const prevId = prev?.target_kind === 'automation' ? Number(String(prev.target_ref).split(':')[1]) : null;
                    const existing = prevId ? await store.getAutomation(profileId, prevId) : null;
                    const draft = t.draft;
                    const unresolved = [];
                    const resolve = (acts) => acts.map((s) => {
                        if (s.type === 'random') return { ...s, branches: s.branches.map((br) => ({ ...br, actions: resolve(br.actions) })) };
                        if (s.type === 'automation.run' && s._ref) {
                            const id = created.get(`${s._ref.source}|${s._ref.kind}|${s._ref.sourceId}`);
                            if (id) return { type: 'automation.run', automationId: id };
                            unresolved.push(s._ref);
                            return null;
                        }
                        return s;
                    }).filter(Boolean);
                    const actions = resolve(draft.actions);
                    const body = { name: draft.name, enabled: false, trigger_type: draft.trigger_type, trigger_config: draft.trigger_config, conditions: draft.conditions, actions: actions.length ? actions : [{ type: 'delay', seconds: 0.1 }] };
                    if (existing) {
                        created.set(keyOf(it), prevId);
                        const links = [{ label: 'Open', href: `/stream/bot/automations/${prevId}` }];
                        if (prev.data?.keep) { record(it, 'already', 'Linked to an automation made by hand; left as it is', links); break; }
                        // Refresh an imported automation only while nobody has touched it: still off, and either exactly what
                        // the importer last wrote (hash) or, for rows from before hashes were kept, never updated since creation.
                        const untouched = !existing.enabled && (prev.data?.hash ? automationHash(existing) === prev.data.hash : sameTime(existing.created_at, existing.updated_at));
                        if (refresh && untouched && automationHash(body) !== automationHash(existing) && !unresolved.length) {
                            await store.updateAutomation(profileId, prevId, body);
                            await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'automation', targetRef: `automation:${prevId}`, data: { hash: automationHash(body) } });
                            record(it, 'updated', 'Updated to the current mapping (it was not edited since the import), switched off', links);
                        } else {
                            if (!prev.data?.hash && untouched) await importStore.upsertItem(profileId, { importId: prev.import_id, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'automation', targetRef: `automation:${prevId}`, data: { hash: automationHash(existing) } });
                            record(it, 'already', untouched ? 'Already imported' : 'Already imported (you changed it, so it was left as it is)', links);
                        }
                        break;
                    }
                    if (draft.adoptByName) {
                        // Song request commands (musicCommandDraft): the Music page may have made this automation already.
                        // Use it, marked keep, so imports never make a second one or change it.
                        byName ||= new Map((await store.listAutomations(profileId)).map((a) => [a.name, a.id]));
                        const have = byName.get(draft.name);
                        if (have) {
                            created.set(keyOf(it), have);
                            await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'automation', targetRef: `automation:${have}`, data: { keep: true, linkedBy: 'name' } });
                            record(it, 'already', `Covered by song requests: uses "${draft.name}" (made on the Music page), left as it is`, [{ label: 'Open', href: `/stream/bot/automations/${have}` }]);
                            break;
                        }
                    }
                    // Imported earlier as a channel command and now an automation (its mapping grew, e.g. an overlay step):
                    // move it when the channel commands are untouched (off, never used, still the importer's), else leave it.
                    let movedFrom = 0;
                    if (prev?.target_kind === 'channel_command') {
                        const rows = [];
                        for (const x of String(prev.target_ref || '').split(',').filter((r) => r.startsWith('cc:'))) {
                            const row = await importStore.getChannelCommand(Number(x.slice(3)));
                            if (row) rows.push(row);
                        }
                        const untouched = rows.every((r) => !Number(r.is_enabled) && !Number(r.use_count) && /^Imported from /.test(String(r.created_by || '')));
                        if (!untouched) { record(it, 'already', 'Already imported as a channel command (you changed it, so it was left as it is)'); break; }
                        if (automationCount >= MAX_AUTOMATIONS) { record(it, 'skipped', `You have ${MAX_AUTOMATIONS} automations, the most a profile can have`); break; }
                        for (const r of rows) await importStore.deleteChannelCommand(r.id);
                        movedFrom = rows.length;
                    }
                    if (automationCount >= MAX_AUTOMATIONS) { record(it, 'skipped', `You have ${MAX_AUTOMATIONS} automations, the most a profile can have`); break; }
                    const { adoptByName, ...createBody } = body;
                    const id = await store.createAutomation(profileId, createBody);
                    automationCount++;
                    created.set(keyOf(it), id);
                    if (unresolved.length) pendingRefs.push({ it, id, draft });
                    await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'automation', targetRef: `automation:${id}`, data: { hash: automationHash(body) } });
                    if (movedFrom) record(it, 'updated', `Moved from ${movedFrom} channel command row${movedFrom === 1 ? '' : 's'} to an automation (it now does more than reply), switched off`, [{ label: 'Open', href: `/stream/bot/automations/${id}` }]);
                    else record(it, 'created', it.status === 'changed' ? 'Created with changes, switched off' : 'Created, switched off', [{ label: 'Open', href: `/stream/bot/automations/${id}` }]);
                    break;
                }
                case 'channel_command': {
                    const refs = String(prev?.target_ref || '').split(',').filter((x) => x.startsWith('cc:')).map((x) => Number(x.slice(3)));
                    const alive = [];
                    for (const id of refs) if (await importStore.channelCommandExists(id)) alive.push(id);
                    if (refs.length && alive.length === refs.length) { record(it, 'already', 'Already imported', linksFor(t.channels, pageFor)); break; }
                    const ids = [...alive];
                    const clashes = [];
                    for (const ch of t.channels) {
                        for (const name of t.names) {
                            const existing = await importStore.channelCommandByName(ch.id, name);
                            if (existing) {
                                if (!alive.includes(Number(existing.id))) clashes.push(`!${name} on ${ch.platform}`);
                                continue;
                            }
                            ids.push(await importStore.insertChannelCommand({ channelId: ch.id, name, response: t.response, cooldown: t.cooldown, modOnly: t.modOnly, broadcasterOnly: t.broadcasterOnly, createdBy: IMPORTED_BY(it.source) }));
                        }
                    }
                    if (!ids.length) { record(it, 'skipped', `A command with this name already exists (${clashes.join(', ')}); it was left as it is`); break; }
                    await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'channel_command', targetRef: ids.map((x) => `cc:${x}`).join(',') });
                    record(it, 'created', clashes.length ? `Created, switched off; already there and left alone: ${clashes.join(', ')}` : 'Created, switched off', linksFor(t.channels, pageFor));
                    break;
                }
                case 'channel_timer': {
                    const refs = String(prev?.target_ref || '').split(',').filter((x) => x.startsWith('timer:')).map((x) => Number(x.slice(6)));
                    const alive = [];
                    for (const id of refs) if (await importStore.channelTimerExists(id)) alive.push(id);
                    if (refs.length && alive.length === refs.length) { record(it, 'already', 'Already imported', linksFor(t.channels, pageFor)); break; }
                    const ids = [...alive];
                    for (const ch of t.channels) if (!alive.length) ids.push(await importStore.insertChannelTimer({ channelId: ch.id, message: t.message, minutes: t.minutes, createdBy: IMPORTED_BY(it.source) }));
                    await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'channel_timer', targetRef: ids.map((x) => `timer:${x}`).join(',') });
                    record(it, 'created', 'Created, switched off', linksFor(t.channels, pageFor));
                    break;
                }
                case 'bot_timer': {
                    const tv = t.timer;
                    const v = {
                        name: tv.name, message: tv.messages[0] || '', extraMessages: tv.messages.slice(1, 10), rotation: tv.rotation === 'random' ? 'random' : 'rotate',
                        intervalMin: Math.min(1440, Math.max(1, tv.intervalMin)), onlyLive: !!tv.onlyLive, minChatLines: Math.min(1000, Math.max(0, tv.minChatLines | 0)),
                        platforms: ['twitch', 'kick', 'all'].includes(tv.platforms) ? tv.platforms : 'all', automationId: null,
                    };
                    if (tv.automationRef) {
                        v.automationId = created.get(`${tv.automationRef.source}|${tv.automationRef.kind}|${tv.automationRef.sourceId}`) || null;
                        if (!v.automationId) { record(it, 'skipped', 'Its automation was not imported, so the timer was not created'); break; }
                    }
                    if (!v.message && !v.automationId) { record(it, 'skipped', 'Nothing to send'); break; }
                    const prevTimer = String(prev?.target_ref || '').startsWith('timer:') ? Number(String(prev.target_ref).split(',')[0].slice(6)) : null;
                    const row = prevTimer ? await importStore.getTimer(prevTimer) : null;
                    const ref = (id) => ({ importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'bot_timer', targetRef: `timer:${id}` });
                    if (row && prev.target_kind === 'bot_timer') { record(it, 'already', 'Already imported'); break; }
                    if (row && prev.target_kind === 'channel_timer') {
                        // Imported earlier as a Kick timed message. Untouched (off, never sent, still the importer's): make it the stream bot timer.
                        const untouched = !row.is_enabled && !Number(row.send_count) && row.profile_id == null && /^Imported from /.test(String(row.created_by || ''));
                        if (!untouched) { record(it, 'already', 'Already imported as a Kick timed message (you changed it, so it was left as it is)'); break; }
                        await importStore.convertToBotTimer(row.id, profileId, v);
                        await importStore.upsertItem(profileId, ref(row.id));
                        record(it, 'updated', 'Moved from a Kick timed message to a stream bot timer, switched off', [{ label: 'Timers', href: '/stream/bot/timers' }]);
                        break;
                    }
                    const id = await importStore.insertBotTimer(profileId, v, IMPORTED_BY(it.source));
                    await importStore.upsertItem(profileId, ref(id));
                    record(it, 'created', 'Created, switched off', [{ label: 'Timers', href: '/stream/bot/timers' }]);
                    break;
                }
                case 'variable': {
                    const cur = await store.variableStore.get(profileId, 'server', t.key);
                    if (cur != null) { record(it, prev ? 'already' : 'skipped', prev ? 'Already imported' : `You already have a value called ${t.key}; it was left as it is`); break; }
                    const r = await store.variableStore.set(profileId, 'server', t.key, t.value);
                    if (r.full) { record(it, 'skipped', 'Your channel values are full'); break; }
                    await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'variable', targetRef: `var:server:${t.key}` });
                    record(it, 'created', `Saved as {sdb:get:${t.key}} = ${t.value}`);
                    break;
                }
                case 'reward_definition': {
                    const data = { ...(prev?.data || {}), definition: t.definition };
                    await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'reward_definition', targetRef: prev?.target_ref || null, data });
                    record(it, prev ? 'already' : 'created', prev ? 'Saved again (definition refreshed)' : 'Saved');
                    break;
                }
                case 'pending_words': {
                    // Saved only. The words reach a Kick channel's automod when the owner presses "Apply to Kick automod".
                    const before = new Set((prev?.data?.words || []).map((w) => String(w).toLowerCase()));
                    const added = t.words.filter((w) => !before.has(w.toLowerCase()));
                    const words = [...(prev?.data?.words || []), ...added];
                    await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: 'Banned words', status: it.status,
                        targetKind: 'pending_words', targetRef: null, data: { ...(prev?.data || {}), words, wasOn: !!t.wasOn } });
                    const links = [{ label: 'Review banned words', href: '/stream/bot/import#sbi-words-title' }];
                    if (prev?.data?.words) record(it, added.length ? 'updated' : 'already', added.length ? `${added.length} more saved, not applied` : 'Already saved, not applied', links);
                    else record(it, 'created', `${words.length} banned word${words.length === 1 ? '' : 's'} saved, not applied. Press "Apply to Kick automod" when you switch over`, links);
                    break;
                }
                case 'viewer_records': {
                    const r = await importStore.importViewers(profileId, t.rows, it.source);
                    let note = '';
                    if (t.settings && !(await store.getSettingsKey(profileId, 'viewers'))) {
                        await store.setSettingsKey(profileId, 'viewers', viewerSettings(t.settings));
                        note = '; points name, earning and ranks set from Firebot';
                    }
                    await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'viewer_records', targetRef: `viewers:${t.rows.length}` });
                    const changed = r.created + r.updated;
                    const detail = `${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged${r.skippedOld ? `, ${r.skippedOld} not seen for over 400 days left out` : ''}${note}`;
                    record(it, !changed ? 'already' : r.created ? 'created' : 'updated', detail, [{ label: 'Viewers', href: '/stream/bot/viewers' }]);
                    break;
                }
                case 'viewer_values': {
                    const n = await importStore.insertViewerValues(profileId, t.rows);
                    await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'viewer_values', targetRef: `viewers:${t.rows.length}` });
                    record(it, n ? 'created' : 'already', n ? `${n} values saved` : 'Already imported');
                    break;
                }
                default: record(it, 'skipped', 'Nothing to write');
            }
        } catch (err) {
            record(it, 'failed', String(err?.message || err).slice(0, 200));
        }
    }

    // automation.run steps whose target was created later in this run
    for (const { it, id, draft } of pendingRefs) {
        const resolve = (acts) => acts.map((s) => {
            if (s.type === 'random') return { ...s, branches: s.branches.map((br) => ({ ...br, actions: resolve(br.actions) })) };
            if (s.type === 'automation.run' && s._ref) {
                const target = created.get(`${s._ref.source}|${s._ref.kind}|${s._ref.sourceId}`);
                return target && target !== id ? { type: 'automation.run', automationId: target } : null;
            }
            return s;
        }).filter(Boolean);
        const actions = resolve(draft.actions);
        try {
            const body = { name: draft.name, enabled: false, trigger_type: draft.trigger_type, trigger_config: draft.trigger_config, conditions: draft.conditions, actions: actions.length ? actions : [{ type: 'delay', seconds: 0.1 }] };
            await store.updateAutomation(profileId, id, body);
            await importStore.upsertItem(profileId, { importId, source: it.source, kind: it.kind, sourceId: it.sourceId, name: it.name, status: it.status, targetKind: 'automation', targetRef: `automation:${id}`, data: { hash: automationHash(body) } });
        } catch (err) {
            const r = results.find((x) => x.source === it.source && x.kind === it.kind && x.sourceId === String(it.sourceId));
            if (r) r.detail += ` (a "run another automation" step could not be linked: ${String(err.message).slice(0, 80)})`;
        }
    }

    const counts = {};
    for (const r of results) {
        const c = (counts[r.category] ||= { created: 0, updated: 0, already: 0, skipped: 0, failed: 0 });
        c[r.result] ??= 0;
        c[r.result]++;
    }
    const report = reportOf(plan, { categories });
    report.results = results;
    await importStore.finishImport(importId, { summary: { counts, planCounts: report.counts }, report });
    return { importId, results, counts, report };
}

function linksFor(channels, pageFor) {
    const out = [];
    for (const c of channels || []) {
        const href = pageFor(c);
        if (href) out.push({ label: `${c.platform === 'kick' ? 'Kick' : 'Twitch'} commands`, href });
    }
    return out;
}

/**
 * The owner's "Recreate under CertiFried" for one saved reward: creates it on Twitch through the Stream bot grant
 * (switched off), saves the new reward id, and points imported automations that matched the old id at the new one.
 * deps: { fetch, clientId, grant: { twitch_user_id, scopes }, token }
 */
export async function recreateReward({ store, importStore, profileId, itemId, deps }) {
    const item = await importStore.getItemById(profileId, itemId);
    const def = item?.data?.definition;
    if (!item || item.kind !== 'reward' || !def) return { ok: false, status: 404, error: 'That saved reward does not exist.' };
    if (def.kind !== 'channel_points') return { ok: false, status: 400, error: 'Only channel point rewards can be recreated; Twitch does not let apps create power-ups.' };
    if (item.data?.recreated?.id) return { ok: false, status: 409, error: 'This reward was already recreated under CertiFried.' };
    const { grant, token, clientId, fetch: fetchImpl } = deps || {};
    if (!grant || !token || !clientId) return { ok: false, status: 400, error: 'Connect Twitch on Stream bot → Connections first.' };
    if (!(grant.scopes || []).includes('channel:manage:redemptions')) return { ok: false, status: 400, error: 'Your Twitch connection does not allow managing rewards. Connect Twitch again on Connections.' };
    const body = {
        title: String(def.title).slice(0, 45), cost: Math.max(1, Math.round(Number(def.cost) || 1)), prompt: String(def.prompt || '').slice(0, 200), is_enabled: false,
        is_user_input_required: !!def.userInput, should_redemptions_skip_request_queue: !!def.skipQueue,
        ...(def.color ? { background_color: def.color } : {}),
        ...(def.maxPerStream > 0 ? { is_max_per_stream_enabled: true, max_per_stream: def.maxPerStream } : {}),
        ...(def.maxPerUserPerStream > 0 ? { is_max_per_user_per_stream_enabled: true, max_per_user_per_stream: def.maxPerUserPerStream } : {}),
        ...(def.cooldownSeconds > 0 ? { is_global_cooldown_enabled: true, global_cooldown_seconds: def.cooldownSeconds } : {}),
    };
    const url = `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${encodeURIComponent(grant.twitch_user_id)}`;
    let res;
    try {
        res = await fetchImpl(url, { method: 'POST', headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
        return { ok: false, status: 502, error: 'Twitch could not be reached. Try again in a minute.' };
    }
    let out = null;
    try { out = await res.json(); } catch { /* empty */ }
    if (res.status === 401) return { ok: false, status: 400, error: 'Twitch refused the connection. Connect Twitch again on Connections.' };
    if (res.status === 400 && /DUPLICATE/i.test(String(out?.message || ''))) return { ok: false, status: 409, error: `A reward called "${body.title}" already exists on your channel (the one made by the other app). Delete it there first, then try again.` };
    if (!res.ok || !out?.data?.[0]?.id) return { ok: false, status: 502, error: `Twitch did not create the reward${out?.message ? `: ${String(out.message).slice(0, 120)}` : '.'}` };
    const newId = String(out.data[0].id);
    await importStore.setItemData(profileId, item.id, { ...item.data, recreated: { id: newId, at: new Date().toISOString() } });
    // Imported automations that waited for the old reward now wait for the new one.
    let moved = 0;
    const oldId = String(def.twitchId || '');
    if (oldId) {
        for (const a of await store.listAutomations(profileId)) {
            if (a.trigger_type !== 'redemption') continue;
            let hit = false;
            const conditions = (a.conditions || []).map((c) => {
                if (c.type === 'metadata' && c.path === 'rewardId' && c.op === 'eq' && String(c.value) === oldId) { hit = true; return { ...c, value: newId }; }
                return c;
            });
            if (hit) { await store.updateAutomation(profileId, a.id, { ...a, conditions }); moved++; }
        }
    }
    return { ok: true, rewardId: newId, automationsUpdated: moved };
}

// ── banned words (H-742) ──────────────────────────────────────────────────────────────────────

/** Kick automod's own field: comma-separated words, edited on the Kick channel page (textarea of 4000 characters). */
export const AUTOMOD_WORDS_MAX = 4000;
const wordsOf = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((w) => String(w).trim()).filter(Boolean);

/**
 * A saved banned word list for the page: every word, and per Kick channel bot what is not in its automod yet.
 * channelBots: [{ id, platform, channelId, name }] already resolved as the profile's own; automods: Map(id → features).
 */
export function pendingWordsView(item, channelBots = [], automods = new Map()) {
    const words = item?.data?.words || [];
    const channels = channelBots.filter((c) => c.platform === 'kick').map((c) => {
        const have = new Set(wordsOf(automods.get(c.id)?.automod?.words).map((w) => w.toLowerCase()));
        const pending = words.filter((w) => !have.has(String(w).toLowerCase()));
        return { id: c.id, channelId: c.channelId, name: c.name, pending: pending.length, applied: item?.data?.applied?.[c.id] || null };
    });
    return { id: item.id, source: item.source, words, wasOn: !!item?.data?.wasOn, channels };
}

/**
 * The owner's "Apply to Kick automod": adds the saved words that are not there yet to one Kick channel's automod word
 * list (which switches the word rule on for that channel). Keeps every word already in the list; never removes one.
 * channelBot must already be checked as the profile's own Kick channel bot.
 */
export async function applyPendingWords({ importStore, profileId, itemId, channelBot }) {
    const item = await importStore.getItemById(profileId, itemId);
    if (!item || item.target_kind !== 'pending_words' || !Array.isArray(item.data?.words)) return { ok: false, status: 404, error: 'That saved word list does not exist.' };
    if (!channelBot || channelBot.platform !== 'kick') return { ok: false, status: 400, error: 'Pick one of your Kick channels.' };
    const ch = await importStore.channelAutomod(channelBot.id);
    if (!ch || ch.platform !== 'kick') return { ok: false, status: 404, error: 'That Kick channel was not found. Add it on the Kick channel bot first.' };
    const current = wordsOf(ch.features?.automod?.words);
    const have = new Set(current.map((w) => w.toLowerCase()));
    const add = item.data.words.map((w) => String(w).trim()).filter((w) => w && !w.includes(',') && !have.has(w.toLowerCase()));
    if (!add.length) return { ok: true, added: 0, total: current.length };
    const merged = [...current, ...add].join(', ');
    if (merged.length > AUTOMOD_WORDS_MAX) return { ok: false, status: 400, error: `Kick automod's word list holds ${AUTOMOD_WORDS_MAX} characters; these words would make it ${merged.length}. Remove some on the Kick channel page first.` };
    await importStore.setChannelAutomodWords(channelBot.id, merged);
    const applied = { ...(item.data.applied || {}), [channelBot.id]: { at: new Date().toISOString(), added: add.length } };
    await importStore.setItemData(profileId, item.id, { ...item.data, applied });
    return { ok: true, added: add.length, total: current.length + add.length };
}

export default { createImportStore, applyPlan, recreateReward, pendingWordsView, applyPendingWords, MAX_AUTOMATIONS };
