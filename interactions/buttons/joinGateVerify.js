const { assignRolesAfterVerification } = require('../../core/autorole-manager');
const db = require('../../utils/db');
const logger = require('../../utils/logger');

module.exports = {
    customId: /^joingate_verify_(\d+)$/,
    async execute(interaction) {
        const guildId = interaction.guild.id;
        const match = this.customId.exec(interaction.customId);
        const targetUserId = match[1];

        if (interaction.user.id !== targetUserId) {
            return interaction.reply({ content: 'This verification button is not for you.', ephemeral: true });
        }

        try {
            const [[config]] = await db.execute('SELECT verification_role_id FROM join_gate_config WHERE guild_id = ?', [guildId]);
            if (!config || !config.verification_role_id) {
                return interaction.reply({ content: 'The verification role has not been configured for this server.', ephemeral: true });
            }

            const member = interaction.member;
            const verificationRole = await interaction.guild.roles.fetch(config.verification_role_id).catch(() => null);

            if (!verificationRole || !verificationRole.editable) {
                logger.error('Verification role not found or is not manageable.', { guildId, category: 'join-gate' });
                return interaction.reply({ content: 'An error occurred: The verification role is missing or I cannot assign it.', ephemeral: true });
            }

            if (member.roles.cache.has(verificationRole.id)) {
                return interaction.reply({ content: 'You are already verified.', ephemeral: true });
            }

            // Assign the verification role
            await member.roles.add(verificationRole, 'User passed join-gate verification');

            // Assign any other autoroles
            await assignRolesAfterVerification(member);

            logger.info(`User ${member.user.tag} has been verified.`, { guildId, category: 'join-gate' });

            // Delete the original prompt message
            try {
                await interaction.message.delete();
            } catch (e) {
                // Ignore if message is already deleted
            }

            await interaction.reply({ content: 'You have been successfully verified!', ephemeral: true });

        } catch (error) {
            logger.error('Error during join-gate verification.', { guildId, category: 'join-gate', error: error.stack });
            await interaction.reply({ content: 'An unexpected error occurred during verification.', ephemeral: true });
        }
    }
};