const db = require('../../utils/db');
const logger = require('../../utils/logger');
// Import the new function from the autorole manager
const { assignRolesAfterVerification } = require('../../core/autorole-manager');

module.exports = {
    customId: 'verify_member',
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const [[config]] = await db.execute('SELECT verification_role_id FROM join_gate_config WHERE guild_id = ?', [interaction.guild.id]);

        if (!config || !config.verification_role_id) {
            return interaction.editReply('The verification system is not configured correctly.');
        }

        const role = await interaction.guild.roles.fetch(config.verification_role_id).catch(() => null);
        if (!role) {
            return interaction.editReply('The verification role no longer exists. Please contact an administrator.');
        }

        if (interaction.member.roles.cache.has(role.id)) {
            return interaction.editReply('You have already been verified.');
        }

        try {
            await interaction.member.roles.add(role);
            
            // NEW: After giving the verification role, trigger the autoroles
            try {
                await assignRolesAfterVerification(interaction.member);
            } catch (autoroleError) {
                logger.error(`[Verification] Error assigning autoroles after verification for ${interaction.user.tag}:`, autoroleError);
                // This error is not critical enough to stop the verification success message
            }

            await interaction.editReply('You have been successfully verified!');
        } catch (error) {
            logger.error(`[Verification] Failed to assign role to ${interaction.user.tag}:`, error);
            await interaction.editReply('I was unable to assign the role. Please ensure my role is higher than the verification role.');
        }
    },
};