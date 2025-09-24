const { EmbedBuilder } = require("discord.js");
const { pool: db } = require("../../utils/db");
const logger = require("../../utils/logger");

async function cleanupInvalidRole(guildId, roleId) {
    if (!guildId || !roleId) return;
    logger.info(`[Reinit Cleanup] Aggressively purging invalid role ID ${roleId} for guild ${guildId}.`);
    try {
        await db.execute("UPDATE guilds SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?", [guildId, roleId]);
        await db.execute("UPDATE twitch_teams SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?", [guildId, roleId]);
    } catch (dbError) {
        logger.error(`[Reinit Cleanup] DB Error while purging role ${roleId} for guild ${guildId}:`, dbError);
    }
}

module.exports = {
    customId: "confirm_reinit",
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const guildId = interaction.guildId;
        const client = interaction.client;

        const statusEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle("Reinitialization in Progress...");

        try {
            statusEmbed.setDescription("Step 1/2: Purging all announcement messages for this server...");
            await interaction.editReply({ embeds: [statusEmbed] });

            const [announcements] = await db.execute("SELECT announcement_id, channel_id, message_id FROM announcements WHERE guild_id = ?", [guildId]);
            logger.info(`[Reinit] Found ${announcements.length} announcements to purge for guild ${guildId}.`);

            for (const ann of announcements) {
                try {
                    const channel = await client.channels.fetch(ann.channel_id).catch(() => null);
                    if (channel) {
                        await channel.messages.delete(ann.message_id).catch(err => {
                            if (err.code !== 10008) {
                                logger.warn(`[Reinit] Could not delete message ${ann.message_id} in channel ${ann.channel_id}:`, err);
                            }
                        });
                    }
                } catch (e) {
                    logger.error(`[Reinit] Error processing announcement ${ann.announcement_id} for deletion:`, e);
                }
            }

            await db.execute("DELETE FROM announcements WHERE guild_id = ?", [guildId]);
            logger.info(`[Reinit] Finished purging announcements from DB for guild ${guildId}.`);

            statusEmbed.setDescription("Step 2/2: Validating all configured roles for this server...");
            await interaction.editReply({ embeds: [statusEmbed] });

            const [guildRoles] = await db.execute("SELECT live_role_id FROM guilds WHERE guild_id = ? AND live_role_id IS NOT NULL", [guildId]);
            const [teamRoles] = await db.execute("SELECT live_role_id FROM twitch_teams WHERE guild_id = ? AND live_role_id IS NOT NULL", [guildId]);
            const allRoleIds = [...new Set([...guildRoles.map(r => r.live_role_id), ...teamRoles.map(r => r.live_role_id)])];

            logger.info(`[Reinit] Found ${allRoleIds.length} unique role configurations to validate for guild ${guildId}.`);

            for (const roleId of allRoleIds) {
                if (!roleId) continue;
                const roleExists = await interaction.guild.roles.fetch(roleId).catch(() => null);
                if (!roleExists) {
                    logger.info(`[Reinit] Found invalid role ${roleId} in guild ${guildId} during validation.`);
                    await cleanupInvalidRole(guildId, roleId);
                }
            }
            logger.info(`[Reinit] Finished validating roles for guild ${guildId}.`);

            const successEmbed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle("✅ Reinitialization Complete")
                .setDescription("The server has been successfully reinitialized. The bot will now build a fresh set of announcements on its next cycle.");

            await interaction.editReply({ embeds: [successEmbed], components: [] });

        } catch (error) {
            logger.error(`[Reinit] A critical error occurred during reinitialization for guild ${guildId}:`, error);
            const errorEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle("❌ Error")
                .setDescription("A critical error occurred. Please check the bot's logs for more details.");
            await interaction.editReply({ embeds: [errorEmbed], components: [] });
        }
    },
};