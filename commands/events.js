"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
// Basic time string parser (e.g., "10m", "1h", "2d")
function parseTime(timeStr) {
    const match = timeStr.match(/^(\d+)(s|m|h|d)$/);
    if (!match) {
        return null;
    }
    const value = parseInt(match[1]);
    const unit = match[2];
    let seconds = 0;
    switch (unit) {
        case "s":
            seconds = value;
            break;
        case "m":
            seconds = value * 60;
            break;
        case "h":
            seconds = value * 60 * 60;
            break;
        case "d":
            seconds = value * 24 * 60 * 60;
            break;
    }
    return new Date(Date.now() + seconds * 1000);
}
module.exports = {
    data: new discord_js_1.SlashCommandBuilder()
        .setName("events")
        .setDescription("Manage events, reminders, and welcome messages.")
        .addSubcommandGroup(group => group
        .setName("remind")
        .setDescription("Set, view, or delete reminders.")
        .addSubcommand(subcommand => subcommand
        .setName("me")
        .setDescription("Set a personal reminder (sent via DM).")
        .addStringOption(option => option.setName("when").setDescription("When to remind (e.g., 10m, 2h, 1d).").setRequired(true))
        .addStringOption(option => option.setName("message").setDescription("The reminder message.").setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName("in")
        .setDescription("Set a reminder for this channel.")
        .addStringOption(option => option.setName("when").setDescription("When to remind (e.g., 30m, 1h).").setRequired(true))
        .addStringOption(option => option.setName("message").setDescription("The reminder message.").setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName("list")
        .setDescription("View your active reminders in this server."))
        .addSubcommand(subcommand => subcommand
        .setName("delete")
        .setDescription("Delete one of your reminders.")
        .addIntegerOption(option => option.setName("id").setDescription("The ID of the reminder to delete.").setRequired(true))))
        .addSubcommandGroup(group => group
        .setName('welcome')
        .setDescription('Configure the welcome message and banner for new members.')
        .addSubcommand(subcommand => subcommand
        .setName('setup')
        .setDescription('Set up the welcome message and banner.')
        .addChannelOption(option => option.setName("channel")
        .setDescription("The channel where welcome messages will be sent.")
        .addChannelTypes(discord_js_1.ChannelType.GuildText)
        .setRequired(true))
        .addStringOption(option => option.setName("message")
        .setDescription("The welcome message. Use {user} for mention and {server} for server name."))
        .addBooleanOption(option => option.setName("enable-banner")
        .setDescription("Enable or disable the welcome banner image (default: false)."))
        .addAttachmentOption(option => option.setName("background")
        .setDescription("Upload a custom background for the welcome banner.")))),
    async execute(interaction) {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        const user = interaction.user;
        if (subcommandGroup === "remind") {
            await interaction.deferReply({ ephemeral: true });
            try {
                if (subcommand === "me" || subcommand === "in") {
                    const when = interaction.options.getString("when", true);
                    const message = interaction.options.getString("message", true);
                    const remindAt = parseTime(when);
                    if (!remindAt) {
                        await interaction.editReply("Invalid time format. Please use formats like `30m`, `2h`, `1d`.");
                        return;
                    }
                    const isDm = subcommand === "me";
                    const channelId = isDm ? user.id : interaction.channel.id;
                    await db_1.default.execute("INSERT INTO reminders (user_id, guild_id, channel_id, is_dm, remind_at, message) VALUES (?, ?, ?, ?, ?, ?)", [user.id, interaction.guild.id, channelId, isDm, remindAt, message]);
                    await interaction.editReply(`✅ Got it! I'll remind you <t:${Math.floor(remindAt.getTime() / 1000)}:R>.`);
                }
                else if (subcommand === "list") {
                    const [reminders] = await db_1.default.execute("SELECT id, remind_at, message, is_dm FROM reminders WHERE user_id = ? AND guild_id = ? AND remind_at > NOW() ORDER BY remind_at ASC", [user.id, interaction.guild.id]);
                    if (reminders.length === 0) {
                        await interaction.editReply("You have no active reminders in this server.");
                        return;
                    }
                    const embed = new discord_js_1.EmbedBuilder()
                        .setTitle("Your Active Reminders")
                        .setColor("#5865F2")
                        .setDescription(reminders.map(r => `**ID: ${r.id}** - <t:${Math.floor(new Date(r.remind_at).getTime() / 1000)}:R>\n> ${r.message.substring(0, 100)}${r.is_dm ? " (in DM)" : ""}`).join("\n\n"));
                    await interaction.editReply({ embeds: [embed] });
                }
                else if (subcommand === "delete") {
                    const reminderId = interaction.options.getInteger("id", true);
                    const [result] = await db_1.default.execute("DELETE FROM reminders WHERE id = ? AND user_id = ?", [reminderId, user.id]);
                    if (result.affectedRows > 0) {
                        await interaction.editReply(`🗑️ Reminder with ID \`${reminderId}\` has been deleted.`);
                    }
                    else {
                        await interaction.editReply("❌ No reminder found with that ID, or you do not own it.");
                    }
                }
            }
            catch (error) {
                logger_1.default.error("[Remind Command Error]", error);
                await interaction.editReply("An error occurred while managing your reminders.");
            }
        }
        else if (subcommandGroup === 'welcome') {
            const member = interaction.member;
            if (!member.permissions.has(discord_js_1.PermissionsBitField.Flags.ManageGuild)) {
                await interaction.reply({ content: "You must have the 'Manage Server' permission to use this command.", ephemeral: true });
                return;
            }
            await interaction.deferReply({ ephemeral: true });
            const channel = interaction.options.getChannel("channel", true);
            const message = interaction.options.getString("message") || "Welcome {user} to {server}!";
            const bannerEnabled = interaction.options.getBoolean("enable-banner") || false;
            const background = interaction.options.getAttachment("background");
            const guildId = interaction.guild.id;
            let backgroundUrl = null;
            if (background) {
                if (!background.contentType?.startsWith("image/")) {
                    await interaction.editReply({ content: "Background must be an image file (PNG, JPG, GIF)." });
                    return;
                }
                backgroundUrl = background.url;
            }
            try {
                await db_1.default.execute(`INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, banner_background_url)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                       channel_id = VALUES(channel_id),
                       message = VALUES(message),
                       banner_enabled = VALUES(banner_enabled),
                       banner_background_url = IF(VALUES(banner_background_url) IS NOT NULL, VALUES(banner_background_url), banner_background_url)`, [guildId, channel.id, message, bannerEnabled, backgroundUrl]);
                const embed = new discord_js_1.EmbedBuilder()
                    .setColor("#57F287")
                    .setTitle("✅ Welcome Settings Updated")
                    .setDescription(`Welcome messages will now be sent to ${channel}.`)
                    .addFields({ name: "Banner Enabled", value: bannerEnabled ? "Yes" : "No", inline: true }, { name: "Message", value: message, inline: false });
                if (backgroundUrl) {
                    embed.setImage(backgroundUrl);
                }
                await interaction.editReply({ embeds: [embed] });
            }
            catch (error) {
                logger_1.default.error("[Welcome Command Error]", error);
                await interaction.editReply({ content: "An error occurred while saving the welcome settings." });
            }
        }
    },
    category: "Events",
};
