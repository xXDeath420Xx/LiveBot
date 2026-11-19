/*
 * Auto-role categories.
 *
 * When a channel is created inside a configured category, generate a matching
 * role (or re-use an existing one named after the base), lock the channel to
 * that role, and append it to the guild's game-roles reaction-role panel.
 *
 * Config lives in `auto_role_categories` (migration 379). Register a category
 * via `/admin auto-role-categories add <category>` or by inserting a row
 * directly (one per guild per category).
 *
 * Name derivation: strip any leading emoji + whitespace, strip `-codes` suffix,
 * title-case the words. "aniimo-codes" and "aniimo" both resolve to role "Aniimo",
 * so a `-codes` channel reuses the base game's role.
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const LOG = '[AutoRoleCat]';
const LEADING_EMOJI = /^(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]+)[\s_-]*/u;

async function getConfig(guildId, categoryId) {
    const [rows] = await pool.query(
        'SELECT * FROM auto_role_categories WHERE guild_id = ? AND category_id = ? AND enabled = 1',
        [guildId, categoryId]).catch(() => [[]]);
    return rows[0] || null;
}

function deriveRoleName(channelName) {
    let name = channelName.replace(LEADING_EMOJI, '').trim();
    // Drop `-codes` suffix so codes-channels share their game's role
    name = name.replace(/-codes$/i, '').trim();
    // Title case the remaining words
    return name.split(/[-_\s]+/)
        .filter(Boolean)
        .map(w => w.length <= 3 && /^[a-z]+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

async function findOrCreateRole(guild, roleName, color) {
    let role = guild.roles.cache.find(r => r.name === roleName);
    if (role) return role;
    try {
        role = await guild.roles.create({
            name: roleName,
            color: color || 0x5865F2,
            mentionable: false,
            hoist: false,
            reason: `${LOG} auto-created for category channel`,
        });
        logger.info(`${LOG} CREATED role @${roleName} in ${guild.id}`);
        return role;
    } catch (err) {
        logger.warn(`${LOG} role create failed in ${guild.id} for "${roleName}": ${err.message}`);
        return null;
    }
}

async function lockChannelToRole(channel, role) {
    const guild = channel.guild;
    const view = PermissionFlagsBits.ViewChannel;
    const me = guild.members.me;
    try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false },
            { reason: `${LOG} lock to @${role.name}` });
        await channel.permissionOverwrites.edit(role, { ViewChannel: true },
            { reason: `${LOG} grant @${role.name}` });
        if (me) await channel.permissionOverwrites.edit(me, { ViewChannel: true },
            { reason: `${LOG} keep bot visibility` });
        logger.info(`${LOG} locked #${channel.name} → @${role.name}`);
        return true;
    } catch (err) {
        logger.warn(`${LOG} lock failed for #${channel.name}: ${err.message}`);
        return false;
    }
}

async function appendToReactionPanel(client, guildId, panelId, roleId, emoji, label) {
    if (!panelId) return;
    const safeEmoji = emoji || '🎮';
    try {
        const [exist] = await pool.query(
            'SELECT 1 FROM reaction_role_mappings WHERE panel_id = ? AND role_id = ?',
            [panelId, roleId]);
        if (exist[0]) return;
        await pool.query(
            'INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, role_id) VALUES (?, ?, ?, ?)',
            [panelId, safeEmoji, label, roleId]);
        logger.info(`${LOG} DB row added for @${label} on panel ${panelId}`);

        // Also re-render the Discord message so users see the new entry immediately,
        // and add the emoji reaction so clicks assign the role via the live
        // reaction-role manager without any manual re-sync.
        const [[panel]] = await pool.query(
            'SELECT channel_id, message_id, panel_name, embed_color FROM reaction_role_panels WHERE id = ?',
            [panelId]);
        if (!panel?.channel_id || !panel?.message_id) return;
        const [maps] = await pool.query(
            'SELECT emoji_id, label FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id',
            [panelId]);
        const titleByName = { games: '🎮 Games', platforms: '📺 Streaming Platforms', notifications: '🔔 Notifications' };
        const colorByName = { games: 0x5865F2, platforms: 0x6441a5, notifications: 0xe2b23a };
        // embed_color is stored as a hex STRING like '#5865F2' — Discord's embed
        // schema wants an integer.
        let color = colorByName[panel.panel_name] || 0x5865F2;
        if (typeof panel.embed_color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(panel.embed_color)) {
            color = parseInt(panel.embed_color.replace('#', ''), 16);
        } else if (typeof panel.embed_color === 'number') {
            color = panel.embed_color;
        }
        const embed = {
            title: titleByName[panel.panel_name] || panel.panel_name || 'Pick a role',
            description: maps.map(m => `${m.emoji_id}  ${m.label}`).join('\n') || '*(no roles yet)*',
            color,
        };
        const channel = await client?.channels?.fetch(panel.channel_id).catch(() => null);
        if (!channel) { logger.warn(`${LOG} panel channel ${panel.channel_id} unreachable`); return; }
        const msg = await channel.messages.fetch(panel.message_id).catch(() => null);
        if (!msg) { logger.warn(`${LOG} panel message ${panel.message_id} missing — DB row still added`); return; }
        await msg.edit({ embeds: [embed] }).catch(err => logger.warn(`${LOG} panel edit failed: ${err.message}`));
        await msg.react(safeEmoji).catch(err => logger.warn(`${LOG} reaction add failed: ${err.message}`));
        logger.info(`${LOG} panel ${panelId} re-rendered with @${label} + ${safeEmoji}`);
    } catch (err) {
        logger.warn(`${LOG} panel append failed: ${err.message}`);
    }
}

/**
 * Handle a channelCreate event. Called from events/channelCreate.js. Safe no-op
 * when the parent category isn't registered.
 */
export async function onChannelCreate(channel) {
    try {
        if (!channel.guildId || !channel.parentId) return;
        if (channel.type === 4) return; // ignore categories themselves
        const cfg = await getConfig(channel.guildId, channel.parentId);
        if (!cfg) return;
        const roleName = deriveRoleName(channel.name);
        if (!roleName) return;
        const color = cfg.role_color ? parseInt(cfg.role_color.replace('#', ''), 16) : 0x5865F2;
        const role = await findOrCreateRole(channel.guild, roleName, color);
        if (!role) return;
        await lockChannelToRole(channel, role);
        await appendToReactionPanel(channel.client, channel.guildId, cfg.reaction_panel_id, role.id, cfg.default_emoji, roleName);
    } catch (err) {
        logger.error(`${LOG} handler error for ${channel?.id}: ${err.message}`, { stack: err.stack });
    }
}

/*
 * Inverse of appendToReactionPanel: drop the mapping, re-render the embed, strip
 * the stale emoji reaction. Scoped to one panel + one role — callers decide which
 * panels to touch (we only call this for panels referenced by auto_role_categories).
 */
async function removeFromReactionPanel(client, panelId, roleId) {
    if (!panelId || !roleId) return;
    const [[mapping]] = await pool.query(
        'SELECT emoji_id FROM reaction_role_mappings WHERE panel_id = ? AND role_id = ? LIMIT 1',
        [panelId, roleId]);
    if (!mapping) return; // nothing to clean up
    await pool.query(
        'DELETE FROM reaction_role_mappings WHERE panel_id = ? AND role_id = ?',
        [panelId, roleId]);
    logger.info(`${LOG} DB row removed for role ${roleId} on panel ${panelId}`);
    try {
        const [[panel]] = await pool.query(
            'SELECT channel_id, message_id, panel_name, embed_color FROM reaction_role_panels WHERE id = ?',
            [panelId]);
        if (!panel?.channel_id || !panel?.message_id) return;
        const [maps] = await pool.query(
            'SELECT emoji_id, label FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id',
            [panelId]);
        const titleByName = { games: '🎮 Games', platforms: '📺 Streaming Platforms', notifications: '🔔 Notifications' };
        const colorByName = { games: 0x5865F2, platforms: 0x6441a5, notifications: 0xe2b23a };
        let color = colorByName[panel.panel_name] || 0x5865F2;
        if (typeof panel.embed_color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(panel.embed_color)) {
            color = parseInt(panel.embed_color.replace('#', ''), 16);
        } else if (typeof panel.embed_color === 'number') {
            color = panel.embed_color;
        }
        const embed = {
            title: titleByName[panel.panel_name] || panel.panel_name || 'Pick a role',
            description: maps.map(m => `${m.emoji_id}  ${m.label}`).join('\n') || '*(no roles yet)*',
            color,
        };
        const ch = await client?.channels?.fetch(panel.channel_id).catch(() => null);
        if (!ch) return;
        const msg = await ch.messages.fetch(panel.message_id).catch(() => null);
        if (!msg) return;
        await msg.edit({ embeds: [embed] }).catch(err => logger.warn(`${LOG} panel edit failed: ${err.message}`));
        if (mapping.emoji_id) {
            // Discord stores reactions by emoji name (unicode) or id (custom). Try both.
            const reaction = msg.reactions.cache.find(r =>
                r.emoji.name === mapping.emoji_id ||
                r.emoji.id === mapping.emoji_id ||
                r.emoji.toString() === mapping.emoji_id);
            if (reaction) await reaction.remove().catch(err =>
                logger.warn(`${LOG} reaction remove failed: ${err.message}`));
        }
        logger.info(`${LOG} panel ${panelId} re-rendered after role ${roleId} removed`);
    } catch (err) {
        logger.warn(`${LOG} panel cleanup after delete failed: ${err.message}`);
    }
}

/**
 * Handle a guildRoleDelete event. If the deleted role has a mapping on any panel
 * that an auto_role_categories row references in this guild, drop the mapping and
 * re-render the panel. Scoped to auto-role panels only — hand-built reaction-role
 * panels are left alone.
 */
export async function onRoleDelete(role) {
    try {
        if (!role?.guild?.id) return;
        const [cfgs] = await pool.query(
            'SELECT DISTINCT reaction_panel_id FROM auto_role_categories WHERE guild_id = ? AND enabled = 1 AND reaction_panel_id IS NOT NULL',
            [role.guild.id]);
        for (const cfg of cfgs) {
            await removeFromReactionPanel(role.client, cfg.reaction_panel_id, role.id);
        }
    } catch (err) {
        logger.error(`${LOG} role-delete handler error for ${role?.id}: ${err.message}`, { stack: err.stack });
    }
}

/**
 * Handle a channelDelete event. If the parent category is registered and no sibling
 * channel derives the same role name (so e.g. "aniimo-codes" won't cause @Aniimo to
 * disappear while #aniimo still exists), delete the role. The resulting
 * guildRoleDelete fires onRoleDelete above, which cleans the panel.
 */
export async function onChannelDelete(channel) {
    try {
        if (!channel.guildId || !channel.parentId) return;
        if (channel.type === 4) return; // category itself
        const cfg = await getConfig(channel.guildId, channel.parentId);
        if (!cfg) return;
        const roleName = deriveRoleName(channel.name);
        if (!roleName) return;
        const guild = channel.guild;
        if (!guild) return;
        // Sibling check: discord.js removes the deleted channel from the cache before
        // this event fires, so we don't need to exclude it, but keep the id filter
        // defensively.
        const sharesRole = guild.channels.cache.some(c =>
            c.id !== channel.id &&
            c.parentId === channel.parentId &&
            deriveRoleName(c.name) === roleName);
        if (sharesRole) {
            logger.info(`${LOG} skipping role delete for @${roleName}: sibling still uses it`);
            return;
        }
        const role = guild.roles.cache.find(r => r.name === roleName);
        if (!role) {
            // Role is already gone (user deleted it manually earlier). Make sure any
            // stale mapping on the panel is cleaned up anyway, by label.
            if (cfg.reaction_panel_id) {
                await pool.query(
                    'DELETE FROM reaction_role_mappings WHERE panel_id = ? AND label = ?',
                    [cfg.reaction_panel_id, roleName]).catch(() => {});
            }
            return;
        }
        await role.delete(`${LOG} last channel in category removed`).catch(err =>
            logger.warn(`${LOG} role delete failed for @${roleName}: ${err.message}`));
        // onRoleDelete (fired by Discord via guildRoleDelete) will clean the panel.
    } catch (err) {
        logger.error(`${LOG} channel-delete handler error for ${channel?.id}: ${err.message}`, { stack: err.stack });
    }
}

export default { onChannelCreate, onChannelDelete, onRoleDelete };
