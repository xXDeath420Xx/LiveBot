const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { db } = require('../../utils/db');
const { logger } = require('../../utils/logger');

module.exports = {
    customId: /^form_open_/,

    async execute(interaction) {
        const formId = interaction.customId.replace('form_open_', '');
        const guildId = interaction.guild.id;

        try {
            // Fetch the form
            const [[form]] = await db.execute(
                "SELECT * FROM forms WHERE form_id = ? AND guild_id = ?",
                [formId, guildId]
            );

            if (!form) {
                return interaction.reply({
                    content: '❌ This form no longer exists.',
                    ephemeral: true
                });
            }

            // Fetch questions for this form
            const [questions] = await db.execute(
                "SELECT * FROM form_questions WHERE form_id = ? ORDER BY question_order ASC, question_id ASC",
                [form.form_id]
            );

            if (questions.length === 0) {
                return interaction.reply({
                    content: '❌ This form has no questions yet. Please contact an administrator.',
                    ephemeral: true
                });
            }

            // Discord modals can only have up to 5 text inputs
            if (questions.length > 5) {
                return interaction.reply({
                    content: '❌ This form has too many questions (maximum 5 allowed by Discord). Please contact an administrator.',
                    ephemeral: true
                });
            }

            // Create modal
            const modal = new ModalBuilder()
                .setCustomId(`form_submit_${form.form_id}`)
                .setTitle(form.form_name.substring(0, 45)); // Discord limit

            // Add questions as text inputs
            for (let i = 0; i < questions.length; i++) {
                const question = questions[i];

                // Determine input style
                let style = TextInputStyle.Short;
                if (question.question_type === 'paragraph') {
                    style = TextInputStyle.Paragraph;
                }

                const textInput = new TextInputBuilder()
                    .setCustomId(`question_${i}`)
                    .setLabel(question.question_text.substring(0, 45)) // Discord limit
                    .setStyle(style)
                    .setRequired(question.is_required === 1);

                // Add placeholder for select type
                if (question.question_type === 'select' && question.question_options) {
                    textInput.setPlaceholder(`Options: ${question.question_options.substring(0, 100)}`);
                }

                // Add to modal
                const actionRow = new ActionRowBuilder().addComponents(textInput);
                modal.addComponents(actionRow);
            }

            // Show modal to user
            await interaction.showModal(modal);

        } catch (error) {
            logger.error('[Form Button] Error:', error);

            if (!interaction.replied && !interaction.deferred) {
                return interaction.reply({
                    content: '❌ An error occurred while loading the form.',
                    ephemeral: true
                });
            }
        }
    }
};
