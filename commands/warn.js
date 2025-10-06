const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const { logInfraction } = require('../core/moderation-manager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Issues a formal warning to a user.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
        .addUserOption(option => 
            option.setName('user')
                .setDescription('The user to warn.')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for the warning.')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const targetUser = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');
        
        if (targetUser.id === interaction.user.id) {
            return interaction.editReply('You cannot warn yourself.');
        }
        if (targetUser.bot) {
            return interaction.editReply('You cannot warn a bot.');
        }

        // Log the infraction
        await logInfraction(interaction, targetUser, 'Warning', reason);

        // Attempt to DM the user
        try {
            const dmEmbed = new EmbedBuilder()
                .setColor('#E67E22')
                .setTitle(`You have been warned in ${interaction.guild.name}`)
                .addFields(
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.tag }
                )
                .setTimestamp();
            await targetUser.send({ embeds: [dmEmbed] });
        } catch (error) {
            // This is not critical, so we just note it
            console.log(`Could not DM user ${targetUser.tag}. They may have DMs disabled.`);
        }

        const replyEmbed = new EmbedBuilder()
            .setColor('#57F287')
            .setDescription(`✅ Successfully warned ${targetUser.tag} for: ${reason}`);
        
        await interaction.editReply({ embeds: [replyEmbed] });
    },
};