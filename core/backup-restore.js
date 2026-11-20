/**
 * Server backup restore engine (register H-801, rebuilt 2026-11-20).
 *
 * The old /admin backup restore deleted every channel and role first and then read snapshot.roles,
 * which weekly and dashboard backups keep under snapshot.discord, so it rebuilt nothing. This engine
 * replaces both the command and the dashboard restore:
 *
 *   1. normalizeSnapshot()  reads every backup kind (v5 weekly/dashboard snapshots, older flat
 *                           snapshots, and the v2.0 format /admin backup create used to write) into
 *                           one shape.
 *   2. readGuildState()     reads the live server.
 *   3. planRestore()        matches backup items to live ones (saved id first, then name) and returns
 *                           ordered steps: create/update roles, categories, channels, order, settings,
 *                           emojis, stickers, member roles, bans, bot settings, and only when asked
 *                           (removeExtras) the deletes, which always come last, so nothing is deleted
 *                           before its replacement exists. Deletes are skipped if any earlier step failed.
 *   4. summarizePlan()      the preview: what would be created, changed and deleted.
 *   5. executePlan()        runs the steps one at a time with pacing and retries on 429/5xx, records
 *                           each finished step in a run file (data/backup-restore-runs/<guild>.json)
 *                           so an interrupted run can be resumed; re-planning is idempotent, finished
 *                           work shows up as already matching.
 *
 * Nothing here imports the database pool at load time (tests stay free of open handles); callers pass
 * `pool` in deps, and startRestore() loads it lazily.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';

const REASON = 'Backup restore';
const CREATABLE_CHANNEL_TYPES = new Set([0, 2, 5, 13, 15, 16]);
const CATEGORY = 4;
const MAX_ROLES = 250;
const MAX_CHANNELS = 500;
const SNOWFLAKE = /\b\d{17,20}\b/g;
const TYPE_NAMES = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum', 16: 'media' };

let RUN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'backup-restore-runs');
/** Tests point the run files at a temp folder. */
export function setRunDir(dir) { RUN_DIR = dir; }

// ───────────────────────────── helpers ─────────────────────────────

function perm(v) {
    try { return BigInt(v ?? 0).toString(); } catch { return '0'; }
}
function toColorInt(c) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string') {
        const hex = c.replace(/^#/, '');
        if (/^[0-9a-f]{1,6}$/i.test(hex)) return parseInt(hex, 16);
    }
    return 0;
}
const str = (v) => (v === undefined || v === null ? null : String(v));

// ───────────────────────────── 1. normalize ─────────────────────────────

/**
 * Which kind of backup this is.
 * 'v5'   weekly and dashboard backups: everything under snapshot.discord, items carry ids.
 * 'flat' older dashboard snapshots: the v5 shape at the top level.
 * 'v2'   /admin backup create before 2026-11-20: no ids, channels nested in categories, no overwrites.
 */
export function detectFormat(s) {
    if (!s || typeof s !== 'object') return 'unknown';
    if (s.discord && typeof s.discord === 'object') return 'v5';
    const hasLists = Array.isArray(s.roles) || Array.isArray(s.categories) || Array.isArray(s.channels);
    if (!hasLists) return 'unknown';
    const hasIds = (s.roles || []).some(r => r && r.id) || (s.channels || []).some(c => c && c.id) || (s.categories || []).some(c => c && c.id);
    return hasIds ? 'flat' : 'v2';
}

/**
 * One shape for every backup kind.
 * overwrites: null means "the backup does not know" (v2): those are never touched.
 * Overwrite targets: {kind:'everyone'} | {kind:'role', key} | {kind:'raw', id} (a role outside the
 * backup, e.g. a bot's managed role) | {kind:'member', id}.
 */
export function normalizeSnapshot(snapshot, { guildId } = {}) {
    const format = detectFormat(snapshot);
    const out = {
        format, roles: [], everyonePermissions: null, categories: [], channels: [],
        settings: null, emojis: [], stickers: [], members: [], bans: [], botConfig: null,
        webhookCount: 0, warnings: [],
    };
    if (format === 'unknown') { out.warnings.push('This backup has no server layout in a format the restore understands.'); return out; }

    if (format === 'v2') {
        const s = snapshot;
        const roleKeyByName = new Map();
        (s.roles || []).forEach((r, i) => {
            if (!r || !r.name || r.name === '@everyone') return;
            const key = `role:n:${i}`;
            if (!roleKeyByName.has(r.name)) roleKeyByName.set(r.name, key);
            out.roles.push({ key, sourceId: null, name: String(r.name), color: toColorInt(r.color), hoist: !!r.hoist,
                mentionable: !!r.mentionable, permissions: perm(r.permissions), position: Number(r.position) || 0 });
        });
        const catKeyByName = new Map();
        const pushChannel = (c, parentKey, i) => {
            if (!c || !c.name) return;
            const type = Number(c.type);
            if (!CREATABLE_CHANNEL_TYPES.has(type)) { out.warnings.push(`#${c.name}: channel type ${type} cannot be re-created, skipped`); return; }
            out.channels.push({ key: `ch:n:${out.channels.length}:${i}`, sourceId: null, name: String(c.name), type, parentKey,
                position: Number(c.position) || 0, topic: c.topic ?? null, nsfw: !!c.nsfw, rateLimitPerUser: Number(c.rateLimitPerUser) || 0,
                bitrate: c.bitrate || null, userLimit: c.userLimit || null, overwrites: null });
        };
        (s.categories || []).forEach((c, i) => {
            if (!c || !c.name) return;
            const key = `cat:n:${i}`;
            if (!catKeyByName.has(c.name)) catKeyByName.set(c.name, key);
            out.categories.push({ key, sourceId: null, name: String(c.name), position: Number(c.position) || 0, overwrites: null });
            (c.channels || []).forEach((ch, j) => pushChannel(ch, key, j));
        });
        (s.channels || []).forEach((ch, j) => pushChannel(ch, ch.parentName ? (catKeyByName.get(ch.parentName) || null) : null, j));
        out.emojis = (s.emoji || s.emojis || []).filter(e => e && e.name && e.url).map(e => ({ name: e.name, url: e.url }));
        out.stickers = (s.stickers || []).filter(x => x && x.name && x.url).map(x => ({ name: x.name, url: x.url, tags: x.tags || 'custom', description: x.description || '' }));
        out.members = (s.memberRoles || []).filter(m => m && m.userId).map(m => ({
            id: String(m.userId), nickname: null,
            roles: (m.roles || []).map(n => roleKeyByName.get(n)).filter(Boolean),
        }));
        out.webhookCount = (s.webhooks || []).length;
        return out;
    }

    // v5 and flat
    const d = format === 'v5' ? snapshot.discord : snapshot;
    const gid = str(guildId);
    const roleKeyById = new Map();
    for (const r of d.roles || []) {
        if (!r || !r.name || r.name === '@everyone' || (gid && str(r.id) === gid)) continue;
        const key = r.id ? `role:${r.id}` : `role:n:${out.roles.length}`;
        if (r.id) roleKeyById.set(str(r.id), key);
        out.roles.push({ key, sourceId: str(r.id), name: String(r.name), color: toColorInt(r.color), hoist: !!r.hoist,
            mentionable: !!r.mentionable, permissions: perm(r.permissions), position: Number(r.position) || 0 });
    }
    if (d.everyonePermissions !== undefined && d.everyonePermissions !== null) out.everyonePermissions = perm(d.everyonePermissions);

    const normOw = (list) => (Array.isArray(list) ? list : null)?.map(ow => {
        const id = str(ow.id); const type = Number(ow.type);
        let target;
        if (type === 0) {
            if (gid && id === gid) target = { kind: 'everyone' };
            else if (roleKeyById.has(id)) target = { kind: 'role', key: roleKeyById.get(id) };
            else target = { kind: 'raw', id };
        } else target = { kind: 'member', id };
        return { target, type, allow: perm(ow.allow), deny: perm(ow.deny) };
    }) ?? null;

    const catKeyById = new Map();
    for (const c of d.categories || []) {
        if (!c || !c.name) continue;
        const key = c.id ? `cat:${c.id}` : `cat:n:${out.categories.length}`;
        if (c.id) catKeyById.set(str(c.id), key);
        out.categories.push({ key, sourceId: str(c.id), name: String(c.name), position: Number(c.position) || 0, overwrites: normOw(c.permissionOverwrites) });
    }
    for (const c of d.channels || []) {
        if (!c || !c.name) continue;
        const type = Number(c.type);
        if (type === CATEGORY) continue;
        if (!CREATABLE_CHANNEL_TYPES.has(type)) { out.warnings.push(`#${c.name}: channel type ${type} cannot be re-created, skipped`); continue; }
        const ch = {
            key: c.id ? `ch:${c.id}` : `ch:n:${out.channels.length}`, sourceId: str(c.id), name: String(c.name), type,
            parentKey: c.parentId ? (catKeyById.get(str(c.parentId)) || null) : null,
            position: Number(c.position) || 0, topic: c.topic ?? null, nsfw: !!c.nsfw, rateLimitPerUser: Number(c.rateLimitPerUser) || 0,
            bitrate: c.bitrate || null, userLimit: c.userLimit || null, defaultAutoArchiveDuration: c.defaultAutoArchiveDuration || null,
            overwrites: normOw(c.permissionOverwrites),
        };
        if (type === 15 || type === 16) {
            if (Array.isArray(c.availableTags)) ch.availableTags = c.availableTags.map(t => ({ name: t.name, moderated: !!t.moderated, emoji: t.emoji || null }));
            if (c.defaultForumLayout !== undefined) ch.defaultForumLayout = c.defaultForumLayout;
            if (c.defaultSortOrder !== undefined) ch.defaultSortOrder = c.defaultSortOrder;
        }
        out.channels.push(ch);
    }
    const chKeyById = new Map(out.channels.map(c => [c.sourceId, c.key]));
    if (d.settings && typeof d.settings === 'object') {
        const s = d.settings;
        const chRef = (id) => (id ? (chKeyById.get(str(id)) || null) : null);
        out.settings = {
            description: s.description ?? undefined,
            verificationLevel: s.verificationLevel, defaultMessageNotifications: s.defaultMessageNotifications,
            explicitContentFilter: s.explicitContentFilter, afkTimeout: s.afkTimeout,
            premiumProgressBarEnabled: s.premiumProgressBarEnabled,
            systemChannelFlags: s.systemChannelFlags,
            afkChannelKey: chRef(s.afkChannelId), systemChannelKey: chRef(s.systemChannelId),
            rulesChannelKey: chRef(s.rulesChannelId), publicUpdatesChannelKey: chRef(s.publicUpdatesChannelId),
        };
    }
    out.emojis = (d.emojis || []).filter(e => e && e.name && e.url).map(e => ({ name: e.name, url: e.url }));
    out.stickers = (d.stickers || []).filter(x => x && x.name && x.url).map(x => ({ name: x.name, url: x.url, tags: x.tags || 'custom', description: x.description || '' }));
    if (Array.isArray(d.members) && d.members.length) {
        out.members = d.members.filter(m => m && m.id).map(m => ({
            id: str(m.id), nickname: m.nickname ?? null,
            roles: (m.roles || []).map(id => roleKeyById.get(str(id))).filter(Boolean),
        }));
    } else if (d.memberRoles && typeof d.memberRoles === 'object' && !Array.isArray(d.memberRoles)) {
        const byMember = new Map();
        for (const [rid, ids] of Object.entries(d.memberRoles)) {
            const key = roleKeyById.get(str(rid));
            if (!key) continue;
            for (const id of ids || []) {
                if (!byMember.has(str(id))) byMember.set(str(id), []);
                byMember.get(str(id)).push(key);
            }
        }
        out.members = [...byMember].map(([id, roles]) => ({ id, nickname: null, roles }));
    }
    out.bans = (snapshot.bans || []).filter(b => b && b.userId).map(b => ({ userId: str(b.userId), username: b.username || null, reason: b.reason || null }));
    if (snapshot.botConfig && typeof snapshot.botConfig === 'object') out.botConfig = snapshot.botConfig;
    out.webhookCount = (snapshot.webhooks || []).length;
    return out;
}

// ───────────────────────────── 2. live state ─────────────────────────────

const owOut = (ow) => ({ id: str(ow.id), type: Number(ow.type), allow: perm(ow.allow?.bitfield ?? ow.allow), deny: perm(ow.deny?.bitfield ?? ow.deny) });

/** Plain description of the live server. Fetches members when it can (needs the GuildMembers intent). */
export async function readGuildState(guild, { fetchMembers = true } = {}) {
    if (fetchMembers) { try { await guild.members.fetch(); } catch { /* intent missing: cached members only */ } }
    const me = guild.members?.me;
    const botTop = me?.roles?.highest?.position ?? 0;
    const roles = [...guild.roles.cache.values()].map(r => ({
        id: str(r.id), name: r.name, color: Number(r.color) || 0, hoist: !!r.hoist, mentionable: !!r.mentionable,
        permissions: perm(r.permissions?.bitfield ?? r.permissions), position: Number(r.position) || 0,
        managed: !!r.managed, everyone: str(r.id) === str(guild.id),
        editable: !r.managed && str(r.id) !== str(guild.id) && (Number(r.position) || 0) < botTop,
    }));
    const all = [...guild.channels.cache.values()].filter(c => !(typeof c.isThread === 'function' && c.isThread()));
    const chan = (c) => ({
        id: str(c.id), name: c.name, type: Number(c.type), parentId: str(c.parentId),
        position: Number(c.rawPosition ?? c.position) || 0,
        topic: c.topic ?? null, nsfw: !!c.nsfw, rateLimitPerUser: Number(c.rateLimitPerUser) || 0,
        bitrate: c.bitrate || null, userLimit: c.userLimit || null,
        overwrites: [...(c.permissionOverwrites?.cache?.values?.() ?? [])].map(owOut),
    });
    const members = new Map();
    for (const m of guild.members?.cache?.values?.() ?? []) {
        members.set(str(m.id), new Set([...(m.roles?.cache?.keys?.() ?? [])].map(str)));
    }
    return {
        guildId: str(guild.id), botTop,
        everyonePermissions: perm(guild.roles.everyone?.permissions?.bitfield ?? guild.roles.everyone?.permissions),
        roles,
        categories: all.filter(c => Number(c.type) === CATEGORY).map(chan),
        channels: all.filter(c => Number(c.type) !== CATEGORY).map(chan),
        emojiNames: new Set([...(guild.emojis?.cache?.values?.() ?? [])].map(e => e.name)),
        stickerNames: new Set([...(guild.stickers?.cache?.values?.() ?? [])].map(s => s.name)),
        members,
        settings: {
            description: guild.description ?? null, verificationLevel: guild.verificationLevel,
            defaultMessageNotifications: guild.defaultMessageNotifications, explicitContentFilter: guild.explicitContentFilter,
            afkTimeout: guild.afkTimeout, premiumProgressBarEnabled: guild.premiumProgressBarEnabled,
            systemChannelFlags: Number(guild.systemChannelFlags?.bitfield ?? guild.systemChannelFlags ?? 0),
            afkChannelId: str(guild.afkChannelId), systemChannelId: str(guild.systemChannelId),
            rulesChannelId: str(guild.rulesChannelId), publicUpdatesChannelId: str(guild.publicUpdatesChannelId),
        },
    };
}

// ───────────────────────────── 3. plan ─────────────────────────────

/** Overwrite target → live id, or null when it cannot be resolved (yet). */
function resolveTarget(t, idMap, state) {
    if (t.kind === 'everyone') return state.guildId;
    if (t.kind === 'role') return idMap[t.key] || null;
    if (t.kind === 'raw') return state.roles.some(r => r.id === t.id) ? t.id : null;
    if (t.kind === 'member') return state.members.size === 0 || state.members.has(t.id) ? t.id : null;
    return null;
}

/**
 * The overwrite list to write, or null when nothing needs to change.
 * merge (default): backup entries are written, live entries for anyone else are kept.
 * exact (removeExtras): the list becomes exactly the backup's.
 */
export function desiredOverwrites(backupList, liveList, idMap, state, { exact = false } = {}) {
    if (backupList === null || backupList === undefined) return null;
    const want = new Map();
    for (const ow of backupList) {
        const id = resolveTarget(ow.target, idMap, state);
        if (id) want.set(id, { id, type: ow.type, allow: ow.allow, deny: ow.deny });
    }
    const result = new Map(exact ? [] : (liveList || []).map(o => [o.id, o]));
    for (const [id, o] of want) result.set(id, o);
    const list = [...result.values()];
    const sig = (l) => l.map(o => `${o.id}:${o.type}:${o.allow}:${o.deny}`).sort().join('|');
    return sig(list) === sig(liveList || []) ? null : list;
}

function matchAll(backupItems, liveItems, { prior, sameKind = () => true, nameKey }) {
    const used = new Set();
    const match = new Map(); // backup key -> live id
    const byId = new Map(liveItems.map(l => [l.id, l]));
    const take = (b, l) => { match.set(b.key, l.id); used.add(l.id); };
    // pass 1: the id recorded by an earlier (interrupted) run, then the id saved in the backup
    for (const b of backupItems) {
        for (const id of [prior?.[b.key], b.sourceId]) {
            const l = id && byId.get(id);
            if (l && !used.has(l.id) && sameKind(b, l)) { take(b, l); break; }
        }
    }
    // pass 2: same name (and the stricter key first, e.g. same parent)
    for (const strict of [true, false]) {
        for (const b of backupItems) {
            if (match.has(b.key)) continue;
            const l = liveItems.find(x => !used.has(x.id) && sameKind(b, x) && nameKey(b, x, strict));
            if (l) take(b, l);
        }
    }
    return match;
}

/**
 * Build the ordered steps. Pure: the live state is not changed.
 * options: removeExtras, restoreBotConfig, restoreBans, priorIdMap
 */
export function planRestore(norm, state, options = {}) {
    const opts = { removeExtras: false, restoreBotConfig: true, restoreBans: false, priorIdMap: {}, ...options };
    const steps = [];
    const skipped = [];
    const notes = [...(norm.warnings || [])];
    const kept = { roles: [], categories: [], channels: [] };
    const idMap = {};
    const liveRoles = state.roles.filter(r => !r.everyone && !r.managed);

    // roles
    const roleMatch = matchAll(norm.roles, liveRoles, { prior: opts.priorIdMap, nameKey: (b, l) => b.name === l.name });
    for (const [k, v] of roleMatch) idMap[k] = v;
    let roleCount = state.roles.length;
    for (const r of [...norm.roles].sort((a, b) => b.position - a.position)) {
        const liveId = roleMatch.get(r.key);
        if (!liveId) {
            if (roleCount >= MAX_ROLES) { skipped.push(`Role "${r.name}": the server already has ${MAX_ROLES} roles`); continue; }
            roleCount++;
            steps.push({ id: `createRole:${r.key}`, kind: 'createRole', phase: 'create', label: `Create role "${r.name}"`, key: r.key,
                spec: { name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions } });
            continue;
        }
        const live = state.roles.find(x => x.id === liveId);
        const changes = {};
        if (live.name !== r.name) changes.name = r.name;
        if (live.color !== r.color) changes.color = r.color;
        if (live.hoist !== r.hoist) changes.hoist = r.hoist;
        if (live.mentionable !== r.mentionable) changes.mentionable = r.mentionable;
        if (live.permissions !== r.permissions) changes.permissions = r.permissions;
        if (!Object.keys(changes).length) continue;
        if (!live.editable) { skipped.push(`Role "${live.name}": it is above the bot's highest role, so it cannot be changed`); continue; }
        steps.push({ id: `updateRole:${r.key}`, kind: 'updateRole', phase: 'update', label: `Update role "${live.name}" (${Object.keys(changes).join(', ')})`, key: r.key, changes });
    }
    if (norm.everyonePermissions !== null && norm.everyonePermissions !== state.everyonePermissions) {
        steps.push({ id: 'updateEveryone', kind: 'updateEveryone', phase: 'update', label: 'Update @everyone permissions', permissions: norm.everyonePermissions });
    }
    // role order: needed when a role is created or the matched roles are out of order
    const matchedEditable = norm.roles.filter(r => roleMatch.has(r.key)).map(r => ({ r, live: state.roles.find(x => x.id === roleMatch.get(r.key)) })).filter(x => x.live.editable);
    const backupOrder = [...matchedEditable].sort((a, b) => b.r.position - a.r.position).map(x => x.live.id);
    const liveOrder = [...matchedEditable].sort((a, b) => b.live.position - a.live.position).map(x => x.live.id);
    if (steps.some(s => s.kind === 'createRole') || backupOrder.join() !== liveOrder.join()) {
        steps.push({ id: 'orderRoles', kind: 'orderRoles', phase: 'order', label: 'Put roles back in the backup\'s order' });
    }

    // categories
    const catMatch = matchAll(norm.categories, state.categories, { prior: opts.priorIdMap, nameKey: (b, l) => b.name === l.name });
    for (const [k, v] of catMatch) idMap[k] = v;
    let channelCount = state.categories.length + state.channels.length;
    for (const c of [...norm.categories].sort((a, b) => a.position - b.position)) {
        const liveId = catMatch.get(c.key);
        if (!liveId) {
            if (channelCount >= MAX_CHANNELS) { skipped.push(`Category "${c.name}": the server already has ${MAX_CHANNELS} channels`); continue; }
            channelCount++;
            steps.push({ id: `createCategory:${c.key}`, kind: 'createCategory', phase: 'create', label: `Create category "${c.name}"`, key: c.key, name: c.name, overwrites: c.overwrites });
            continue;
        }
        const live = state.categories.find(x => x.id === liveId);
        const changes = {};
        if (live.name !== c.name) changes.name = c.name;
        // overwrites are resolved at run time (new roles get their ids then); the plan only records the intent
        const ow = desiredOverwrites(c.overwrites, live.overwrites, { ...idMap, ...pendingRoleIds(steps) }, state, { exact: opts.removeExtras });
        if (!Object.keys(changes).length && !ow) continue;
        steps.push({ id: `updateCategory:${c.key}`, kind: 'updateCategory', phase: 'update',
            label: `Update category "${live.name}"${changes.name ? ` (rename to "${c.name}")` : ''}${ow ? ' (permissions)' : ''}`,
            key: c.key, changes, overwrites: ow ? c.overwrites : null });
    }

    // channels
    const parentOf = (b) => (b.parentKey ? (idMap[b.parentKey] || `pending:${b.parentKey}`) : null);
    const chMatch = matchAll(norm.channels, state.channels, {
        prior: opts.priorIdMap,
        sameKind: (b, l) => b.type === l.type || (isTextLike(b.type) && isTextLike(l.type)),
        nameKey: (b, l, strict) => b.name === l.name && (!strict || parentOf(b) === l.parentId),
    });
    for (const [k, v] of chMatch) idMap[k] = v;
    for (const c of [...norm.channels].sort((a, b) => a.position - b.position)) {
        const liveId = chMatch.get(c.key);
        if (!liveId) {
            if (channelCount >= MAX_CHANNELS) { skipped.push(`#${c.name}: the server already has ${MAX_CHANNELS} channels`); continue; }
            channelCount++;
            steps.push({ id: `createChannel:${c.key}`, kind: 'createChannel', phase: 'create', label: `Create ${TYPE_NAMES[c.type] || 'channel'} channel #${c.name}`, key: c.key, channel: c });
            continue;
        }
        const live = state.channels.find(x => x.id === liveId);
        const changes = {};
        if (live.name !== c.name) changes.name = c.name;
        if (isTextLike(c.type) && (live.topic ?? null) !== (c.topic ?? null) && c.topic !== undefined) changes.topic = c.topic;
        if (live.nsfw !== c.nsfw) changes.nsfw = c.nsfw;
        if ((c.type === 0 || c.type === 15 || c.type === 16) && live.rateLimitPerUser !== c.rateLimitPerUser) changes.rateLimitPerUser = c.rateLimitPerUser;
        if ((c.type === 2 || c.type === 13) && c.bitrate && live.bitrate !== c.bitrate) changes.bitrate = c.bitrate;
        if ((c.type === 2 || c.type === 13) && (live.userLimit || 0) !== (c.userLimit || 0)) changes.userLimit = c.userLimit || 0;
        const wantParent = parentOf(c);
        if (c.parentKey !== undefined && wantParent !== live.parentId) changes.parentKey = c.parentKey;
        const ow = desiredOverwrites(c.overwrites, live.overwrites, { ...idMap, ...pendingRoleIds(steps) }, state, { exact: opts.removeExtras });
        if (!Object.keys(changes).length && !ow) continue;
        const what = Object.keys(changes).map(k => (k === 'parentKey' ? 'category' : k));
        if (ow) what.push('permissions');
        steps.push({ id: `updateChannel:${c.key}`, kind: 'updateChannel', phase: 'update', label: `Update #${live.name} (${what.join(', ')})`, key: c.key, changes, overwrites: ow ? c.overwrites : null });
    }
    const layoutChanges = steps.some(s => s.kind === 'createCategory' || s.kind === 'createChannel' || (s.kind === 'updateChannel' && 'parentKey' in s.changes));
    if (layoutChanges || channelOrderUpdates(norm, state, idMap, { resolvedOnly: true }).length) {
        steps.push({ id: 'orderChannels', kind: 'orderChannels', phase: 'order', label: 'Put categories and channels back in the backup\'s order' });
    }

    // server settings
    if (norm.settings) {
        const s = norm.settings; const live = state.settings;
        const changes = {};
        for (const f of ['description', 'verificationLevel', 'defaultMessageNotifications', 'explicitContentFilter', 'afkTimeout', 'premiumProgressBarEnabled', 'systemChannelFlags']) {
            if (s[f] !== undefined && s[f] !== null && s[f] !== live[f]) changes[f] = s[f];
        }
        for (const [k, liveField] of [['afkChannelKey', 'afkChannelId'], ['systemChannelKey', 'systemChannelId'], ['rulesChannelKey', 'rulesChannelId'], ['publicUpdatesChannelKey', 'publicUpdatesChannelId']]) {
            if (s[k] && idMap[s[k]] !== live[liveField]) changes[k] = s[k];
        }
        if (Object.keys(changes).length) steps.push({ id: 'updateSettings', kind: 'updateSettings', phase: 'update', label: `Update server settings (${Object.keys(changes).map(k => k.replace(/Key$/, '')).join(', ')})`, changes });
    }

    // emojis, stickers
    for (const e of norm.emojis) if (!state.emojiNames.has(e.name)) steps.push({ id: `createEmoji:${e.name}`, kind: 'createEmoji', phase: 'create', label: `Add emoji :${e.name}:`, emoji: e });
    for (const s of norm.stickers) if (!state.stickerNames.has(s.name)) steps.push({ id: `createSticker:${s.name}`, kind: 'createSticker', phase: 'create', label: `Add sticker "${s.name}"`, sticker: s });

    // member roles: only adds, for members who are in the server now
    let memberAdds = 0;
    const createdRoleKeys = new Set(steps.filter(s => s.kind === 'createRole').map(s => s.key));
    for (const m of norm.members) {
        const have = state.members.get(m.id);
        if (!have) continue;
        const missing = m.roles.filter(k => createdRoleKeys.has(k) || (idMap[k] && !have.has(idMap[k]) && state.roles.find(r => r.id === idMap[k])?.editable));
        if (!missing.length) continue;
        memberAdds += missing.length;
        steps.push({ id: `memberRoles:${m.id}`, kind: 'memberRoles', phase: 'members', label: `Give ${missing.length} role(s) back to member ${m.id}`, memberId: m.id, roleKeys: missing, quiet: true });
    }

    // bans (opt-in: someone unbanned since the backup would be banned again)
    if (opts.restoreBans && norm.bans.length) {
        steps.push({ id: 'bans', kind: 'bans', phase: 'members', label: `Ban again anyone in the backup's ban list who is not banned now (${norm.bans.length} in the backup)`, bans: norm.bans });
    }

    // bot settings
    if (opts.restoreBotConfig && norm.botConfig) {
        for (const [table, rows] of Object.entries(norm.botConfig)) {
            if (!Array.isArray(rows)) continue;
            steps.push({ id: `botConfig:${table}`, kind: 'botConfig', phase: 'config', label: `${opts.removeExtras ? 'Replace' : 'Restore'} CertiFried settings: ${table} (${rows.length} row${rows.length === 1 ? '' : 's'})`, table, rows, replace: !!opts.removeExtras });
        }
    }

    // extras: in the server now, not in the backup
    const matchedRoleIds = new Set(roleMatch.values());
    const matchedCatIds = new Set(catMatch.values());
    const matchedChIds = new Set(chMatch.values());
    for (const r of liveRoles) if (!matchedRoleIds.has(r.id)) kept.roles.push(r);
    for (const c of state.categories) if (!matchedCatIds.has(c.id)) kept.categories.push(c);
    for (const c of state.channels) if (!matchedChIds.has(c.id)) kept.channels.push(c);

    if (opts.removeExtras) {
        // Never empty a kind the backup holds none of: a backup without channels is not a request to delete them all.
        if (norm.channels.length) for (const c of kept.channels) steps.push({ id: `deleteChannel:${c.id}`, kind: 'deleteChannel', phase: 'delete', label: `Delete #${c.name} (not in the backup)`, liveId: c.id });
        else if (kept.channels.length) notes.push('The backup has no channels, so no channels are removed.');
        if (norm.categories.length) for (const c of kept.categories) steps.push({ id: `deleteCategory:${c.id}`, kind: 'deleteCategory', phase: 'delete', label: `Delete category "${c.name}" (not in the backup)`, liveId: c.id });
        else if (kept.categories.length) notes.push('The backup has no categories, so no categories are removed.');
        if (norm.roles.length) {
            for (const r of kept.roles) {
                if (!r.editable) { skipped.push(`Role "${r.name}" is not in the backup but is above the bot's highest role, so it stays`); continue; }
                steps.push({ id: `deleteRole:${r.id}`, kind: 'deleteRole', phase: 'delete', label: `Delete role "${r.name}" (not in the backup)`, liveId: r.id });
            }
        } else if (kept.roles.length) notes.push('The backup has no roles, so no roles are removed.');
    }
    if (norm.format === 'v2') notes.push('This backup was made with the old /admin backup create: it has no channel permissions, so channels it re-creates start with default permissions, and existing permissions are left as they are.');
    if (norm.webhookCount) notes.push(`${norm.webhookCount} webhook(s) in the backup are not re-created: a new webhook gets a new address, so the services using the old one would need the new one anyway.`);

    const PHASES = ['create', 'update', 'order', 'members', 'config', 'delete'];
    // stable sort by phase; within a phase the order above (roles, categories, channels...) is kept
    const ordered = steps.map((s, i) => ({ s, i })).sort((a, b) => (PHASES.indexOf(a.s.phase) - PHASES.indexOf(b.s.phase)) || (a.i - b.i)).map(x => x.s);
    const plan = { steps: ordered, skipped, notes, kept, idMap, options: opts, memberAdds, format: norm.format };
    plan.hash = planHash(plan);
    return plan;
}

function isTextLike(t) { return t === 0 || t === 5; }

/**
 * Position updates that put categories, and the channels inside each category, in the backup's order.
 * Channels not in the backup keep their relative order after the backup's. resolvedOnly (planning):
 * channels whose category does not exist yet are left out.
 */
export function channelOrderUpdates(norm, state, idMap, { resolvedOnly = false } = {}) {
    const updates = [];
    const order = (backupList, liveList) => {
        const mapped = [...backupList].sort((a, b) => a.position - b.position).map(b => liveList.find(l => l.id === idMap[b.key])).filter(Boolean);
        const mappedIds = new Set(mapped.map(l => l.id));
        const rest = liveList.filter(l => !mappedIds.has(l.id)).sort((a, b) => a.position - b.position);
        [...mapped, ...rest].forEach((l, i) => { if (l.position !== i) updates.push({ id: l.id, position: i }); });
    };
    order(norm.categories, state.categories);
    const groups = new Map();
    for (const c of norm.channels) {
        if (resolvedOnly && c.parentKey && !idMap[c.parentKey]) continue;
        const pid = c.parentKey ? idMap[c.parentKey] || null : null;
        if (!groups.has(pid)) groups.set(pid, []);
        groups.get(pid).push(c);
    }
    for (const [pid, list] of groups) order(list, state.channels.filter(l => (l.parentId || null) === pid));
    return updates;
}
function pendingRoleIds(steps) {
    // roles about to be created resolve at run time; for planning, mark them resolvable so overwrite diffs include them
    const o = {};
    for (const s of steps) if (s.kind === 'createRole') o[s.key] = `pending:${s.key}`;
    return o;
}

export function planHash(plan) {
    // member-role steps change whenever someone joins or gets a role; they are not part of what the admin confirms
    const basis = plan.steps.filter(s => !s.quiet).map(s => [s.id, s.changes ? Object.keys(s.changes).sort().join(',') : '', s.overwrites ? 'ow' : ''].join('/')).join('\n');
    return crypto.createHash('sha256').update(basis + '|' + JSON.stringify({ r: !!plan.options.removeExtras, c: !!plan.options.restoreBotConfig, b: !!plan.options.restoreBans })).digest('hex').slice(0, 16);
}

// ───────────────────────────── 4. preview ─────────────────────────────

export function summarizePlan(plan) {
    const pick = (phase) => plan.steps.filter(s => s.phase === phase && !s.quiet).map(s => s.label);
    const count = (kind) => plan.steps.filter(s => s.kind === kind).length;
    return {
        hash: plan.hash,
        format: plan.format,
        create: pick('create'),
        update: [...pick('update'), ...pick('order'), ...pick('members'), ...pick('config'),
            ...(plan.memberAdds ? [`Give ${plan.memberAdds} role assignment(s) back to members who are in the server now`] : [])],
        remove: pick('delete'),
        skipped: plan.skipped,
        notes: plan.notes,
        keptNotInBackup: plan.options.removeExtras ? null : {
            roles: plan.kept.roles.map(r => r.name), categories: plan.kept.categories.map(c => c.name), channels: plan.kept.channels.map(c => c.name),
        },
        counts: {
            createRoles: count('createRole'), createCategories: count('createCategory'), createChannels: count('createChannel'),
            updates: plan.steps.filter(s => s.phase === 'update').length, memberRoleAdds: plan.memberAdds,
            deletes: plan.steps.filter(s => s.phase === 'delete').length, total: plan.steps.length,
        },
        options: { removeExtras: !!plan.options.removeExtras, restoreBotConfig: !!plan.options.restoreBotConfig, restoreBans: !!plan.options.restoreBans },
    };
}

// ───────────────────────────── 5. run ─────────────────────────────

export function isRetryable(err) {
    const status = err?.status ?? err?.httpStatus;
    return status === 429 || (status >= 500 && status < 600) || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code);
}

export async function withRetry(fn, { attempts = 4, sleep = (ms) => new Promise(r => setTimeout(r, ms)), onRetry } = {}) {
    for (let i = 1; ; i++) {
        try { return await fn(); } catch (err) {
            if (!isRetryable(err) || i >= attempts) throw err;
            const ra = Number(err?.retryAfter ?? err?.rawError?.retry_after);
            const wait = Math.min(30000, Number.isFinite(ra) && ra > 0 ? (ra > 100 ? ra : ra * 1000) : 1000 * 2 ** (i - 1));
            onRetry?.(err, wait, i);
            await sleep(wait);
        }
    }
}

const big = (v) => BigInt(v ?? 0);

/** Exact snowflakes in strings are remapped from backup ids to the ids the restore created or matched. */
export function remapValue(v, remap) {
    if (typeof v === 'string') return remap.size ? v.replace(SNOWFLAKE, (m) => remap.get(m) ?? m) : v;
    return v;
}

const ISO = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(\.\d+)?Z$/;
export function sqlValue(v) {
    if (v === undefined) return null;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'string' && ISO.test(v)) { const m = v.match(ISO); return `${m[1]} ${m[2]}`; }
    return v;
}

/**
 * Bot settings for one table. Default: rows are added or updated (current rows not in the backup stay);
 * replace (removeExtras): this server's rows become exactly the backup's. One transaction either way,
 * and a row id that now belongs to another server is never touched.
 */
export async function restoreConfigTable(pool, guildId, table, rows, { replace = false, remap = new Map(), allowedTables } = {}) {
    if (!allowedTables?.has(table)) return { skipped: `unknown table ${String(table).slice(0, 64)}` };
    const [colRows] = await pool.execute('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    const known = new Set(colRows.map(r => r.COLUMN_NAME));
    if (!known.has('guild_id')) return { skipped: `${table} is not in this database` };
    const ignored = new Set();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        if (replace) await conn.execute(`DELETE FROM \`${table}\` WHERE guild_id = ?`, [guildId]);
        for (const row of rows) {
            const cols = Object.keys(row).filter(c => /^[A-Za-z0-9_]{1,64}$/.test(c));
            for (const c of cols) if (!known.has(c)) ignored.add(c);
            const usable = cols.filter(c => known.has(c));
            if (!usable.includes('guild_id')) usable.push('guild_id');
            const values = usable.map(c => (c === 'guild_id' ? guildId : sqlValue(remapValue(row[c], remap))));
            const upd = usable.filter(c => c !== 'guild_id').map(c => `\`${c}\` = IF(guild_id = VALUES(guild_id), VALUES(\`${c}\`), \`${c}\`)`);
            const sql = `INSERT INTO \`${table}\` (${usable.map(c => '`' + c + '`').join(', ')}) VALUES (${usable.map(() => '?').join(', ')})`
                + (upd.length ? ` ON DUPLICATE KEY UPDATE ${upd.join(', ')}` : '');
            await conn.execute(sql, values);
        }
        await conn.commit();
        return { rows: rows.length, ignored: [...ignored] };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally { conn.release(); }
}

/** discord.js calls used by the run, in one place (the fake guild in tests implements the same surface). */
function ops(guild) {
    const role = (id) => guild.roles.cache.get(id);
    const ch = (id) => guild.channels.cache.get(id);
    return {
        createRole: async (s) => (await guild.roles.create({ name: s.name, color: s.color, hoist: s.hoist, mentionable: s.mentionable, permissions: big(s.permissions), reason: REASON })).id,
        editRole: (id, c) => role(id).edit({ ...c, ...(c.permissions !== undefined ? { permissions: big(c.permissions) } : {}), reason: REASON }),
        deleteRole: (id) => role(id)?.delete(REASON),
        setRolePositions: (list) => guild.roles.setPositions(list.map(x => ({ role: x.id, position: x.position }))),
        editEveryone: (p) => guild.roles.everyone.edit({ permissions: big(p), reason: REASON }),
        createChannel: async (spec) => (await guild.channels.create({ ...spec, reason: REASON })).id,
        editChannel: (id, c) => ch(id).edit({ ...c, reason: REASON }),
        setOverwrites: (id, list) => ch(id).permissionOverwrites.set(list.map(o => ({ id: o.id, type: o.type, allow: big(o.allow), deny: big(o.deny) })), REASON),
        deleteChannel: (id) => ch(id)?.delete(REASON),
        setChannelPositions: (list) => guild.channels.setPositions(list.map(x => ({ channel: x.id, position: x.position }))),
        editGuild: (c) => guild.edit({ ...c, reason: REASON }),
        createEmoji: (e) => guild.emojis.create({ attachment: e.url, name: e.name, reason: REASON }),
        createSticker: (s) => guild.stickers.create({ file: s.url, name: s.name, tags: s.tags || 'custom', description: s.description || '', reason: REASON }),
        fetchBans: () => guild.bans.fetch(),
        ban: (userId, reason) => guild.members.ban(userId, { reason }),
        addMemberRoles: async (memberId, roleIds) => {
            const m = guild.members.cache.get(memberId) || await guild.members.fetch(memberId).catch(() => null);
            if (!m) return false;
            await m.roles.add(roleIds, REASON);
            return true;
        },
    };
}

// run files ---------------------------------------------------------------

function runPath(guildId) { return path.join(RUN_DIR, `${String(guildId).replace(/\D/g, '') || 'x'}.json`); }
export function loadRun(guildId) {
    try { return JSON.parse(fs.readFileSync(runPath(guildId), 'utf8')); } catch { return null; }
}
export function saveRun(run) {
    try {
        fs.mkdirSync(RUN_DIR, { recursive: true });
        const p = runPath(run.guildId); const tmp = `${p}.${process.pid}.tmp`;
        run.updatedAt = new Date().toISOString();
        fs.writeFileSync(tmp, JSON.stringify(run));
        fs.renameSync(tmp, p);
    } catch (err) { logger.warn('[Backup Restore] Could not save run state', { guildId: run.guildId, error: err.message }); }
}

const active = new Map(); // guildId -> run (this process)
export function activeRun(guildId) { return active.get(String(guildId)) || null; }
/** The last run for this server; a 'running' run that this process is not running was interrupted (restart). */
export function runStatus(guildId) {
    const run = activeRun(guildId) || loadRun(guildId);
    if (!run) return null;
    if (run.status === 'running' && !activeRun(guildId)) return { ...run, status: 'interrupted' };
    return run;
}

function channelSpec(c, idMap, state, guildId) {
    const spec = { name: c.name, type: c.type };
    if (c.parentKey && idMap[c.parentKey]) spec.parent = idMap[c.parentKey];
    if (c.topic && (isTextLike(c.type) || c.type === 15 || c.type === 16)) spec.topic = c.topic;
    if (c.nsfw) spec.nsfw = true;
    if (c.rateLimitPerUser && (c.type === 0 || c.type === 15 || c.type === 16)) spec.rateLimitPerUser = c.rateLimitPerUser;
    if (c.bitrate && (c.type === 2 || c.type === 13)) spec.bitrate = c.bitrate;
    if (c.userLimit && (c.type === 2 || c.type === 13)) spec.userLimit = c.userLimit;
    if (c.defaultAutoArchiveDuration) spec.defaultAutoArchiveDuration = c.defaultAutoArchiveDuration;
    if (c.availableTags) spec.availableTags = c.availableTags;
    if (c.defaultForumLayout !== undefined) spec.defaultForumLayout = c.defaultForumLayout;
    if (c.defaultSortOrder !== undefined && c.defaultSortOrder !== null) spec.defaultSortOrder = c.defaultSortOrder;
    if (c.overwrites) {
        const list = desiredOverwrites(c.overwrites, [], idMap, { ...state, guildId }, { exact: true });
        if (list?.length) spec.permissionOverwrites = list.map(o => ({ id: o.id, type: o.type, allow: big(o.allow), deny: big(o.deny) }));
    }
    return spec;
}

/**
 * Run the plan. Each finished step is recorded in `run` and saved, so resume skips it.
 * deps: { pool, allowedTables, pace (ms between Discord calls), sleep, onProgress }
 */
export async function executePlan(guild, plan, norm, run, deps = {}) {
    const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    const pace = deps.pace ?? 350;
    const api = deps.ops || ops(guild);
    const idMap = run.idMap = { ...plan.idMap, ...(run.idMap || {}) };
    const done = new Set(run.completed || []);
    run.completed = [...done];
    run.failed = run.failed || [];
    run.log = run.log || [];
    run.total = plan.steps.length;
    const say = (line) => { run.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`); if (run.log.length > 400) run.log.splice(0, run.log.length - 400); };
    let state = deps.state || await readGuildState(guild, { fetchMembers: false });
    const stateFresh = async () => { state = await readGuildState(guild, { fetchMembers: false }); return state; };
    const byKey = (list) => new Map(list.map(x => [x.key, x]));
    const roles = byKey(norm.roles); const cats = byKey(norm.categories); const chans = byKey(norm.channels);
    let failedBeforeDelete = 0;

    for (const step of plan.steps) {
        if (done.has(step.id)) continue;
        if (step.phase === 'delete' && failedBeforeDelete) {
            run.failed.push({ id: step.id, label: step.label, error: 'Skipped: an earlier step failed, so nothing is deleted' });
            say(`Skipped ${step.label}: an earlier step failed`);
            continue;
        }
        try {
            await withRetry(() => runStep(step), { sleep, onRetry: (err, wait) => say(`Discord asked to slow down (${err.status || err.code}); waiting ${Math.round(wait / 1000)} s`) });
            done.add(step.id); run.completed.push(step.id);
            if (!step.quiet) say(`Done: ${step.label}`);
        } catch (err) {
            if (step.phase !== 'delete') failedBeforeDelete++;
            run.failed.push({ id: step.id, label: step.label, error: String(err?.message || err).slice(0, 300) });
            say(`Failed: ${step.label}: ${String(err?.message || err).slice(0, 200)}`);
            logger.warn('[Backup Restore] Step failed', { guildId: run.guildId, step: step.id, error: err?.message });
        }
        run.done = run.completed.length;
        saveRun(run);
        deps.onProgress?.(run, step);
        if (pace) await sleep(pace);
    }
    return run;

    async function runStep(step) {
        switch (step.kind) {
            case 'createRole': idMap[step.key] = await api.createRole(step.spec); return;
            case 'updateRole': return api.editRole(idMap[step.key], step.changes);
            case 'updateEveryone': return api.editEveryone(step.permissions);
            case 'orderRoles': {
                await stateFresh();
                const items = [...roles.values()].map(r => ({ r, live: state.roles.find(x => x.id === idMap[r.key]) })).filter(x => x.live?.editable);
                const slots = items.map(x => x.live.position).sort((a, b) => b - a);
                const want = [...items].sort((a, b) => b.r.position - a.r.position).map((x, i) => ({ id: x.live.id, position: slots[i] }));
                // equal slots (a role created at the bottom shares position 1) need distinct numbers
                for (let i = want.length - 2; i >= 0; i--) if (want[i].position <= want[i + 1].position) want[i].position = want[i + 1].position + 1;
                if (want.length && want[0].position >= state.botTop) throw new Error('Not enough room below the bot\'s highest role to order the roles; move the bot\'s role higher and resume');
                const changed = want.filter(w => state.roles.find(x => x.id === w.id)?.position !== w.position);
                if (changed.length) await api.setRolePositions(want);
                return;
            }
            case 'createCategory': {
                const spec = { name: step.name, type: CATEGORY };
                const c = cats.get(step.key);
                if (c?.overwrites) {
                    const list = desiredOverwrites(c.overwrites, [], idMap, state, { exact: true });
                    if (list?.length) spec.permissionOverwrites = list.map(o => ({ id: o.id, type: o.type, allow: big(o.allow), deny: big(o.deny) }));
                }
                idMap[step.key] = await api.createChannel(spec);
                return;
            }
            case 'updateCategory':
            case 'updateChannel': {
                const id = idMap[step.key];
                const ch = { ...step.changes };
                if ('parentKey' in ch) { const p = ch.parentKey ? idMap[ch.parentKey] : null; delete ch.parentKey; if (p !== undefined) ch.parent = p; }
                if (Object.keys(ch).length) await api.editChannel(id, ch);
                if (step.overwrites) {
                    await stateFresh();
                    const live = [...state.categories, ...state.channels].find(x => x.id === id);
                    const list = desiredOverwrites(step.overwrites, live?.overwrites || [], idMap, state, { exact: !!plan.options.removeExtras });
                    if (list) await api.setOverwrites(id, list);
                }
                return;
            }
            case 'createChannel': {
                const c = chans.get(step.key);
                idMap[step.key] = await api.createChannel(channelSpec(c, idMap, state, state.guildId));
                return;
            }
            case 'orderChannels': {
                await stateFresh();
                const updates = channelOrderUpdates(norm, state, idMap);
                if (updates.length) await api.setChannelPositions(updates);
                return;
            }
            case 'updateSettings': {
                const c = {};
                for (const [k, v] of Object.entries(step.changes)) {
                    if (k.endsWith('ChannelKey')) { const id = idMap[v]; if (id) c[k.replace(/Key$/, '')] = id; } else c[k] = v;
                }
                if (Object.keys(c).length) await api.editGuild(c);
                return;
            }
            case 'createEmoji': return api.createEmoji(step.emoji);
            case 'createSticker': return api.createSticker(step.sticker);
            case 'memberRoles': {
                const ids = step.roleKeys.map(k => idMap[k]).filter(Boolean);
                if (ids.length) await api.addMemberRoles(step.memberId, ids);
                return;
            }
            case 'bans': {
                const current = await api.fetchBans().catch(() => new Map());
                let n = 0;
                for (const b of step.bans) {
                    if (current.has?.(b.userId)) continue;
                    try { await withRetry(() => api.ban(b.userId, b.reason ? `${REASON}: ${b.reason}`.slice(0, 500) : REASON), { sleep }); n++; } catch { /* one ban failing does not stop the rest */ }
                    if (pace) await sleep(pace);
                }
                say(`Bans applied again: ${n}`);
                return;
            }
            case 'botConfig': {
                if (!deps.pool) throw new Error('No database connection for bot settings');
                const remap = new Map();
                for (const list of [norm.roles, norm.categories, norm.channels]) {
                    for (const x of list) if (x.sourceId && idMap[x.key] && idMap[x.key] !== x.sourceId) remap.set(x.sourceId, idMap[x.key]);
                }
                const r = await restoreConfigTable(deps.pool, run.guildId, step.table, step.rows, { replace: step.replace, remap, allowedTables: deps.allowedTables });
                if (r.skipped) say(`Skipped ${step.table}: ${r.skipped}`);
                else if (r.ignored?.length) say(`${step.table}: ignored columns no longer in the database: ${r.ignored.join(', ')}`);
                return;
            }
            case 'deleteChannel':
            case 'deleteCategory': return api.deleteChannel(step.liveId);
            case 'deleteRole': return api.deleteRole(step.liveId);
            default: throw new Error(`Unknown step ${step.kind}`);
        }
    }
}

// ───────────────────────────── orchestration ─────────────────────────────

/** Read one backup row of this server. */
export async function loadBackupRow(pool, guildId, backupId) {
    const [rows] = await pool.execute('SELECT id, snapshot_name, snapshot_json, created_at FROM server_backups WHERE id = ? AND guild_id = ?', [backupId, guildId]);
    return rows[0] || null;
}

function parseSnapshot(row) {
    try { return JSON.parse(row.snapshot_json); } catch { return null; }
}

/** Dry run: nothing on the server changes. */
export async function previewRestore({ guild, backupRow, options = {} }) {
    const snapshot = parseSnapshot(backupRow);
    if (!snapshot) return { ok: false, error: 'This backup cannot be read.' };
    const norm = normalizeSnapshot(snapshot, { guildId: guild.id });
    if (norm.format === 'unknown') return { ok: false, error: norm.warnings[0] };
    const state = await readGuildState(guild);
    const plan = planRestore(norm, state, options);
    return { ok: true, plan, norm, state, summary: summarizePlan(plan), backupName: backupRow.snapshot_name };
}

/**
 * Start (or resume) a restore. Resolves when the run has been set up; `done` resolves when it finishes.
 * expectedHash: the preview the admin confirmed. If the server changed since, the admin sees a new preview.
 */
export async function startRestore({ guild, backupRow, options = {}, by, source, expectedHash, graceDays = 0, deps = {}, resume = false }) {
    const guildId = String(guild.id);
    if (activeRun(guildId)) return { ok: false, error: 'A restore is already running for this server.' };
    const prior = resume ? loadRun(guildId) : null;
    if (resume && (!prior || prior.status === 'done')) return { ok: false, error: 'There is no unfinished restore to resume.' };
    if (resume) options = { ...prior.options };
    const pv = await previewRestore({ guild, backupRow, options: { ...options, priorIdMap: prior?.idMap || {} } });
    if (!pv.ok) return pv;
    if (!resume && expectedHash && expectedHash !== pv.plan.hash) {
        return { ok: false, error: 'The server changed since the preview. Look at the new preview before restoring.', summary: pv.summary };
    }
    const run = resume ? { ...prior, status: 'running', resumedAt: new Date().toISOString(), failed: [] } : {
        runId: crypto.randomUUID(), guildId, backupId: backupRow.id, backupName: backupRow.snapshot_name,
        by: by ? { id: String(by.id || ''), name: String(by.username || by.name || '') } : null, source,
        options: { removeExtras: !!options.removeExtras, restoreBotConfig: options.restoreBotConfig !== false, restoreBans: !!options.restoreBans },
        graceDays, planHash: pv.plan.hash, status: 'running', startedAt: new Date().toISOString(), completed: [], failed: [], idMap: {}, log: [],
    };
    run.total = pv.plan.steps.length;
    active.set(guildId, run);
    saveRun(run);
    logger.warn(`[Backup Restore] ${resume ? 'Resuming' : 'Starting'} restore of "${run.backupName}" (${pv.plan.steps.length} steps, removeExtras=${run.options.removeExtras}) for ${guild.name} (${guildId}) by ${run.by?.name || '?'} via ${source}`);
    deps.onStart?.(run, pv.summary);

    const done = (async () => {
        try {
            const pool = 'pool' in deps ? deps.pool : (pv.plan.steps.some(s => s.kind === 'botConfig') || graceDays > 0 ? (await import('../utils/db.js')).default : null);
            const allowedTables = 'allowedTables' in deps ? deps.allowedTables : new Set((await import('../utils/backup-utils.js')).BACKUP_CONFIG_TABLES);
            await executePlan(guild, pv.plan, pv.norm, run, { ...deps, pool, allowedTables, state: pv.state });
            if (graceDays > 0 && pool) await storeRejoinRoles(pool, guild, pv.norm, run, graceDays).catch(err => run.log.push(`Rejoin roles not stored: ${err.message}`));
            run.status = run.failed.length ? 'done_with_errors' : 'done';
        } catch (err) {
            run.status = 'failed';
            run.error = String(err?.message || err).slice(0, 300);
            logger.error('[Backup Restore] Run stopped', { guildId, error: err?.message, stack: err?.stack });
        } finally {
            run.finishedAt = new Date().toISOString();
            saveRun(run);
            active.delete(guildId);
            logger.info(`[Backup Restore] ${run.status}: "${run.backupName}" for ${guildId}: ${run.completed.length}/${run.total} steps, ${run.failed.length} failed`);
            deps.onFinish?.(run);
        }
        return run;
    })();
    return { ok: true, run, summary: pv.summary, done };
}

/** Members who are not in the server now get their roles back if they rejoin within the window (events/guildMemberAdd.js). */
async function storeRejoinRoles(pool, guild, norm, run, graceDays) {
    const pending = norm.members
        .map(m => ({ userId: m.id, nickname: m.nickname, roles: m.roles.map(k => run.idMap[k]).filter(id => id && guild.roles.cache.has(id)) }))
        .filter(m => m.roles.length);
    if (!pending.length) return;
    await pool.execute(
        `INSERT INTO guild_settings (guild_id, backup_restore_data, backup_restore_expires)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))
         ON DUPLICATE KEY UPDATE backup_restore_data = VALUES(backup_restore_data), backup_restore_expires = VALUES(backup_restore_expires)`,
        [String(guild.id), JSON.stringify(pending), Math.min(Math.max(Number(graceDays) || 0, 1), 365)]);
    run.log.push(`Stored roles for ${pending.length} member(s) who get them back if they rejoin within ${graceDays} days`);
}
