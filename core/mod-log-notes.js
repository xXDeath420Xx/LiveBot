/*
 * Mod-log posts for moderation actions that are not infractions.
 *
 * core/moderation-manager.js posts infractions (Ban, Mute, …) to moderation_config.mod_log_channel_id
 * but only for the infractions.type ENUM. Channel locks and temporary roles are moderation actions a
 * server still wants in that same channel, so they are posted here, to the same place, in the same
 * style. A missing or broken channel is logged and never throws: the action itself has already
 * happened by the time this runs.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const COLOURS = {
    lock: '#C0392B',
    unlock: '#2ECC71',
    role_add: '#3498DB',
    role_remove: '#95A5A6',
    warning: '#E67E22',
};

/**
 * @param {import('discord.js').Guild} guild
 * @param {{kind?:string, title:string, description?:string, fields?:Array<{name:string,value:string,inline?:boolean}>}} entry
 * @returns {Promise<string|false>} the mod-log channel id it posted to (truthy), or false when nothing was
 *          posted — callers pass it as `avoidChannelIds` so the server log does not repeat the same post there.
 */
export async function postModNote(guild, { kind = 'warning', title, description, fields = [] }) {
    if (!guild) return false;
    try {
        const [rows] = await pool.execute(
            'SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?',
            [guild.id]
        );
        const channelId = rows[0]?.mod_log_channel_id;
        if (!channelId) return false;

        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            logger.warn('[ModLogNotes] Mod log channel missing or not text-based', { guildId: guild.id, channelId });
            return false;
        }

        const embed = new EmbedBuilder()
            .setColor(COLOURS[kind] || COLOURS.warning)
            .setAuthor({ name: 'Moderation Log' })
            .setTitle(title)
            .setTimestamp();
        if (description) embed.setDescription(String(description).slice(0, 4000));
        for (const f of fields) {
            if (!f || !f.name) continue;
            embed.addFields({ name: String(f.name).slice(0, 256), value: String(f.value || '—').slice(0, 1024), inline: !!f.inline });
        }
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return String(channelId);
    } catch (error) {
        logger.error('[ModLogNotes] Could not post to the mod log', { guildId: guild.id, title, error: error.message });
        return false;
    }
}

export default { postModNote };
