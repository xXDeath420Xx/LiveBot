const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ticket-forms")
    .setDescription("Manage pre-ticket submission forms.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
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
    ),

  async autocomplete(interaction) {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === "form-name" || focusedOption.name === "name") {
      try {
        const [forms] = await db.execute("SELECT form_name FROM ticket_forms WHERE guild_id = ? AND form_name LIKE ?", [interaction.guild.id, `${focusedOption.value}%`]);
        await interaction.respond(forms.map(form => ({name: form.form_name, value: form.form_name})));
      } catch (e) {
        await interaction.respond([]);
      }
    }
  },

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

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
  },
};