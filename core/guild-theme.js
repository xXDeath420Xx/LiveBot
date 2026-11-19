import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Per-guild embed theming.
 *
 * ## Why the lookup is synchronous
 *
 * Colours are set inside builder chains:
 *
 *     new EmbedBuilder().setColor('#57F287').setTitle(…)
 *
 * There is no await point there, and threading one in would mean restructuring
 * hundreds of call sites. So the whole theme table is held in memory — 82 guilds
 * × 6 colours is nothing — loaded once at boot and refreshed on write. That
 * makes `themeColor(guildId, 'success')` a Map lookup, which drops into an
 * existing chain with no other change.
 *
 * The trade-off is that a theme change is invisible until `invalidate()` runs.
 * Every write path here calls it, so the only way to miss one is to write to the
 * table directly.
 *
 * ## Why slots, not colours
 *
 * Call sites ask for `success`, never for `green`. That is what lets a guild
 * whose brand is red-on-black map success onto something that reads as success
 * in *their* palette. If call sites asked for colours, theming would be a
 * find-and-replace with extra steps.
 *
 * Defaults reproduce today's most-used literal for each slot exactly, so a guild
 * with no theme row renders precisely as it does now. Theming is opt-in and
 * invisible until used.
 */

/** Slot -> the literal that call sites most commonly used before theming. */
export const DEFAULT_THEME = Object.freeze({
    primary: '#5865F2',
    success: '#57F287',
    danger: '#ED4245',
    warning: '#FFD700',
    info: '#3498DB',
    accent: '#9B59B6',
});

export const THEME_SLOTS = Object.freeze(Object.keys(DEFAULT_THEME));

/** guild_id -> { primary, success, … } (only slots the guild actually set). */
const cache = new Map();
let loaded = false;

const COLUMN_FOR = {
    primary: 'primary_color',
    success: 'success_color',
    danger: 'danger_color',
    warning: 'warning_color',
    info: 'info_color',
    accent: 'accent_color',
};

/**
 * Load every theme into memory. Called once during manager init.
 *
 * Deliberately swallows failure: an unreachable theme table must not stop the
 * bot from rendering embeds. Everything falls back to DEFAULT_THEME, which is
 * exactly the palette that shipped before this existed.
 */
export async function loadThemes() {
    try {
        const [rows] = await pool.execute('SELECT * FROM guild_theme WHERE enabled = 1');
        cache.clear();
        for (const row of rows) cache.set(row.guild_id, rowToTheme(row));
        loaded = true;
        logger.info(`[GuildTheme] Loaded ${cache.size} guild theme(s)`);
    } catch (error) {
        logger.warn(`[GuildTheme] Could not load themes, using defaults everywhere: ${error.message}`);
        loaded = true;
    }
}

function rowToTheme(row) {
    const theme = {};
    for (const [slot, column] of Object.entries(COLUMN_FOR)) {
        if (row[column]) theme[slot] = row[column];
    }
    if (row.footer_text) theme.footerText = row.footer_text;
    if (row.footer_icon_url) theme.footerIconUrl = row.footer_icon_url;
    if (row.thumbnail_url) theme.thumbnailUrl = row.thumbnail_url;
    return theme;
}

/**
 * The colour for a slot in a guild. Synchronous.
 *
 * @param {string|null} guildId  Null/undefined (DMs) yields the default.
 * @param {string} slot          One of THEME_SLOTS.
 * @returns {string} Hex colour, always valid.
 */
export function themeColor(guildId, slot = 'primary') {
    const fallback = DEFAULT_THEME[slot] ?? DEFAULT_THEME.primary;
    if (!guildId || !loaded) return fallback;
    return cache.get(guildId)?.[slot] ?? fallback;
}

/** Branding extras for a guild, or an empty object. */
export function themeBranding(guildId) {
    if (!guildId || !loaded) return {};
    const theme = cache.get(guildId);
    if (!theme) return {};
    return {
        footerText: theme.footerText,
        footerIconUrl: theme.footerIconUrl,
        thumbnailUrl: theme.thumbnailUrl,
    };
}

/**
 * A themed EmbedBuilder, pre-coloured and pre-branded.
 *
 * The preferred entry point for new code — it applies the guild's footer and
 * thumbnail too, which `setColor(themeColor(...))` alone does not.
 *
 * Accepts an interaction, message, or guild so callers can pass whatever they
 * already hold instead of digging out an id.
 *
 * @param {object|string|null} source  Interaction, Message, Guild, or guild id.
 * @param {string} [slot='primary']
 */
export function themedEmbed(source, slot = 'primary') {
    const guildId = resolveGuildId(source);
    const embed = new EmbedBuilder().setColor(themeColor(guildId, slot));

    const { footerText, footerIconUrl } = themeBranding(guildId);
    if (footerText) {
        embed.setFooter({ text: footerText, ...(footerIconUrl ? { iconURL: footerIconUrl } : {}) });
    }
    return embed;
}

/**
 * H-719: the Embed theme page's footer on the bot's replies. Each embed in `options` that is coloured by the
 * theme (its colour is one of the guild's six slots, set or default) and has no footer of its own gets the
 * guild's footer text and icon. Anything else, and every reply in a guild with no footer text, is returned
 * as it was. The caller's embeds are copied, never changed.
 */
export function applyThemeFooter(guildId, options) {
    const { footerText, footerIconUrl } = themeBranding(guildId);
    if (!footerText || !options || typeof options !== 'object' || !Array.isArray(options.embeds) || !options.embeds.length) return options;
    const palette = new Set(THEME_SLOTS.map((slot) => parseInt(themeColor(guildId, slot).slice(1), 16)));
    let changed = false;
    const embeds = options.embeds.map((e) => {
        const data = e?.data && typeof e.toJSON === 'function' ? e.data : e;
        if (!data || data.footer?.text || data.color == null || !palette.has(Number(data.color))) return e;
        changed = true;
        return EmbedBuilder.from(e).setFooter({ text: footerText, ...(footerIconUrl ? { iconURL: footerIconUrl } : {}) });
    });
    return changed ? { ...options, embeds } : options;
}

/**
 * Put applyThemeFooter in front of a command's replies (a slash interaction, or the text-command adapter):
 * reply, editReply and followUp. Does nothing in a guild without footer text. Called once per command, before
 * it runs (events/interactionCreate.js, core/universal-commands.js).
 */
export function themeReplies(interaction) {
    const guildId = interaction?.guildId;
    if (!guildId || interaction._themeReplies || !themeBranding(guildId).footerText) return false;
    interaction._themeReplies = true;
    for (const method of ['reply', 'editReply', 'followUp']) {
        const original = interaction[method]?.bind(interaction);
        if (original) interaction[method] = (options) => original(applyThemeFooter(guildId, options));
    }
    return true;
}

function resolveGuildId(source) {
    if (!source) return null;
    if (typeof source === 'string') return source;
    return source.guildId ?? source.guild?.id ?? source.id ?? null;
}

/** Read a guild's stored theme, merged over the defaults. Async — for config UIs. */
export async function getTheme(guildId) {
    try {
        const [rows] = await pool.execute('SELECT * FROM guild_theme WHERE guild_id = ?', [guildId]);
        const stored = rows[0] ? rowToTheme(rows[0]) : {};
        return {
            ...DEFAULT_THEME,
            ...stored,
            enabled: rows[0] ? Boolean(rows[0].enabled) : true,
            isCustomized: Object.keys(stored).length > 0,
        };
    } catch (error) {
        logger.error(`[GuildTheme] getTheme failed for ${guildId}: ${error.message}`);
        return { ...DEFAULT_THEME, enabled: true, isCustomized: false };
    }
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * Write a guild's theme.
 *
 * @param {string} guildId
 * @param {object} updates   Slot names and/or footerText/footerIconUrl/thumbnailUrl.
 *                           An explicit null clears that slot back to the default.
 * @param {string} [updatedBy]
 */
export async function setTheme(guildId, updates, updatedBy = null) {
    const columns = [];
    const values = [];

    for (const [slot, column] of Object.entries(COLUMN_FOR)) {
        if (!(slot in updates)) continue;
        const value = updates[slot];
        if (value !== null && !HEX.test(String(value))) {
            throw new Error(`${slot} must be a hex colour like #5865F2 (got ${JSON.stringify(value)})`);
        }
        columns.push(column);
        values.push(value === null ? null : String(value).toUpperCase());
    }

    for (const [key, column] of [['footerText', 'footer_text'], ['footerIconUrl', 'footer_icon_url'], ['thumbnailUrl', 'thumbnail_url']]) {
        if (!(key in updates)) continue;
        columns.push(column);
        values.push(updates[key] || null);
    }

    if ('enabled' in updates) {
        columns.push('enabled');
        values.push(updates.enabled ? 1 : 0);
    }

    if (!columns.length) return getTheme(guildId);

    const insertCols = ['guild_id', ...columns, 'updated_by'];
    const placeholders = insertCols.map(() => '?').join(', ');
    const updateClause = [...columns, 'updated_by'].map((c) => `${c} = VALUES(${c})`).join(', ');

    await pool.execute(
        `INSERT INTO guild_theme (${insertCols.join(', ')}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updateClause}`,
        [guildId, ...values, updatedBy]
    );

    await invalidate(guildId);
    return getTheme(guildId);
}

/** Drop a guild's theme entirely, returning it to the network defaults. */
export async function resetTheme(guildId) {
    await pool.execute('DELETE FROM guild_theme WHERE guild_id = ?', [guildId]);
    await invalidate(guildId);
}

/**
 * Re-read one guild from the database into the cache.
 *
 * Every write path here calls this. It exists as a named export because the
 * dashboard and the slash command both write, and a stale cache would make a
 * saved theme look like it silently failed.
 */
export async function invalidate(guildId) {
    try {
        const [rows] = await pool.execute('SELECT * FROM guild_theme WHERE guild_id = ? AND enabled = 1', [guildId]);
        if (rows[0]) cache.set(guildId, rowToTheme(rows[0]));
        else cache.delete(guildId);
    } catch (error) {
        logger.warn(`[GuildTheme] invalidate(${guildId}) failed: ${error.message}`);
    }
}

export default {
    loadThemes,
    themeColor,
    themedEmbed,
    themeBranding,
    applyThemeFooter,
    themeReplies,
    getTheme,
    setTheme,
    resetTheme,
    invalidate,
    DEFAULT_THEME,
    THEME_SLOTS,
};
