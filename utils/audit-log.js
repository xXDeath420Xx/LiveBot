"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAuditEvent = logAuditEvent;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("./db"));
const logger_1 = require("./logger");
async function logAuditEvent(interaction, title, description) {
    try {
        const [guildSettingsRows] = await db_1.default.execute('SELECT audit_log_channel_id FROM guilds WHERE guild_id = ?', [interaction.guild.id]);
        const guildSettings = guildSettingsRows[0];
        const channelId = guildSettings?.audit_log_channel_id;
        if (!channelId) {
            return; // This guild has not configured an audit log channel.
        }
        const auditChannel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (!auditChannel || !(auditChannel instanceof discord_js_1.TextChannel)) {
            logger_1.logger.warn(`[Audit Log] Guild ${interaction.guild.id} has an invalid audit channel ID: ${channelId}`);
            return;
        }
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#FEE75C')
            .setTitle(title)
            .setDescription(description)
            .setTimestamp()
            .setFooter({
            text: `Action performed by: ${interaction.user.tag}`,
            iconURL: interaction.user.displayAvatarURL()
        });
        await auditChannel.send({ embeds: [embed] });
    }
    catch (error) {
        logger_1.logger.error(`[Audit Log] Failed to send audit log for guild ${interaction.guild.id}:`, { error });
    }
}
