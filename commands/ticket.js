"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const data = new discord_js_1.SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Manage support tickets.")
    .setDefaultMemberPermissions(discord_js_1.PermissionsBitField.Flags.ManageMessages)
    .addSubcommand(subcommand => subcommand
    .setName("claim")
    .setDescription("Claims the current ticket for yourself."))
    .addSubcommand(subcommand => subcommand
    .setName("unclaim")
    .setDescription("Releases the current ticket, making it available for others."))
    .addSubcommand(subcommand => subcommand
    .setName("transfer")
    .setDescription("Transfers the current ticket to another staff member.")
    .addUserOption(option => option.setName("member")
    .setDescription("The staff member to transfer the ticket to.")
    .setRequired(true)))
    .addSubcommandGroup(group => group
    .setName('forms')
    .setDescription('Create custom forms users fill out when opening tickets (collects info upfront).')
    .addSubcommand(subcommand => subcommand
    .setName("create")
    .setDescription("Create a new form template that users fill out before creating a ticket.")
    .addStringOption(option => option.setName("name")
    .setDescription("A unique name to identify this form (e.g., 'Bug Report', 'Support Request').")
    .setRequired(true)))
    .addSubcommand(subcommand => subcommand
    .setName("delete")
    .setDescription("Delete a ticket form and all its questions permanently.")
    .addStringOption(option => option.setName("name")
    .setDescription("The name of the form to delete.")
    .setRequired(true)
    .setAutocomplete(true)))
    .addSubcommand(subcommand => subcommand
    .setName("add-question")
    .setDescription("Add a question/field to a form (users will answer when creating tickets).")
    .addStringOption(option => option.setName("form-name")
    .setDescription("Which form to add this question to.")
    .setRequired(true)
    .setAutocomplete(true))
    .addStringOption(option => option.setName("question-text")
    .setDescription("The question you want to ask (e.g., 'What issue are you experiencing?').")
    .setRequired(true))
    .addStringOption(option => option.setName("question-type")
    .setDescription("How should users answer this question?")
    .setRequired(true)
    .addChoices({ name: "Short Text (Single Line)", value: "text" }, { name: "Paragraph (Multi-Line)", value: "paragraph" })))
    .addSubcommand(subcommand => subcommand
    .setName("list")
    .setDescription("View all ticket forms and their questions configured for this server.")));
async function autocomplete(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const focusedOption = interaction.options.getFocused(true);
    if (subcommandGroup === 'forms') {
        if (focusedOption.name === "form-name" || focusedOption.name === "name") {
            try {
                const [forms] = await db_1.default.execute("SELECT form_name FROM ticket_forms WHERE guild_id = ? AND form_name LIKE ?", [interaction.guild.id, `${focusedOption.value}%`]);
                await interaction.respond(forms.map(form => ({ name: form.form_name, value: form.form_name })));
            }
            catch (e) {
                await interaction.respond([]);
            }
        }
    }
}
async function execute(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;
    if (subcommandGroup === 'forms') {
        const member = interaction.member;
        if (!member.permissions.has(discord_js_1.PermissionsBitField.Flags.ManageGuild)) {
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
                await db_1.default.execute("INSERT INTO ticket_forms (guild_id, form_name) VALUES (?, ?)", [guildId, name]);
                await interaction.editReply(`✅ Form \`${name}\` created. You can now add questions to it.`);
            }
            else if (subcommand === "delete") {
                const name = interaction.options.getString("name", true);
                const [result] = await db_1.default.execute("DELETE FROM ticket_forms WHERE guild_id = ? AND form_name = ?", [guildId, name]);
                if (result.affectedRows > 0) {
                    await interaction.editReply(`🗑️ Form \`${name}\` and all its questions have been deleted.`);
                }
                else {
                    await interaction.editReply(`❌ Form \`${name}\` not found.`);
                }
            }
            else if (subcommand === "add-question") {
                const formName = interaction.options.getString("form-name", true);
                const questionText = interaction.options.getString("question-text", true);
                const questionType = interaction.options.getString("question-type", true);
                const [[form]] = await db_1.default.execute("SELECT form_id FROM ticket_forms WHERE guild_id = ? AND form_name = ?", [guildId, formName]);
                if (!form) {
                    await interaction.editReply(`❌ Form \`${formName}\` not found.`);
                    return;
                }
                await db_1.default.execute("INSERT INTO ticket_form_questions (form_id, question_text, question_type) VALUES (?, ?, ?)", [form.form_id, questionText, questionType]);
                await interaction.editReply(`✅ Added question to form \`${formName}\`.`);
            }
            else if (subcommand === "list") {
                const [forms] = await db_1.default.execute("SELECT form_id, form_name FROM ticket_forms WHERE guild_id = ?", [guildId]);
                if (forms.length === 0) {
                    await interaction.editReply("No ticket forms have been created on this server yet.");
                    return;
                }
                const embed = new discord_js_1.EmbedBuilder()
                    .setColor("#5865F2")
                    .setTitle("Ticket Forms");
                for (const form of forms) {
                    const [questions] = await db_1.default.execute("SELECT question_text, question_type FROM ticket_form_questions WHERE form_id = ?", [form.form_id]);
                    const questionList = questions.map(q => `> • ${q.question_text} (*${q.question_type}*)`).join("\n") || "> No questions yet.";
                    embed.addFields({ name: `📄 ${form.form_name}`, value: questionList });
                }
                await interaction.editReply({ embeds: [embed] });
            }
        }
        catch (error) {
            if (error.code === "ER_DUP_ENTRY") {
                await interaction.editReply("A form with that name already exists.");
            }
            else if (error.code === "ER_NO_SUCH_TABLE") {
                await interaction.editReply("The database tables for this feature have not been created yet. Please ask the bot owner to update the schema.");
            }
            else {
                logger_1.default.error("[Ticket Forms Command Error]", error);
                await interaction.editReply("An error occurred while managing ticket forms.");
            }
        }
    }
    else {
        await interaction.deferReply({ ephemeral: true });
        const channelId = interaction.channel.id;
        const staffMember = interaction.member;
        try {
            const [[ticket]] = await db_1.default.execute("SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?", [guildId, channelId]);
            if (!ticket) {
                await interaction.editReply("This command can only be used in an active ticket channel.");
                return;
            }
            if (ticket.status === "closed") {
                await interaction.editReply("This ticket has already been closed.");
                return;
            }
            const [[config]] = await db_1.default.execute("SELECT support_role_id FROM ticket_config WHERE guild_id = ?", [guildId]);
            const isSupportStaff = config && staffMember.roles.cache.has(config.support_role_id);
            if (!isSupportStaff) {
                await interaction.editReply("You do not have the required support role to manage tickets.");
                return;
            }
            if (subcommand === "claim") {
                if (ticket.claimed_by_id) {
                    const claimedUser = await interaction.client.users.fetch(ticket.claimed_by_id).catch(() => null);
                    const claimedBy = claimedUser ? claimedUser.tag : "an unknown user";
                    await interaction.editReply(`This ticket has already been claimed by ${claimedBy}.`);
                    return;
                }
                await db_1.default.execute("UPDATE tickets SET claimed_by_id = ? WHERE id = ?", [staffMember.id, ticket.id]);
                const claimEmbed = new discord_js_1.EmbedBuilder()
                    .setColor("#F1C40F")
                    .setDescription(`🎟️ This ticket has been claimed by ${staffMember}.`);
                const channel = interaction.channel;
                await channel.send({ embeds: [claimEmbed] });
                await interaction.editReply("You have successfully claimed this ticket.");
                logger_1.default.info(`Ticket #${ticket.id} claimed by ${staffMember.user.tag}`, { guildId, category: "tickets" });
            }
            else if (subcommand === "unclaim") {
                const isAdmin = staffMember.permissions.has(discord_js_1.PermissionsBitField.Flags.Administrator);
                if (!ticket.claimed_by_id) {
                    await interaction.editReply("This ticket is not currently claimed.");
                    return;
                }
                if (ticket.claimed_by_id !== staffMember.id && !isAdmin) {
                    await interaction.editReply("You can only unclaim a ticket that you have claimed yourself.");
                    return;
                }
                await db_1.default.execute("UPDATE tickets SET claimed_by_id = NULL WHERE id = ?", [ticket.id]);
                const unclaimEmbed = new discord_js_1.EmbedBuilder()
                    .setColor("#E67E22")
                    .setDescription(`🎟️ This ticket has been unclaimed by ${staffMember} and is now open for anyone to handle.`);
                const channel = interaction.channel;
                await channel.send({ embeds: [unclaimEmbed] });
                await interaction.editReply("You have successfully unclaimed this ticket.");
                logger_1.default.info(`Ticket #${ticket.id} unclaimed by ${staffMember.user.tag}`, { guildId, category: "tickets" });
            }
            else if (subcommand === "transfer") {
                const newStaff = interaction.options.getMember("member");
                if (!newStaff || !config || !newStaff.roles.cache.has(config.support_role_id)) {
                    await interaction.editReply("The selected user is not a valid support staff member.");
                    return;
                }
                if (ticket.claimed_by_id === newStaff.id) {
                    await interaction.editReply("This ticket is already claimed by that staff member.");
                    return;
                }
                await db_1.default.execute("UPDATE tickets SET claimed_by_id = ? WHERE id = ?", [newStaff.id, ticket.id]);
                const transferEmbed = new discord_js_1.EmbedBuilder()
                    .setColor("#3498DB")
                    .setDescription(`🎟️ This ticket has been transferred from ${staffMember} to ${newStaff}.`);
                const channel = interaction.channel;
                await channel.send({ embeds: [transferEmbed] });
                await interaction.editReply(`You have successfully transferred the ticket to ${newStaff.user.tag}.`);
                logger_1.default.info(`Ticket #${ticket.id} transferred from ${staffMember.user.tag} to ${newStaff.user.tag}`, { guildId, category: "tickets" });
            }
        }
        catch (error) {
            if (error.code === "ER_NO_SUCH_TABLE" || error.code === "ER_BAD_FIELD_ERROR") {
                await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
            }
            else {
                logger_1.default.error(`[Ticket Command: ${subcommand}] Error`, error);
                await interaction.editReply("An error occurred while processing this ticket command.");
            }
        }
    }
}
// Export using CommonJS pattern
module.exports = {
    data,
    autocomplete,
    execute,
    category: "Moderation"
};
