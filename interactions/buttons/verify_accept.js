import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export async function handleVerifyAccept(interaction) {
    try {
        const guildId = interaction.guild?.id;
        if (!guildId) return;

        const [rows] = await pool.execute(
            'SELECT verified_role_id, unverified_role_id, enabled FROM verify_config WHERE guild_id = ?',
            [guildId]
        );
        if (!rows.length || !rows[0].enabled) {
            return interaction.reply({ content: 'Verification is not configured for this server.', ephemeral: true });
        }

        const { verified_role_id, unverified_role_id } = rows[0];
        const member = interaction.member;

        if (verified_role_id && member.roles.cache.has(verified_role_id)) {
            return interaction.reply({ content: '✅ You are already verified. Welcome!', ephemeral: true });
        }

        const verifiedRole = interaction.guild.roles.cache.get(verified_role_id);
        if (!verifiedRole) {
            logger.error(`[verify_accept] verified_role_id ${verified_role_id} missing in guild ${guildId}`);
            return interaction.reply({ content: 'Verified role not found — ping a mod.', ephemeral: true });
        }

        const me = await interaction.guild.members.fetchMe();
        if (me.roles.highest.position <= verifiedRole.position) {
            logger.error(`[verify_accept] bot role (${me.roles.highest.position}) not above verified role (${verifiedRole.position}) in guild ${guildId}`);
            return interaction.reply({ content: 'Bot hierarchy is misconfigured — ping a mod.', ephemeral: true });
        }

        try {
            await member.roles.add(verifiedRole, 'Verification: user accepted the rules');
            if (unverified_role_id && member.roles.cache.has(unverified_role_id)) {
                await member.roles.remove(unverified_role_id, 'Verification: cleanup').catch(() => {});
            }
        } catch (err) {
            logger.error(`[verify_accept] role toggle failed for ${member.id} in ${guildId}: ${err.message}`);
            return interaction.reply({ content: 'Could not grant Verified — the bot is missing Manage Roles, or its role sits below Verified. Ping a mod.', ephemeral: true });
        }

        await interaction.reply({ content: '✅ Verified. Enjoy the server!', ephemeral: true });
    } catch (err) {
        logger.error('[verify_accept] handler error', { error: err.message, stack: err.stack });
        if (!interaction.replied) {
            await interaction.reply({ content: 'Verification hit an error — ping a mod.', ephemeral: true }).catch(() => {});
        }
    }
}

export default handleVerifyAccept;
