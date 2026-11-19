/**
 * Leveling settings: the rules core/leveling-manager.js applies (no-XP lists, boosts, which
 * level-ups are announced and where, reward-role stacking) and the dashboard form save
 * (POST /manage/:guildId/update-leveling, dashboard/views/partials/manage/leveling.ejs).
 *
 * level_config columns added by migrations/418_leveling_announce_rewards_boosts.js:
 * level_up_mode, announce_every_n, announce_min_level, announce_rewards_only, reward_mode,
 * remove_reward_on_loss, xp_boost_roles, xp_boost_channels. Until that migration has run the
 * save keeps working for every older column and logs a warning for the new ones.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

export const SNOWFLAKE = /^\d{15,25}$/;
export const LEVEL_UP_MODES = ['channel', 'dm', 'off'];
export const REWARD_MODES = ['stack', 'replace'];
export const BOOST_MIN = 0.25;
export const BOOST_MAX = 5;
export const MAX_BOOSTS = 25;
// Seconds between a member's XP-earning messages. One range for /level setup, the dashboard page,
// the dashboard API and the save (register H-672: they were 1-300, 10-300 and 0-600).
export const XP_COOLDOWN_MIN = 10;
export const XP_COOLDOWN_MAX = 300;
export const XP_COOLDOWN_DEFAULT = 60;
export const MESSAGE_MAX = 1500;
export const DEFAULT_LEVEL_UP_MESSAGE = 'Congrats {user}! You reached **Level {level}**!';

const NEW_COLUMNS = [
    'level_up_mode', 'announce_every_n', 'announce_min_level', 'announce_rewards_only',
    'reward_mode', 'remove_reward_on_loss', 'xp_boost_roles', 'xp_boost_channels',
];

const clampInt = (v, min, max, dflt) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const clampNum = (v, min, max, dflt) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n)) * 100) / 100 : dflt;
};
const asArray = (v) => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]));
const on = (v) => v === true || v === 1 || v === '1' || v === 'on' || v === 'true';

/** A JSON column (string, already-parsed array, or NULL) as an array. */
export function parseJsonList(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** Unique snowflake strings from a JSON column or a list. */
export function parseIdList(value) {
    return [...new Set(parseJsonList(value).map(String).filter((id) => SNOWFLAKE.test(id)))];
}

/** [{ id, multiplier }] from a JSON column or a list: valid ids, clamped multipliers, one per id. */
export function parseBoostList(value) {
    const byId = new Map();
    for (const entry of parseJsonList(value)) {
        const id = String(entry?.id ?? '');
        const multiplier = clampNum(entry?.multiplier, BOOST_MIN, BOOST_MAX, NaN);
        if (SNOWFLAKE.test(id) && Number.isFinite(multiplier)) byId.set(id, { id, multiplier });
    }
    return [...byId.values()].slice(0, MAX_BOOSTS);
}

/**
 * Where XP is being earned: the member's role ids and the channel ids that apply (the channel, its
 * parent channel for a thread, and the category above that).
 */
export function xpScope(member, channel) {
    const roleIds = member?.roles?.cache ? [...member.roles.cache.keys()] : [];
    const channelIds = [];
    if (channel) {
        channelIds.push(channel.id);
        if (channel.parentId) channelIds.push(channel.parentId);
        const grand = channel.parent?.parentId;
        if (grand) channelIds.push(grand);
    }
    return { roleIds, channelIds };
}

/** True when a no-XP channel or a no-XP role applies. */
export function isNoXp(config, { roleIds = [], channelIds = [] } = {}) {
    const channels = new Set(parseIdList(config?.ignored_channels));
    if (channelIds.some((id) => channels.has(id))) return true;
    const roles = new Set(parseIdList(config?.ignored_roles));
    return roleIds.some((id) => roles.has(id));
}

/**
 * Boost from boosted roles (the highest one the member holds) times the boost of the first boosted
 * channel in channelIds (the channel itself before its parent). 1 when nothing applies.
 */
export function boostMultiplier(config, { roleIds = [], channelIds = [] } = {}) {
    const held = new Set(roleIds);
    const roleBoosts = parseBoostList(config?.xp_boost_roles).filter((b) => held.has(b.id)).map((b) => b.multiplier);
    const roleMult = roleBoosts.length ? Math.max(...roleBoosts) : 1;
    const channelBoosts = new Map(parseBoostList(config?.xp_boost_channels).map((b) => [b.id, b.multiplier]));
    const hit = channelIds.find((id) => channelBoosts.has(id));
    const channelMult = hit ? channelBoosts.get(hit) : 1;
    return roleMult * channelMult;
}

export function levelUpMode(config) {
    const mode = String(config?.level_up_mode || 'channel');
    return LEVEL_UP_MODES.includes(mode) ? mode : 'channel';
}

/**
 * Whether a level-up to newLevel is announced. hasReward: a role reward sits on a level just crossed.
 * Off -> never. Below the minimum level -> no. "Rewards only" -> only reward levels. Otherwise every
 * Nth level, and reward levels always.
 */
export function shouldAnnounce(config, newLevel, hasReward) {
    if (levelUpMode(config) === 'off') return false;
    const min = clampInt(config?.announce_min_level, 0, 1000, 0);
    if (newLevel < min) return false;
    if (on(config?.announce_rewards_only)) return !!hasReward;
    const every = clampInt(config?.announce_every_n, 1, 100, 1);
    return every === 1 || newLevel % every === 0 || !!hasReward;
}

/** The level-up template with {user} {username} {level} {server} filled in (every occurrence). */
export function renderLevelUpMessage(template, { userId, username, level, serverName }) {
    const text = String(template || '').trim() || DEFAULT_LEVEL_UP_MESSAGE;
    return text
        .replaceAll('{user}', () => `<@${userId}>`)
        .replaceAll('{username}', () => String(username ?? ''))
        .replaceAll('{level}', () => String(level))
        .replaceAll('{server}', () => String(serverName ?? ''))
        .slice(0, 4000);
}

/**
 * Which reward roles to add and remove for a member at `level`.
 *   rewards      [{ level, role_id }]
 *   fromLevel    the level before a level-up: only rewards above it are granted, and nothing changes
 *                unless one was crossed. null = a full sync (dashboard XP edits).
 *   mode         'stack' keeps every reward earned; 'replace' keeps only the highest.
 *   removeOnLoss take back rewards above the member's level (full sync only in stack mode; in
 *                replace mode a higher reward they still hold is otherwise kept as "the highest").
 *   heldRoleIds  the roles the member has now.
 */
export function rewardRolePlan(rewards, { level, fromLevel = null, mode = 'stack', removeOnLoss = false, heldRoleIds = new Set() }) {
    const held = (id) => heldRoleIds.has(id);
    const sorted = (rewards || [])
        .map((r) => ({ level: Number(r.level), roleId: String(r.role_id) }))
        .filter((r) => Number.isFinite(r.level) && SNOWFLAKE.test(r.roleId))
        .sort((a, b) => a.level - b.level);
    const earned = sorted.filter((r) => r.level <= level);
    const unearned = sorted.filter((r) => r.level > level);
    const add = new Set();
    const remove = new Set();

    if (fromLevel !== null && !earned.some((r) => r.level > fromLevel)) return { add: [], remove: [] };

    if (mode === 'replace') {
        let keep = earned.length ? earned[earned.length - 1] : null;
        if (!removeOnLoss) {
            const heldHigher = unearned.filter((r) => held(r.roleId));
            if (heldHigher.length) keep = heldHigher[heldHigher.length - 1];
        }
        if (keep && !held(keep.roleId)) add.add(keep.roleId);
        for (const r of sorted) if (r.roleId !== keep?.roleId && held(r.roleId)) remove.add(r.roleId);
    } else {
        const earnedIds = new Set(earned.map((r) => r.roleId));
        for (const r of earned) {
            if ((fromLevel === null || r.level > fromLevel) && !held(r.roleId)) add.add(r.roleId);
        }
        if (removeOnLoss && fromLevel === null) {
            for (const r of unearned) if (held(r.roleId) && !earnedIds.has(r.roleId)) remove.add(r.roleId);
        }
    }
    for (const id of add) remove.delete(id);
    return { add: [...add], remove: [...remove] };
}

/** The guild on whichever bot client has it, or null (then ids are checked by shape only). */
function guildFor(guildId) {
    return global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId) ?? null;
}

/** Boost rows posted as parallel lists (<select name=idField> + <input name=multField>). */
function boostRowsFromForm(ids, mults, owns) {
    const idList = asArray(ids);
    const multList = asArray(mults);
    const rows = [];
    idList.forEach((id, i) => {
        id = String(id || '').trim();
        if (!SNOWFLAKE.test(id) || !owns(id)) return;
        const multiplier = clampNum(multList[i], BOOST_MIN, BOOST_MAX, NaN);
        if (Number.isFinite(multiplier)) rows.push({ id, multiplier });
    });
    return parseBoostList(rows);
}

/**
 * Save the Leveling page form. Fields from before this change are saved exactly as before; the
 * fields added with it are only touched when the form says it carries them (leveling_form_v2), so a
 * page loaded before the update cannot switch them off.
 */
export async function saveLevelingForm(guildId, body = {}, guild = guildFor(guildId)) {
    const ownsChannel = (id) => !guild || guild.channels.cache.has(id);
    const ownsRole = (id) => !guild || guild.roles.cache.has(id);
    const v2 = on(body.leveling_form_v2);

    const ignoredChannels = parseIdList(asArray(body.leveling_ignored_channels)).filter(ownsChannel);
    const ignoredRoles = parseIdList(asArray(body.leveling_ignored_roles)).filter(ownsRole);
    const resetIntervalDays = clampInt(body.reset_interval_days, 7, 365, 30);
    const xpPerMessage = clampInt(body.leveling_xp_rate, 1, 100, 15);
    const cooldown = clampInt(body.leveling_xp_cooldown, XP_COOLDOWN_MIN, XP_COOLDOWN_MAX, XP_COOLDOWN_DEFAULT);

    // The announcement select carries a channel id, '' (the member's own channel), 'dm' or 'off'.
    // DM and off keep the stored channel, so switching back restores it.
    const rawDest = String(body.level_up_channel_id ?? '').trim();
    let mode = 'channel';
    let channelId = null;
    if (rawDest === 'dm' || rawDest === 'off') mode = rawDest;
    else if (SNOWFLAKE.test(rawDest) && ownsChannel(rawDest)) channelId = rawDest;
    const keepChannel = mode !== 'channel' ? 1 : 0;

    const base = {
        enabled: on(body.leveling_enabled) ? 1 : 0,
        xp_per_message: xpPerMessage,
        xp_cooldown_seconds: cooldown,
        level_up_channel_id: channelId,
        ignored_channels: JSON.stringify(ignoredChannels),
        ignored_roles: JSON.stringify(ignoredRoles),
        monthly_reset_enabled: on(body.monthly_reset_enabled) ? 1 : 0,
        reset_interval_days: resetIntervalDays,
        reset_exempt_staff: on(body.reset_exempt_staff) ? 1 : 0,
    };
    await pool.execute(
        `INSERT INTO level_config
            (guild_id, enabled, xp_per_message, xp_cooldown_seconds, level_up_channel_id,
             ignored_channels, ignored_roles, monthly_reset_enabled, reset_interval_days, reset_exempt_staff)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            enabled = VALUES(enabled),
            xp_per_message = VALUES(xp_per_message),
            xp_cooldown_seconds = VALUES(xp_cooldown_seconds),
            level_up_channel_id = IF(? = 1, level_up_channel_id, VALUES(level_up_channel_id)),
            ignored_channels = VALUES(ignored_channels),
            ignored_roles = VALUES(ignored_roles),
            monthly_reset_enabled = VALUES(monthly_reset_enabled),
            reset_interval_days = VALUES(reset_interval_days),
            reset_exempt_staff = VALUES(reset_exempt_staff)`,
        [guildId, base.enabled, base.xp_per_message, base.xp_cooldown_seconds, base.level_up_channel_id,
            base.ignored_channels, base.ignored_roles, base.monthly_reset_enabled, base.reset_interval_days,
            base.reset_exempt_staff, keepChannel],
    );

    if (!v2) return { saved: base, extended: false };

    // Columns that already existed but had no control on the page.
    const message = String(body.level_up_message ?? '').replace(/\r\n/g, '\n').trim().slice(0, MESSAGE_MAX);
    const older = {
        level_up_message: message || DEFAULT_LEVEL_UP_MESSAGE,
        voice_xp_enabled: on(body.voice_xp_enabled) ? 1 : 0,
        xp_per_voice_minute: clampInt(body.xp_per_voice_minute, 1, 50, 5),
        xp_multiplier_weekends: clampNum(body.xp_multiplier_weekends, BOOST_MIN, BOOST_MAX, 1),
    };
    await pool.execute(
        `UPDATE level_config SET level_up_message = ?, voice_xp_enabled = ?, xp_per_voice_minute = ?, xp_multiplier_weekends = ?
         WHERE guild_id = ?`,
        [older.level_up_message, older.voice_xp_enabled, older.xp_per_voice_minute, older.xp_multiplier_weekends, guildId],
    );

    // Columns from migration 418.
    const added = {
        level_up_mode: mode,
        announce_every_n: clampInt(body.announce_every_n, 1, 100, 1),
        announce_min_level: clampInt(body.announce_min_level, 0, 1000, 0),
        announce_rewards_only: on(body.announce_rewards_only) ? 1 : 0,
        reward_mode: REWARD_MODES.includes(body.reward_mode) ? body.reward_mode : 'stack',
        remove_reward_on_loss: on(body.remove_reward_on_loss) ? 1 : 0,
        xp_boost_roles: JSON.stringify(boostRowsFromForm(body.xp_boost_role_id, body.xp_boost_role_mult, ownsRole)),
        xp_boost_channels: JSON.stringify(boostRowsFromForm(body.xp_boost_channel_id, body.xp_boost_channel_mult, ownsChannel)),
    };
    let extended = true;
    try {
        await pool.execute(
            `UPDATE level_config SET ${NEW_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE guild_id = ?`,
            [...NEW_COLUMNS.map((c) => added[c]), guildId],
        );
    } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        extended = false;
        logger.warn(`[Leveling] New leveling options not saved for ${guildId}: run migration 418 (${err.message})`);
    }
    return { saved: { ...base, ...older, ...added }, extended };
}
