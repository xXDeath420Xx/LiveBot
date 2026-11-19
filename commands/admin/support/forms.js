import { PermissionsBitField, EmbedBuilder } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { themeColor } from '../../../core/guild-theme.js';
import { TYPES as QUESTION_TYPES, isValidType, parseOptions, serialiseOptions } from '../../../core/form-questions.js';

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
            const [target] = await pool.execute(
                "SELECT form_id FROM ticket_forms WHERE guild_id = ? AND form_name = ?",
                [guildId, name]
            );

            if (target.length === 0) {
                await interaction.editReply(`Form \`${name}\` not found.`);
                return;
            }
            const formId = target[0].form_id;

            // A panel still pointing at this form would open nothing at all.
            const [panels] = await pool.execute(
                "SELECT panel_name FROM ticket_panels WHERE form_id = ? AND guild_id = ?",
                [formId, guildId]
            );
            if (panels.length > 0) {
                await interaction.editReply(
                    `\`${name}\` is still attached to ${panels.length === 1 ? "the panel" : "panels"} ${panels.map(p => `**${p.panel_name}**`).join(", ")}. Detach it there first.`);
                return;
            }

            // There is no ON DELETE CASCADE on these tables, so the children go explicitly —
            // otherwise they linger and get inherited by the next form to reuse the id.
            await pool.execute("DELETE FROM ticket_form_questions WHERE form_id = ?", [formId]);
            await pool.execute("DELETE FROM form_submissions WHERE form_id = ? AND guild_id = ?", [formId, guildId]);
            await pool.execute("DELETE FROM ticket_forms WHERE form_id = ? AND guild_id = ?", [formId, guildId]);

            await interaction.editReply(`Form \`${name}\`, its questions and its responses have been deleted.`);

        } else if (subcommand === "add-question") {
            const formName = interaction.options.getString("form-name", true);
            const questionText = interaction.options.getString("question-text", true);
            const questionType = interaction.options.getString("question-type", true);
            const rawChoices = interaction.options.getString("choices");
            // Absent means required — matching how every question behaved before the flag existed.
            const isRequired = interaction.options.getBoolean("required") === false ? 0 : 1;

            if (!isValidType(questionType)) {
                await interaction.editReply("That answer format isn't recognised.");
                return;
            }
            const options = serialiseOptions(questionType, rawChoices ? rawChoices.split("|") : null);
            if (QUESTION_TYPES[questionType].needsOptions && !options) {
                await interaction.editReply(
                    `A **${QUESTION_TYPES[questionType].label}** question needs choices. Add them with \`choices:\` — separate them with \`|\`, e.g. \`Twitch|YouTube|Kick\`.`);
                return;
            }

            const [forms] = await pool.execute(
                "SELECT form_id FROM ticket_forms WHERE guild_id = ? AND form_name = ?",
                [guildId, formName]
            );

            if (forms.length === 0) {
                await interaction.editReply(`Form \`${formName}\` not found.`);
                return;
            }

            const [[{ nextOrder }]] = await pool.execute(
                "SELECT COALESCE(MAX(question_order), -1) + 1 AS nextOrder FROM ticket_form_questions WHERE form_id = ?",
                [forms[0].form_id]
            );
            await pool.execute(
                `INSERT INTO ticket_form_questions
                    (form_id, question_text, question_type, question_options, is_required, question_order)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [forms[0].form_id, questionText, questionType, options, isRequired, nextOrder]
            );

            // Discord only shows five fields in a pop-up, so say it the moment a form outgrows it
            // rather than letting the sixth question silently never be asked.
            const [[{ total }]] = await pool.execute(
                "SELECT COUNT(*) AS total FROM ticket_form_questions WHERE form_id = ?",
                [forms[0].form_id]
            );
            const overflow = total > 5
                ? `\n\n:warning: This form now has **${total}** questions, but a Discord pop-up only shows **5**. Reorder them on the dashboard to choose which five get asked.`
                : "";
            await interaction.editReply(`Added question to form \`${formName}\`.${overflow}`);

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
                .setColor(themeColor(interaction.guildId, 'primary'))
                .setTitle("Ticket Forms");

            for (const form of forms) {
                const [questions] = await pool.execute(
                    "SELECT * FROM ticket_form_questions WHERE form_id = ? ORDER BY question_order ASC, question_id ASC",
                    [form.form_id]
                );
                const questionList = questions.map((q, i) => {
                    const label = QUESTION_TYPES[q.question_type]?.label || q.question_type;
                    const choices = parseOptions(q.question_options);
                    const suffix = choices.length ? ` \u2014 ${choices.join(", ")}` : "";
                    const optional = Number(q.is_required) ? "" : ", optional";
                    // Past the fifth, a question exists but will never be shown in the pop-up.
                    const cut = i >= 5 ? " :warning: not shown (Discord limit)" : "";
                    return `> ${i + 1}. ${q.question_text} (*${label}${optional}*)${suffix}${cut}`;
                }).join("\n") || "> No questions yet.";
                embed.addFields({ name: form.form_name, value: questionList.slice(0, 1024) });
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
