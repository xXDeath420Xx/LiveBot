import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import logger from '../../utils/logger.js';

export async function handleSuggestionFormButton(interaction) {
    try {
        const modal = new ModalBuilder()
            .setCustomId('forum_suggestion_submit')
            .setTitle('Submit a Suggestion');

        const categoryInput = new TextInputBuilder()
            .setCustomId('suggestion_category')
            .setLabel('Category')
            .setPlaceholder('Game Feature, Server Improvement, Community Event, QoL, Other')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50);

        const titleInput = new TextInputBuilder()
            .setCustomId('suggestion_title')
            .setLabel('Title / Brief Summary')
            .setPlaceholder('A short, clear summary of your idea')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('suggestion_description')
            .setLabel('Detailed Description')
            .setPlaceholder('Explain your suggestion in detail. What would it look like? How would it work?')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1500);

        const benefitInput = new TextInputBuilder()
            .setCustomId('suggestion_benefit')
            .setLabel('Why would this benefit the community?')
            .setPlaceholder('How does this improve the experience for members?')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500);

        modal.addComponents(
            new ActionRowBuilder().addComponents(categoryInput),
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(descriptionInput),
            new ActionRowBuilder().addComponents(benefitInput)
        );

        await interaction.showModal(modal);
    } catch (error) {
        logger.error('[ForumSubmit] Error showing suggestion form', { error: error.message });
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
        }
    }
}

export async function handleBugReportFormButton(interaction) {
    try {
        const modal = new ModalBuilder()
            .setCustomId('forum_bug_report_submit')
            .setTitle('Report a Bug');

        const titleInput = new TextInputBuilder()
            .setCustomId('bug_title')
            .setLabel('Bug Title')
            .setPlaceholder('Brief summary of the issue')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100);

        const tryingInput = new TextInputBuilder()
            .setCustomId('bug_trying')
            .setLabel('What were you trying to do?')
            .setPlaceholder('e.g., I was trying to use the /music play command...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500);

        const happenedInput = new TextInputBuilder()
            .setCustomId('bug_happened')
            .setLabel('What happened instead?')
            .setPlaceholder('e.g., The bot responded with an error message saying...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500);

        const stepsInput = new TextInputBuilder()
            .setCustomId('bug_steps')
            .setLabel('Steps to Reproduce')
            .setPlaceholder('1. Go to #channel\n2. Type /command\n3. Click button\n4. Error appears')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(500);

        const severityInput = new TextInputBuilder()
            .setCustomId('bug_severity')
            .setLabel('How severe is this? (Low / Medium / High / Critical)')
            .setPlaceholder('Low = minor annoyance, Critical = breaks core functionality')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20);

        modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(tryingInput),
            new ActionRowBuilder().addComponents(happenedInput),
            new ActionRowBuilder().addComponents(stepsInput),
            new ActionRowBuilder().addComponents(severityInput)
        );

        await interaction.showModal(modal);
    } catch (error) {
        logger.error('[ForumSubmit] Error showing bug report form', { error: error.message });
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
        }
    }
}
