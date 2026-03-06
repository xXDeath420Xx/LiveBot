import { EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';

export async function handleStaffIntroSubmit(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const name = interaction.fields.getTextInputValue('staff_name');
        const role = interaction.fields.getTextInputValue('staff_role');
        const duties = interaction.fields.getTextInputValue('staff_duties');
        const tenure = interaction.fields.getTextInputValue('staff_tenure');
        const funFact = interaction.fields.getTextInputValue('staff_funfact');

        const highestRole = interaction.member.roles.highest;

        const embed = new EmbedBuilder()
            .setAuthor({ name: interaction.user.displayName, iconURL: interaction.user.displayAvatarURL() })
            .setTitle(`👋 ${name}`)
            .setColor(highestRole.color || 0x5865F2)
            .addFields(
                { name: 'Role', value: role, inline: true },
                { name: 'With YourMafia Since', value: tenure, inline: true },
                { name: 'What I Do', value: duties, inline: false }
            )
            .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
            .setTimestamp();

        if (funFact) {
            embed.addFields({ name: 'Fun Fact', value: funFact, inline: false });
        }

        embed.setFooter({ text: `${highestRole.name} • YourMafia Staff` });

        await interaction.channel.send({ embeds: [embed] });
        await interaction.editReply({ content: 'Your introduction has been posted!' });

        logger.info(`[StaffIntro] ${interaction.user.tag} posted their introduction`, {
            guildId: interaction.guildId,
            userId: interaction.user.id
        });
    } catch (error) {
        logger.error('[StaffIntro] Error submitting intro', { error: error.message, stack: error.stack });
        const reply = interaction.deferred ? 'editReply' : 'reply';
        await interaction[reply]({ content: 'Failed to post your introduction. Please try again.', ephemeral: true }).catch(() => {});
    }
}
