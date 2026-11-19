/**
 * Generic feature-configuration API.
 *
 * One router for every feature declared in core/feature-config-spec.js, rather than one router
 * per feature. Field names are validated against the spec before they reach SQL, and column
 * names in table-backed features come from the spec too — never from the request body.
 */

import express from 'express';
import { ChannelType } from 'discord.js';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { FEATURE_SPECS, getSpec } from '../../../../core/feature-config-spec.js';
import { getConfig, setConfig } from '../../../../core/feature-config.js';
import { getVoiceInfo, getVoiceOptions } from '../../../../utils/piper-tts.js';
import { parseDays, normaliseTime, isValidTimeZone } from '../../../../core/qotd-poster.js';
import { MOUNTS } from '../../../../core/command-mounts.js';

const router = express.Router({ mergeParams: true });

/** GET /api/guilds/:guildId/feature-config — every feature's spec and current values. */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const out = {};
        for (const key of Object.keys(FEATURE_SPECS)) {
            out[key] = {
                spec: publicSpec(key),
                config: forPage(key, await getConfig(key, guildId)),
            };
        }
        res.json({ success: true, features: out });
    } catch (error) {
        logger.error('[API FeatureConfig GET all] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to load feature configuration' });
    }
});

/** GET /api/guilds/:guildId/feature-config/:feature */
router.get('/:feature', async (req, res) => {
    try {
        const { guildId, feature } = req.params;
        const spec = getSpec(feature);
        if (!spec) return res.status(404).json({ error: `Unknown feature "${feature}"` });

        const client = global.botManager?.getClientForGuild?.(guildId) || req.app?.locals?.client || null;
        const payload = {
            success: true,
            spec: { ...publicSpec(feature), commandInfo: describeCommands(getSpec(feature).commands || [], client) },
            config: forPage(feature, await getConfig(feature, guildId)),
        };

        // Context menus have no setup command — the menus are defined in code, so the guild's
        // rows are created on demand here. Opening the page is exactly when the list needs to
        // exist, and doing it lazily means a newly added menu appears without a migration.
        if (feature === 'context-menus') {
            await ensureContextMenuRows(guildId).catch(err => {
                logger.warn(`[API FeatureConfig] Could not seed context menu rows: ${err.message}`);
            });
        }

        // Some features also own a list of rows (watchers, channels, reports) that the settings
        // form cannot express. Ship it alongside so the page renders in one round trip.
        if (spec.list) {
            payload.rows = await loadList(spec.list, guildId);
        }

        res.json(payload);
    } catch (error) {
        logger.error('[API FeatureConfig GET] Error:', { error: error.message, feature: req.params.feature });
        res.status(500).json({ error: 'Failed to load feature configuration' });
    }
});

/** PUT /api/guilds/:guildId/feature-config/:feature */
router.put('/:feature', async (req, res) => {
    try {
        const { guildId, feature } = req.params;
        const spec = getSpec(feature);
        if (!spec) return res.status(404).json({ error: `Unknown feature "${feature}"` });

        const patch = {};
        const rejected = [];
        let current = null;

        for (const field of spec.fields) {
            if (!(field.key in (req.body || {}))) continue;
            let coerced = coerce(field, req.body[field.key]);
            // A voice that is no longer installed may still be re-saved unchanged (the page offers
            // it as "Current: ..."), so saving other settings never changes or blocks it.
            if (coerced === undefined && field.type === 'voice') {
                current ??= await getConfig(feature, guildId);
                if (String(current?.[field.key] ?? '') === String(req.body[field.key])) coerced = current[field.key];
            }
            if (coerced === undefined) { rejected.push(field.label); continue; }
            // Channel fields: each channel must be in this server and of the field's channelKind
            // (ChannelType), checked when the bot can see the server. A channel already saved may be
            // re-saved unchanged.
            if ((field.type === 'channel' || field.type === 'channels') && coerced !== null) {
                const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId);
                if (guild) {
                    current ??= await getConfig(feature, guildId);
                    const saved = new Set(channelIdList(current?.[field.key]));
                    const bad = channelIdList(coerced).find(id => !saved.has(id) && !channelFitsKind(guild.channels.cache.get(id), field.channelKind));
                    if (bad) { rejected.push(field.label); continue; }
                }
            }
            patch[field.key] = coerced;
        }

        if (rejected.length) {
            return res.status(400).json({ error: `Invalid value for: ${rejected.join(', ')}` });
        }
        if (!Object.keys(patch).length) {
            return res.status(400).json({ error: 'No recognised settings in request' });
        }

        const before = AFTER_SAVE[feature] ? await getConfig(feature, guildId) : null;
        const config = await setConfig(feature, guildId, patch, req.user?.id || null);
        let extra = '';
        if (AFTER_SAVE[feature]) {
            extra = await AFTER_SAVE[feature](guildId, before, config).catch((err) => {
                logger.warn(`[API FeatureConfig] After-save step for ${feature} failed: ${err.message}`);
                return '';
            });
        }
        res.json({ success: true, message: extra ? `${spec.label} updated.${extra}` : `${spec.label} updated`, config: forPage(feature, config) });
    } catch (error) {
        logger.error('[API FeatureConfig PUT] Error:', { error: error.message, feature: req.params.feature });
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

/**
 * Work a save must trigger in the bot, by feature. Each returns text appended to the save message.
 *   (guildId, before, after) -> Promise<string>
 */
const AFTER_SAVE = {
    // Staff contact: "Contact panel channel" is where the bot posts (and keeps) the contact panel.
    'staff-contact': async (guildId, before, after) => {
        const prev = before?.contact_channel_id ? String(before.contact_channel_id) : null;
        const next = after?.contact_channel_id ? String(after.contact_channel_id) : null;
        const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId);
        if (!guild) return next ? ' The bot is not available right now, so the contact panel will be posted the next time you save.' : '';
        const { syncStaffContactPanel, describePanelSync } = await import('../../../../core/staff-contact-panel.js');
        return describePanelSync(await syncStaffContactPanel(guild, { previousChannelId: prev !== next ? prev : null }));
    },
    // Orientation: a new guide channel moves the guide message there; an empty one removes it.
    orientation: async (guildId, before, after) => {
        const prev = before?.channel_id ? String(before.channel_id) : null;
        const next = after?.channel_id ? String(after.channel_id) : null;
        if (prev === next) return '';
        const client = global.botManager?.getClientForGuild?.(guildId) || null;
        const { moveOrientationMessage, describeOrientationMove } = await import('../../../../core/orientation-manager.js');
        return describeOrientationMove(await moveOrientationMessage(client, guildId,
            { fromChannelId: prev, messageId: before?.message_id ? String(before.message_id) : null, toChannelId: next }));
    },
};

/**
 * Features whose list rows are edited from the page. Each editor owns validation and the write,
 * and is shared with the feature's own slash command so both paths enforce the same rules.
 *   update(guildId, rowKey, patch) -> { ok, row } | { ok: false, error }
 *   create(guildId, rowKey)        -> { ok, created, row } | { ok: false, error }
 *   checkTarget(guildId, rowKey)   -> null when the new row's target is usable, else an error string
 */
const LIST_EDITORS = {
    // H-703: per-menu switch and role limit, keyed by menu name (core/context-menu-config.js).
    'context-menus': {
        rowId: /^[\p{L}\p{N} _'.-]{1,100}$/u,
        async update(guildId, menuName, patch) {
            const m = await import('../../../../core/context-menu-config.js');
            return m.updateMenu(guildId, menuName, patch);
        },
    },
    qotd: {
        async update(guildId, id, patch) {
            const m = await import('../../../../core/qotd-poster.js');
            return m.updateChannelSchedule(guildId, id, patch);
        },
        async create(guildId, id) {
            const m = await import('../../../../core/qotd-poster.js');
            return m.createChannel(guildId, id);
        },
        async checkTarget(guildId, id) {
            const { resolveBotForGuild } = await import('../../../../utils/bot-resolver.js');
            const bot = await resolveBotForGuild(guildId, { db: pool });
            const ch = await bot.rest(`/channels/${id}`).catch(() => null);
            if (!ch || String(ch.guild_id) !== String(guildId)) return 'The bot cannot see that channel.';
            if (ch.type !== 0 && ch.type !== 5) return 'Pick a text or announcement channel.';
            return null;
        },
    },
};

/** A channel / channels value (id, JSON array text or array) as a list of ids. */
function channelIdList(value) {
    if (value === null || value === undefined || value === '') return [];
    if (Array.isArray(value)) return value.map(String);
    const text = String(value);
    if (text.startsWith('[')) {
        try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
    }
    return [text];
}

/**
 * Whether a channel suits a spec field's channelKind, by ChannelType (the same rule the page's pickers
 * use): 'text' = text or announcement, 'voice' = voice or stage, 'category' = category, none = any of those.
 */
function channelFitsKind(channel, kind) {
    if (!channel) return false;
    const text = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
    const voice = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
    if (kind === 'text') return text.includes(channel.type);
    if (kind === 'voice') return voice.includes(channel.type);
    if (kind === 'category') return channel.type === ChannelType.GuildCategory;
    return text.includes(channel.type) || voice.includes(channel.type);
}

/** The spec field list for a row editor, plus coerced values for whatever the body sent. */
function coerceRow(spec, body) {
    const patch = {};
    const rejected = [];
    for (const field of spec.list.edit) {
        if (!(field.key in (body || {}))) continue;
        const v = coerce(field, body[field.key]);
        if (v === undefined) { rejected.push(field.label); continue; }
        // The editors take arrays for role lists; coerce() returns the stored JSON text.
        patch[field.key] = field.type === 'roles' ? JSON.parse(v) : v;
    }
    return { patch, rejected };
}

/** PUT /api/guilds/:guildId/feature-config/:feature/rows/:rowId — change one row. */
router.put('/:feature/rows/:rowId', async (req, res) => {
    try {
        const { guildId, feature, rowId } = req.params;
        const spec = getSpec(feature);
        const editor = spec?.list?.editor && LIST_EDITORS[spec.list.editor];
        if (!editor) return res.status(404).json({ error: 'This list cannot be edited here' });
        if (!(editor.rowId || /^\d{15,25}$/).test(rowId)) return res.status(400).json({ error: 'Bad row id' });

        const { patch, rejected } = coerceRow(spec, req.body);
        if (rejected.length) return res.status(400).json({ error: `Invalid value for: ${rejected.join(', ')}` });
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });

        const result = await editor.update(guildId, rowId, patch);
        if (!result.ok) return res.status(400).json({ error: result.error });
        const rows = await loadList(spec.list, guildId);
        res.json({ success: true, message: 'Saved', row: rows.find(r => String(r[spec.list.key]) === rowId) || null });
    } catch (error) {
        logger.error('[API FeatureConfig row PUT] Error:', { error: error.message, feature: req.params.feature });
        res.status(500).json({ error: 'Failed to save' });
    }
});

/** POST /api/guilds/:guildId/feature-config/:feature/rows — add a row ({ id }). */
router.post('/:feature/rows', async (req, res) => {
    try {
        const { guildId, feature } = req.params;
        const spec = getSpec(feature);
        const editor = spec?.list?.editor && LIST_EDITORS[spec.list.editor];
        if (!editor?.create || spec.list.canAdd === false) return res.status(404).json({ error: 'Rows cannot be added here' });
        const id = String(req.body?.id || '');
        if (!/^\d{15,25}$/.test(id)) return res.status(400).json({ error: 'Pick a channel first' });

        const problem = await editor.checkTarget(guildId, id);
        if (problem) return res.status(400).json({ error: problem });
        const result = await editor.create(guildId, id);
        if (!result.ok) return res.status(400).json({ error: result.error });
        const rows = await loadList(spec.list, guildId);
        res.json({
            success: true,
            message: result.created ? 'Added' : 'Already set up — turned back on',
            row: rows.find(r => String(r[spec.list.key]) === id) || null,
        });
    } catch (error) {
        logger.error('[API FeatureConfig row POST] Error:', { error: error.message, feature: req.params.feature });
        res.status(500).json({ error: 'Failed to add' });
    }
});

/**
 * Coerce and validate one field. Returns `undefined` for a value that fails validation, which
 * the caller turns into a 400 — silently storing a clamped or empty value would leave the page
 * showing something the user did not choose.
 */
function coerce(field, raw) {
    switch (field.type) {
        case 'toggle':
            return raw ? 1 : 0;

        case 'number': {
            if (raw === '' || raw === null) return null;
            const n = Number(raw);
            if (!Number.isFinite(n)) return undefined;
            if (field.min !== undefined && n < field.min) return undefined;
            if (field.max !== undefined && n > field.max) return undefined;
            // `scale`: the page shows the stored value times scale (a 0.05 chance as 5 %); store it back.
            return field.scale ? Math.trunc(n) / field.scale : Math.trunc(n);
        }

        case 'select':
            if (raw === '' || raw === null) return null;
            return field.options?.some(o => o.value === raw) ? raw : undefined;

        case 'color': {
            if (!raw) return null;
            return /^#?[0-9a-f]{6}$/i.test(String(raw)) ? String(raw).replace(/^#?/, '#') : undefined;
        }

        case 'channel':
        case 'role': {
            if (!raw) return null;
            return /^\d{15,25}$/.test(String(raw)) ? String(raw) : undefined;
        }

        case 'channels':
        case 'roles': {
            const list = Array.isArray(raw)
                ? raw
                : String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
            if (list.some(id => !/^\d{15,25}$/.test(String(id)))) return undefined;
            // Stored as JSON so it round-trips as an array regardless of backing store.
            return JSON.stringify(list.map(String));
        }

        case 'voice': {
            // A Piper voice with a model on disk, or a Kokoro voice while Kokoro is installed.
            if (raw === '' || raw === null || raw === undefined) return null;
            const id = String(raw);
            const info = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? getVoiceInfo(id) : null;
            return info && info.installed !== false ? id : undefined;
        }

        case 'days': {
            // Weekdays as full lowercase names in week order, stored as a JSON array.
            const days = parseDays(raw);
            if (raw && (Array.isArray(raw) ? raw.length : String(raw).trim()) && !days.length) return undefined;
            return days.length ? JSON.stringify(days) : null;
        }

        case 'time':
            if (raw === '' || raw === null || raw === undefined) return null;
            return normaliseTime(raw)?.slice(0, 5) ?? undefined;

        case 'timezone':
            if (raw === '' || raw === null || raw === undefined) return null;
            return isValidTimeZone(String(raw)) ? String(raw) : undefined;

        case 'text':
        case 'multiline':
        case 'message':
            // The same limits the page sets as maxlength. 'message' is text the bot posts, so
            // Discord's 2000-character message limit unless the spec gives a lower maxLength.
            if (raw === null || raw === undefined) return null;
            // `json: true`: the text must be JSON (an object or array) or empty. The runtime ignores anything else
            // without a word, so refusing it here is the only way the admin finds out.
            if (field.json && String(raw).trim() && !isJsonObjectText(String(raw))) return undefined;
            return String(raw).slice(0, field.maxLength || (field.type === 'message' ? 2000 : field.type === 'multiline' ? 4000 : 500));

        default:
            return undefined;
    }
}

/** True when `text` parses as a JSON object or array (heat thresholds are stored in either form), not a plain value. */
export function isJsonObjectText(text) {
    try {
        const v = JSON.parse(text);
        return !!v && typeof v === 'object';
    } catch {
        return false;
    }
}

/**
 * A config as the page shows it: number fields with a `scale` multiplied into page units (a stored
 * 0.05 chance becomes 5 %). coerce() divides them back on save.
 */
export function forPage(key, config) {
    const spec = FEATURE_SPECS[key];
    if (!spec || !config) return config;
    let out = config;
    for (const f of spec.fields) {
        if (f.type !== 'number' || !f.scale || config[f.key] === null || config[f.key] === undefined || config[f.key] === '') continue;
        const n = Number(config[f.key]);
        if (!Number.isFinite(n)) continue;
        if (out === config) out = { ...config };
        out[f.key] = Math.round(n * f.scale * 1000) / 1000;
    }
    return out;
}

/** The spec minus anything the browser has no business knowing (table and column names). */
function publicSpec(key) {
    const s = FEATURE_SPECS[key];
    return {
        key,
        label: s.label,
        icon: s.icon,
        iconPack: s.iconPack || 'fas',
        colour: s.colour,
        blurb: s.blurb,
        commands: s.commands || [],
        category: s.category || null,
        note: s.note || null,
        // Present only when nothing in the runtime reads this feature's table. The page turns
        // it into a banner rather than silently offering controls that do nothing.
        unwired: s.unwired || null,
        fields: s.fields.map(f => ({ ...f, wired: f.wired !== false })),
        // Optional section order and descriptions; fields name their section with `group`.
        groups: Array.isArray(s.groups) ? s.groups : null,
        // The voice picker's options (Piper groups first, then Kokoro), only for specs that have one.
        voices: s.fields.some(f => f.type === 'voice') ? getVoiceOptions() : undefined,
        hasList: !!s.list,
        listTitle: s.list?.title || null,
        listLabels: s.list?.labels || null,
        // Rows that are edited in place (see LIST_EDITORS). Field keys double as the row's column names.
        listKey: s.list?.editor ? s.list.key : null,
        listEdit: s.list?.editor ? s.list.edit : null,
        listAddLabel: s.list?.editor && s.list.canAdd !== false ? (s.list.addLabel || 'Add') : null,
        // How the editable rows are worded: ['channel', 'channels'], the Save button, and the line under each name.
        listNoun: s.list?.editor ? (s.list.noun || ['channel', 'channels']) : null,
        listSaveLabel: s.list?.editor ? (s.list.saveLabel || 'Save channel') : null,
        listMeta: s.list?.editor ? (s.list.meta || null) : null,
    };
}

/**
 * The spec's command paths ('/voice reader enable', '/fun owoify') with the description the bot
 * registers for them and the key their settings are saved under on the Commands page ('voice:reader',
 * 'owoify'): command-restrictions keys a subcommand group or a plain subcommand as 'command:name',
 * and a command moved under another (core/command-mounts.js) by its own name. A path the bot does
 * not have keeps a null key and description, so the page still lists it.
 */
function describeCommands(paths, client) {
    const commands = client?.commands;
    return paths.map((path) => {
        const words = String(path).trim().replace(/^\//, '').split(/\s+/).filter(Boolean);
        const out = { path: String(path), description: null, key: null };
        if (!words.length || !commands?.get) return out;
        let base = words[0];
        let rest = words.slice(1);
        if (words.length >= 2) {
            const moved = Object.entries(MOUNTS).find(([child, m]) => !m.drop && m.parent === words[0] && (m.as ?? child) === words[1]);
            if (moved) { base = moved[0]; rest = words.slice(2); }
        }
        const cmd = commands.get(base);
        if (!cmd) return out;
        let json = null;
        try { json = cmd.data?.toJSON?.() || null; } catch { json = null; }
        out.key = base;
        out.description = json?.description || null;
        if (rest.length) {
            const opt = (json?.options || []).find((o) => o.name === rest[0] && (o.type === 1 || o.type === 2));
            if (!opt) return out;
            out.key = `${base}:${rest[0]}`;
            out.description = opt.description || out.description;
            if (rest[1] && opt.type === 2) {
                const sub = (opt.options || []).find((o) => o.name === rest[1] && o.type === 1);
                if (sub?.description) out.description = sub.description;
            }
        }
        return out;
    });
}

/**
 * Seed context_menu_config from the context-menu commands that actually exist on disk, so the
 * page lists the real set rather than whatever a guild happened to have rows for.
 */
async function ensureContextMenuRows(guildId) {
    const { readdirSync, existsSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../commands/context');
    if (!existsSync(dir)) return;

    const menus = [];
    for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
        try {
            const mod = await import(`file://${join(dir, file)}`);
            const json = mod.default?.data?.toJSON?.();
            if (!json?.name) continue;
            // ApplicationCommandType: 2 = User, 3 = Message.
            menus.push({ name: json.name, type: json.type === 2 ? 'user' : 'message' });
        } catch { /* a broken menu file should not break the page */ }
    }

    const { ensureRows } = await import('../../../../core/context-menu-config.js');
    await ensureRows(guildId, menus);
}

async function loadList(listSpec, guildId) {
    try {
        const names = listSpec.editor
            ? [...new Set([listSpec.key, ...listSpec.columns, ...listSpec.edit.map(f => f.key)])]
            : listSpec.columns;
        const cols = names.map(c => `\`${c}\``).join(', ');
        const [rows] = await pool.execute(
            `SELECT ${cols} FROM \`${listSpec.table}\` WHERE guild_id = ? ORDER BY 1 DESC LIMIT 100`,
            [guildId]
        );
        return rows;
    } catch (err) {
        // A missing table is not fatal — the settings form is still useful without the list.
        logger.warn(`[API FeatureConfig] Could not load list from ${listSpec.table}: ${err.message}`);
        return [];
    }
}

export default router;
