const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const { logInfraction } = require('../core/moderation-manager');
const db = require('../utils/db');
const logger = require('../utils/logger');

// Simple time string parser (e.g., "5m", "1h", "2d")
function parseDuration(durationStr) {
    const match = durationStr.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2];
    let milliseconds = 0;

    switch (unit) {
        case 's': milliseconds = value * 1000; break;
        case 'm': milliseconds = value * 60 * 1000; break;
        case 'h': milliseconds = value * 60 * 60 * 1000; break;
        case 'd': milliseconds = value * 24 * 60 * 60 * 1000; break;
    }
    // Discord timeout max is 28 days
    if (milliseconds > 28 * 24 * 60 * 60 * 1000) {
        return 28 * 24 * 60 * 60 * 1000;
    }
    return milliseconds;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Times out a user, preventing them from talking or speaking.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
        .addUserOption(option => 
            option.setName('user')
                .setDescription('The user to mute.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('duration')
                .setDescription('The duration of the mute (e.g., 5m, 1h, 3d). Max 28d.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for the mute.')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const targetUser = interaction.options.getUser('user');
        const durationStr = interaction.options.getString('duration');
        const reason = interaction.options.getString('reason');
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

        if (!member) {
            return interaction.editReply("Could not find that user in the server.");
        }
        if (member.id === interaction.user.id) {
            return interaction.editReply("You cannot mute yourself.");
        }
        if (member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
            return interaction.editReply("You cannot mute another moderator.");
        }
        if (!member.moderatable) {
            return interaction.editReply("I cannot mute this user. They may have a higher role than me.");
        }

        const durationMs = parseDuration(durationStr);
        if (!durationMs) {
            return interaction.editReply("Invalid duration format. Use formats like `10m`, `2h`, `1d`.");
        }

        try {
            // Apply the timeout
            await member.timeout(durationMs, reason);

            // Log the infraction
            const durationMinutes = Math.floor(durationMs / (60 * 1000));
            await logInfraction(interaction, targetUser, 'Mute', reason, durationMinutes);
            
            // Attempt to DM the user
            try {
                const dmEmbed = new EmbedBuilder()
                    .setColor('#E74C3C')
                    .setTitle(`You have been muted in ${interaction.guild.name}`)
                    .addFields(
                        { name: 'Duration', value: durationStr },
                        { name: 'Reason', value: reason },
                        { name: 'Moderator', value: interaction.user.tag }
                    )
                    .setTimestamp();
                await targetUser.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                logger.warn(`[Mute Command] Could not DM user ${targetUser.tag}: ${dmError.message}`);
            }

            const replyEmbed = new EmbedBuilder()
                .setColor('#57F287')
                .setDescription(`✅ Successfully muted ${targetUser.tag} for ${durationStr}. Reason: ${reason}`);
            
            await interaction.editReply({ embeds: [replyEmbed] });

        } catch (error) {
            logger.error('[Mute Command Error]', error);
            await interaction.editReply("An unexpected error occurred while trying to mute this user.");
        }
    },
};