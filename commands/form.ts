import {
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction
} from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';
import { RowDataPacket } from 'mysql2';

interface FormRow extends RowDataPacket {
    form_id: number;
    form_name: string;
    guild_id: string;
}

interface FormQuestionRow extends RowDataPacket {
    question_id: number;
    form_id: number;
    question_text: string;
    question_type: 'text' | 'paragraph' | 'select';
    question_options?: string;
    question_order: number;
    is_required: number;
}

interface CommandData {
    data: SlashCommandBuilder;
    autocomplete: (interaction: AutocompleteInteraction) => Promise<void>;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('form')
        .setDescription('Submit a form')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('The name of the form to submit')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        const focusedValue = interaction.options.getFocused();
        const guildId = interaction.guild!.id;

        try {
            const [forms] = await db.execute<FormRow[]>(
                "SELECT form_name FROM forms WHERE guild_id = ? AND form_name LIKE ? LIMIT 25",
                [guildId, `%${focusedValue}%`]
            );

            const choices = forms.map(form => ({
                name: form.form_name,
                value: form.form_name
            }));

            await interaction.respond(choices);
        } catch (error) {
            logger.error('[Form Autocomplete] Error:', error as Record<string, any>);
            await interaction.respond([]);
        }
    },

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        const formName = interaction.options.getString('name', true);
        const guildId = interaction.guild!.id;

        try {
            // Fetch the form
            const [[form]] = await db.execute<FormRow[]>(
                "SELECT * FROM forms WHERE guild_id = ? AND form_name = ?",
                [guildId, formName]
            );

            if (!form) {
                await interaction.reply({
                    content: `❌ Form "${formName}" not found.`,
                    ephemeral: true
                });
                return;
            }

            // Fetch questions for this form
            const [questions] = await db.execute<FormQuestionRow[]>(
                "SELECT * FROM form_questions WHERE form_id = ? ORDER BY question_order ASC, question_id ASC",
                [form.form_id]
            );

            if (questions.length === 0) {
                await interaction.reply({
                    content: '❌ This form has no questions yet. Please contact an administrator.',
                    ephemeral: true
                });
                return;
            }

            // Discord modals can only have up to 5 text inputs
            if (questions.length > 5) {
                await interaction.reply({
                    content: '❌ This form has too many questions (maximum 5 allowed by Discord). Please contact an administrator.',
                    ephemeral: true
                });
                return;
            }

            // Create modal
            const modal = new ModalBuilder()
                .setCustomId(`form_submit_${form.form_id}`)
                .setTitle(form.form_name.substring(0, 45)); // Discord limit

            // Add questions as text inputs
            for (let i = 0; i < questions.length; i++) {
                const question = questions[i];
                if (!question) continue;

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
                const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);
                modal.addComponents(actionRow);
            }

            // Show modal to user
            await interaction.showModal(modal);

        } catch (error) {
            logger.error('[Form Command] Error:', error as Record<string, any>);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ An error occurred while loading the form.',
                    ephemeral: true
                });
                return;
            }
        }
    }
} as CommandData;