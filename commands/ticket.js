const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Manage support tickets.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .addSubcommand(subcommand =>
      subcommand
        .setName("claim")
        .setDescription("Claims the current ticket for yourself.")
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("unclaim")
        .setDescription("Releases the current ticket, making it available for others.")
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("transfer")
        .setDescription("Transfers the current ticket to another staff member.")
        .addUserOption(option =>
          option.setName("member")
            .setDescription("The staff member to transfer the ticket to.")
            .setRequired(true)
        )
    )
    .addSubcommandGroup(group =>
        group
            .setName('forms')
            .setDescription('Manage pre-ticket submission forms.')
            .addSubcommand(subcommand =>
              subcommand
                .setName("create")
                .setDescription("Creates a new ticket form.")
                .addStringOption(option => option.setName("name").setDescription("A unique name for the form.").setRequired(true))
            )
            .addSubcommand(subcommand =>
              subcommand
                .setName("delete")
                .setDescription("Deletes a ticket form and its questions.")
                .addStringOption(option => option.setName("name").setDescription("The name of the form to delete.").setRequired(true).setAutocomplete(true))
            )
            .addSubcommand(subcommand =>
              subcommand
                .setName("add-question")
                .setDescription("Adds a question to a form.")
                .addStringOption(option => option.setName("form-name").setDescription("The form to add the question to.").setRequired(true).setAutocomplete(true))
                .addStringOption(option => option.setName("question-text").setDescription("The text of the question.").setRequired(true))
                .addStringOption(option =>
                  option.setName("question-type")
                    .setDescription("The type of input for the question.")
                    .setRequired(true)
                    .addChoices(
                      {name: "Short Text (Single Line)", value: "text"},
                      {name: "Paragraph (Multi-Line)", value: "paragraph"}
                    )
                )
            )
            .addSubcommand(subcommand =>
              subcommand
                .setName("list")
                .setDescription("Lists all ticket forms and their questions.")
            )
    ),

  async autocomplete(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const focusedOption = interaction.options.getFocused(true);

    if (subcommandGroup === 'forms') {
        if (focusedOption.name === "form-name" || focusedOption.name === "name") {
            try {
                const [forms] = await db.execute("SELECT form_name FROM ticket_forms WHERE guild_id = ? AND form_name LIKE ?", [interaction.guild.id, `${focusedOption.value}%`]);
                await interaction.respond(forms.map(form => ({name: form.form_name, value: form.form_name})));
            } catch (e) {
                await interaction.respond([]);
            }
        }
    }
  },

  async execute(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (subcommandGroup === 'forms') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return interaction.reply({ content: "You must have the 'Manage Server' permission to manage ticket forms.", ephemeral: true });
        }
        await interaction.deferReply({ephemeral: true});
        try {
            if (subcommand === "create") {
                const name = interaction.options.getString("name");
                await db.execute("INSERT INTO ticket_forms (guild_id, form_name) VALUES (?, ?)", [guildId, name]);
                await interaction.editReply(`✅ Form \`${name}\` created. You can now add questions to it.`);
            } else if (subcommand === "delete") {
                const name = interaction.options.getString("name");
                const [result] = await db.execute("DELETE FROM ticket_forms WHERE guild_id = ? AND form_name = ?", [guildId, name]);
                if (result.affectedRows > 0) {
                    await interaction.editReply(`🗑️ Form \`${name}\` and all its questions have been deleted.`);
                } else {
                    await interaction.editReply(`❌ Form \`${name}\` not found.`);
                }
            } else if (subcommand === "add-question") {
                const formName = interaction.options.getString("form-name");
                const questionText = interaction.options.getString("question-text");
                const questionType = interaction.options.getString("question-type");

                const [[form]] = await db.execute("SELECT form_id FROM ticket_forms WHERE guild_id = ? AND form_name = ?", [guildId, formName]);
                if (!form) {
                    return interaction.editReply(`❌ Form \`${formName}\` not found.`);
                }

                await db.execute("INSERT INTO ticket_form_questions (form_id, question_text, question_type) VALUES (?, ?, ?)", [form.form_id, questionText, questionType]);
                await interaction.editReply(`✅ Added question to form \`${formName}\`.`);
            } else if (subcommand === "list") {
                const [forms] = await db.execute("SELECT form_id, form_name FROM ticket_forms WHERE guild_id = ?", [guildId]);
                if (forms.length === 0) {
                    return interaction.editReply("No ticket forms have been created on this server yet.");
                }

                const embed = new EmbedBuilder().setColor("#5865F2").setTitle("Ticket Forms");
                for (const form of forms) {
                    const [questions] = await db.execute("SELECT question_text, question_type FROM ticket_form_questions WHERE form_id = ?", [form.form_id]);
                    const questionList = questions.map(q => `> • ${q.question_text} (*${q.question_type}*)`).join("\n") || "> No questions yet.";
                    embed.addFields({name: `📄 ${form.form_name}`, value: questionList});
                }
                await interaction.editReply({embeds: [embed]});
            }
        } catch (error) {
            if (error.code === "ER_DUP_ENTRY") {
                await interaction.editReply("A form with that name already exists.");
            } else if (error.code === "ER_NO_SUCH_TABLE") {
                await interaction.editReply("The database tables for this feature have not been created yet. Please ask the bot owner to update the schema.");
            } else {
                logger.error("[Ticket Forms Command Error]", error);
                await interaction.editReply("An error occurred while managing ticket forms.");
            }
        }
    } else {
        await interaction.deferReply({ephemeral: true});
        const channelId = interaction.channel.id;
        const staffMember = interaction.member;

        try {
            const [[ticket]] = await db.execute("SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?", [guildId, channelId]);
            if (!ticket) {
                return interaction.editReply("This command can only be used in an active ticket channel.");
            }

            if (ticket.status === "closed") {
                return interaction.editReply("This ticket has already been closed.");
            }

            const [[config]] = await db.execute("SELECT support_role_id FROM ticket_config WHERE guild_id = ?", [guildId]);
            const isSupportStaff = config && staffMember.roles.cache.has(config.support_role_id);

            if (!isSupportStaff) {
                return interaction.editReply("You do not have the required support role to manage tickets.");
            }

            if (subcommand === "claim") {
                if (ticket.claimed_by_id) {
                    const claimedUser = await interaction.client.users.fetch(ticket.claimed_by_id).catch(() => null);
                    const claimedBy = claimedUser ? claimedUser.tag : "an unknown user";
                    return interaction.editReply(`This ticket has already been claimed by ${claimedBy}.`);
                }

                await db.execute("UPDATE tickets SET claimed_by_id = ? WHERE id = ?", [staffMember.id, ticket.id]);

                const claimEmbed = new EmbedBuilder()
                    .setColor("#F1C40F")
                    .setDescription(`🎟️ This ticket has been claimed by ${staffMember}.`);

                await interaction.channel.send({embeds: [claimEmbed]});
                await interaction.editReply("You have successfully claimed this ticket.");
                logger.info(`Ticket #${ticket.id} claimed by ${staffMember.user.tag}`, {guildId, category: "tickets"});

            } else if (subcommand === "unclaim") {
                const isAdmin = staffMember.permissions.has(PermissionsBitField.Flags.Administrator);

                if (!ticket.claimed_by_id) {
                    return interaction.editReply("This ticket is not currently claimed.");
                }

                if (ticket.claimed_by_id !== staffMember.id && !isAdmin) {
                    return interaction.editReply("You can only unclaim a ticket that you have claimed yourself.");
                }

                await db.execute("UPDATE tickets SET claimed_by_id = NULL WHERE id = ?", [ticket.id]);

                const unclaimEmbed = new EmbedBuilder()
                    .setColor("#E67E22")
                    .setDescription(`🎟️ This ticket has been unclaimed by ${staffMember} and is now open for anyone to handle.`);

                await interaction.channel.send({embeds: [unclaimEmbed]});
                await interaction.editReply("You have successfully unclaimed this ticket.");
                logger.info(`Ticket #${ticket.id} unclaimed by ${staffMember.user.tag}`, {guildId, category: "tickets"});

            } else if (subcommand === "transfer") {
                const newStaff = interaction.options.getMember("member");

                if (!newStaff || !newStaff.roles.cache.has(config.support_role_id)) {
                    return interaction.editReply("The selected user is not a valid support staff member.");
                }

                if (ticket.claimed_by_id === newStaff.id) {
                    return interaction.editReply("This ticket is already claimed by that staff member.");
                }

                await db.execute("UPDATE tickets SET claimed_by_id = ? WHERE id = ?", [newStaff.id, ticket.id]);

                const transferEmbed = new EmbedBuilder()
                    .setColor("#3498DB")
                    .setDescription(`🎟️ This ticket has been transferred from ${staffMember} to ${newStaff}.`);

                await interaction.channel.send({embeds: [transferEmbed]});
                await interaction.editReply(`You have successfully transferred the ticket to ${newStaff.user.tag}.`);
                logger.info(`Ticket #${ticket.id} transferred from ${staffMember.user.tag} to ${newStaff.user.tag}`, {guildId, category: "tickets"});
            }
        } catch (error) {
            if (error.code === "ER_NO_SUCH_TABLE" || error.code === "ER_BAD_FIELD_ERROR") {
                await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
            } else {
                logger.error(`[Ticket Command: ${subcommand}] Error`, error);
                await interaction.editReply("An error occurred while processing this ticket command.");
            }
        }
    }
  },
  category: "Moderation",
};