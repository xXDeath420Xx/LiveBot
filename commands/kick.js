const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const { logInfraction } = require('../core/moderation-manager');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kicks a user from the server.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers)
        .addUserOption(option => 
            option.setName('user')
                .setDescription('The user to kick.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for the kick.')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const targetUser = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

        if (!member) {
            return interaction.editReply("Could not find that user in the server.");
        }
        if (member.id === interaction.user.id) {
            return interaction.editReply("You cannot kick yourself.");
        }
        if (!member.kickable) {
            return interaction.editReply("I cannot kick this user. They may have a higher role than me or I lack permissions.");
        }

        try {
            // Attempt to DM the user first
            const dmEmbed = new EmbedBuilder()
                .setColor('#E67E22')
                .setTitle(`You have been kicked from ${interaction.guild.name}`)
                .addFields({ name: 'Reason', value: reason }, { name: 'Moderator', value: interaction.user.tag })
                .setTimestamp();
            await targetUser.send({ embeds: [dmEmbed] }).catch((e) => logger.warn(`Could not DM user ${targetUser.tag}: ${e.message}`));

            // Kick the user
            await member.kick(reason);

            // Log the infraction
            await logInfraction(interaction, targetUser, 'Kick', reason);

            const replyEmbed = new EmbedBuilder()
                .setColor('#57F287')
                .setDescription(`✅ Successfully kicked ${targetUser.tag}.`);
            
            await interaction.editReply({ embeds: [replyEmbed] });

        } catch (error) {
            logger.error('[Kick Command Error]', error);
            await interaction.editReply("An unexpected error occurred while trying to kick this user.");
        }
    },
};