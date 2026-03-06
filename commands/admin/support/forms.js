import { PermissionsBitField, EmbedBuilder } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * Autocomplete handler for forms subcommand group.
 * Handles form-name and name autocomplete options.
 */
async function autocomplete(interaction) {
    const focusedOption = interaction.options.getFocused(true);

    if (focusedOption.name === "form-name" || focusedOption.name === "name") {
        try {
            const [forms] = await pool.execute(
                "SELECT form_name FROM ticket_forms WHERE guild_id = ? AND form_name LIKE ?",
                [interaction.guild.id, `${focusedOption.value}%`]
            );
            await interaction.respond(
                forms.map(form => ({ name: form.form_name, value: form.form_name }))
            );
        } catch (e) {
            await interaction.respond([]);
        }
    }
}

/**
 * Execute handler for /support forms subcommands.
 * Routes to: create, delete, add-question, list
 */
async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // Permission check: ManageGuild required
    const member = interaction.member;
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
            content: "You must have the 'Manage Server' permission to manage ticket forms.",
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        if (subcommand === "create") {
            const name = interaction.options.getString("name", true);
            await pool.execute(
                "INSERT INTO ticket_forms (guild_id, form_name) VALUES (?, ?)",
                [guildId, name]
            );
            await interaction.editReply(`Form \`${name}\` created. You can now add questions to it with \`/support forms add-question\`.`);

        } else if (subcommand === "delete") {
            const name = interaction.options.getString("name", true);
            const [result] = await pool.execute(
                "DELETE FROM ticket_forms WHERE guild_id = ? AND form_name = ?",
                [guildId, name]
            );

            if (result.affectedRows > 0) {
                await interaction.editReply(`Form \`${name}\` and all its questions have been deleted.`);
            } else {
                await interaction.editReply(`Form \`${name}\` not found.`);
            }

        } else if (subcommand === "add-question") {
            const formName = interaction.options.getString("form-name", true);
            const questionText = interaction.options.getString("question-text", true);
            const questionType = interaction.options.getString("question-type", true);

            const [forms] = await pool.execute(
                "SELECT form_id FROM ticket_forms WHERE guild_id = ? AND form_name = ?",
                [guildId, formName]
            );

            if (forms.length === 0) {
                await interaction.editReply(`Form \`${formName}\` not found.`);
                return;
            }

            await pool.execute(
                "INSERT INTO ticket_form_questions (form_id, question_text, question_type) VALUES (?, ?, ?)",
                [forms[0].form_id, questionText, questionType]
            );
            await interaction.editReply(`Added question to form \`${formName}\`.`);

        } else if (subcommand === "list") {
            const [forms] = await pool.execute(
                "SELECT form_id, form_name FROM ticket_forms WHERE guild_id = ?",
                [guildId]
            );

            if (forms.length === 0) {
                await interaction.editReply("No ticket forms have been created on this server yet.\n\nUse `/support forms create` to get started.");
                return;
            }

            const embed = new EmbedBuilder()
                .setColor("#5865F2")
                .setTitle("Ticket Forms");

            for (const form of forms) {
                const [questions] = await pool.execute(
                    "SELECT question_text, question_type FROM ticket_form_questions WHERE form_id = ?",
                    [form.form_id]
                );
                const questionList = questions.map(q => `> \u2022 ${q.question_text} (*${q.question_type}*)`).join("\n") || "> No questions yet.";
                embed.addFields({ name: form.form_name, value: questionList });
            }

            await interaction.editReply({ embeds: [embed] });
        }
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            await interaction.editReply("A form with that name already exists.");
        } else if (error.code === "ER_NO_SUCH_TABLE") {
            await interaction.editReply("The database tables for this feature have not been created yet. Please ask the bot owner to update the schema.");
        } else {
            logger.error("[Support Forms Command Error]", error);
            await interaction.editReply("An error occurred while managing ticket forms.");
        }
    }
}

export { execute, autocomplete };
