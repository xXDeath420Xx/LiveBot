import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import logger from '../../utils/logger.js';

const STAFF_ROLE_IDS = [
    '1475365678222541112', // Trial Mod
    '1475365680999043177', // Moderator
    '1475365683612090418', // Admin
    '1475365685755510888', // Head Admin
    '1475365688104325183', // Developer
    '1475365691099054192', // Owner
];

export async function handleStaffIntroButton(interaction) {
    try {
        const isStaff = interaction.member.roles.cache.some(r => STAFF_ROLE_IDS.includes(r.id));
        if (!isStaff) {
            return await interaction.reply({ content: 'Only staff members can submit introductions.', ephemeral: true });
        }

        const modal = new ModalBuilder()
            .setCustomId('staff_intro_submit')
            .setTitle('Staff Introduction');

        const nameInput = new TextInputBuilder()
            .setCustomId('staff_name')
            .setLabel('Your Name / In-Game Alias')
            .setPlaceholder('e.g., CertiFried')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50);

        const roleInput = new TextInputBuilder()
            .setCustomId('staff_role')
            .setLabel('Your Role on the Team')
            .setPlaceholder('e.g., Head Admin, Developer, Moderator')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100);

        const whatYouDoInput = new TextInputBuilder()
            .setCustomId('staff_duties')
            .setLabel('What Do You Do?')
            .setPlaceholder('e.g., I handle moderation, community events, and...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500);

        const tenureInput = new TextInputBuilder()
            .setCustomId('staff_tenure')
            .setLabel('How Long Have You Been with YourMafia?')
            .setPlaceholder('e.g., Since day one, 6 months, etc.')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100);

        const funFactInput = new TextInputBuilder()
            .setCustomId('staff_funfact')
            .setLabel('Fun Fact About You')
            .setPlaceholder('Something the community might not know...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(300);

        modal.addComponents(
            new ActionRowBuilder().addComponents(nameInput),
            new ActionRowBuilder().addComponents(roleInput),
            new ActionRowBuilder().addComponents(whatYouDoInput),
            new ActionRowBuilder().addComponents(tenureInput),
            new ActionRowBuilder().addComponents(funFactInput)
        );

        await interaction.showModal(modal);
    } catch (error) {
        logger.error('[StaffIntro] Error showing modal', { error: error.message, stack: error.stack });
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
        }
    }
}
