/*
 * Name filters — the live side (the rules are in core/name-filter-logic.js, the curated packs and the
 * generated-name vocabulary in core/name-filter-templates.js).
 *
 *   on join      checkNamesOnJoin(), called by core/join-gate.js checkJoin right after the spammer check
 *   on rename    onMemberUpdate() (server nickname, events/guildMemberUpdate.js) and onUserUpdate()
 *                (username / global display name, events/userUpdate.js — a global event, so every
 *                server the member shares with the bot that serves it is checked)
 *   test         testNames() — which filters a name or a member hits, and the folded forms
 *   preview      previewFilter() — the current members a filter would hit, before it is saved;
 *                actOnPreview() carries out "save and act on these N"
 *   cleanse      startCleanse() — scan every member: review mode queues matches in
 *                name_filter_reviews for Ban / Kick / Mark safe / Skip (decideReviews); force mode
 *                acts at once with each filter's own action (log-only matches still queue)
 *   templates    applyTemplate() / removeTemplate(); syncTemplates() keeps a server's copy of each
 *                applied pack in step with the code (runs whenever the filters are loaded)
 *   Auto-Pilot   syncAutoPilot() keeps exact-name filters for protected staff (bot-manager roles,
 *                the allowlist, chosen staff roles); renames retire and replace them
 *
 * Storage (migrations/324_name_filters.js): filters are automod_patterns rows with target 'name'
 * (hit counters in spam_patterns_stats, shared with the message patterns); settings are the name_*
 * columns of join_gate_config, read through join-gate's cached getConfig; outcomes go to
 * join_gate_events (the Recent hits list); the review queue and "marked safe" members are
 * name_filter_reviews (kind 'name'; the same table holds avatar protection's queue as kind 'avatar',
 * core/avatar-protection.js, so every query here is scoped to kind 'name').
 *
 * Every automatic action goes through protectionHold (allowlist, managers, pause). Staff (owner or a
 * moderation permission) are never touched, nor a member marked safe while their names are unchanged.
 * Off until a server switches name checks on; new filters default to log-only. Unable to act fails
 * open and says so, like the rest of the join protections.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { protectionHold, isExempt, isPaused, getState as protectionState } from './protection-exempt.js';
import { isStaff } from './spammer-guard.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';
import { recordPatternHit, markPatternFalsePositive } from './advanced-automod-manager.js';
import {
    validateNameFilter, compileFilter, nameFieldsOf, namesHash, matchNames, describeForms, generatedUsername,
    planCleanse, splitForce, planAutoPilot, planTemplateSync, nameReason, nameEventAction, filterLabel, exactKey,
    normaliseNameAction, STORED_TYPE, TYPE_OF_STORED, NAME_ACTIONS, FIELD_LABEL, FORM_LABEL, MAX_NAME_FILTERS,
    MAX_MANUAL_FILTERS, NAME_FILTER_TYPES, buildNameExport, planNameImport,
} from './name-filter-logic.js';
import { TEMPLATE_PACKS, PACKS_BY_ID, expandPack, serverNameForTemplates } from './name-filter-templates.js';

export const FLAG_ROLE_NAME = 'Flagged Name';
const CACHE_MS = 5 * 60_000;
const SCAN_CAP = 1000;              // most members one decision / force cleanse acts on
const MEMBER_FETCH_FRESH_MS = 10 * 60_000;
const AUTOPILOT_DEBOUNCE_MS = 20_000;
const AUTOPILOT_REFRESH_MS = 6 * 3600_000;

const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    flag: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
};
const DONE = { ban: 'banned', kick: 'kicked', timeout: 'timed out', flag: 'flagged', log: 'logged' };

// join-gate imports this module; importing it back lazily keeps the cycle out of module load.
const gate = () => import('./join-gate.js');

// ── settings ─────────────────────────────────────────────────────────────────

const json = (value, fallback) => {
    try { const v = typeof value === 'string' ? JSON.parse(value) : value; return v ?? fallback; } catch { return fallback; }
};

/** The name_* columns of a join_gate_config row, as one object (defaults when there is no row). */
export function settingsFrom(cfg) {
    const c = cfg || {};
    const roles = json(c.name_autopilot_roles, []);
    const templates = json(c.name_templates, {});
    return {
        enabled: !!Number(c.name_filters_enabled ?? 0),
        fuzzy: c.name_fuzzy == null ? true : !!Number(c.name_fuzzy),
        collapse: !!Number(c.name_collapse ?? 0),
        flagRoleId: c.name_flag_role_id || null,
        timeoutMinutes: Math.min(40320, Math.max(1, Number(c.name_timeout_minutes ?? 60) || 60)),
        dm: c.name_dm == null ? true : !!Number(c.name_dm),
        generated: { enabled: !!Number(c.name_generated_enabled ?? 0), action: normaliseNameAction(c.name_generated_action) },
        autopilot: {
            enabled: !!Number(c.name_autopilot_enabled ?? 0),
            action: normaliseNameAction(c.name_autopilot_action),
            managers: c.name_autopilot_managers == null ? true : !!Number(c.name_autopilot_managers),
            roles: Array.isArray(roles) ? roles.filter(r => /^\d{15,25}$/.test(String(r))).map(String) : [],
        },
        templates: templates && typeof templates === 'object' && !Array.isArray(templates) ? templates : {},
    };
}

export async function getSettings(guildId) {
    const { getConfig } = await gate();
    return settingsFrom(await getConfig(guildId));
}

/**
 * Save settings. `patch` uses the settingsFrom shape (any subset). Logs the change.
 * @returns {Promise<object>} the new settings
 */
export async function saveSettings(guild, patch, by = null) {
    const { setConfig } = await gate();
    const cur = await getSettings(guild.id);
    const row = {};
    const changed = [];
    const set = (col, value, label) => { row[col] = value; changed.push(label); };
    if (patch.enabled !== undefined) set('name_filters_enabled', patch.enabled ? 1 : 0, `checks ${patch.enabled ? 'on' : 'off'}`);
    if (patch.fuzzy !== undefined) set('name_fuzzy', patch.fuzzy ? 1 : 0, `fuzzy ${patch.fuzzy ? 'on' : 'off'}`);
    if (patch.collapse !== undefined) set('name_collapse', patch.collapse ? 1 : 0, `collapse ${patch.collapse ? 'on' : 'off'}`);
    if (patch.flagRoleId !== undefined) set('name_flag_role_id', patch.flagRoleId || null, 'flag role');
    if (patch.timeoutMinutes !== undefined) {
        set('name_timeout_minutes', Math.min(40320, Math.max(1, Math.round(Number(patch.timeoutMinutes) || 60))), 'timeout length');
    }
    if (patch.dm !== undefined) set('name_dm', patch.dm ? 1 : 0, `DM ${patch.dm ? 'on' : 'off'}`);
    if (patch.generated) {
        if (patch.generated.enabled !== undefined) set('name_generated_enabled', patch.generated.enabled ? 1 : 0, `generated-name check ${patch.generated.enabled ? 'on' : 'off'}`);
        if (patch.generated.action !== undefined) set('name_generated_action', normaliseNameAction(patch.generated.action), 'generated-name action');
    }
    let autopilotChanged = false;
    if (patch.autopilot) {
        const a = patch.autopilot;
        if (a.enabled !== undefined) set('name_autopilot_enabled', a.enabled ? 1 : 0, `Auto-Pilot ${a.enabled ? 'on' : 'off'}`);
        if (a.action !== undefined) set('name_autopilot_action', normaliseNameAction(a.action), 'Auto-Pilot action');
        if (a.managers !== undefined) set('name_autopilot_managers', a.managers ? 1 : 0, 'Auto-Pilot covers managers');
        if (a.roles !== undefined) {
            const roles = [...new Set((a.roles || []).map(String).filter(r => /^\d{15,25}$/.test(r)))].slice(0, 25);
            set('name_autopilot_roles', JSON.stringify(roles), 'Auto-Pilot roles');
        }
        autopilotChanged = true;
    }
    if (patch.templates !== undefined) row.name_templates = JSON.stringify(patch.templates || {});
    if (!Object.keys(row).length) return cur;
    await setConfig(guild.id, row);
    invalidate(guild.id);
    const next = await getSettings(guild.id);
    if (autopilotChanged && patch.autopilot.action !== undefined) {
        await pool.execute("UPDATE automod_patterns SET action = ? WHERE guild_id = ? AND target = 'name' AND origin = 'auto'",
            [next.autopilot.action, guild.id]).catch(err => logger.warn(`[NameFilters] Auto-Pilot action update failed in ${guild.id}: ${err.message}`));
    }
    if (autopilotChanged) scheduleAutoPilot(guild, 0);
    if (changed.length) {
        logger.info(`[NameFilters] settings changed in ${guild.id} by ${by}: ${changed.join(', ')}`);
        void logFeatureEvent(() => (guild), 'join-gate.nameSettings', () => ({
            title: '⚙️ Name Filter Settings Changed',
            fields: [['Changed', changed.join(', '), false], ['By', userLabel(by)]],
        }));
    }
    return next;
}

// ── filters ──────────────────────────────────────────────────────────────────

const filterCache = new Map();   // guildId -> { at, filters, autoUserIds:Set }

export function invalidate(guildId) {
    if (guildId) filterCache.delete(guildId);
    else filterCache.clear();
}

/** Enabled, compiled filters for a guild (templates brought up to date first). Never throws. */
export async function loadFilters(guild, settings = null) {
    const hit = filterCache.get(guild.id);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const s = settings || await getSettings(guild.id);
    try {
        await syncTemplates(guild, s);
    } catch (err) {
        logger.warn(`[NameFilters] template sync failed in ${guild.id}: ${err.message}`);
    }
    let rows = [];
    try {
        [rows] = await pool.execute(
            `SELECT id, pattern_type, pattern, action, case_sensitive, origin, source_key, auto_user_id
               FROM automod_patterns
              WHERE guild_id = ? AND target = 'name' AND enabled = 1 AND removed_at IS NULL
              ORDER BY id`, [guild.id]);
    } catch (err) {
        logger.warn(`[NameFilters] could not load filters for ${guild.id}: ${err.message}`);
        return { at: Date.now(), filters: [], autoUserIds: new Set() };
    }
    const filters = [];
    for (const row of rows) {
        const f = compileFilter(row);
        if (f) filters.push(f);
        else logger.warn(`[NameFilters] skipping filter #${row.id} in ${guild.id}: it no longer compiles`);
    }
    const entry = { at: Date.now(), filters, autoUserIds: new Set(filters.filter(f => f.autoUserId).map(f => f.autoUserId)) };
    filterCache.set(guild.id, entry);
    if (s.autopilot.enabled && Date.now() - (autoSyncedAt.get(guild.id) || 0) > AUTOPILOT_REFRESH_MS) scheduleAutoPilot(guild);
    return entry;
}

/** Every filter of a guild with its counters, for the list views. */
export async function listFilters(guildId) {
    const [rows] = await pool.execute(
        `SELECT p.id, p.pattern_type, p.pattern, p.action, p.reason, p.enabled, p.disabled_reason, p.case_sensitive,
                p.origin, p.source_key, p.auto_user_id, p.removed_at, p.created_by, p.created_at,
                COALESCE(s.true_positives, 0) AS hits, COALESCE(s.false_positives, 0) AS false_positives, s.last_hit_at
           FROM automod_patterns p
           LEFT JOIN spam_patterns_stats s ON s.pattern_id = p.id AND s.guild_id = p.guild_id
          WHERE p.guild_id = ? AND p.target = 'name'
          ORDER BY p.origin = 'manual' DESC, p.id`, [guildId]);
    return rows.map(r => ({
        id: r.id,
        type: TYPE_OF_STORED[r.pattern_type] ?? r.pattern_type,
        pattern: r.pattern,
        action: normaliseNameAction(r.action),
        note: r.reason,
        enabled: !!r.enabled,
        disabledReason: r.disabled_reason,
        caseSensitive: !!r.case_sensitive,
        origin: r.origin,
        pack: r.origin === 'template' ? String(r.source_key || '').split(':')[0] : null,
        autoUserId: r.auto_user_id,
        removed: !!r.removed_at,
        createdBy: r.created_by,
        createdAt: r.created_at,
        hits: Number(r.hits),
        falsePositives: Number(r.false_positives),
        lastHitAt: r.last_hit_at,
    }));
}

async function counts(guildId) {
    const [[row]] = await pool.execute(
        `SELECT COUNT(*) AS total, SUM(origin = 'manual') AS manual
           FROM automod_patterns WHERE guild_id = ? AND target = 'name' AND removed_at IS NULL`, [guildId]);
    return { total: Number(row?.total ?? 0), manual: Number(row?.manual ?? 0) };
}

function changedLog(guild, title, fields) {
    void logFeatureEvent(() => (guild), 'join-gate.nameSettings', () => ({ title, fields }));
}

/**
 * Validate and store a filter.
 * @returns {Promise<{ ok:true, id:number, value:string } | { ok:false, error:string }>}
 */
export async function addFilter(guild, { type, pattern, action = 'log', caseSensitive = false, note = null }, by = null) {
    if (!NAME_FILTER_TYPES.includes(type)) return { ok: false, error: `Unknown filter type "${type}".` };
    const check = validateNameFilter(type, pattern, { caseSensitive });
    if (!check.ok) return check;
    const c = await counts(guild.id);
    if (c.manual >= MAX_MANUAL_FILTERS) return { ok: false, error: `This server already has ${MAX_MANUAL_FILTERS} name filters. Remove one first.` };
    if (c.total >= MAX_NAME_FILTERS) return { ok: false, error: `This server has ${MAX_NAME_FILTERS} name filters including templates and Auto-Pilot. Remove some first.` };
    const [dupes] = await pool.execute(
        `SELECT id FROM automod_patterns
          WHERE guild_id = ? AND target = 'name' AND pattern_type = ? AND pattern = ? COLLATE utf8mb4_bin AND removed_at IS NULL LIMIT 1`,
        [guild.id, STORED_TYPE[type], check.value]);
    if (dupes.length) return { ok: false, error: `That filter already exists as #${dupes[0].id}.` };
    const act = normaliseNameAction(action);
    const [result] = await pool.execute(
        `INSERT INTO automod_patterns (guild_id, target, pattern_type, pattern, action, reason, enabled, created_by, case_sensitive, origin)
         VALUES (?, 'name', ?, ?, ?, ?, 1, ?, ?, 'manual')`,
        [guild.id, STORED_TYPE[type], check.value, act, note ? String(note).slice(0, 200) : null, by, caseSensitive ? 1 : 0]);
    invalidate(guild.id);
    logger.info(`[NameFilters] filter #${result.insertId} added in ${guild.id} by ${by} (${type}, ${act})`);
    changedLog(guild, '➕ Name Filter Added', [['Filter', `#${result.insertId} ${filterLabel({ type, value: check.value })}`, false], ['Action', act], ['By', userLabel(by)]]);
    return { ok: true, id: result.insertId, value: check.value };
}

async function ownedRow(guildId, id) {
    const [[row]] = await pool.execute(
        "SELECT * FROM automod_patterns WHERE id = ? AND guild_id = ? AND target = 'name'", [id, guildId]);
    return row || null;
}

/**
 * Edit a filter. Manual filters can change everything; template and Auto-Pilot filters only their
 * action and on/off (their text comes from the pack / the staff member's name).
 * @returns {Promise<{ ok:boolean, error?:string }>}
 */
export async function updateFilter(guild, id, patch, by = null) {
    const row = await ownedRow(guild.id, id);
    if (!row) return { ok: false, error: 'No such filter.' };
    const sets = [];
    const args = [];
    if (patch.pattern !== undefined || patch.type !== undefined || patch.caseSensitive !== undefined) {
        if (row.origin !== 'manual') return { ok: false, error: 'Template and Auto-Pilot filters take their text from the pack or the staff name; change the action or switch them off instead.' };
        const type = patch.type ?? TYPE_OF_STORED[row.pattern_type];
        const cs = patch.caseSensitive ?? !!row.case_sensitive;
        const check = validateNameFilter(type, patch.pattern ?? row.pattern, { caseSensitive: cs });
        if (!check.ok) return check;
        sets.push('pattern_type = ?', 'pattern = ?', 'case_sensitive = ?');
        args.push(STORED_TYPE[type], check.value, cs ? 1 : 0);
    }
    if (patch.action !== undefined) { sets.push('action = ?'); args.push(normaliseNameAction(patch.action)); }
    if (patch.note !== undefined) { sets.push('reason = ?'); args.push(patch.note ? String(patch.note).slice(0, 200) : null); }
    if (patch.enabled !== undefined) {
        sets.push('enabled = ?', 'disabled_reason = ?');
        args.push(patch.enabled ? 1 : 0, patch.enabled ? null : 'switched off by staff');
    }
    if (!sets.length) return { ok: true };
    await pool.execute(`UPDATE automod_patterns SET ${sets.join(', ')} WHERE id = ? AND guild_id = ? AND target = 'name'`, [...args, id, guild.id]);
    invalidate(guild.id);
    logger.info(`[NameFilters] filter #${id} edited in ${guild.id} by ${by}`);
    changedLog(guild, '✏️ Name Filter Changed', [['Filter', `#${id}`], ['By', userLabel(by)]]);
    return { ok: true };
}

/**
 * Remove a filter. Template and Auto-Pilot filters are kept as "removed" so they are not created
 * again by the next sync; restoreFilter() brings one back.
 */
export async function removeFilter(guild, id, by = null) {
    const row = await ownedRow(guild.id, id);
    if (!row) return false;
    if (row.origin === 'manual') {
        await pool.execute("DELETE FROM automod_patterns WHERE id = ? AND guild_id = ? AND target = 'name'", [id, guild.id]);
    } else {
        await pool.execute("UPDATE automod_patterns SET removed_at = NOW(), enabled = 0, disabled_reason = 'removed by staff' WHERE id = ? AND guild_id = ?", [id, guild.id]);
    }
    invalidate(guild.id);
    logger.info(`[NameFilters] filter #${id} removed in ${guild.id} by ${by}`);
    changedLog(guild, '➖ Name Filter Removed', [['Filter', `#${id} ${filterLabel({ type: TYPE_OF_STORED[row.pattern_type], value: row.pattern })}`, false], ['By', userLabel(by)]]);
    return true;
}

export async function restoreFilter(guild, id, by = null) {
    const [r] = await pool.execute(
        "UPDATE automod_patterns SET removed_at = NULL, enabled = 1, disabled_reason = NULL WHERE id = ? AND guild_id = ? AND target = 'name' AND removed_at IS NOT NULL",
        [id, guild.id]);
    invalidate(guild.id);
    if (r.affectedRows) changedLog(guild, '↩️ Name Filter Restored', [['Filter', `#${id}`], ['By', userLabel(by)]]);
    return r.affectedRows > 0;
}

/** A regex that timed out on a real name is switched off and said so, like the message patterns. */
async function disableSlow(guild, ids) {
    for (const id of ids) {
        await pool.execute("UPDATE automod_patterns SET enabled = 0, disabled_reason = 'too slow on a real name' WHERE id = ? AND guild_id = ?", [id, guild.id]).catch(() => {});
        logger.warn(`[NameFilters] filter #${id} in ${guild.id} timed out and was switched off`);
        void logFeatureEvent(() => (guild), 'join-gate.failed', () => ({
            title: '⚠️ Name Filter Switched Off',
            description: `Filter #${id} took too long to check a name, so it was switched off to keep the bot responsive. Simplify it and switch it back on.`,
        }));
    }
    if (ids.length) invalidate(guild.id);
}

// ── templates ────────────────────────────────────────────────────────────────

/** Bring every applied pack in line with the code and the server's current name. */
export async function syncTemplates(guild, settings = null) {
    const s = settings || await getSettings(guild.id);
    const applied = s.templates;
    let dirty = false;
    const server = serverNameForTemplates(guild.name);
    for (const [packId, state] of Object.entries(applied)) {
        const pack = PACKS_BY_ID.get(packId);
        if (!pack) continue;
        if (state.version === pack.version && (state.server ?? null) === server) continue;
        const [rows] = await pool.execute(
            `SELECT id, source_key, pattern_type, pattern, removed_at FROM automod_patterns
              WHERE guild_id = ? AND target = 'name' AND origin = 'template' AND source_key LIKE ?`,
            [guild.id, `${packId}:%`]);
        const existing = rows.map(r => ({
            id: r.id, key: String(r.source_key).slice(packId.length + 1), type: TYPE_OF_STORED[r.pattern_type],
            value: r.pattern, removed: !!r.removed_at,
        }));
        const plan = planTemplateSync(existing, expandPack(pack, { serverName: guild.name }));
        const action = normaliseNameAction(state.action);
        for (const e of plan.insert) {
            await pool.execute(
                `INSERT IGNORE INTO automod_patterns (guild_id, target, pattern_type, pattern, action, enabled, origin, source_key)
                 VALUES (?, 'name', ?, ?, ?, 1, 'template', ?)`,
                [guild.id, STORED_TYPE[e.type], e.value, action, `${packId}:${e.key}`]);
        }
        for (const { id, entry } of plan.update) {
            await pool.execute('UPDATE automod_patterns SET pattern_type = ?, pattern = ? WHERE id = ? AND guild_id = ?',
                [STORED_TYPE[entry.type], entry.value, id, guild.id]);
        }
        if (plan.remove.length) {
            await pool.execute(`DELETE FROM automod_patterns WHERE guild_id = ? AND id IN (${plan.remove.map(() => '?').join(',')})`,
                [guild.id, ...plan.remove]);
        }
        applied[packId] = { ...state, version: pack.version, server };
        dirty = true;
        if (plan.insert.length || plan.update.length || plan.remove.length) {
            logger.info(`[NameFilters] pack ${packId} synced in ${guild.id}: +${plan.insert.length} ~${plan.update.length} -${plan.remove.length}`);
        }
    }
    if (dirty) {
        const { setConfig } = await gate();
        await setConfig(guild.id, { name_templates: JSON.stringify(applied) });
        filterCache.delete(guild.id);
    }
}

/** The packs and whether this server has applied each. */
export async function listTemplates(guildId) {
    const s = await getSettings(guildId);
    const [rows] = await pool.execute(
        `SELECT source_key, removed_at FROM automod_patterns WHERE guild_id = ? AND target = 'name' AND origin = 'template'`, [guildId]);
    return TEMPLATE_PACKS.map(p => {
        const mine = rows.filter(r => String(r.source_key).startsWith(`${p.id}:`));
        return {
            id: p.id, title: p.title, description: p.description, version: p.version,
            entries: p.entries.map(e => ({ key: e.key, type: e.type, value: e.value })),
            applied: !!s.templates[p.id],
            action: s.templates[p.id] ? normaliseNameAction(s.templates[p.id].action) : null,
            active: mine.filter(r => !r.removed_at).length,
            removed: mine.filter(r => r.removed_at).length,
        };
    });
}

export async function applyTemplate(guild, packId, action = 'log', by = null) {
    const pack = PACKS_BY_ID.get(packId);
    if (!pack) return { ok: false, error: 'No such template.' };
    const s = await getSettings(guild.id);
    const act = normaliseNameAction(action);
    const templates = { ...s.templates, [packId]: { action: act, version: 0, server: null } };
    const { setConfig } = await gate();
    await setConfig(guild.id, { name_templates: JSON.stringify(templates) });
    // Re-applying changes the action of the pack's filters.
    await pool.execute(
        "UPDATE automod_patterns SET action = ? WHERE guild_id = ? AND target = 'name' AND origin = 'template' AND source_key LIKE ?",
        [act, guild.id, `${packId}:%`]);
    await syncTemplates(guild, { ...s, templates });
    invalidate(guild.id);
    const [[{ n }]] = await pool.execute(
        "SELECT COUNT(*) AS n FROM automod_patterns WHERE guild_id = ? AND target = 'name' AND origin = 'template' AND source_key LIKE ? AND removed_at IS NULL",
        [guild.id, `${packId}:%`]);
    logger.info(`[NameFilters] pack ${packId} applied in ${guild.id} by ${by} (${act})`);
    changedLog(guild, '📦 Name Filter Template Applied', [['Template', pack.title], ['Filters', String(n)], ['Action', act], ['By', userLabel(by)]]);
    return { ok: true, count: Number(n) };
}

export async function removeTemplate(guild, packId, by = null) {
    const pack = PACKS_BY_ID.get(packId);
    if (!pack) return { ok: false, error: 'No such template.' };
    const s = await getSettings(guild.id);
    const templates = { ...s.templates };
    delete templates[packId];
    const { setConfig } = await gate();
    await setConfig(guild.id, { name_templates: JSON.stringify(templates) });
    const [r] = await pool.execute(
        "DELETE FROM automod_patterns WHERE guild_id = ? AND target = 'name' AND origin = 'template' AND source_key LIKE ?",
        [guild.id, `${packId}:%`]);
    invalidate(guild.id);
    changedLog(guild, '📦 Name Filter Template Removed', [['Template', pack.title], ['Filters removed', String(r.affectedRows)], ['By', userLabel(by)]]);
    return { ok: true, removed: r.affectedRows };
}

// ── acting ───────────────────────────────────────────────────────────────────

/** The configured role, or a "Flagged Name" role created (and saved) the first time it is needed. */
async function flagRole(guild, settings) {
    const existing = settings.flagRoleId ? guild.roles.cache.get(settings.flagRoleId) : null;
    if (existing) return existing;
    const byName = guild.roles.cache.find(r => r.name === FLAG_ROLE_NAME && !r.managed);
    const role = byName || await guild.roles.create({
        name: FLAG_ROLE_NAME, color: 0xE67E22, permissions: [], mentionable: false,
        reason: 'Name filters: role for members whose names matched a filter',
    });
    const { setConfig } = await gate();
    await setConfig(guild.id, { name_flag_role_id: role.id });
    return role;
}

function actionable(member, action, role) {
    if (action === 'ban') return member.bannable;
    if (action === 'kick') return member.kickable;
    if (action === 'timeout') return member.moderatable;
    if (action === 'flag') return !role || role.editable;
    return true;
}

/** Already in the state the action would put them in (so a repeat rename does not act twice). */
function alreadyDone(member, action, settings) {
    if (action === 'flag') return !!settings.flagRoleId && member.roles.cache.has(settings.flagRoleId);
    if (action === 'timeout') return (member.communicationDisabledUntilTimestamp ?? 0) > Date.now();
    return false;
}

async function recordEvent(guildId, user, action, detail) {
    await pool.execute(
        `INSERT INTO join_gate_events (guild_id, user_id, username, action, account_age_hours, dm_delivered, detail, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, NOW())`,
        [guildId, user.id, user.username?.slice(0, 100) ?? null, action, 0, detail?.slice(0, 255) ?? null],
    ).catch(err => logger.error(`[NameFilters] could not record ${action} for ${user.id}: ${err.message}`));
}

function nameDM(guild, action, settings) {
    const title = { ban: `You were banned from ${guild.name}`, kick: `You were removed from ${guild.name}`,
        timeout: `You were timed out in ${guild.name}` }[action];
    const next = action === 'timeout'
        ? `Change the name and the timeout can be lifted by the server's staff; it ends by itself in ${settings.timeoutMinutes} minute(s).`
        : action === 'kick' ? 'Change your name and you are welcome to join again.'
            : "If this is a mistake, contact the server's staff.";
    return {
        embeds: [new EmbedBuilder().setColor(0xC0392B).setTitle(title)
            .setDescription('This is automatic.\n\n**Why:** your name (username, display name or server nickname) matches '
                + 'one of this server\'s name rules. They block names used to impersonate staff and by scam accounts.\n\n'
                + `**What now:** ${next}`)],
    };
}

/** Carry out one action. Never throws. */
async function punish(member, action, settings, reason) {
    try {
        if (action === 'ban') await member.ban({ reason, deleteMessageSeconds: 3600 });
        else if (action === 'kick') await member.kick(reason);
        else if (action === 'timeout') await member.timeout(settings.timeoutMinutes * 60_000, reason);
        else if (action === 'flag') await member.roles.add(await flagRole(member.guild, settings), reason);
        return { ok: true };
    } catch (err) {
        return { ok: false, problem: err.message, err };
    }
}

async function safeHashOf(guildId, userId) {
    const [[row]] = await pool.execute(
        "SELECT names_hash FROM name_filter_reviews WHERE guild_id = ? AND user_id = ? AND kind = 'name' AND status = 'safe'", [guildId, userId]).catch(() => [[null]]);
    return row?.names_hash ?? null;
}

function memberNames(member) {
    return nameFieldsOf({ username: member.user.username, globalName: member.user.globalName, nickname: member.nickname });
}

const matchText = (m) => (m.generated
    ? `generated username (${m.text})`
    : `#${m.filter.id} ${filterLabel(m.filter)} on the ${FIELD_LABEL[m.field]} "${m.text}"`);

/**
 * Act on one member whose names matched. Returns what happened:
 * 'removed' (kicked / banned), 'acted' (flag / timeout), 'logged', 'held', 'skipped', 'failed'.
 */
async function enforce(member, match, settings, { source = 'auto', trigger = 'join', actorId = null } = {}) {
    const guild = member.guild;
    const action = match.generated ? settings.generated.action : match.filter.action;
    const fields = [['Member', userLabel(member)], ['Matched', matchText(match), false],
        ['When', { join: 'On joining', nickname: 'Changed their server nickname', username: 'Changed their username',
            display: 'Changed their display name', cleanse: 'Cleanse', review: 'Review queue', preview: 'New filter' }[trigger] ?? trigger]];
    if (match.filter) void recordPatternHit(guild.id, match.filter.id);

    if (action === 'log') {
        await recordEvent(guild.id, member.user, 'name_logged', matchText(match));
        logger.info(`[NameFilters] ${member.user.tag} matched in ${guild.id} (log only): ${matchText(match)}`);
        void logFeatureEvent(() => (guild), 'join-gate.nameObserved', () => ({
            title: '👀 Name Filter Match (Log Only)',
            description: 'This member\'s name matches a filter set to log only, so nothing was done.',
            fields: [...fields, ['If it is wrong', 'Mark them safe on the dashboard\'s Name Filters page', false]],
        }));
        return 'logged';
    }
    if (alreadyDone(member, action, settings)) return 'skipped';
    if (await protectionHold(member, action, 'Name filter')) return 'held';

    const role = action === 'flag' && settings.flagRoleId ? guild.roles.cache.get(settings.flagRoleId) : null;
    const cannot = whyCannot(guild, action, { member, role });
    if (cannot) {
        const problem = cannot.text.replace(/\*\*/g, '');
        await recordEvent(guild.id, member.user, 'failed', `name filter: ${problem}`);
        await reportManualAction(guild, { action, member, source: 'Name filter', problem: cannot });
        return 'failed';
    }

    let delivered = false;
    if (settings.dm && action !== 'flag') {
        try { await member.send(nameDM(guild, action, settings)); delivered = true; } catch { delivered = false; }
    }
    const result = await punish(member, action, settings, nameReason(match, source));
    if (!result.ok) {
        await recordEvent(guild.id, member.user, 'failed', `name filter: ${result.problem}`);
        logger.error(`[NameFilters] ${action} failed for ${member.user.tag} in ${guild.id}: ${result.problem}`);
        const cause = whyFailed(result.err, guild, action, { member, role });
        if (cause) await reportManualAction(guild, { action, member, source: 'Name filter', problem: cause });
        else {
            void logFeatureEvent(() => (guild), 'join-gate.failed', () => ({
                title: '⚠️ Name Filter Could Not Act',
                fields: [...fields, ['Tried to', action], ['Problem', result.problem, false]],
            }));
        }
        return 'failed';
    }
    await recordEvent(guild.id, member.user, nameEventAction(action), matchText(match));
    logger.info(`[NameFilters] ${DONE[action]} ${member.user.tag} in ${guild.id}: ${matchText(match)}`);
    void logFeatureEvent(() => (guild), 'join-gate.nameFilter', () => ({
        title: { ban: '🔨 Banned — Name Filter', kick: '🚪 Removed — Name Filter', timeout: '⏱️ Timed Out — Name Filter',
            flag: '🚩 Flagged — Name Filter' }[action],
        fields: [...fields,
            ['They were told', settings.dm && action !== 'flag' ? (delivered ? 'Yes — by DM' : 'No — their DMs are closed') : null],
            ['By', actorId ? userLabel(actorId) : null]],
    }));
    return action === 'ban' || action === 'kick' ? 'removed' : 'acted';
}

/**
 * Match one member against the server's filters (and the generated-name check where it applies).
 * @returns {Promise<{ match:object|null, settings:object, fields:object[] }>}
 */
async function evaluate(member, settings, { generated = false } = {}) {
    const fields = memberNames(member);
    let match = null;
    if (settings.enabled) {
        const { filters } = await loadFilters(member.guild, settings);
        if (filters.length) {
            const r = matchNames(filters, fields, { fuzzy: settings.fuzzy, collapse: settings.collapse, memberId: member.id });
            if (r.timedOut.length) await disableSlow(member.guild, r.timedOut);
            match = r.match;
        }
    }
    if (!match && generated && settings.generated.enabled) {
        const g = generatedUsername(member.user.username);
        if (g) match = { generated: true, action: settings.generated.action, field: 'username', text: member.user.username, form: 'raw', detail: g };
    }
    return { match, fields };
}

/**
 * The live check, for a join or a rename. Returns 'name_removed' when the member was kicked or
 * banned, otherwise null. Never throws.
 */
export async function checkMember(member, trigger, cfg = null) {
    try {
        if (!member?.guild || member.user?.bot) return null;
        const settings = cfg ? settingsFrom(cfg) : await getSettings(member.guild.id);
        if (!settings.enabled && !settings.generated.enabled) return null;
        const generated = trigger === 'join' || trigger === 'username';
        if (!settings.enabled && !generated) return null;
        const { match, fields } = await evaluate(member, settings, { generated });

        if (!match) {
            // A name that no longer matches takes the flag role back off.
            if (trigger !== 'join' && settings.flagRoleId && member.roles.cache.has(settings.flagRoleId)) {
                const role = member.guild.roles.cache.get(settings.flagRoleId);
                if (role?.editable) {
                    await member.roles.remove(role, 'Name filter: their names no longer match').catch(() => {});
                    logger.info(`[NameFilters] took the flag role off ${member.user.tag} in ${member.guild.id}: names no longer match`);
                }
            }
            return null;
        }
        if (isStaff(member)) return null;
        const safe = await safeHashOf(member.guild.id, member.id);
        if (safe && safe === namesHash(fields)) return null;
        const outcome = await enforce(member, match, settings, { trigger });
        return outcome === 'removed' ? 'name_removed' : null;
    } catch (err) {
        logger.error(`[NameFilters] check failed for ${member?.id} in ${member?.guild?.id}: ${err.message}`);
        return null;
    }
}

/** Called by checkJoin. */
export async function checkNamesOnJoin(member, cfg) {
    return checkMember(member, 'join', cfg);
}

/** Does this client serve the guild (custom-bot servers are acted on by their own bot only)? Also used by core/avatar-protection.js. */
export async function servesGuild(client, guildId) {
    try {
        const { default: botManager } = await import('./bot-manager.js');
        const serving = botManager?.getClientForGuild?.(guildId);
        if (serving) return serving === client;
    } catch { /* fall through */ }
    if (!client.isDefaultBot) return true;
    const { shouldIgnoreGuild } = await import('../utils/custom-bot-check.js');
    return !(await shouldIgnoreGuild(guildId));
}

/** events/guildMemberUpdate.js: nickname changes, and staff changes Auto-Pilot follows. Never throws. */
export async function onMemberUpdate(oldMember, newMember) {
    try {
        if (newMember.user?.bot) return;
        const nickChanged = oldMember.nickname !== newMember.nickname && !oldMember.partial;
        const rolesChanged = oldMember.roles?.cache && !oldMember.roles.cache.equals?.(newMember.roles.cache);
        if (!nickChanged && !rolesChanged) return;
        const { getConfig } = await gate();
        const cfg = await getConfig(newMember.guild.id);
        if (!cfg) return;
        const settings = settingsFrom(cfg);
        if (nickChanged && settings.enabled) await checkMember(newMember, 'nickname', cfg);
        if (settings.autopilot.enabled && (await relevantToAutoPilot(newMember, settings, rolesChanged ? oldMember : null))) {
            scheduleAutoPilot(newMember.guild);
        }
    } catch (err) {
        logger.warn(`[NameFilters] member update handling failed: ${err.message}`);
    }
}

/** events/userUpdate.js: username / display-name changes, checked in every server this bot serves. */
export async function onUserUpdate(oldUser, newUser) {
    try {
        if (newUser.bot) return;
        const userChanged = oldUser.username !== newUser.username;
        const displayChanged = oldUser.globalName !== newUser.globalName;
        if (!userChanged && !displayChanged) return;
        const { getConfig } = await gate();
        for (const guild of newUser.client.guilds.cache.values()) {
            const cfg = await getConfig(guild.id);
            if (!cfg) continue;
            const settings = settingsFrom(cfg);
            if (!settings.enabled && !(userChanged && settings.generated.enabled) && !settings.autopilot.enabled) continue;
            if (!(await servesGuild(newUser.client, guild.id))) continue;
            const member = guild.members.cache.get(newUser.id) || await guild.members.fetch(newUser.id).catch(() => null);
            if (!member) continue;
            await checkMember(member, userChanged ? 'username' : 'display', cfg);
            if (settings.autopilot.enabled && (await relevantToAutoPilot(member, settings))) scheduleAutoPilot(guild);
        }
    } catch (err) {
        logger.warn(`[NameFilters] user update handling failed: ${err.message}`);
    }
}

// ── test & preview ───────────────────────────────────────────────────────────

const describeMatch = (m) => ({
    filterId: m.filter?.id ?? null,
    label: m.generated ? 'generated scam username' : filterLabel(m.filter),
    action: m.generated ? null : m.filter.action,
    origin: m.filter?.origin ?? 'built-in',
    field: m.field,
    fieldLabel: FIELD_LABEL[m.field],
    text: m.text,
    form: m.form,
    formLabel: FORM_LABEL[m.form] ?? m.form,
});

/**
 * Which filters a name (or a member's names) hits, and how the names look folded.
 * `text`: a name to try; or `member`: a GuildMember.
 */
export async function testNames(guild, { text = null, member = null }) {
    const settings = await getSettings(guild.id);
    const fields = member ? memberNames(member) : nameFieldsOf({ username: String(text ?? '').slice(0, 100) });
    const { filters } = await loadFilters(guild, settings);
    const r = matchNames(filters, fields, { fuzzy: settings.fuzzy, collapse: settings.collapse, memberId: member?.id ?? null });
    const username = member ? member.user.username : String(text ?? '');
    const g = generatedUsername(username);
    const out = {
        settings: { enabled: settings.enabled, fuzzy: settings.fuzzy, collapse: settings.collapse, generated: settings.generated },
        fields: fields.map(f => ({ field: f.field, fieldLabel: FIELD_LABEL[f.field], text: f.text, forms: describeForms(f.text, { collapse: settings.collapse }) })),
        matches: r.matches.map(describeMatch),
        top: r.match ? describeMatch(r.match) : null,
        generated: g ? { ...g, enabled: settings.generated.enabled, action: settings.generated.action } : null,
        filterCount: filters.length,
        notes: [],
    };
    if (member) {
        if (member.user.bot) out.notes.push('Bots are never checked.');
        if (isStaff(member)) out.notes.push('Staff (owner or a moderation permission) are never acted on.');
        const ex = await isExempt(member);
        if (ex.exempt) out.notes.push(`Exempt from automatic protections: ${ex.text}.`);
        const safe = await safeHashOf(guild.id, member.id);
        if (safe) out.notes.push(safe === namesHash(fields) ? 'Marked safe for these names.' : 'Was marked safe, but has changed name since.');
    }
    return out;
}

// Full member fetches are rate-limited: reuse one for a few minutes (shared with core/avatar-protection.js).
const lastFetch = new Map();
export async function allMembers(guild) {
    let complete = true;
    if (Date.now() - (lastFetch.get(guild.id) || 0) > MEMBER_FETCH_FRESH_MS || guild.members.cache.size < guild.memberCount) {
        try {
            await guild.members.fetch({ time: 120_000 });
            lastFetch.set(guild.id, Date.now());
        } catch (err) {
            logger.warn(`[NameFilters] member fetch failed in ${guild.id}: ${err.message}`);
            complete = guild.members.cache.size >= guild.memberCount;
        }
    }
    return { members: [...guild.members.cache.values()], complete };
}

const memberRow = (m) => ({
    id: m.id,
    username: m.user.username,
    globalName: m.user.globalName ?? null,
    nickname: m.nickname ?? null,
    displayName: m.displayName,
    avatar: m.displayAvatarURL({ size: 64 }),
    joinedAt: m.joinedTimestamp ?? null,
    createdAt: m.user.createdTimestamp,
});

/**
 * The current members a filter would hit, before it is saved.
 * @returns {Promise<{ ok:boolean, error?:string, value?:string, total?:number, complete?:boolean,
 *           hits?:object[], skipped?:object, count?:number }>}
 */
export async function previewFilter(guild, { type, pattern, caseSensitive = false }) {
    const check = validateNameFilter(type, pattern, { caseSensitive });
    if (!check.ok) return check;
    const settings = await getSettings(guild.id);
    const filter = compileFilter({ id: 0, pattern_type: STORED_TYPE[type], pattern: check.value, case_sensitive: caseSensitive ? 1 : 0, action: 'log' });
    const { members, complete } = await allMembers(guild);
    const hits = [];
    const skipped = { staff: 0, exempt: 0, bots: 0 };
    for (const m of members) {
        if (m.user.bot) { skipped.bots++; continue; }
        const r = matchNames([filter], memberNames(m), { fuzzy: settings.fuzzy, collapse: settings.collapse });
        if (!r.match) continue;
        if (isStaff(m)) { skipped.staff++; continue; }
        if ((await isExempt(m)).exempt) { skipped.exempt++; continue; }
        hits.push({ ...memberRow(m), field: r.match.field, fieldLabel: FIELD_LABEL[r.match.field], text: r.match.text, formLabel: FORM_LABEL[r.match.form] });
    }
    return { ok: true, value: check.value, total: members.length, complete, count: hits.length, hits: hits.slice(0, 500), skipped };
}

/**
 * "Save and act on these N": the saved filter's action on each listed member, each re-checked
 * against the filter first. A log-only filter puts them in the review queue instead.
 */
export async function actOnPreview(guild, filterId, userIds, actorId) {
    const row = await ownedRow(guild.id, filterId);
    const out = { done: 0, queued: 0, failed: [], skipped: 0, action: null };
    if (!row) { out.failed.push({ id: '*', problem: 'The filter is gone.' }); return out; }
    const filter = compileFilter(row);
    const settings = await getSettings(guild.id);
    out.action = filter.action;
    if (filter.action !== 'log' && await isPaused(guild.id, guild)) {
        out.failed.push({ id: '*', problem: 'Protections are paused in this server. Resume them first.' });
        return out;
    }
    for (const id of [...new Set(userIds)].slice(0, SCAN_CAP)) {
        const member = await guild.members.fetch(id).catch(() => null);
        if (!member || member.user.bot || isStaff(member)) { out.skipped++; continue; }
        const r = matchNames([filter], memberNames(member), { fuzzy: settings.fuzzy, collapse: settings.collapse, memberId: member.id });
        if (!r.match) { out.skipped++; continue; }
        if (filter.action === 'log') {
            await queueReview(guild.id, member, r.match);
            out.queued++;
            continue;
        }
        const outcome = await enforce(member, r.match, settings, { source: 'review', trigger: 'preview', actorId });
        if (outcome === 'removed' || outcome === 'acted') out.done++;
        else if (outcome === 'failed') out.failed.push({ id, problem: 'Could not act (see the log)' });
        else out.skipped++;
    }
    logger.info(`[NameFilters] preview action for #${filterId} in ${guild.id} by ${actorId}: done ${out.done}, queued ${out.queued}`);
    return out;
}

// ── cleanse & review ─────────────────────────────────────────────────────────

async function queueReview(guildId, member, match) {
    const fields = memberNames(member);
    await pool.execute(
        `INSERT INTO name_filter_reviews (guild_id, user_id, username, display_name, nickname, filter_id, filter_label, field, names_hash, status, detail, found_at, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NOW(), NULL, NULL)
         ON DUPLICATE KEY UPDATE username = VALUES(username), display_name = VALUES(display_name), nickname = VALUES(nickname),
           filter_id = VALUES(filter_id), filter_label = VALUES(filter_label), field = VALUES(field), names_hash = VALUES(names_hash),
           status = 'pending', detail = NULL, found_at = NOW(), decided_by = NULL, decided_at = NULL`,
        [guildId, member.id, member.user.username?.slice(0, 100) ?? null, member.user.globalName?.slice(0, 100) ?? null,
            member.nickname?.slice(0, 100) ?? null, match.filter?.id ?? null,
            (match.generated ? 'generated scam username' : filterLabel(match.filter)).slice(0, 200), match.field, namesHash(fields)]);
}

const jobs = new Map();   // guildId -> { running, mode, by, startedAt, finishedAt, result, error }

export function cleanseStatus(guildId) {
    return jobs.get(guildId) ?? { running: false };
}

/**
 * Scan every member against the filters (and the generated-name check if it is on).
 * mode 'review' queues every match; 'force' acts at once with each filter's own action.
 * Runs in the background; cleanseStatus() reports progress and the result.
 */
export function startCleanse(guild, { mode = 'review' } = {}, actorId = null) {
    const cur = jobs.get(guild.id);
    if (cur?.running) return { ok: false, error: 'A cleanse is already running for this server.' };
    const job = { running: true, mode: mode === 'force' ? 'force' : 'review', by: actorId, startedAt: Date.now(), checked: 0 };
    jobs.set(guild.id, job);
    runCleanse(guild, job).catch(err => {
        job.error = err.message;
        logger.error(`[NameFilters] cleanse failed in ${guild.id}: ${err.message}`);
    }).finally(() => { job.running = false; job.finishedAt = Date.now(); });
    return { ok: true };
}

async function runCleanse(guild, job) {
    const settings = await getSettings(guild.id);
    const { filters } = await loadFilters(guild, settings);
    if (!filters.length && !settings.generated.enabled) throw new Error('This server has no name filters yet.');
    const { members, complete } = await allMembers(guild);
    job.total = members.length;
    const [safeRows] = await pool.execute("SELECT user_id, names_hash FROM name_filter_reviews WHERE guild_id = ? AND kind = 'name' AND status = 'safe'", [guild.id]);
    const safe = new Map(safeRows.map(r => [r.user_id, r.names_hash]));
    const candidates = [];
    const slow = new Set();
    for (const m of members) {
        job.checked++;
        if (m.user.bot) { candidates.push({ id: m.id, bot: true }); continue; }
        const fields = memberNames(m);
        const r = matchNames(filters, fields, { fuzzy: settings.fuzzy, collapse: settings.collapse, memberId: m.id });
        r.timedOut.forEach(id => slow.add(id));
        let match = r.match;
        if (!match && settings.generated.enabled) {
            const g = generatedUsername(m.user.username);
            if (g) match = { generated: true, action: settings.generated.action, field: 'username', text: m.user.username, form: 'raw', detail: g };
        }
        candidates.push({
            id: m.id, member: m, match, owner: guild.ownerId === m.id, staff: match ? isStaff(m) : false,
            exempt: match ? (await isExempt(m)).exempt : false, safeHash: safe.get(m.id) ?? null, namesHash: namesHash(fields),
        });
    }
    if (slow.size) await disableSlow(guild, [...slow]);
    const plan = planCleanse(candidates);
    const { act, review } = job.mode === 'force' ? splitForce(plan.queue) : { act: [], review: plan.queue };

    for (const c of review) await queueReview(guild.id, c.member, c.match);
    // Pending rows for members who no longer match (renamed or left) are closed.
    const stillQueued = new Set(review.map(c => c.id));
    const [pending] = await pool.execute("SELECT user_id FROM name_filter_reviews WHERE guild_id = ? AND kind = 'name' AND status = 'pending'", [guild.id]);
    const stale = pending.map(r => r.user_id).filter(id => !stillQueued.has(id));
    if (stale.length) {
        await pool.execute(
            `UPDATE name_filter_reviews SET status = 'gone', detail = 'no longer matches, or left' WHERE guild_id = ? AND kind = 'name' AND status = 'pending' AND user_id IN (${stale.map(() => '?').join(',')})`,
            [guild.id, ...stale]);
    }

    const acted = { done: 0, failed: 0, held: 0 };
    for (const c of act.slice(0, SCAN_CAP)) {
        const outcome = await enforce(c.member, c.match, settings, { source: 'cleanse', trigger: 'cleanse', actorId: job.by });
        if (outcome === 'removed' || outcome === 'acted') acted.done++;
        else if (outcome === 'failed') acted.failed++;
        else acted.held++;
    }

    job.result = {
        total: members.length, complete, matched: plan.queue.length, queued: review.length, acted,
        skipped: Object.fromEntries(Object.entries(plan.skipped).map(([k, ids]) => [k, ids.length])),
        closed: stale.length,
    };
    logger.info(`[NameFilters] cleanse (${job.mode}) in ${guild.id} by ${job.by}: ${plan.queue.length} matched, ${review.length} queued, ${acted.done} acted`);
    void logFeatureEvent(() => (guild), 'join-gate.nameCleanse', () => ({
        title: job.mode === 'force' ? '🧹 Name Cleanse (Force) Finished' : '🧹 Name Cleanse Finished',
        fields: [
            ['Run by', userLabel(job.by)],
            ['Members checked', `${members.length}${complete ? '' : ' (member list incomplete)'}`],
            ['Matched', String(plan.queue.length)],
            ['Queued for review', String(review.length)],
            ['Acted on', job.mode === 'force' ? String(acted.done) : null],
            ['Could not act', acted.failed ? String(acted.failed) : null],
        ],
    }));
}

/** The review queue (and decided rows, for the history view). */
export async function listReviews(guildId, { status = 'pending', limit = 200 } = {}) {
    const statuses = status === 'all' ? null : String(status).split(',');
    const [rows] = await pool.execute(
        `SELECT user_id, username, display_name, nickname, filter_id, filter_label, field, status, detail, found_at, decided_by, decided_at
           FROM name_filter_reviews WHERE guild_id = ? AND kind = 'name' ${statuses ? `AND status IN (${statuses.map(() => '?').join(',')})` : ''}
          ORDER BY found_at DESC LIMIT ${Math.min(1000, Math.max(1, Number(limit) || 200))}`,
        [guildId, ...(statuses ?? [])]);
    return rows;
}

export async function reviewCounts(guildId) {
    const [rows] = await pool.execute("SELECT status, COUNT(*) AS n FROM name_filter_reviews WHERE guild_id = ? AND kind = 'name' GROUP BY status", [guildId]);
    return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
}

async function setReview(guildId, userId, status, by, detail = null, hash = undefined) {
    await pool.execute(
        `UPDATE name_filter_reviews SET status = ?, detail = ?, decided_by = ?, decided_at = NOW()${hash !== undefined ? ', names_hash = ?' : ''}
          WHERE guild_id = ? AND user_id = ? AND kind = 'name'`,
        [status, detail ? String(detail).slice(0, 255) : null, by, ...(hash !== undefined ? [hash] : []), guildId, userId]);
}

/**
 * Decide queued members: 'ban' | 'kick' | 'safe' | 'skip'. Bans and kicks re-check that the member
 * is still here and still matches, and go through protectionHold.
 * @returns {Promise<{ done:number, failed:Array<{id,problem}>, skipped:number, decision:string }>}
 */
export async function decideReviews(guild, userIds, decision, actorId) {
    const out = { done: 0, failed: [], skipped: 0, decision };
    if (!['ban', 'kick', 'safe', 'skip'].includes(decision)) { out.failed.push({ id: '*', problem: 'Unknown decision.' }); return out; }
    const settings = await getSettings(guild.id);
    if ((decision === 'ban' || decision === 'kick')) {
        const [perm, permName] = NEEDS[decision];
        if (!guild.members.me?.permissions?.has(perm)) { out.failed.push({ id: '*', problem: `The bot is missing the ${permName} permission` }); return out; }
        if (await isPaused(guild.id, guild)) { out.failed.push({ id: '*', problem: 'Protections are paused in this server. Resume them first.' }); return out; }
    }
    const ids = [...new Set(userIds.map(String))].slice(0, SCAN_CAP);
    const [rows] = ids.length ? await pool.execute(
        `SELECT * FROM name_filter_reviews WHERE guild_id = ? AND kind = 'name' AND user_id IN (${ids.map(() => '?').join(',')})`, [guild.id, ...ids]) : [[]];
    const byId = new Map(rows.map(r => [r.user_id, r]));
    for (const id of ids) {
        const row = byId.get(id);
        if (!row) { out.skipped++; continue; }
        const member = await guild.members.fetch(id).catch(() => null);
        if (decision === 'skip') { await setReview(guild.id, id, 'skipped', actorId); out.done++; continue; }
        if (decision === 'safe') {
            await setReview(guild.id, id, 'safe', actorId, null, member ? namesHash(memberNames(member)) : row.names_hash);
            if (row.filter_id) await markPatternFalsePositive(guild.id, row.filter_id).catch(() => {});
            out.done++;
            continue;
        }
        if (!member) { await setReview(guild.id, id, 'gone', actorId, 'left the server'); out.skipped++; continue; }
        if (member.user.bot || isStaff(member)) { await setReview(guild.id, id, 'skipped', actorId, 'staff'); out.skipped++; continue; }
        if (await protectionHold(member, decision, 'Name filter review')) { out.skipped++; continue; }
        if (!actionable(member, decision, null)) {
            await setReview(guild.id, id, 'failed', actorId, 'their highest role is above the bot');
            out.failed.push({ id, problem: 'Their highest role is above the bot' });
            continue;
        }
        const match = { filter: row.filter_id ? { id: row.filter_id } : null, field: row.field, generated: !row.filter_id };
        let delivered = false;
        if (settings.dm) { try { await member.send(nameDM(guild, decision, settings)); delivered = true; } catch { delivered = false; } }
        const result = await punish(member, decision, settings, nameReason(match, 'review'));
        if (!result.ok) {
            await setReview(guild.id, id, 'failed', actorId, result.problem);
            out.failed.push({ id, problem: result.problem });
            continue;
        }
        await setReview(guild.id, id, decision === 'ban' ? 'banned' : 'kicked', actorId, delivered ? 'told by DM' : null);
        await recordEvent(guild.id, member.user, nameEventAction(decision), `review: ${row.filter_label ?? 'name filter'}`);
        out.done++;
    }
    logger.info(`[NameFilters] review decision ${decision} in ${guild.id} by ${actorId}: ${out.done} done, ${out.failed.length} failed`);
    if ((decision === 'ban' || decision === 'kick') && (out.done || out.failed.length)) {
        void logFeatureEvent(() => (guild), 'join-gate.nameCleanse', () => ({
            title: decision === 'ban' ? '🔨 Name Review: Banned' : '🚪 Name Review: Kicked',
            fields: [['By', userLabel(actorId)], ['Done', String(out.done)], ['Failed', out.failed.length ? String(out.failed.length) : null]],
        }));
    }
    return out;
}

/** Mark one member safe for their current names (from the test box or the recent hits). */
export async function markSafe(guild, userId, by) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return { ok: false, error: 'They are not in the server.' };
    const fields = memberNames(member);
    await pool.execute(
        `INSERT INTO name_filter_reviews (guild_id, user_id, username, display_name, nickname, names_hash, status, decided_by, decided_at, found_at)
         VALUES (?, ?, ?, ?, ?, ?, 'safe', ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE username = VALUES(username), display_name = VALUES(display_name), nickname = VALUES(nickname),
           names_hash = VALUES(names_hash), status = 'safe', decided_by = VALUES(decided_by), decided_at = NOW()`,
        [guild.id, userId, member.user.username?.slice(0, 100) ?? null, member.user.globalName?.slice(0, 100) ?? null,
            member.nickname?.slice(0, 100) ?? null, namesHash(fields), by]);
    changedLog(guild, '✅ Marked Safe (Name Filters)', [['Member', userLabel(member)], ['By', userLabel(by)]]);
    return { ok: true };
}

export async function unmarkSafe(guild, userId, by) {
    const [r] = await pool.execute("DELETE FROM name_filter_reviews WHERE guild_id = ? AND user_id = ? AND kind = 'name' AND status = 'safe'", [guild.id, userId]);
    if (r.affectedRows) changedLog(guild, '↩️ No Longer Marked Safe (Name Filters)', [['Member', `<@${userId}>`], ['By', userLabel(by)]]);
    return r.affectedRows > 0;
}

/** The latest name-filter outcomes (join_gate_events), newest first. */
export async function recentHits(guildId, limit = 50) {
    const [rows] = await pool.execute(
        `SELECT id, user_id, username, action, detail, created_at FROM join_gate_events
          WHERE guild_id = ? AND (action LIKE 'name\\_%' OR (action = 'failed' AND detail LIKE 'name filter%'))
          ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, Number(limit) || 50))}`, [guildId]);
    return rows;
}

// ── Auto-Pilot ───────────────────────────────────────────────────────────────

const autoTimers = new Map();
const autoSyncedAt = new Map();

/**
 * Does Auto-Pilot cover this member (a covered staff role, or with "managers" on a bot-manager role,
 * an allowlisted role, or the member allowlisted)? One definition for names and for avatars
 * (core/avatar-protection.js). `state` is protection-exempt's getState().
 */
export function autoPilotCovers(member, autopilot, state) {
    if (member.user?.bot) return false;
    for (const id of member.roles.cache.keys()) {
        if (autopilot.roles.includes(id)) return true;
        if (autopilot.managers && (state.managers.has(id) || state.roles.has(id))) return true;
    }
    return autopilot.managers && (state.users.has(member.id) || state.seen.has(member.id));
}

/** Is this member (or were they, before this role change) someone Auto-Pilot protects or tracks? */
async function relevantToAutoPilot(member, settings, before = null) {
    const cached = filterCache.get(member.guild.id);
    if (cached?.autoUserIds?.has(member.id)) return true;
    const state = await protectionState(member.guild.id);
    const roleSets = [member.roles.cache, before?.roles?.cache].filter(Boolean);
    for (const roles of roleSets) {
        for (const id of roles.keys()) {
            if (settings.autopilot.roles.includes(id)) return true;
            if (settings.autopilot.managers && (state.managers.has(id) || state.roles.has(id))) return true;
        }
    }
    return settings.autopilot.managers && (state.users.has(member.id) || state.seen.has(member.id));
}

export function scheduleAutoPilot(guild, delay = AUTOPILOT_DEBOUNCE_MS) {
    clearTimeout(autoTimers.get(guild.id));
    autoTimers.set(guild.id, setTimeout(() => {
        autoTimers.delete(guild.id);
        syncAutoPilot(guild).catch(err => logger.warn(`[NameFilters] Auto-Pilot sync failed in ${guild.id}: ${err.message}`));
    }, delay));
}

/**
 * Create / retire the exact-name filters for protected staff. With Auto-Pilot off, the active
 * Auto-Pilot filters are removed (staff deletions stay remembered).
 * @returns {Promise<{ created:number, retired:number, protected:number }>}
 */
export async function syncAutoPilot(guild, { fetch = false } = {}) {
    const settings = await getSettings(guild.id);
    autoSyncedAt.set(guild.id, Date.now());
    if (!settings.autopilot.enabled) {
        const [r] = await pool.execute(
            "DELETE FROM automod_patterns WHERE guild_id = ? AND target = 'name' AND origin = 'auto' AND removed_at IS NULL", [guild.id]);
        if (r.affectedRows) invalidate(guild.id);
        return { created: 0, retired: r.affectedRows, protected: 0 };
    }
    const members = fetch ? (await allMembers(guild)).members : [...guild.members.cache.values()];
    const state = await protectionState(guild.id);
    const isProtected = (m) => autoPilotCovers(m, settings.autopilot, state);
    const owners = new Map();
    const protectedMembers = [];
    for (const m of members) {
        if (m.user.bot) continue;
        const names = [m.user.username, m.user.globalName, m.nickname].filter(Boolean);
        for (const n of names) {
            const key = exactKey(n);
            if (!owners.has(key)) owners.set(key, new Set());
            owners.get(key).add(m.id);
        }
        if (isProtected(m)) protectedMembers.push({ id: m.id, names });
    }
    const [rows] = await pool.execute(
        "SELECT id, auto_user_id, source_key, removed_at FROM automod_patterns WHERE guild_id = ? AND target = 'name' AND origin = 'auto'",
        [guild.id]);
    // Only members still in the cache can be judged; a staff member missing from it keeps their filters.
    const present = new Set(members.map(m => m.id));
    const existing = rows.filter(r => present.has(r.auto_user_id)).map(r => ({
        id: r.id, autoUserId: r.auto_user_id, key: String(r.source_key).split(':').slice(2).join(':'), removed: !!r.removed_at,
    }));
    const plan = planAutoPilot({ protectedMembers, owners, existing });
    const room = MAX_NAME_FILTERS - (await counts(guild.id)).total;
    for (const c of plan.create.slice(0, Math.max(0, room))) {
        await pool.execute(
            `INSERT IGNORE INTO automod_patterns (guild_id, target, pattern_type, pattern, action, enabled, origin, source_key, auto_user_id)
             VALUES (?, 'name', 'exact', ?, ?, 1, 'auto', ?, ?)`,
            [guild.id, c.text.slice(0, 100), settings.autopilot.action, `auto:${c.userId}:${c.key}`.slice(0, 100), c.userId]);
    }
    if (plan.retire.length) {
        await pool.execute(`DELETE FROM automod_patterns WHERE guild_id = ? AND origin = 'auto' AND id IN (${plan.retire.map(() => '?').join(',')})`,
            [guild.id, ...plan.retire]);
    }
    if (plan.create.length || plan.retire.length) {
        invalidate(guild.id);
        logger.info(`[NameFilters] Auto-Pilot in ${guild.id}: +${plan.create.length} -${plan.retire.length} (${protectedMembers.length} protected)`);
    }
    return { created: Math.min(plan.create.length, Math.max(0, room)), retired: plan.retire.length, protected: protectedMembers.length };
}

/** Overview numbers for the dashboard and `/moderation namefilter list`. */
export async function overview(guild) {
    const settings = await getSettings(guild.id);
    const [byOrigin] = await pool.execute(
        `SELECT origin, SUM(removed_at IS NULL AND enabled = 1) AS active, SUM(removed_at IS NULL) AS kept, SUM(removed_at IS NOT NULL) AS removed
           FROM automod_patterns WHERE guild_id = ? AND target = 'name' GROUP BY origin`, [guild.id]);
    const [[hits]] = await pool.execute(
        `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM join_gate_events
          WHERE guild_id = ? AND action LIKE 'name\\_%' AND created_at > NOW() - INTERVAL 30 DAY`, [guild.id]);
    return {
        settings,
        filters: Object.fromEntries(byOrigin.map(r => [r.origin, { active: Number(r.active), total: Number(r.kept), removed: Number(r.removed) }])),
        hits30d: Number(hits?.n ?? 0),
        lastHitAt: hits?.last ?? null,
        reviews: await reviewCounts(guild.id),
        cleanse: cleanseStatus(guild.id),
        autoPilotSyncedAt: autoSyncedAt.get(guild.id) ?? null,
    };
}

// ── export / import ──────────────────────────────────────────────────────────

/** The server's own filters as a versioned JSON export (core/name-filter-logic.js buildNameExport). */
export async function exportFilters(guild) {
    return buildNameExport(await listFilters(guild.id), { guildId: guild.id, guildName: guild.name });
}

/**
 * Preview (apply = false) or carry out an import. Every entry goes through the same validation as /namefilter add.
 * @returns {Promise<{ ok:false, error:string } | { ok:true, add, duplicates, rejected, overCap, added?:number }>}
 */
export async function importFilters(guild, input, { apply = false } = {}, by = null) {
    const [rows] = await pool.execute(
        `SELECT pattern_type, pattern FROM automod_patterns WHERE guild_id = ? AND target = 'name' AND removed_at IS NULL`, [guild.id]);
    const c = await counts(guild.id);
    const room = Math.max(0, Math.min(MAX_MANUAL_FILTERS - c.manual, MAX_NAME_FILTERS - c.total));
    const plan = planNameImport(input, rows.map(r => ({ type: TYPE_OF_STORED[r.pattern_type] ?? r.pattern_type, pattern: r.pattern })), { room });
    if (!plan.ok || !apply) return plan;
    let added = 0;
    for (const f of plan.add) {
        try {
            await pool.execute(
                `INSERT INTO automod_patterns (guild_id, target, pattern_type, pattern, action, reason, enabled, created_by, case_sensitive, origin)
                 VALUES (?, 'name', ?, ?, ?, ?, ?, ?, ?, 'manual')`,
                [guild.id, STORED_TYPE[f.type], f.pattern, f.action, f.note, f.enabled ? 1 : 0, by, f.caseSensitive ? 1 : 0]);
            added++;
        } catch (err) {
            plan.rejected.push({ type: f.type, pattern: f.pattern, why: `not stored (${err.code || err.message})` });
        }
    }
    invalidate(guild.id);
    logger.info(`[NameFilters] import in ${guild.id} by ${by}: ${added} added, ${plan.duplicates.length} duplicates, ${plan.rejected.length} rejected, ${plan.overCap.length} over the limit`);
    changedLog(guild, '📥 Name Filters Imported', [['Added', String(added)], ['Skipped (already there)', plan.duplicates.length ? String(plan.duplicates.length) : null],
        ['Rejected', plan.rejected.length ? String(plan.rejected.length) : null], ['Over the limit', plan.overCap.length ? String(plan.overCap.length) : null], ['By', userLabel(by)]]);
    return { ...plan, added };
}

// Pending command previews, confirmed from buttons (interactions/buttons/name_filter.js).
const pending = new Map();
const PENDING_TTL = 15 * 60_000;

export function rememberPending(entry) {
    const token = Math.random().toString(36).slice(2, 10);
    pending.set(token, { ...entry, at: Date.now() });
    for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL) pending.delete(k);
    return token;
}

export function peekPending(token) {
    const entry = pending.get(token);
    return entry && Date.now() - entry.at <= PENDING_TTL ? entry : null;
}

export function takePending(token) {
    const entry = peekPending(token);
    pending.delete(token);
    return entry;
}

export { NAME_ACTIONS, NAME_FILTER_TYPES, TEMPLATE_PACKS };

export default {
    settingsFrom, getSettings, saveSettings, loadFilters, listFilters, addFilter, updateFilter, removeFilter, restoreFilter,
    syncTemplates, listTemplates, applyTemplate, removeTemplate, checkMember, checkNamesOnJoin, onMemberUpdate, onUserUpdate,
    servesGuild, allMembers, autoPilotCovers,
    testNames, previewFilter, actOnPreview, startCleanse, cleanseStatus, listReviews, reviewCounts, decideReviews, markSafe,
    unmarkSafe, recentHits, syncAutoPilot, scheduleAutoPilot, overview, rememberPending, peekPending, takePending, invalidate,
    exportFilters, importFilters,
    FLAG_ROLE_NAME,
};
