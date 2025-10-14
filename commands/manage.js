const { SlashCommandBuilder, PermissionsBitField, StringSelectMenuBuilder, ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle, ComponentType, escapeMarkdown, ChannelType, AttachmentBuilder } = require('discord.js');
const { pendingInteractions } = require("../interactions/pending-interactions"); // Share the map
const db = require("../utils/db");
const logger = require("../utils/logger");
const twitchApi = require("../utils/twitch-api");
const kickApi = require("../utils/kick-api");
const { getYouTubeChannelId } = require("../utils/api_checks");
const { exitCycleTLSInstance } = require("../utils/tls-manager");
const { getBrowser } = require("../utils/browserManager");
const axios = require("axios");
const Papa = require("papaparse");
const apiChecks = require("../utils/api_checks");
const { logInfraction } = require("../core/moderation-manager");
const { createSnapshot } = require("../core/backup-manager");
const { invalidateCommandCache } = require("../core/custom-command-handler");
const crypto = require("crypto");

async function sendPaginatedEmbed(interaction, pages) {
  if (!pages || pages.length === 0) {
    return;
  }
  let currentPage = 0;
  const uniqueId = `listpage:${interaction.id}`;

  const createButtons = (ended = false) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`prev:${uniqueId}`).setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0 || ended),
    new ButtonBuilder().setCustomId(`next:${uniqueId}`).setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pages.length - 1 || ended)
  );

  const message = await interaction.editReply({embeds: [pages[currentPage]], components: pages.length > 1 ? [createButtons()] : [], ephemeral: true});

  if (!message || pages.length <= 1) {
    return;
  }

  const collector = message.createMessageComponentCollector({componentType: ComponentType.Button, time: 300000});

  collector.on("collect", async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({content: "You cannot use these buttons.", ephemeral: true});
    }
    i.customId.startsWith("next") ? currentPage++ : currentPage--;
    await i.update({embeds: [pages[currentPage]], components: [createButtons()]});
  });

  collector.on("end", (collected, reason) => {
    if (reason === "time") {
      message.edit({components: [createButtons(true)]}).catch(e => logger.warn(`[List Streamers] Failed to disable pagination buttons: ${e.message}`));
    }
  });
}

// Simple time string parser (e.g., "5m", "1h", "2d")
function parseDuration(durationStr) {
  const match = durationStr.match(/^(\\d+)(s|m|h|d)$/);
  if (!match) {
    return null;
  }

  const value = parseInt(match[1]);
  const unit = match[2];
  let milliseconds = 0;

  switch (unit) {
    case "s":
      milliseconds = value * 1000;
      break;
    case "m":
      milliseconds = value * 60 * 1000;
      break;
    case "h":
      milliseconds = value * 60 * 60 * 1000;
      break;
    case "d":
      milliseconds = value * 24 * 60 * 60 * 1000;
      break;
  }
  // Discord timeout max is 28 days
  if (milliseconds > 28 * 24 * 60 * 60 * 1000) {
    return 28 * 24 * 60 * 60 * 1000;
  }
  return milliseconds;
}

// Helper to parse time strings like "10s", "5m", "1h" into seconds
function parseTimeToSeconds(timeStr) {
  if (timeStr === "off" || timeStr === "0") {
    return 0;
  }
  const match = timeStr.match(/^(\\d+)(s|m|h)$/);
  if (!match) {
    return null;
  }

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 60 * 60;
  }
  return null;
}

// In a real scenario, you would use a proper password hashing library like bcrypt.
// Using crypto for demonstration purposes as it's a built-in Node module.
function verifyPassword(plainPassword, hash) {
  const [salt, key] = hash.split(":");
  const keyBuffer = Buffer.from(key, "hex");
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

const logOptions = [
  {name: "Message Deleted", value: "messageDelete"},
  {name: "Message Edited", value: "messageUpdate"},
  {name: "Member Roles Updated", value: "memberUpdate"},
  // Add more loggable events here in the future
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Commands for managing streamers, teams, and other server configurations.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommandGroup(group =>
            group
                .setName('streamer')
                .setDescription('Manage streamer profiles.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('add')
                        .setDescription('Adds a streamer to the notification list using an interactive form.')
                        .addStringOption(option =>
                            option.setName("username")
                                .setDescription("The streamer's username or channel ID. Must be the same on all chosen platforms.")
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('remove')
                        .setDescription('Removes a streamer and all their subscriptions from this server.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('edit')
                        .setDescription('Edit settings for a specific streamer subscription.')
                        .addStringOption(option =>
                            option.setName("username")
                                .setDescription("The username of the streamer to edit.")
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('list')
                        .setDescription('Lists all tracked streamers and their live status.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('check-live')
                        .setDescription("Instantly lists all currently live streamers for this server."))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('massadd')
                        .setDescription('Adds multiple streamers from a platform.')
                        .addStringOption(o => o.setName("platform").setDescription("The platform to add streamers to.").setRequired(true).addChoices(
                            {name: "Twitch", value: "twitch"}, {name: "YouTube", value: "youtube"},
                            {name: "Kick", value: "kick"}, {name: "TikTok", value: "tiktok"}, {name: "Trovo", value: "trovo"}
                        ))
                        .addStringOption(o => o.setName("usernames").setDescription("A comma-separated list of usernames or Channel IDs.").setRequired(true))
                        .addChannelOption(o => o.setName("channel").setDescription("Announce all streamers in this list to a specific channel.").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
                        .addStringOption(o => o.setName("nickname").setDescription("Apply a custom webhook nickname to all streamers in this list."))
                        .addAttachmentOption(o => o.setName("avatar").setDescription("Apply a custom webhook avatar to all streamers in this list.").setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('massremove')
                        .setDescription('Removes multiple streamers and purges their active announcements.')
                        .addStringOption(o => o.setName("platform").setDescription("The platform to remove streamers from.").setRequired(true).addChoices(
                            {name: "Twitch", value: "twitch"}, {name: "YouTube", value: "youtube"},
                            {name: "Kick", value: "kick"}, {name: "TikTok", value: "tiktok"}, {name: "Trovo", value: "trovo"}
                        ))
                        .addStringOption(o => o.setName("usernames").setDescription("A comma-separated list of usernames.").setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('importcsv')
                        .setDescription('Bulk adds/updates streamer subscriptions from a CSV file.')
                        .addAttachmentOption(o => o.setName("csvfile")
                            .setDescription("CSV Headers: platform,username,announcement_channel_id,discord_user_id,etc.")
                            .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('exportcsv')
                        .setDescription('Exports all streamer subscriptions on this server to a CSV file.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('clear')
                        .setDescription('⚠️ Deletes ALL tracked streamers from this server and purges their announcements.')))
        .addSubcommandGroup(group =>
            group
                .setName('team')
                .setDescription('Manage streaming teams.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('add')
                        .setDescription('Adds all members of a Twitch Team to the announcement list for a channel.')
                        .addStringOption(option =>
                            option.setName("team")
                                .setDescription("The name of the Twitch Team (e.g., the \\\"reeferrealm\\\" in twitch.tv/team/reeferrealm).")
                                .setRequired(true)))
                        .addChannelOption(option =>
                            option.setName("channel")
                                .setDescription("The channel where the team members will be announced.")
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('remove')
                        .setDescription('Removes all members of a Twitch Team from a channel and purges their active announcements.')
                        .addStringOption(option =>
                            option.setName("team")
                                .setDescription("The name of the Twitch Team to remove (e.g., reeferrealm).")
                                .setRequired(true))
                        .addChannelOption(option =>
                            option.setName("channel")
                                .setDescription("The channel to remove the team members and announcements from.")
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('subscribe')
                        .setDescription('Automate syncing a Twitch Team with a channel (adds/removes members).')
                        .addStringOption(option =>
                            option.setName("team")
                                .setDescription("The name of the Twitch Team to monitor (e.g., reeferrealm).")
                                .setRequired(true))
                        .addChannelOption(option =>
                            option.setName("channel")
                                .setDescription("The channel the team was synced with.")
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('unsubscribe')
                        .setDescription('Stops automatically syncing a Twitch Team with a channel.')
                        .addStringOption(option =>
                            option.setName("team")
                                .setDescription("The name of the Twitch Team to stop monitoring.")
                                .setRequired(true))
                        .addChannelOption(option =>
                            option.setName("channel")
                                .setDescription("The channel the team was synced with.")
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('importcsv')
                        .setDescription('Syncs a specific channel with a CSV, adding/updating and removing streamers.')
                        .addAttachmentOption(o => o.setName("csvfile")
                            .setDescription("CSV with headers: platform, username, discord_user_id, etc.")
                            .setRequired(true))
                        .addChannelOption(o => o.setName("channel")
                            .setDescription("The single channel to sync this team with.")
                            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                            .setRequired(true)))
        .addSubcommandGroup(group =>
            group
                .setName('config')
                .setDescription('Manage server-specific configurations.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('setchannel')
                        .setDescription('Sets the channel for live stream announcements.')
                        .addChannelOption(o => o.setName("channel").setDescription("The channel for notifications").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('setliverole')
                        .setDescription('Sets or clears the role to be assigned when a linked user goes live.')
                        .addRoleOption(option => option.setName("role").setDescription("The role to assign. Leave blank to clear/disable.").setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('set-dj-role')
                        .setDescription("Sets the DJ role. Users with this role can manage the music queue.")
                        .addRoleOption(option => option.setName("role").setDescription("The role to set as the DJ role.").setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("logging")
                        .setDescription("Configure the server audit log.")
                        .addChannelOption(option =>
                          option.setName("channel")
                            .setDescription("The channel where logs will be sent.")
                            .addChannelTypes(ChannelType.GuildText)
                            .setRequired(true)
                        )
                        .addStringOption(option =>
                          option.setName("event1")
                            .setDescription("The first event to log.")
                            .setRequired(true)
                            .addChoices(...logOptions)
                        )
                        .addStringOption(option => option.setName("event2").setDescription("An additional event to log.").addChoices(...logOptions))
                        .addStringOption(option => option.setName("event3").setDescription("An additional event to log.").addChoices(...logOptions)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('customizebot')
                        .setDescription('Changes the bot\'s appearance (nickname/avatar) on this server.')
                        .addStringOption(option =>
                            option.setName("nickname")
                                .setDescription("The new nickname for the bot on this server (32 chars max). Type \\\"reset\\\" to remove.")
                                .setRequired(false))
                        .addAttachmentOption(option =>
                            option.setName("avatar")
                                .setDescription("The new avatar the bot will use for announcements.")
                                .setRequired(false))
                        .addBooleanOption(option =>
                            option.setName("reset_avatar")
                                .setDescription("Set to true to reset the custom announcement avatar to bot default.")
                                .setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('customizechannel')
                        .setDescription('Sets a default webhook appearance for all announcements in a specific channel.')
                        .addChannelOption(option =>
                            option.setName("channel")
                                .setDescription("The channel to customize.")
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true))
                        .addStringOption(option => option.setName("nickname").setDescription("Default name for announcements in this channel. Type \\\"reset\\\" to clear."))
                        .addAttachmentOption(option => option.setName("avatar").setDescription("Default avatar for announcements in this channel (upload file)."))
                        .addStringOption(option => option.setName("avatar_url_text").setDescription("Default avatar URL (overrides file upload). Type \\\"reset\\\" to clear.")))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('customizestreamer')
                        .setDescription('Sets a custom name, avatar, or message for a specific streamer\'s announcements.')
                        .addStringOption(option =>
                            option.setName("platform")
                                .setDescription("The platform of the streamer to customize.")
                                .setRequired(true)
                                .addChoices(
                                    {name: "Twitch", value: "twitch"}, {name: "Kick", value: "kick"},
                                    {name: "YouTube", value: "youtube"}, {name: "tiktok", value: "tiktok"},
                                    {name: "Trovo", value: "trovo"}
                                ))
                        .addStringOption(option => option.setName("username").setDescription("The username of the streamer to customize.").setRequired(true).setAutocomplete(true))
                        .addChannelOption(option =>
                            option.setName("channel")
                                .setDescription("The specific channel to customize. Leave blank for the server default channel.")
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(false))
                        .addStringOption(option => option.setName("nickname").setDescription("Custom name for announcements (max 80 chars). Type \\\"reset\\\" to clear.").setMaxLength(80))
                        .addAttachmentOption(option =>
                            option.setName("avatar").setDescription("Custom avatar for announcements (upload file)."))
                        .addStringOption(option =>
                            option.setName("avatar_url_text").setDescription("Custom avatar URL (overrides file upload). Type \\\"reset\\\" to clear."))
                        .addStringOption(option => option.setName("message").setDescription("Custom message. Placeholders: {username}, {url}, etc. Type \\\"reset\\\" to clear.")))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('permissions')
                        .setDescription('Manage command permissions for roles on this server.')
                        .addRoleOption(option => option.setName("role").setDescription("The role to grant permission to.").setRequired(true))
                        .addStringOption(option => option.setName("command").setDescription("The command to grant permission for.").setRequired(true).setAutocomplete(true)))
        .addSubcommandGroup(group =>
            group
                .setName('moderation')
                .setDescription('Moderation commands.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('ban')
                        .setDescription('Bans a user from the server.')
                        .addUserOption(option =>
                            option.setName("user")
                                .setDescription("The user to ban.")
                                .setRequired(true))
                        .addStringOption(option =>
                            option.setName("reason")
                                .setDescription("The reason for the ban.")
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('unban')
                        .setDescription('Revokes a ban for a user.')
                        .addStringOption(option =>
                            option.setName("user-id")
                                .setDescription("The ID of the user to unban.")
                                .setRequired(true))
                        .addStringOption(option =>
                            option.setName("reason")
                                .setDescription("The reason for the unban.")
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('kick')
                        .setDescription('Kicks a user from the server.')
                        .addUserOption(option =>
                            option.setName("user")
                                .setDescription("The user to kick.")
                                .setRequired(true))
                        .addStringOption(option =>
                            option.setName("reason")
                                .setDescription("The reason for the kick.")
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('mute')
                        .setDescription('Times out a user, preventing them from talking or speaking.')
                        .addUserOption(option =>
                            option.setName("user")
                                .setDescription("The user to mute.")
                                .setRequired(true))
                        .addStringOption(option =>
                            option.setName("duration")
                                .setDescription("The duration of the mute (e.g., 5m, 1h, 3d). Max 28d.")
                                .setRequired(true))
                        .addStringOption(option =>
                            option.setName("reason")
                                .setDescription("The reason for the mute.")
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('unmute')
                        .setDescription('Removes a timeout from a user.')
                        .addUserOption(option =>
                            option.setName("user")
                                .setDescription("The user to unmute.")
                                .setRequired(true))
                        .addStringOption(option =>
                            option.setName("reason")
                                .setDescription("The reason for the unban.")
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('warn')
                        .setDescription('Issues a formal warning to a user.')
                        .addUserOption(option =>
                            option.setName("user")
                                .setDescription("The user to warn.")
                                .setRequired(true))
                        .addStringOption(option =>
                            option.setName("reason")
                                .setDescription("The reason for the warning.")
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('clearinfractions')
                        .setDescription('Clears a user\'s moderation history.')
                        .addUserOption(option =>
                            option.setName("user")
                                .setDescription("The user whose history you want to clear.")
                                .setRequired(true))
                        .addStringOption(option =>
                            option.setName("reason")
                                .setDescription("The reason for clearing the history.")
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('history')
                        .setDescription("Checks a user\'s moderation history.")
                        .addUserOption(option =>
                          option.setName("user")
                            .setDescription("The user to check.")
                            .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('purge')
                        .setDescription('Advanced message cleaning with filters.')
                        .addIntegerOption(option =>
                            option.setName("amount")
                                .setDescription("Number of messages to scan (up to 100).")
                                .setRequired(true)
                                .setMinValue(1)
                                .setMaxValue(100)
                        )
                        .addStringOption(option =>
                            option.setName("filter")
                                .setDescription("The type of message to clean.")
                                .setRequired(true)
                                .addChoices(
                                    {name: "All", value: "all"},
                                    {name: "User", value: "user"},
                                    {name: "Bots", value: "bots"},
                                    {name: "Contains Text", value: "text"},
                                    {name: "Has Link", value: "links"},
                                    {name: "Has Attachment", value: "files"}
                                )
                        )
                        .addUserOption(option =>
                            option.setName("user")
                                .setDescription("The user whose messages to delete (required if filter is \\\"User\\\").")
                        )
                        .addStringOption(option =>
                            option.setName("text")
                                .setDescription("The text to search for (required if filter is \\\"Contains Text\\\").")
                        )))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('quarantine')
                        .setDescription('Quarantines a user, temporarily restricting their permissions.')
                        .addUserOption(option =>
                            option.setName("user")
                                .setDescription("The user to quarantine.")
                                .setRequired(true))
                        .addBooleanOption(option =>
                            option.setName("enable")
                                .setDescription("Enable or disable quarantine for the user.")
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('slowmode')
                        .setDescription('Sets or removes a slowmode cooldown for the current channel.')
                        .addStringOption(option =>
                            option.setName("duration")
                                .setDescription("The slowmode duration (e.g., 10m, 5m, 1h) or \\\"off\\\".")
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option.setName("reason")
                                .setDescription("The reason for changing the slowmode.")
                        )))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('lock')
                        .setDescription('Locks the current channel, preventing @everyone from sending messages.')
                        .addStringOption(option =>
                            option.setName("reason")
                                .setDescription("The reason for locking the channel.")
                        ))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('unlock')
                        .setDescription('Unlocks the current channel, allowing @everyone to send messages.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('lockdown')
                        .setDescription('Locks the current channel, preventing messages. Requires a special password.')
                        .addStringOption(option =>
                            option.setName("password")
                                .setDescription("The password required to execute this sensitive action.")
                                .setRequired(true)))
                        .addBooleanOption(option =>
                            option.setName("unlock")
                                .setDescription("Set to true to unlock the channel.")
                                .setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("announce")
                        .setDescription("Sends an announcement to a specified channel.")
                        .addChannelOption(option =>
                            option.setName("channel")
                                .setDescription("The channel to send the announcement to.")
                                .addChannelTypes(ChannelType.GuildText)
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option.setName("message")
                                .setDescription("The main content of the announcement.")
                                .setRequired(true)
                        )
                        .addStringOption(option =>
                            option.setName("title")
                                .setDescription("An optional title for the embed.")
                        )
                        .addStringOption(option =>
                            option.setName("color")
                                .setDescription("An optional hex color for the embed (e.g., #3498DB).")
                        )
                        .addRoleOption(option =>
                            option.setName("mention")
                                .setDescription("An optional role to mention with the announcement.")
        .addSubcommandGroup(group =>
            group
                .setName("backup")
                .setDescription("Manage server structure backups (roles & channels).")
                .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
                .addSubcommand(subcommand =>
                  subcommand
                    .setName("create")
                    .setDescription("Creates a new backup of the server's roles and channels.")
                    .addStringOption(option => option.setName("name").setDescription("A descriptive name for this backup.").setRequired(true)))
                .addSubcommand(subcommand =>
                  subcommand
                    .setName("list")
                    .setDescription("Lists all available backups for this server."))
                .addSubcommand(subcommand =>
                  subcommand
                    .setName("load")
                    .setDescription("Restores the server structure from a backup. THIS IS DESTRUCTIVE.")
                    .addStringOption(option => option.setName("backup_id").setDescription("The ID of the backup to load.").setRequired(true)))
                .addSubcommand(subcommand =>
                  subcommand
                    .setName("delete")
                    .setDescription("Deletes a server backup.")
                    .addStringOption(option => option.setName("backup_id").setDescription("The ID of the backup to delete.").setRequired(true)))
        )
        .addSubcommandGroup(group =>
            group
                .setName('fun')
                .setDescription('Fun commands.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('coinflip')
                        .setDescription('Flips a coin.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('meme')
                        .setDescription('Sends a random meme from Reddit.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('roll')
                        .setDescription('Rolls a dice.')
                        .addIntegerOption(option => option.setName('sides').setDescription('The number of sides on the dice (default 6).').setMinValue(2).setMaxValue(100)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('cat')
                        .setDescription('Sends a random cat picture.')))
        .addSubcommandGroup(group =>
            group
                .setName('events')
                .setDescription('Event management commands.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('giveaway')
                        .setDescription('Start a giveaway.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('remind')
                        .setDescription('Set a reminder.')
                        .addStringOption(option => option.setName('time').setDescription('When to remind (e.g., 1h, 30m).').setRequired(true))
                        .addStringOption(option => option.setName('message').setDescription('What to remind you about.').setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('reactionroles')
                        .setDescription('Manage reaction roles.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('starboard')
                        .setDescription('Manage starboard settings.'))
        .addSubcommandGroup(group =>
            group
                .setName('core')
                .setDescription('Core bot commands.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('stats')
                        .setDescription('Display bot statistics.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('status')
                        .setDescription('Display bot status.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('ping')
                        .setDescription('Check bot latency.'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('globalreinit')
                        .setDescription('Reinitialize global commands (Bot Owner Only).'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('reinit')
                        .setDescription('Reinitialize guild commands (Admin Only).'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('resetdatabase')
                        .setDescription('Reset the bot\'s database (Bot Owner Only).'))
        .addSubcommandGroup(group =>
            group
                .setName("custom-command")
                .setDescription("Manage custom commands for this server.")
                .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
                .addSubcommand(subcommand =>
                  subcommand
                    .setName("create")
                    .setDescription("Creates a new, advanced custom command.")
                    .addStringOption(option => option.setName("name").setDescription("The name of the command.").setRequired(true))
                    .addStringOption(option =>
                      option.setName("action-type")
                        .setDescription("The action this command will perform.")
                        .setRequired(true)
                        .addChoices(
                          {name: "Reply with Text", value: "reply"},
                          {name: "Add Role to User", value: "add_role"},
                          {name: "Remove Role from User", value: "remove_role"}
                        )
                    )
                    .addStringOption(option => option.setName("response-or-role-id").setDescription("The text response or the ID of the role to manage.").setRequired(true))
                    .addStringOption(option => option.setName("required-roles").setDescription("Comma-separated list of role IDs required to use this command."))
                    .addStringOption(option => option.setName("allowed-channels").setDescription("Comma-separated list of channel IDs where this command can be used."))
                )
                .addSubcommand(subcommand =>
                  subcommand
                    .setName("remove")
                    .setDescription("Removes a custom command.")
                    .addStringOption(option => option.setName("name").setDescription("The name of the command to remove.").setRequired(true).setAutocomplete(true)))
                .addSubcommand(subcommand =>
                  subcommand
                    .setName("list")
                    .setDescription("Lists all custom commands on this server."))
        ),
    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const subcommandGroup = interaction.options.getSubcommandGroup();

        if (subcommandGroup === 'playlist' && focusedOption.name === "name") {
            const focusedValue = focusedOption.value;
            try {
                const [playlists] = await db.execute("SELECT name FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name LIKE ? LIMIT 25", [interaction.guild.id, interaction.user.id, `${focusedValue}%`]);
                await interaction.respond(playlists.map(p => ({name: p.name, value: p.name})));
            } catch (error) {
                console.error("[Playlist Autocomplete Error]", error);
                await interaction.respond([]);
            }
        } else if (subcommandGroup === 'tag' && focusedOption.name === "name") {
            const focusedValue = focusedOption.value;
            try {
                const [tags] = await db.execute("SELECT tag_name FROM tags WHERE guild_id = ? AND tag_name LIKE ? LIMIT 25", [interaction.guild.id, `${focusedValue}%`]);
                await interaction.respond(tags.map(tag => ({name: tag.tag_name, value: tag.tag_name})));
            } catch (error) {
                console.error("[Tag Autocomplete Error]", error);
                await interaction.respond([]);
            }
        } else if (subcommandGroup === 'config' && focusedOption.name === "command") {
            const focusedValue = focusedOption.value;
            try {
                const commandNames = Array.from(interaction.client.commands.keys());
                const filtered = commandNames.filter(name => name.startsWith(focusedValue) && name !== "permissions");
                await interaction.respond(filtered.map(name => ({name, value: name})));
            } catch (error) {
                logger.error("[Permissions Command Autocomplete Error]", error);
                await interaction.respond([]);
            }
        } else if (subcommandGroup === 'custom-command' && focusedOption.name === "name") {
            const focusedValue = focusedOption.value;
            try {
              const [commands] = await db.execute("SELECT command_name FROM custom_commands WHERE guild_id = ? AND command_name LIKE ? LIMIT 25", [interaction.guild.id, `${focusedValue}%`]);
              await interaction.respond(commands.map(cmd => ({name: cmd.command_name, value: cmd.command_name})));
            } catch (error) {
              await interaction.respond([]);
            }
        }
    },
    async execute(interaction) {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        const guild = interaction.guild;

        if (subcommandGroup === 'streamer') {
            switch (subcommand) {
                case 'add': {
                    await interaction.deferReply({flags: [MessageFlags.Ephemeral]});

                    const username = interaction.options.getString("username");
                    const discordUser = interaction.options.getUser("user");
                    const avatar = interaction.options.getAttachment("avatar");

                    let avatarUrl = null;
                    if (avatar) {
                        if (!avatar.contentType?.startsWith("image/")) {
                            return interaction.editReply({content: "The provided avatar must be an image file (PNG, JPG, GIF)."});
                        }
                        const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                        if (!tempUploadChannelId) {
                            return interaction.editReply({content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file."});
                        }
                        try {
                            const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                            if (!tempChannel || !tempChannel.isTextBased()) {
                                throw new Error("Temporary upload channel is not a text channel or was not found.");
                            }
                            const tempMessage = await tempChannel.send({files: [{attachment: avatar.url, name: avatar.name}]});
                            avatarUrl = tempMessage.attachments.first().url;
                        } catch (uploadError) {
                            console.error("[Add Streamer Command] Error uploading temporary avatar to Discord:", uploadError);
                            return interaction.editReply({content: `Failed to upload custom avatar: ${uploadError.message}. Please check bot's permissions or TEMP_UPLOAD_CHANNEL_ID.`});
                        }
                    }

                    const interactionId = interaction.id;
                    pendingInteractions.set(interactionId, {
                        username,
                        discordUserId: discordUser?.id || null,
                        avatarUrl,
                        guildId: interaction.guild.id
                    });

                    setTimeout(() => pendingInteractions.delete(interactionId), 15 * 60 * 1000); // 15 minute timeout

                    const platformSelect = new StringSelectMenuBuilder()
                        .setCustomId(`addstreamer_platforms_${interactionId}`)
                        .setPlaceholder("Select the platform(s) to add this streamer on")
                        .setMinValues(1)
                        .setMaxValues(5)
                        .addOptions([
                            {label: "Twitch", value: "twitch", emoji: "🟣"},
                            {label: "Kick", value: "kick", emoji: "🟢"},
                            {label: "YouTube", value: "youtube", emoji: "🔴"},
                            {label: "TikTok", value: "tiktok", emoji: "⚫"},
                            {label: "Trovo", value: "trovo", emoji: "🟢"},
                        ]);

                    const row = new ActionRowBuilder().addComponents(platformSelect);

                    await interaction.editReply({
                        content: `Adding streamer \`${username}\`. Please select the platforms below to continue.`,
                        components: [row]
                    });
                    break;
                }
                case 'remove': {
                    const guildId = interaction.guild.id;

                    const [streamers] = await db.execute(
                        `SELECT s.streamer_id, s.username, s.platform 
                         FROM streamers s 
                         JOIN subscriptions sub ON s.streamer_id = sub.streamer_id 
                         WHERE sub.guild_id = ? 
                         GROUP BY s.streamer_id, s.username, s.platform`,
                        [guildId]
                    );

                    if (streamers.length === 0) {
                        return interaction.reply({content: "There are no streamers configured for this server.", ephemeral: true});
                    }

                    const options = streamers.map(s => ({
                        label: `${s.username} on ${s.platform.charAt(0).toUpperCase() + s.platform.slice(1)}`,
                        value: s.streamer_id.toString(),
                    }));

                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId("remove_streamer_select")
                        .setPlaceholder("Select streamers to remove")
                        .setMinValues(1)
                        .setMaxValues(Math.min(options.length, 25))
                        .addOptions(options);

                    const row = new ActionRowBuilder().addComponents(selectMenu);

                    const replyMessage = await interaction.reply({content: "Please select the streamer(s) you want to remove:", components: [row], ephemeral: true});

                    const filter = i => i.customId === "remove_streamer_select" && i.user.id === interaction.user.id;
                    const collector = replyMessage.createMessageComponentCollector({componentType: ComponentType.Button, time: 60000});

                    collector.on("collect", async i => {
                        await i.deferUpdate();
                        const streamerIdsToRemove = i.values;

                        if (!streamerIdsToRemove || streamerIdsToRemove.length === 0) {
                            await i.editReply({content: "No streamers selected. Operation cancelled.", components: []});
                            return;
                        }

                        try {
                            await db.query("START TRANSACTION");

                            const placeholders = streamerIdsToRemove.map(() => "?").join(",");

                            const [subscriptionsResult] = await db.query(
                                `DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id IN (${placeholders})`,
                                [guildId, ...streamerIdsToRemove]
                            );

                            await db.query("COMMIT");

                            const removedCount = subscriptionsResult.affectedRows;
                            await i.editReply({content: `Successfully removed ${removedCount} subscription(s) for the selected streamer(s) from this server.`, components: []});

                        } catch (error) {
                            await db.query("ROLLBACK");
                            logger.error("[RemoveStreamer Error]", error);
                            await i.editReply({content: "An error occurred while removing the streamer(s). The operation has been cancelled.", components: []});
                        } finally {
                            collector.stop();
                        }
                    });

                    collector.on("end", (collected, reason) => {
                        if (reason === "time" && collected.size === 0) {
                            // Only edit if no interaction was collected (i.e., timeout without selection)
                            interaction.editReply({content: "Time has run out, no streamers were removed.", components: []}).catch(e => logger.warn(`[RemoveStreamer] Failed to edit reply after timeout: ${e.message}`));
                        } else if (reason !== "time") {
                            // If collector stopped for other reasons (e.g., 'collect' event called collector.stop()),
                            // the interaction has already been updated by i.editReply.
                            // No need to editReply again.
                        }
                    });
                    break;
                }
                case 'edit': {
                    await interaction.deferReply({ephemeral: true});
                    const username = interaction.options.getString("username");
                    const guildId = interaction.guild.id;

                    try {
                        const [subscriptions] = await db.execute(`
                            SELECT sub.subscription_id, sub.announcement_channel_id, s.platform, s.username, s.streamer_id
                            FROM subscriptions sub
                            JOIN streamers s ON sub.streamer_id = s.streamer_id
                            WHERE sub.guild_id = ? AND s.username = ? AND sub.team_subscription_id IS NULL
                        `, [guildId, username]);

                        if (subscriptions.length === 0) {
                            return interaction.editReply({content: `No editable (non-team) subscriptions found for "${username}" in this server.`});
                        }

                        const options = await Promise.all(subscriptions.map(async (sub) => {
                            const channel = sub.announcement_channel_id ? await interaction.guild.channels.fetch(sub.announcement_channel_id).catch(() => null) : null;
                            const channelName = channel ? `#${channel.name}` : "Server Default";
                            return {
                                label: `${sub.platform.toUpperCase()} in ${channelName}`,
                                description: `ID: ${sub.subscription_id}`,
                                value: sub.subscription_id.toString(),
                            };
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId(`editstreamer_select_${interaction.id}`)
                            .setPlaceholder("Select a subscription to edit")
                            .addOptions(options);

                        const row = new ActionRowBuilder().addComponents(selectMenu);

                        const reply = await interaction.editReply({
                            content: `Found ${subscriptions.length} subscription(s) for "${username}". Please select one to edit.`,
                            components: [row]
                        });

                        const filter = i => i.customId === `editstreamer_select_${interaction.id}` && i.user.id === interaction.user.id;
                        const collector = reply.createMessageComponentCollector({componentType: ComponentType.Button, time: 60000});

                        collector.on("collect", async i => {
                            await i.deferUpdate();
                            const subscriptionId = i.values[0];
                            const [[subDetails]] = await db.execute("SELECT * FROM subscriptions WHERE subscription_id = ?", [subscriptionId]);

                            if (!subDetails) {
                                return i.update({content: "Could not find subscription details. Please try again.", components: []});
                            }

                            const modal = new ModalBuilder()
                                .setCustomId(`editstreamer_modal_${subscriptionId}`)
                                .setTitle("Edit Subscription");

                            const messageInput = new TextInputBuilder().setCustomId("custom_message").setLabel("Custom Announcement Message").setStyle(TextInputStyle.Paragraph).setValue(subDetails.custom_message || "").setRequired(false);
                            const nicknameInput = new TextInputBuilder().setCustomId("override_nickname").setLabel("Custom Webhook Name").setStyle(TextInputStyle.Short).setValue(subDetails.override_nickname || "").setRequired(false);
                            const avatarInput = new TextInputBuilder().setCustomId("override_avatar_url").setLabel("Custom Webhook Avatar URL").setStyle(TextInputStyle.Short).setValue(subDetails.override_avatar_url || "").setRequired(false);

                            modal.addComponents(
                                new ActionRowBuilder().addComponents(messageInput),
                                new ActionRowBuilder().addComponents(nicknameInput),
                                new ActionRowBuilder().addComponents(avatarInput)
                            );

                            await i.showModal(modal);
                            collector.stop(); // Modal has been shown, stop listening for select menu interaction
                        });

                        collector.on("end", async (collected, reason) => {
                            if (reason === "time" && collected.size === 0) {
                                // Only edit if no interaction was collected (i.e., timeout without selection)
                                interaction.editReply({content: "You did not make a selection in time.", components: []}).catch(e => logger.warn(`[EditStreamer] Failed to edit reply after timeout: ${e.message}`));
                            } else if (reason !== "time") {
                                // If collector stopped for other reasons (e.g., 'collect' event called collector.stop()),
                                // the interaction has already been updated by i.editReply.
                                // No need to editReply again.
                            }
                            if (reason === "time" && collected.size === 0) {
                                logger.info(`[EditStreamer] Select menu interaction timed out for user ${interaction.user.id}.`);
                            }
                        });

                    } catch (error) {
                        logger.error("Error executing editstreamer command:", {error});
                        interaction.editReply({content: "An error occurred while fetching subscription data."});
                    }
                    break;
                }
                case 'list': {
                    await interaction.deferReply({ephemeral: true});
                    try {
                        const [allStreamers] = await db.execute(`
                            SELECT s.platform, s.username, s.discord_user_id, s.platform_user_id,
                                   a.announcement_id IS NOT NULL AS isLive
                            FROM subscriptions sub
                            JOIN streamers s ON sub.streamer_id = s.streamer_id
                            LEFT JOIN announcements a ON s.streamer_id = a.streamer_id AND sub.guild_id = a.guild_id
                            WHERE sub.guild_id = ?
                            GROUP BY s.streamer_id, s.platform, s.username, s.discord_user_id, s.platform_user_id, isLive
                            ORDER BY isLive DESC, s.platform, s.username`,
                            [interaction.guild.id]
                        );

                        if (allStreamers.length === 0) {
                            return interaction.editReply({content: "No streamers are tracked on this server."});
                        }

                        const liveCount = allStreamers.filter(s => s.isLive).length;
                        const totalCount = allStreamers.length;

                        const pages = [];
                        const pageSize = 15;
                        for (let i = 0; i < totalCount; i += pageSize) {
                            const chunk = allStreamers.slice(i, i + pageSize);
                            const description = chunk.map(s => {
                                const status = s.isLive ? "🟢" : "🔴";
                                const user = s.discord_user_id ? `(<@${s.discord_user_id}>)` : "";
                                let url;
                                switch (s.platform) {
                                    case "twitch":
                                        url = `https://www.twitch.tv/${s.username}`;
                                        break;
                                    case "youtube":
                                        url = `https://www.youtube.com/channel/${s.platform_user_id}`;
                                        break;
                                    case "kick":
                                        url = `https://kick.com/${s.username}`;
                                        break;
                                    case "tiktok":
                                        url = `https://www.tiktok.com/@${s.username}`;
                                        break;
                                    case "trovo":
                                        url = `https://trovo.live/s/${s.username}`;
                                        break;
                                    default:
                                        url = null;
                                }
                                const usernameDisplay = url ? `[**${escapeMarkdown(s.username)}**](${url})` : `**${escapeMarkdown(s.username)}**`;
                                return `${status} ${usernameDisplay} (${s.platform}) ${user}`;
                            }).join("\\n");

                            pages.push(new EmbedBuilder()
                                .setTitle(`Tracked Streamers (${liveCount} Live / ${totalCount} Total)`)
                                .setColor(liveCount > 0 ? "#57F287" : "#ED4245")
                                .setDescription(description)
                                .setFooter({text: `Page ${Math.floor(i / pageSize) + 1} of ${Math.ceil(totalCount / pageSize)}`})
                            );
                        }

                        await sendPaginatedEmbed(interaction, pages);
                    } catch (e) {
                        logger.error("[List Streamers Command Error]", e);
                        await interaction.editReply({content: "An error occurred while fetching the list."}).catch(() => {
                        });
                    }
                    break;
                }
                case 'check-live': {
                    await interaction.deferReply({ephemeral: true});

                    let browser;

                    try {
                      const [subscriptions] = await db.execute(`
                        SELECT s.streamer_id, s.platform, s.username, s.discord_user_id, s.platform_user_id
                        FROM subscriptions sub
                        JOIN streamers s ON sub.streamer_id = s.streamer_id
                        WHERE sub.guild_id = ?`,
                        [interaction.guild.id]
                      );

                      if (subscriptions.length === 0) {
                        return interaction.editReply("There are no streamers being tracked on this server.");
                      }

                      const uniqueStreamersMap = new Map();
                      subscriptions.forEach(streamer => {
                        uniqueStreamersMap.set(streamer.streamer_id, streamer);
                      });
                      const streamersToCheck = Array.from(uniqueStreamersMap.values());

                      if (streamersToCheck.some(s => ["tiktok", "youtube", "trovo"].includes(s.platform))) {
                        browser = await getBrowser();
                      }

                      const checkPromises = streamersToCheck.map(async (streamer) => {
                        let liveData = {isLive: false};
                        if (streamer.platform === "twitch") {
                          liveData = await apiChecks.checkTwitch(streamer);
                        } else if (streamer.platform === "kick") {
                          liveData = await apiChecks.checkKick(streamer.username);
                        } else if (streamer.platform === "youtube" && browser) {
                          liveData = await apiChecks.checkYouTube(streamer.platform_user_id);
                        } else if (streamer.platform === "tiktok" && browser) {
                          liveData = await apiChecks.checkTikTok(streamer.username);
                        } else if (streamer.platform === "trovo" && browser) {
                          liveData = await apiChecks.checkTrovo(streamer.username);
                        }

                        if (liveData.isLive) {
                          return {...streamer, ...liveData};
                        }
                        return null;
                      });

                      const results = await Promise.allSettled(checkPromises);
                      const liveStreamers = results
                        .filter(result => result.status === "fulfilled" && result.value !== null)
                        .map(result => result.value);

                      if (liveStreamers.length === 0) {
                        const embed = new EmbedBuilder()
                          .setColor("#ED4245")
                          .setTitle("No One is Live")
                          .setDescription("None of the tracked streamers on this server are currently live.");
                        return interaction.editReply({embeds: [embed]});
                      }

                      const platformEmojis = {twitch: "🟣", kick: "🟢", youtube: "🔴", tiktok: "⚫", trovo: "🟢", default: "⚪"};

                      const descriptionLines = liveStreamers.sort((a, b) => a.username.localeCompare(b.username)).map(s => {
                        const statusEmoji = platformEmojis[s.platform] || platformEmojis.default;
                        const discordLink = s.discord_user_id ? ` (<@${s.discord_user_id}>)` : "";
                        const platformName = s.platform.charAt(0).toUpperCase() + s.platform.slice(1);
                        return `${statusEmoji} [**${escapeMarkdown(s.username)}**](${s.url}) (${platformName})${discordLink}`;
                      });

                      const embed = new EmbedBuilder()
                        .setColor("#57F287")
                        .setTitle(`🟢 ${liveStreamers.length} Streamer(s) Currently Live`)
                        .setDescription(descriptionLines.join("\\n"))
                        .setTimestamp();

                      await interaction.editReply({embeds: [embed]});

                    } catch (e) {
                      console.error("--- Critical Error in /check-live ---", e);
                      await interaction.editReply({content: "A critical error occurred while fetching live statuses."});
                    } finally {
                      if (browser) {
                        await browser.close();
                      }
                    }
                    break;
                }
                case 'massadd': {
                    await interaction.deferReply({ephemeral: true});
                    const platform = interaction.options.getString("platform");
                    const channelOverride = interaction.options.getChannel("channel");
                    const nickname = interaction.options.getString("nickname");
                    const avatarAttachment = interaction.options.getAttachment("avatar");
                    const usernames = [...new Set(interaction.options.getString("usernames").split(",").map(name => name.trim()).filter(Boolean))];
                    if (usernames.length === 0) {
                        return interaction.editReply("Please provide at least one username.");
                    }

                    const added = [], updated = [], failed = [];
                    let browser = null;
                    let finalAvatarUrl = null;

                    try {
                        if (avatarAttachment) {
                            if (!avatarAttachment.contentType?.startsWith("image/")) {
                                return interaction.editReply({content: "The provided avatar must be an image file (PNG, JPG, GIF)."});
                            }
                            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                            if (!tempUploadChannelId) {
                                logger.error("[Mass Add Streamer] TEMP_UPLOAD_CHANNEL_ID is not configured.");
                                return interaction.editReply({content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file."});
                            }
                            try {
                                const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                                if (!tempChannel || !tempChannel.isTextBased()) {
                                    throw new Error("Temporary upload channel is not a text channel or was not found.");
                                }
                                const tempMessage = await tempChannel.send({files: [{attachment: avatar.url, name: avatar.name}]});
                                finalAvatarUrl = tempMessage.attachments.first().url;
                            } catch (uploadError) {
                                logger.error("[Mass Add Streamer] Error uploading temporary avatar to Discord:", uploadError);
                                return interaction.editReply({content: "Failed to upload custom avatar. Please check bot's permissions or TEMP_UPLOAD_CHANNEL_ID."});
                            }
                        }

                        if (platform === "youtube") {
                            browser = await getBrowser();
                        }

                        for (const username of usernames) {
                            const correctedDiscordId = null; // Mass add doesn't support linking Discord users directly per row
                            try {
                                let streamerInfo = null;
                                if (platform === "twitch") {
                                    const u = await twitchApi.getTwitchUser(username);
                                    if (u) streamerInfo = {puid: u.id, dbUsername: u.login};
                                } else if (platform === "kick") {
                                    const u = await kickApi.getKickUser(username);
                                    if (u) streamerInfo = {puid: u.id.toString(), dbUsername: u.user.username};
                                } else if (platform === "youtube") {
                                    const c = await getYouTubeChannelId(username);
                                    if (c?.channelId) streamerInfo = {puid: c.channelId, dbUsername: c.channelName || username};
                                } else if (["tiktok", "trovo"].includes(platform)) {
                                    streamerInfo = {puid: username, dbUsername: username};
                                }

                                if (!streamerInfo || !streamerInfo.puid) {
                                    failed.push(`${username} (Not Found)`);
                                    continue;
                                }

                                const [[existingStreamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", [platform, streamerInfo.puid]);
                                let streamerId = existingStreamer?.streamer_id;

                                if (!streamerId) {
                                    const [result] = await db.execute("INSERT INTO streamers (platform,username,platform_user_id,discord_user_id) VALUES (?,?,?,?)", [platform, streamerInfo.dbUsername, streamerInfo.puid, correctedDiscordId]);
                                    streamerId = result.insertId;
                                }

                                const announcementChannel = channelOverride?.id || null;

                                const [[existingSubscription]] = await db.execute(
                                    "SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?",
                                    [interaction.guild.id, streamerId, announcementChannel]
                                );

                                if (existingSubscription) {
                                    await db.execute(
                                        `UPDATE subscriptions SET override_nickname = ?, override_avatar_url = IF(? IS NOT NULL, ?, override_avatar_url) WHERE subscription_id = ?`,
                                        [nickname || null, finalAvatarUrl, finalAvatarUrl, existingSubscription.subscription_id]
                                    );
                                    updated.push(username);
                                } else {
                                    await db.execute(
                                        `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?, ?)`,
                                        [interaction.guild.id, streamerId, announcementChannel, nickname || null, finalAvatarUrl]
                                    );
                                    added.push(username);
                                }

                            } catch (e) {
                                logger.error(`[Mass Add Streamer] Error for ${username}:`, e);
                                failed.push(`${username} (API/DB Error)`);
                            }
                        }
                    } catch (e) {
                        logger.error("[Mass Add Streamer] Main Error:", e);
                        return await interaction.editReply({content: `A critical error occurred processing the command: ${e.message}`});
                    } finally {
                        if (browser) await browser.close();
                        await exitCycleTLSInstance();
                    }

                    const embed = new EmbedBuilder().setTitle("Mass Add Report").setColor("#5865F2");
                    const field = (l) => l.length > 0 ? l.join(", ").substring(0, 1020) : "None";
                    embed.addFields(
                        {name: `✅ Added (${[...new Set(added)].length} subscriptions)`, value: field(added)},
                        {name: `🔄 Updated (${[...new Set(updated)].length} subscriptions)`, value: field(updated)},
                        {name: `❌ Failed (${[...new Set(failed)].length} rows)`, value: field(failed)}
                    );

                    let footerText = [];
                    if (channelOverride) footerText.push(`Channel: #${channelOverride.name}`);
                    if (nickname) footerText.push(`Nickname: ${nickname}`);
                    if (finalAvatarUrl) footerText.push(`Avatar URL provided`);
                    if (footerText.length > 0) embed.setFooter({text: `Applied to all successful entries: ${footerText.join(' | ')}`});

                    await interaction.editReply({embeds: [embed]});
                    break;
                }
                case 'massremove': {
                    await interaction.deferReply({ephemeral: true});
                    const platform = interaction.options.getString("platform");
                    const usernames = [...new Set(interaction.options.getString("usernames").split(",").map(name => name.trim().toLowerCase()).filter(Boolean))];
                    const guildId = interaction.guild.id;

                    if (usernames.length === 0) {
                        return interaction.editReply("Please provide at least one username.");
                    }

                    const removed = [], failed = [];
                    let purgedMessageCount = 0;

                    try {
                        const usernamePlaceholders = usernames.map(() => "?").join(", ");
                        const [streamers] = await db.execute(
                            `SELECT streamer_id, LOWER(username) as lower_username FROM streamers WHERE platform = ? AND LOWER(username) IN (${usernamePlaceholders})`,
                            [platform, ...usernames]
                        );

                        const streamerMap = new Map(streamers.map(s => [s.lower_username, s.streamer_id]));

                        const idsToRemove = [];
                        for (const username of usernames) {
                            if (streamerMap.has(username)) {
                                idsToRemove.push(streamerMap.get(username));
                                removed.push(username);
                            } else {
                                failed.push(`${username} (Not Found)`);
                            }
                        }

                        if (idsToRemove.length > 0) {
                            const idPlaceholders = idsToRemove.map(() => "?").join(", ");

                            const [announcementsToPurge] = await db.execute(
                                `SELECT message_id, channel_id FROM announcements WHERE guild_id = ? AND streamer_id IN (${idPlaceholders})`,
                                [guildId, ...idsToRemove]
                            );

                            if (announcementsToPurge.length > 0) {
                                const purgePromises = announcementsToPurge.map(ann => {
                                    return interaction.client.channels.fetch(ann.channel_id)
                                        .then(channel => channel?.messages.delete(ann.message_id))
                                        .catch(e => logger.warn(`[Mass Remove Streamer] Failed to delete message ${ann.message_id} in channel ${ann.channel_id}: ${e.message}`));
                            });
                                await Promise.allSettled(purgePromises);
                                purgedMessageCount = announcementsToPurge.length;
                            }

                            await db.execute(
                                `DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id IN (${idPlaceholders})`,
                                [guildId, ...idsToRemove]
                            );
                        }

                        const embed = new EmbedBuilder().setTitle("Mass Remove Report").setColor("#f04747");
                        const field = (l) => {
                            const content = l.length > 0 ? l.join(", ") : "None";
                            return content.length > 1024 ? content.substring(0, 1020) + "..." : content;
                        };

                        embed.addFields(
                            {name: `✅ Removed (${removed.length})`, value: field(removed)},
                            {name: `❌ Failed (${failed.length})`, value: field(failed)},
                            {name: `🗑️ Announcements Purged`, value: `${purgedMessageCount} message(s)`}
                        );
                        await interaction.editReply({embeds: [embed]});
                    } catch (error) {
                        logger.error("[Mass Remove Streamer Command Error]", error);
                        await interaction.editReply("An error occurred while trying to remove streamers. Please try again later.");
                    }
                    break;
                }
                case 'importcsv': {
                    const file = interaction.options.getAttachment("csvfile");
                    if (!file.name.endsWith(".csv")) {
                        return interaction.reply({content: "Invalid file type. Must be a `.csv` file.", flags: [MessageFlags.Ephemeral]});
                    }

                    await interaction.deferReply({ephemeral: true});

                    const added = [], updated = [], failed = [];
                    let browser = null;

                    try {
                        const fileContent = await axios.get(file.url, {responseType: "text"}).then(res => res.data);
                        const {data: rows} = Papa.parse(fileContent, {header: true, skipEmptyLines: true});
                        if (!rows || rows.length === 0) {
                            return interaction.editReply({content: "CSV is empty or does not contain valid data rows."});
                        }

                        const platformsInCsv = new Set(rows.map(r => r.platform).filter(Boolean));

                        if (platformsInCsv.has("youtube")) {
                            browser = await getBrowser();
                        }

                        for (const row of rows) {
                            const {platform, username, discord_user_id, custom_message, override_nickname, override_avatar_url, announcement_channel_id} = row;
                            if (!platform || !username) {
                                failed.push(`(Skipped row: missing platform/username)`);
                                continue;
                            }

                            let correctedDiscordId = /^[0-9]+$/.test(discord_user_id) ? discord_user_id : null;
                            if (discord_user_id && !correctedDiscordId) {
                                failed.push(`${username} (Invalid Discord ID)`);
                            }

                            try {
                                let [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?", [platform, username]);
                                let streamerId = streamer?.streamer_id;

                                if (!streamerId) {
                                    let streamerInfo = null;
                                    if (platform === "twitch") {
                                        const u = await twitchApi.getTwitchUser(username);
                                        if (u) streamerInfo = {puid: u.id, dbUsername: u.login};
                                    } else if (platform === "kick") {
                                        const u = await kickApi.getKickUser(username);
                                        if (u) streamerInfo = {puid: u.id.toString(), dbUsername: u.user.username};
                                    } else if (platform === "youtube") {
                                        const c = await getYouTubeChannelId(username);
                                        if (c?.channelId) streamerInfo = {puid: c.channelId, dbUsername: c.channelName || username};
                                    } else if (["tiktok", "trovo"].includes(platform)) {
                                        streamerInfo = {puid: username, dbUsername: username};
                                    }

                                    if (!streamerInfo || !streamerInfo.puid) {
                                        failed.push(`${username} (Not Found)`);
                                        continue;
                                    }

                                    const [result] = await db.execute("INSERT INTO streamers (platform, username, platform_user_id, discord_user_id) VALUES (?, ?, ?, ?)", [platform, streamerInfo.dbUsername, streamerInfo.puid, correctedDiscordId]);
                                    streamerId = result.insertId;
                                }

                                const announcementChannel = announcement_channel_id || null;

                                const [[existingSubscription]] = await db.execute(
                                    "SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?",
                                    [interaction.guild.id, streamerId, announcementChannel]
                                );

                                if (existingSubscription) {
                                    await db.execute(
                                        `UPDATE subscriptions SET custom_message = ?, override_nickname = ?, override_avatar_url = ? WHERE subscription_id = ?`,
                                        [custom_message || null, override_nickname || null, override_avatar_url || null, existingSubscription.subscription_id]
                                    );
                                    updated.push(`${username} (Channel: ${announcementChannel || "Default"})`);
                                } else {
                                    await db.execute(
                                        `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?, ?, ?)`,
                                        [interaction.guild.id, streamerId, announcementChannel, custom_message || null, override_nickname || null, override_avatar_url || null]
                                    );
                                    added.push(`${username} (Channel: ${announcementChannel || "Default"})`);
                                }

                            } catch (err) {
                                logger.error(`[Import CSV] Row Error for ${username}:`, err);
                                failed.push(`${username}(DB Error)`);
                            }
                        }
                    } catch (e) {
                        logger.error("[Import CSV] Main Error:", e);
                        return await interaction.editReply({content: "A critical error occurred processing the file."});
                    } finally {
                        if (browser) await browser.close();
                        await exitCycleTLSInstance();
                    }

                    const embed = new EmbedBuilder().setTitle("CSV Import Complete").setColor("#5865F2");
                    const field = (l) => l.length > 0 ? [...new Set(l)].join(", ").substring(0, 1020) : "None";
                    embed.addFields(
                        {name: `✅ Added (${[...new Set(added)].length} subscriptions)`, value: field(added)},
                        {name: `🔄 Updated (${[...new Set(updated)].length} subscriptions)`, value: field(updated)},
                        {name: `❌ Failed (${[...new Set(failed)].length} rows)`, value: field(failed)}
                    );
                    await interaction.editReply({embeds: [embed]});
                    break;
                }
                case 'exportcsv': {
                    await interaction.deferReply({ephemeral: true});

                    try {
                        const [subscriptions] = await db.execute(
                            `SELECT 
                                s.platform, 
                                s.username, 
                                s.discord_user_id, 
                                sub.custom_message,
                                sub.override_nickname,
                                sub.override_avatar_url,
                                sub.announcement_channel_id
                             FROM streamers s 
                             JOIN subscriptions sub ON s.streamer_id = sub.streamer_id 
                             WHERE sub.guild_id = ?
                             ORDER BY s.platform, s.username, sub.announcement_channel_id`,
                            [interaction.guild.id]
                        );

                        if (subscriptions.length === 0) {
                            return interaction.editReply("There are no streamer subscriptions to export from this server.");
                        }

                        const formattedData = subscriptions.map(sub => ({
                            platform: sub.platform,
                            username: sub.username,
                            discord_user_id: sub.discord_user_id || "",
                            custom_message: sub.custom_message || "",
                            override_nickname: sub.override_nickname || "",
                            override_avatar_url: sub.override_avatar_url || "",
                            announcement_channel_id: sub.announcement_channel_id || ""
                        }));


                        const csv = Papa.unparse(formattedData);
                        const attachment = new AttachmentBuilder(Buffer.from(csv), {name: `streamers_export_${interaction.guild.id}.csv`});

                        await interaction.editReply({
                            content: `Here is the export of ${subscriptions.length} streamer subscriptions.`,
                            files: [attachment]
                        });

                    } catch (error) {
                        logger.error("[Export CSV Error]", error);
                        await interaction.editReply("An error occurred while exporting the streamer list.");
                    }
                    break;
                }
                case 'clear': {
                    const embed = new EmbedBuilder()
                        .setTitle("⚠️ Confirmation Required")
                        .setDescription("This will remove **ALL** streamer subscriptions and delete **ALL** active live announcements from this server. This action cannot be undone.")
                        .setColor("#FF0000");

                    const confirmButton = new ButtonBuilder()
                        .setCustomId("confirm_clear")
                        .setLabel("Yes, delete everything")
                        .setStyle(ButtonStyle.Danger);

                    const cancelButton = new ButtonBuilder()
                        .setCustomId("cancel_clear")
                        .setLabel("Cancel")
                        .setStyle(ButtonStyle.Secondary);

                    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

                    const response = await interaction.reply({
                        embeds: [embed],
                        components: [row],
                        ephemeral: true
                    });

                    const collectorFilter = i => i.user.id === interaction.user.id;
                    try {
                        const confirmation = await response.awaitMessageComponent({filter: collectorFilter, time: 60_000});

                        if (confirmation.customId === "confirm_clear") {
                            await confirmation.update({content: "⚙️ Processing... Deleting announcements and subscriptions now.", embeds: [], components: []});
                            try {
                                let purgedMessageCount = 0;
                                const [announcementsToPurge] = await db.execute(`SELECT message_id, channel_id FROM announcements WHERE guild_id = ?`, [interaction.guild.id]);

                                if (announcementsToPurge.length > 0) {
                                    const purgePromises = announcementsToPurge.map(ann => {
                                        return interaction.client.channels.fetch(ann.channel_id)
                                            .then(channel => channel?.messages.delete(ann.message_id))
                                            .catch(e => logger.warn(`Failed to delete message ${ann.message_id} in channel ${ann.channel_id}: ${e.message}`));
                            });
                                await Promise.allSettled(purgePromises);
                                purgedMessageCount = announcementsToPurge.length;
                            }

                                const [result] = await db.execute("DELETE FROM subscriptions WHERE guild_id = ?", [interaction.guild.id]);

                                await interaction.editReply({
                                    content: `✅ **Operation Complete!**\\nRemoved **${result.affectedRows}** streamer subscriptions.\\nPurged **${purgedMessageCount}** active announcement message(s).`,
                                });

                            } catch (dbError) {
                                logger.error("[Clear Streamers Command Error] Database error:", dbError);
                                await interaction.editReply({content: "❌ An error occurred while trying to clear the server. Please try again later.",});
                            }
                        } else if (confirmation.customId === "cancel_clear") {
                            await confirmation.update({
                                content: "Action cancelled.",
                                embeds: [],
                                components: []
                            });
                        }
                    } catch (e) {
                        logger.error("[Clear Streamers Command Error] Confirmation timeout or error:", e);
                        await interaction.editReply({content: "Confirmation not received within 1 minute, cancelling.", embeds: [], components: []});
                    }
                    break;
                }
                default:
                    await interaction.reply({ content: 'Invalid streamer subcommand.', ephemeral: true });
                    break;
            }
        } else if (subcommandGroup === 'team') {
            switch (subcommand) {
                case 'add': {
                    await interaction.deferReply({ephemeral: true});

                    const teamName = interaction.options.getString("team").toLowerCase();
                    const channel = interaction.options.getChannel("channel");
                    const guildId = interaction.guild.id;

                    const added = [], updated = [], failed = [];

                    try {
                        const teamMembers = await apiChecks.getTwitchTeamMembers(teamName);
                        if (!teamMembers) {
                            return interaction.editReply({content: `❌ Could not find a Twitch Team named \\\"${teamName}\\\". Please check the name and try again.`});
                        }
                        if (teamMembers.length === 0) {
                            return interaction.editReply({content: `ℹ️ The Twitch Team \\\"${teamName}\\\" does not have any members.`});
                        }

                        for (const member of teamMembers) {
                            try {
                                await db.execute(
                                    `INSERT INTO streamers (platform, platform_user_id, username) VALUES ('twitch', ?, ?)
                                                 ON DUPLICATE KEY UPDATE username = VALUES(username)`,
                                    [member.user_id, member.user_login]
                                );

                                const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", ["twitch", member.user_id]);

                                const [subResult] = await db.execute(
                                    `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)
                                                 ON DUPLICATE KEY UPDATE streamer_id = VALUES(streamer_id)`,
                                    [guildId, streamer.streamer_id, channel.id]
                                );

                                if (subResult.affectedRows > 1) { // This indicates an UPDATE happened on duplicate key
                                    updated.push(member.user_login);
                                } else {
                                    added.push(member.user_login);
                                }

                            } catch (dbError) {
                                console.error(`Error processing team member ${member.user_login}:`, dbError);
                                failed.push(`${member.user_login} (DB Error)`);
                            }
                        }

                        const embed = new EmbedBuilder()
                            .setTitle(`Twitch Team Import Report for \\"${teamName}\\\"`) // Escaped backslashes
                            .setDescription(`All members have been added/updated for announcements in ${channel}.`)
                            .setColor("#5865F2")
                            .addFields(
                                {name: `✅ Added (${added.length})`, value: added.length > 0 ? added.join(", ").substring(0, 1020) : "None"},
                                {name: `🔄 Updated/Already Existed (${updated.length})`, value: updated.length > 0 ? updated.join(", ").substring(0, 1020) : "None"},
                                {name: `❌ Failed (${failed.length})`, value: failed.length > 0 ? failed.join(", ") : "None"}
                            )
                            .setTimestamp();

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        console.error("AddTeam Command Error:", error);
                        await interaction.editReply({content: "A critical error occurred while executing the command."});
                    }
                    break;
                }
                case 'remove': {
                    await interaction.deferReply({ephemeral: true});

                    const teamName = interaction.options.getString("team").toLowerCase();
                    const channel = interaction.options.getChannel("channel");
                    const guildId = interaction.guild.id;
                    let purgedMessageCount = 0;

                    try {
                        const teamMembers = await apiChecks.getTwitchTeamMembers(teamName);
                        if (!teamMembers) {
                            return interaction.editReply({content: `❌ Could not find a Twitch Team named \`${teamName}\`.`});
                        }
                        if (teamMembers.length === 0) {
                            return interaction.editReply({content: `ℹ️ The Twitch Team \`${teamName}\` has no members to remove.`});
                        }

                        const memberUserIds = teamMembers.map(m => m.user_id);
                        if (memberUserIds.length === 0) {
                            return interaction.editReply({content: `ℹ️ No valid members found for team \`${teamName}\`.`});
                        }

                        const placeholders = memberUserIds.map(() => "?").join(",");
                        const [streamers] = await db.execute(`SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND platform_user_id IN (${placeholders})`, [...memberUserIds]);

                        if (streamers.length === 0) {
                            return interaction.editReply({content: `ℹ️ None of the members of team \`${teamName}\` were found in this server's subscription list for that channel.`});
                        }

                        const streamerIdsToRemove = streamers.map(s => s.streamer_id);
                        const subPlaceholders = streamerIdsToRemove.map(() => "?").join(",");

                        await db.query("START TRANSACTION");

                        const [announcementsToPurge] = await db.execute(
                            `SELECT message_id, channel_id FROM announcements WHERE guild_id = ? AND channel_id = ? AND streamer_id IN (${subPlaceholders})`,
                            [guildId, channel.id, ...streamerIdsToRemove]
                        );

                        if (announcementsToPurge.length > 0) {
                            const purgePromises = announcementsToPurge.map(announcement => {
                                return interaction.client.channels.fetch(announcement.channel_id)
                                    .then(announcementChannel => announcementChannel?.messages.delete(announcement.message_id))
                                    .catch(e => logger.warn(`[RemoveTeam] Failed to delete message ${announcement.message_id} in channel ${announcement.channel_id}: ${e.message}`));
                            });
                            await Promise.allSettled(purgePromises);
                            purgedMessageCount = announcementsToPurge.length;
                        }

                        const [deleteResult] = await db.execute(
                            `DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (${subPlaceholders})`,
                            [guildId, channel.id, ...streamerIdsToRemove]
                        );

                        await db.query("COMMIT");

                        const embed = new EmbedBuilder()
                            .setTitle(`Twitch Team Removal Report for "${teamName}"`)
                            .setDescription(`Successfully processed team removal from ${channel}.`)
                            .setColor("#ED4245")
                            .addFields(
                                {name: "Subscriptions Removed", value: `${deleteResult.affectedRows}`, inline: true},
                                {name: "Announcements Purged", value: `${purgedMessageCount}`, inline: true}
                            )
                            .setTimestamp();

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        await db.query("ROLLBACK");
                        logger.error("[RemoveTeam Command Error]", error);
                        await interaction.editReply({content: "A critical error occurred while executing the command. The operation has been rolled back."});
                    }
                    break;
                }
                case 'subscribe': {
                    await interaction.deferReply({ephemeral: true});

                    const teamName = interaction.options.getString("team").toLowerCase();
                    const channel = interaction.options.getChannel("channel");

                    try {
                        await db.execute(
                            "INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE team_name = VALUES(team_name), announcement_channel_id = VALUES(announcement_channel_id)",
                            [interaction.guild.id, teamName, channel.id]
                        );

                        const embed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setTitle("✅ Team Subscription Activated")
                            .setDescription(`I will now automatically keep the member list for the Twitch Team **${teamName}** in sync with ${channel}.`)
                            .setFooter({text: "The team will be checked for updates approximately every 15 minutes."});

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        logger.error("[SubscribeTeam command error]", error);
                        await interaction.editReply({content: "A database error occurred while trying to subscribe to the team."});
                    }
                    break;
                }
                case 'unsubscribe': {
                    await interaction.deferReply({ephemeral: true});

                    const teamName = interaction.options.getString("team").toLowerCase();
                    const channel = interaction.options.getChannel("channel");

                    try {
                        const [result] = await db.execute(
                            "DELETE FROM twitch_teams WHERE guild_id = ? AND announcement_channel_id = ? AND team_name = ?",
                            [interaction.guild.id, channel.id, teamName]
                        );

                        if (result.affectedRows > 0) {
                            const embed = new EmbedBuilder()
                                .setColor("#ED4245")
                                .setTitle("🗑️ Team Subscription Deactivated")
                                .setDescription(`I will no longer automatically sync the Twitch Team **${teamName}** with the channel ${channel}. Note: Existing streamers will not be removed.`);
                            await interaction.editReply({embeds: [embed]});
                        } else {
                            await interaction.editReply({content: `No subscription was found for the Twitch Team **${teamName}** in that channel.`});
                        }

                    } catch (error) {
                        logger.error("[UnsubscribeTeam command error]", error);
                        await interaction.editReply({content: "A database error occurred while trying to unsubscribe from the team."});
                    }
                    break;
                }
                case 'importcsv': {
                    const file = interaction.options.getAttachment("csvfile");
                    if (!file.name.endsWith(".csv")) {
                        return interaction.reply({content: "Invalid file type. Must be a `.csv` file.", flags: [MessageFlags.Ephemeral]});
                    }

                    await interaction.deferReply({ephemeral: true});

                    const added = [], updated = [], failed = [], removed = [];
                    let browser = null;

                    try {
                        const fileContent = await axios.get(file.url, {responseType: "text"}).then(res => res.data);
                        const {data: rows} = Papa.parse(fileContent, {header: true, skipEmptyLines: true});
                        if (!rows || rows.length === 0) {
                            return interaction.editReply({content: "CSV is empty or does not contain valid data rows."});
                        }

                        const platformsInCsv = new Set(rows.map(r => r.platform).filter(Boolean));

                        if (platformsInCsv.has("youtube")) {
                            browser = await getBrowser();
                        }

                        const targetChannelId = interaction.options.getChannel("channel").id;

                        const [existingSubsInChannel] = await db.execute(
                            "SELECT s.streamer_id, s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ?",
                            [interaction.guild.id, targetChannelId]
                        );
                        const dbStreamerMap = new Map(existingSubsInChannel.map(sub => [sub.streamer_id, sub.username]));

                        const csvStreamerIds = new Set();

                        for (const row of rows) {
                            const {platform, username, discord_user_id, custom_message, override_nickname, override_avatar_url} = row;
                            if (!platform || !username) {
                                failed.push(`(Skipped row: missing platform/username)`);
                                continue;
                            }

                            const correctedDiscordId = /^[0-9]+$/.test(discord_user_id) ? discord_user_id : null;
                            if (discord_user_id && !correctedDiscordId) {
                                failed.push(`${username} (Invalid Discord ID)`);
                            }

                            try {
                                let streamerInfo = null;
                                let [[existingStreamer]] = await db.execute("SELECT streamer_id, platform_user_id, username FROM streamers WHERE platform = ? AND username = ?", [platform, username]);

                                if (existingStreamer) {
                                    streamerInfo = {id: existingStreamer.streamer_id, puid: existingStreamer.platform_user_id, dbUsername: existingStreamer.username};
                                } else {
                                    let apiResult;
                                    if (platform === "twitch") {
                                        apiResult = await twitchApi.getTwitchUser(username);
                                        if (apiResult) streamerInfo = {puid: apiResult.id, dbUsername: apiResult.login};
                                    } else if (platform === "kick") {
                                        apiResult = await kickApi.getKickUser(username);
                                        if (apiResult) streamerInfo = {puid: apiResult.id.toString(), dbUsername: apiResult.user.username};
                                    } else if (platform === "youtube") {
                                        apiResult = await getYouTubeChannelId(username);
                                        if (apiResult?.channelId) streamerInfo = {puid: apiResult.channelId, dbUsername: apiResult.channelName || username};
                                    } else if (["tiktok", "trovo"].includes(platform)) {
                                        streamerInfo = {puid: username, dbUsername: username};
                                    }

                                    if (!streamerInfo || !streamerInfo.puid) {
                                        failed.push(`${username} (${platform}, Not Found via API)`);
                                        continue;
                                    }

                                    const [result] = await db.execute(
                                        `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)
                                                 ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=VALUES(discord_user_id)`,
                                        [platform, streamerInfo.puid, streamerInfo.dbUsername, correctedDiscordId]
                                    );
                                    const streamerId = result.insertId || (await db.execute("SELECT streamer_id FROM streamers WHERE platform=? AND platform_user_id=?", [platform, streamerInfo.puid]))[0][0].streamer_id;

                                    csvStreamerIds.add(streamerId);

                                    const [subResult] = await db.execute(
                                        `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?, ?, ?)
                                                 ON DUPLICATE KEY UPDATE custom_message=VALUES(custom_message), override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url)`,
                                        [interaction.guild.id, streamerId, targetChannelId, custom_message || null, override_nickname || null, override_avatar_url || null]
                                    );

                                    if (subResult.affectedRows > 1) {
                                        updated.push(username);
                                    } else {
                                        added.push(username);
                                    }

                                } catch (err) {
                                    logger.error(`[Import Team CSV] Row Error for ${username}:`, err);
                                    failed.push(`${username} (DB Error)`);
                                }
                            }
                        }

                        const idsToRemove = [];
                        for (const [streamerId, streamerUsername] of dbStreamerMap.entries()) {
                            if (!csvStreamerIds.has(streamerId)) {
                                idsToRemove.push(streamerId);
                                removed.push(streamerUsername);
                            }
                        }

                        if (idsToRemove.length > 0) {
                            const placeholders = idsToRemove.map(() => "?").join(",");
                            await db.execute(
                                `DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (${placeholders})`,
                                [interaction.guild.id, targetChannelId, ...idsToRemove]
                            );
                        }

                    } catch (e) {
                        logger.error("[Import Team CSV] Main Error:", e);
                        return await interaction.editReply({content: `A critical error occurred processing the file: ${e.message}`});
                    } finally {
                        if (browser) await browser.close();
                        await exitCycleTLSInstance();
                    }

                    const embed = new EmbedBuilder().setTitle(`Team Sync Complete for #${targetChannel.name}`).setColor("#5865F2");
                    const field = (l) => l.length > 0 ? [...new Set(l)].join(", ").substring(0, 1020) : "None";
                    embed.addFields(
                        {name: `✅ Added (${[...new Set(added)].length})`, value: field(added)},
                        {name: `🔄 Updated (${[...new Set(updated)].length} subscriptions)`, value: field(updated)},
                        {name: `❌ Failed (${[...new Set(failed)].length} rows)`, value: field(failed)}
                    );
                    await interaction.editReply({embeds: [embed]});
                    break;
                }
                default:
                    await interaction.reply({ content: 'Invalid team subcommand.', ephemeral: true });
                    break;
            }
        } else if (subcommandGroup === 'config') {
            switch (subcommand) {
                case 'setchannel': {
                    const channel = interaction.options.getChannel("channel");
                    const guildId = interaction.guild.id;

                    await interaction.deferReply({flags: [MessageFlags.Ephemeral]});

                    try {
                        await db.execute(
                            "INSERT INTO guilds (guild_id, announcement_channel_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id)",
                            [guildId, channel.id]
                        );

                        const embed = new EmbedBuilder()
                            .setColor("#00FF00")
                            .setTitle("✅ Channel Set!")
                            .setDescription(`Announcements will now be sent to ${channel}.`);
                        await interaction.editReply({embeds: [embed]});

                    } catch (e) {
                        logger.error("[SetChannel Error]", e);
                        await interaction.editReply({content: "An error occurred while setting the channel."});
                    }
                    break;
                }
                case 'setliverole': {
                    const role = interaction.options.getRole("role");
                    const roleId = role ? role.id : null;
                    const guildId = interaction.guild.id;

                    await interaction.deferReply({flags: [MessageFlags.Ephemeral]});

                    try {
                        if (role) {
                            const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
                            if (role.position >= botMember.roles.highest.position) {
                                return interaction.editReply({content: `Error: The "${role.name}" role is higher than my role in the server hierarchy, so I cannot assign it.`});
                            }
                        }

                        await db.execute(
                            "INSERT INTO guilds (guild_id, live_role_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE live_role_id = VALUES(live_role_id)",
                            [guildId, roleId]
                        );

                        const embed = new EmbedBuilder().setColor(role ? "#57F287" : "#ED4245").setTitle("Live Role Updated");
                        embed.setDescription(role ? `The live role has been set to ${role}.` : "The live role has been cleared and is now disabled.");
                        await interaction.editReply({embeds: [embed]});

                    } catch (e) {
                        logger.error("[SetLiveRole Error]", e);
                        await interaction.editReply({content: "A critical database error occurred."});
                    }
                    break;
                }
                case 'set-dj-role': {
                    const role = interaction.options.getRole("role");
                    const guildId = interaction.guild.id;

                    try {
                      await db.execute("INSERT INTO music_config (guild_id, dj_role_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE dj_role_id = ?", [guildId, role.id, role.id]);
                      await interaction.reply({content: `✅ The DJ role has been set to <@&${role.id}>.`, ephemeral: true});
                    } catch (error) {
                      logger.error("[Config DJ Role Error]", error);
                      await interaction.reply({content: "❌ An error occurred while setting the DJ role.", ephemeral: true});
                    }
                    break;
                }
                case 'logging': {
                    await interaction.deferReply({ephemeral: true});

                    const channel = interaction.options.getChannel("channel");
                    const enabledLogs = [
                      interaction.options.getString("event1"),
                      interaction.options.getString("event2"),
                      interaction.options.getString("event3"),
                    ].filter(Boolean); // Filter out null values

                    try {
                      await db.execute(
                        "INSERT INTO log_config (guild_id, log_channel_id, enabled_logs) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), enabled_logs = VALUES(enabled_logs)",
                        [interaction.guild.id, channel.id, JSON.stringify(enabledLogs)]
                      );

                      const embed = new EmbedBuilder()
                        .setColor("#57F287")
                        .setTitle("✅ Logging Settings Updated")
                        .setDescription(`Logs will now be sent to ${channel}.`)
                        .addFields({name: "Enabled Events", value: enabledLogs.map(log => `\`${log}\``).join(", ")});

                      await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                      logger.error("[Logging Command Error]", error);
                      await interaction.editReply({content: "An error occurred while saving logging settings."});
                    }
                    break;
                }
                case 'customizebot': {
                    await interaction.deferReply({ephemeral: true});

                    const newNickname = interaction.options.getString("nickname");
                    const newAvatar = interaction.options.getAttachment("avatar");
                    const resetAvatarFlag = interaction.options.getBoolean("reset_avatar");
                    const guildId = interaction.guild.id;

                    const shouldResetNickname = newNickname?.toLowerCase() === "reset";

                    let nicknameUpdated = false;
                    let avatarUpdated = false;
                    let avatarReset = false;
                    let finalAvatarUrlForEmbed = null;

                    try {
                        const botMember = await interaction.guild.members.fetch(interaction.client.user.id);

                        if (shouldResetNickname) {
                            try {
                                await botMember.setNickname(null);
                                await db.execute("UPDATE guilds SET bot_nickname = NULL WHERE guild_id = ?", [guildId]);
                                nicknameUpdated = true;
                            } catch (e) {
                                logger.error("[Customize Bot Command] Failed to reset nickname:", e);
                                return interaction.editReply({content: "Failed to reset nickname. My role is likely not high enough in the role list or I lack permissions."});
                            }
                        } else if (newNickname) {
                            try {
                                await botMember.setNickname(newNickname);
                                await db.execute("UPDATE guilds SET bot_nickname = ? WHERE guild_id = ?", [newNickname, guildId]);
                                nicknameUpdated = true;
                            }
                            catch (e) {
                                logger.error("[Customize Bot Command] Failed to set nickname:", e);
                                return interaction.editReply({content: "Failed to set nickname. My role is likely not high enough in the role list."});
                            }
                        }

                        let permanentAvatarUrl = undefined;
                        if (resetAvatarFlag) {
                            permanentAvatarUrl = null;
                            avatarReset = true;
                        }
                        else if (newAvatar) {
                            if (!newAvatar.contentType.startsWith("image/")) {
                                return interaction.editReply({content: "Avatar must be an image file (PNG, JPG, GIF)."});
                            }
                            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                            if (!tempUploadChannelId) {
                                return interaction.editReply({content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file."});
                            }
                            try {
                                const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                                if (!tempChannel) {
                                    throw new Error("Temporary upload channel not found.");
                                }
                                const tempMessage = await tempChannel.send({files: [{attachment: newAvatar.url, name: newAvatar.name}]});
                                finalAvatarUrl = tempMessage.attachments.first().url;
                            } catch (uploadError) {
                                logger.error("[Customize Bot Command] Error uploading temporary avatar to Discord:", uploadError);
                                return interaction.editReply({content: "Failed to upload custom avatar. Please check bot\\'s permissions or TEMP_UPLOAD_CHANNEL_ID."});
                            }
                        }

                        if (permanentAvatarUrl !== undefined) {
                            await db.execute("UPDATE guilds SET webhook_avatar_url = ? WHERE guild_id = ?", [permanentAvatarUrl, guildId]);
                            finalAvatarUrlForEmbed = permanentAvatarUrl;
                        }

                        if (!nicknameUpdated && !avatarUpdated && !avatarReset) {
                            return interaction.editReply({content: "No changes were requested."});
                        }

                        const embed = new EmbedBuilder().setColor("#57F287").setTitle("Bot Appearance Updated!");
                        let description = "";
                        if (shouldResetNickname) {
                            description += "Bot nickname has been reset to default.\\n";
                        }
                        if (nicknameUpdated) {
                            description += `Nickname set to: **${newNickname}**\\n`;
                        }

                        if (avatarReset) {
                            description += "Announcement avatar has been reset to default.\\n";
                        } else if (avatarUpdated) {
                            description += "Announcement avatar has been updated.\\n";
                        }

                        embed.setDescription(description.trim());

                        if (avatarUpdated && finalAvatarUrlForEmbed) {
                            embed.setThumbnail(finalAvatarUrlForEmbed);
                        }

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        logger.error('Customize Bot Error:', error);
                        await interaction.editReply({content: `An error occurred: ${error.message}`});
                    }
                    break;
                }
                case 'customizechannel': {
                    await interaction.deferReply({ephemeral: true});

                    const channel = interaction.options.getChannel("channel");
                    const newNickname = interaction.options.getString("nickname");
                    const newAvatarAttachment = interaction.options.getAttachment("avatar");
                    const newAvatarUrlText = interaction.options.getString("avatar_url_text");

                    if (newNickname === null && newAvatarAttachment === null && newAvatarUrlText === null) {
                        return interaction.editReply("You must provide a nickname, an avatar file, or an avatar URL to set/reset.");
                    }

                    let finalAvatarUrl = undefined;

                    try {
                        if (newAvatarAttachment) {
                            if (!newAvatarAttachment.contentType?.startsWith("image/")) {
                                return interaction.editReply({content: "Avatar must be an image file (PNG, JPG, GIF)."});
                            }
                            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                            if (!tempUploadChannelId) {
                                logger.error("[Customize Channel Command] TEMP_UPLOAD_CHANNEL_ID is not configured.");
                                return interaction.editReply({content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file."});
                            }
                            try {
                                const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                                if (!tempChannel) {
                                    throw new Error("Temporary upload channel not found.");
                                }
                                const tempMessage = await tempChannel.send({files: [{attachment: newAvatarAttachment.url, name: newAvatarAttachment.name}]});
                                finalAvatarUrl = tempMessage.attachments.first().url;
                            } catch (uploadError) {
                                logger.error("[Customize Channel Command] Error uploading temporary avatar to Discord:", uploadError);
                                return interaction.editReply({content: "Failed to upload custom avatar. Please check bot\\'s permissions or TEMP_UPLOAD_CHANNEL_ID."});
                            }
                        } else if (newAvatarUrlText !== null) {
                            if (newAvatarUrlText?.toLowerCase() === "reset" || newAvatarUrlText === "") {
                                finalAvatarUrl = null;
                            }
                            else {
                                if (!/^https?:\\/\\//.test(newAvatarUrlText)) {
                                    return interaction.editReply("The provided avatar URL must start with `http://` or `https://`.");
                                }
                                finalAvatarUrl = newAvatarUrlText;
                            }
                        }

                        const insertColumns = ["channel_id", "guild_id"];
                        const insertPlaceholders = ["?", "?"];
                        const insertValues = [channel.id, interaction.guild.id];
                        const updateClauses = [];
                        const updateValuesForDuplicateKey = [];

                        if (newNickname !== null) {
                            insertColumns.push("override_nickname");
                            insertPlaceholders.push("?");
                            const nicknameToSet = newNickname?.toLowerCase() === "reset" ? null : newNickname;
                            insertValues.push(nicknameToSet);
                            updateClauses.push("override_nickname = ?");
                            updateValuesForDuplicateKey.push(nicknameToSet);
                        }

                        if (finalAvatarUrl !== undefined) {
                            insertColumns.push("override_avatar_url");
                            insertPlaceholders.push("?");
                            insertValues.push(finalAvatarUrl);
                            updateClauses.push("override_avatar_url = ?");
                            updateValuesForDuplicateKey.push(finalAvatarUrl);
                        }

                        await db.execute(
                            `INSERT INTO channel_settings (${insertColumns.join(", ")}) 
                                 VALUES (${insertPlaceholders.join(", ")}) 
                                 ON DUPLICATE KEY UPDATE ${updateClauses.join(", ")}`,
                            [...insertValues, ...updateValuesForDuplicateKey]
                        );

                        const embed = new EmbedBuilder().setColor("#57F287").setTitle(`Channel Customization Updated for #${channel.name}`);
                        let description = "";

                        if (newNickname?.toLowerCase() === "reset") {
                            description += "Nickname has been reset to default.\\n";
                        }
                        if (newNickname) {
                            description += `Nickname set to: **${newNickname}**\\n`;
                        }
                        if (finalAvatarUrl === null) {
                            description += "Avatar has been reset to default.\\n";
                        } else if (finalAvatarUrl !== undefined) {
                            description += "Avatar has been updated.\\n";
                        }

                        embed.setDescription(description.trim());
                        if (finalAvatarUrl) {
                            embed.setThumbnail(finalAvatarUrl);
                        }

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        logger.error("[Customize Channel Error]", error);
                        await interaction.editReply(`An error occurred while updating the channel customization: ${error.message}.`);
                    }
                    break;
                }
                case 'customizestreamer': {
                    await interaction.deferReply({ephemeral: true});

                    const platform = interaction.options.getString("platform");
                    const username = interaction.options.getString("username");
                    const channel = interaction.options.getChannel("channel");
                    const targetChannelId = channel ? channel.id : null;

                    const newNickname = interaction.options.getString("nickname");
                    const newAvatarAttachment = interaction.options.getAttachment("avatar");
                    const newAvatarUrlText = interaction.options.getString("avatar_url_text");
                    const newMessage = interaction.options.getString("message");

                    if (newNickname === null && newAvatarAttachment === null && newAvatarUrlText === null && newMessage === null) {
                        return interaction.editReply("You must provide at least one item to customize (nickname, avatar, or message).");
                    }

                    let finalAvatarUrl = undefined;

                    try {
                        if (newAvatarUrlText !== null) {
                            const lowerCaseText = newAvatarUrlText.toLowerCase();
                            if (lowerCaseText === "reset" || lowerCaseText === "") {
                                finalAvatarUrl = null;
                            }
                            else {
                                if (!/^https?:\\/\\//.test(newAvatarUrlText)) {
                                    return interaction.editReply("The provided avatar URL must start with `http://` or `https://`.");
                                }
                                finalAvatarUrl = newAvatarUrlText;
                            }
                        } else if (newAvatarAttachment) {
                            if (!newAvatarAttachment.contentType?.startsWith("image/")) {
                                return interaction.editReply({content: "Avatar must be an image file (PNG, JPG, GIF)."});
                            }
                            const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                            if (!tempUploadChannelId) {
                                logger.error("[Customize Streamer Command] TEMP_UPLOAD_CHANNEL_ID is not configured.");
                                return interaction.editReply({content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file."});
                            }
                            try {
                                const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                                if (!tempChannel) {
                                    throw new Error("Temporary upload channel not found.");
                                }
                                const tempMessage = await tempChannel.send({files: [{attachment: newAvatarAttachment.url, name: newAvatarAttachment.name}]});
                                finalAvatarUrl = tempMessage.attachments.first().url;
                            } catch (uploadError) {
                                logger.error("[Customize Streamer Command] Error uploading temporary avatar to Discord:", uploadError);
                                return interaction.editReply({content: "Failed to upload custom avatar. Please check bot\\'s permissions or TEMP_UPLOAD_CHANNEL_ID."});
                            }
                        }

                        const [[streamer]] = await db.execute("SELECT s.streamer_id FROM streamers s WHERE s.platform = ? AND s.username = ?", [platform, username]);
                        if (!streamer) {
                            return interaction.editReply(`Streamer \`${username}\` (${platform}) was not found.`);
                        }

                        const [[subscription]] = await db.execute("SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?", [interaction.guild.id, streamer.streamer_id, targetChannelId]);
                        if (!subscription) {
                            const channelName = channel ? `in ${channel}` : "in the server default channel";
                            return interaction.editReply(`That streamer is not configured to announce ${channelName}.`);
                        }

                        const updates = [];
                        const values = [];

                        if (newNickname !== null) {
                            updates.push("override_nickname = ?");
                            values.push(newNickname?.toLowerCase() === "reset" ? null : newNickname);
                        }
                        if (finalAvatarUrl !== undefined) {
                            updates.push("override_avatar_url = ?");
                            values.push(finalAvatarUrl);
                        }
                        if (newMessage !== null) {
                            updates.push("custom_message = ?");
                            values.push(newMessage?.toLowerCase() === "reset" ? null : newMessage);
                        }

                        if (updates.length === 0) {
                            return interaction.editReply("No changes were made.");
                        }

                        values.push(interaction.guild.id, streamer.streamer_id, targetChannelId);

                        await db.execute(`UPDATE subscriptions SET ${updates.join(", ")} WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?`, values);

                        const embed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setTitle(`Customization updated for ${username}`)
                            .setDescription(`Settings for announcements ${channel ? `in ${channel}` : "in the server default channel"} have been updated.`);

                        if (finalAvatarUrl) {
                            embed.setThumbnail(finalAvatarUrl);
                        }

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        logger.error("[Customize Streamer Error]", error);
                        await interaction.editReply(`An error occurred while updating the streamer customization: ${error.message}`);
                    }
                    break;
                }
                case 'permissions': {
                    await interaction.deferReply({ephemeral: true});
                    const role = interaction.options.getRole("role");
                    const commandName = interaction.options.getString("command");

                    if (!interaction.client.commands.has(commandName) || commandName === "permissions") {
                        return interaction.editReply({content: "That is not a valid command to set permissions for."});
                    }

                    try {
                        // This was missing
                        const action = interaction.options.getSubcommand(); // This line was missing
                        if (action === "grant") {
                            await db.execute(
                                "INSERT INTO bot_permissions (guild_id, role_id, command) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE command=command",
                                [interaction.guild.id, role.id, commandName]
                            );
                            await interaction.editReply({embeds: [new EmbedBuilder().setColor("#57F287").setTitle("✅ Permission Granted").setDescription(`The role ${role} can now use the \`/${commandName}\` command.`)]});
                        } else if (action === "revoke") {
                            await db.execute(
                                "DELETE FROM bot_permissions WHERE guild_id = ? AND role_id = ? AND command = ?",
                                [interaction.guild.id, role.id, commandName]
                            );
                            await interaction.editReply({embeds: [new EmbedBuilder().setColor("#ED4245").setTitle("✅ Permission Revoked").setDescription(`The role ${role} can no longer use the \`/${commandName}\` command.`)]});
                        }
                    } catch (error) {
                        logger.error("[Permissions Command Error]", error);
                        await interaction.editReply({content: "An error occurred while updating permissions."});
                    }
                    break;
                }
                default:
                    await interaction.reply({ content: 'Invalid config subcommand.', ephemeral: true });
                    break;
            }
        } else if (subcommandGroup === 'moderation') {
            switch (subcommand) {
                case 'ban': {
                    await interaction.deferReply({ephemeral: true});

                    const targetUser = interaction.options.getUser("user");
                    const reason = interaction.options.getString("reason");
                    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

                    if (member && !member.bannable) {
                        return interaction.editReply("I cannot ban this user. They may have a higher role than me or I lack permissions.");
                    }
                    if (member && member.id === interaction.user.id) {
                        return interaction.editReply("You cannot ban yourself.");
                    }

                    try {
                        // Attempt to DM the user first
                        const dmEmbed = new EmbedBuilder()
                            .setColor("#E74C3C")
                            .setTitle(`You have been banned from ${interaction.guild.name}`)
                            .addFields({name: "Reason", value: reason}, {name: "Moderator", value: interaction.user.tag})
                            .setTimestamp();
                        await targetUser.send({embeds: [dmEmbed]}).catch((e) => logger.warn(`Could not DM user ${targetUser.tag}: ${e.message}`));

                        // Ban the user
                        await interaction.guild.members.ban(targetUser, {reason});

                        // Log the infraction
                        await logInfraction(interaction, targetUser, "Ban", reason);

                        const replyEmbed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setDescription(`✅ Successfully banned ${targetUser.tag}.`);

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        logger.error("[Ban Command Error]", error);
                        await interaction.editReply("An unexpected error occurred while trying to ban this user.");
                    }
                    break;
                }
                case 'unban': {
                    await interaction.deferReply({ephemeral: true});

                    const targetUserId = interaction.options.getString("user-id");
                    const reason = interaction.options.getString("reason");

                    try {
                        // Fetch the user to get their tag for logging purposes
                        const targetUser = await interaction.client.users.fetch(targetUserId);

                        // Unban the user
                        await interaction.guild.members.unban(targetUser, reason);

                        // Log the action
                        await logInfraction(interaction, targetUser, "Unban", reason);

                        const replyEmbed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setDescription(`✅ Successfully unbanned ${targetUser.tag}.`);

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        logger.error("[Unban Command Error]", error);
                        if (error.code === 10026) { // Unknown Ban
                            await interaction.editReply("Could not find a ban for that user ID.");
                        } else {
                            await interaction.editReply("An error occurred. I may be missing Ban Members permission or the User ID is invalid.");
                        }
                    }
                    break;
                }
                case 'kick': {
                    await interaction.deferReply({ephemeral: true});

                    const targetUser = interaction.options.getUser("user");
                    const reason = interaction.options.getString("reason");
                    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

                    if (!member) {
                        return interaction.editReply("Could not find that user in the server.");
                    }
                    if (member.id === interaction.user.id) {
                        return interaction.editReply("You cannot kick yourself.");
                    }
                    if (!member.kickable) {
                        return interaction.editReply("I cannot kick this user. They may have a higher role than me or I lack permissions.");
                    }

                    try {
                        // Attempt to DM the user first
                        const dmEmbed = new EmbedBuilder()
                            .setColor("#E67E22")
                            .setTitle(`You have been kicked from ${interaction.guild.name}`)
                            .addFields({name: "Reason", value: reason}, {name: "Moderator", value: interaction.user.tag})
                            .setTimestamp();
                        await targetUser.send({embeds: [dmEmbed]}).catch((e) => logger.warn(`Could not DM user ${targetUser.tag}: ${e.message}`));

                        // Kick the user
                        await member.kick(reason);

                        // Log the infraction
                        await logInfraction(interaction, targetUser, "Kick", reason);

                        const replyEmbed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setDescription(`✅ Successfully kicked ${targetUser.tag}.`);

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        logger.error("[Kick Command Error]", error);
                        await interaction.editReply("An unexpected error occurred while trying to kick this user.");
                    }
                    break;
                }
                case 'mute': {
                    await interaction.deferReply({ephemeral: true});

                    const targetUser = interaction.options.getUser("user");
                    const durationStr = interaction.options.getString("duration");
                    const reason = interaction.options.getString("reason");
                    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

                    if (!member) {
                        return interaction.editReply("Could not find that user in the server.");
                    }
                    if (member.id === interaction.user.id) {
                        return interaction.editReply("You cannot mute yourself.");
                    }
                    if (member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                        return interaction.editReply("You cannot mute another moderator.");
                    }
                    if (!member.moderatable) {
                        return interaction.editReply("I cannot mute this user. They may have a higher role than me.");
                    }

                    const durationMs = parseDuration(durationStr);
                    if (!durationMs) {
                        return interaction.editReply("Invalid duration format. Use formats like `10m`, `2h`, `1d`.");
                    }

                    try {
                        // Apply the timeout
                        await member.timeout(durationMs, reason);

                        // Log the infraction
                        const durationMinutes = Math.floor(durationMs / (60 * 1000));
                        await logInfraction(interaction, targetUser, "Mute", reason, durationMinutes);

                        // Attempt to DM the user
                        try {
                            const dmEmbed = new EmbedBuilder()
                                .setColor("#E74C3C")
                                .setTitle(`You have been muted in ${interaction.guild.name}`)
                                .addFields(
                                    {name: "Duration", value: durationStr},
                                    {name: "Reason", value: reason},
                                    {name: "Moderator", value: interaction.user.tag}
                                )
                                .setTimestamp();
                            await targetUser.send({embeds: [dmEmbed]});
                        } catch (dmError) {
                            logger.warn(`[Mute Command] Could not DM user ${targetUser.tag}: ${dmError.message}`);
                        }

                        const replyEmbed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setDescription(`✅ Successfully muted ${targetUser.tag} for ${durationStr}. Reason: ${reason}`);

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        logger.error("[Mute Command Error]", error);
                        await interaction.editReply("An unexpected error occurred while trying to mute this user.");
                    }
                    break;
                }
                case 'unmute': {
                    await interaction.deferReply({ephemeral: true});

                    const targetUser = interaction.options.getUser("user");
                    const reason = interaction.options.getString("reason");
                    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

                    if (!member) {
                        return interaction.editReply("Could not find that user in the server.");
                    }
                    if (!member.communicationDisabledUntilTimestamp) {
                        return interaction.editReply("This user is not currently muted.");
                    }

                    try {
                        // Remove the timeout
                        await member.timeout(null, reason);

                        // Log the action as a new type of "infraction" for record-keeping
                        await logInfraction(interaction, targetUser, "Unmute", reason);

                        // Attempt to DM the user
                        try {
                            const dmEmbed = new EmbedBuilder()
                                .setColor("#2ECC71")
                                .setTitle(`You have been unmuted in ${interaction.guild.name}`)
                                .addFields({name: "Reason", value: reason}, {name: "Moderator", value: interaction.user.tag})
                                .setTimestamp();
                            await targetUser.send({embeds: [dmEmbed]});
                        } catch (dmError) {
                            logger.warn(`[Unmute Command] Could not DM user ${targetUser.tag}: ${dmError.message}`);
                        }

                        const replyEmbed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setDescription(`✅ Successfully unmuted ${targetUser.tag}.`);

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        logger.error("[Unmute Command Error]", error);
                        await interaction.editReply("An unexpected error occurred. I may be missing permissions to remove timeouts.");
                    }
                    break;
                }
                case 'warn': {
                    await interaction.deferReply({ephemeral: true});

                    const targetUser = interaction.options.getUser("user");
                    const reason = interaction.options.getString("reason");

                    if (targetUser.id === interaction.user.id) {
                        return interaction.editReply("You cannot warn yourself.");
                    }
                    if (targetUser.bot) {
                        return interaction.editReply("You cannot warn a bot.");
                    }

                    // Log the infraction
                    await logInfraction(interaction, targetUser, "Warning", reason);

                    // Attempt to DM the user
                    try {
                        const dmEmbed = new EmbedBuilder()
                            .setColor("#E67E22")
                            .setTitle(`You have been warned in ${interaction.guild.name}`)
                            .addFields(
                                {name: "Reason", value: reason},
                                {name: "Moderator", value: interaction.user.tag}
                            )
                            .setTimestamp();
                        await targetUser.send({embeds: [dmEmbed]}).catch((e) => logger.warn(`[Warn Command] Could not DM user ${targetUser.tag}: ${e.message}`));
                    }

                    const replyEmbed = new EmbedBuilder()
                        .setColor("#57F287")
                        .setDescription(`✅ Successfully warned ${targetUser.tag} for: ${reason}`);

                    await interaction.editReply({embeds: [replyEmbed]});
                    break;
                }
                case 'clearinfractions': {
                    await interaction.deferReply({ephemeral: true});

                    const targetUser = interaction.options.getUser("user");
                    const reason = interaction.options.getString("reason");

                    try {
                        const [result] = await db.execute(
                            "DELETE FROM infractions WHERE guild_id = ? AND user_id = ?",
                            [interaction.guild.id, targetUser.id]
                        );

                        if (result.affectedRows > 0) {
                            // Log this action for accountability
                            await logInfraction(interaction, targetUser, "ClearInfractions", reason);

                            const replyEmbed = new EmbedBuilder()
                                .setColor("#57F287")
                                .setDescription(`✅ Successfully cleared all ${result.affectedRows} infractions for ${targetUser.tag}.`);

                            await interaction.editReply({embeds: [replyEmbed]});
                        } else {
                            await interaction.editReply(`${targetUser.tag} has no infractions to clear.`);
                        }

                    } catch (error) {
                        logger.error("[Clear Infractions Command Error]", error);
                        await interaction.editReply("An error occurred while trying to clear this user's history.");
                    }
                    break;
                }
                case 'history': {
                    await interaction.deferReply({ephemeral: true});

                    const targetUser = interaction.options.getUser("user");

                    const [infractions] = await db.execute(
                      "SELECT id, moderator_id, type, reason, created_at FROM infractions WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 10",
                      [interaction.guild.id, targetUser.id]
                    );

                    if (infractions.length === 0) {
                      return interaction.editReply(`${targetUser.tag} has a clean record.`);
                    }

                    const embed = new EmbedBuilder()
                      .setColor("#5865F2")
                      .setAuthor({name: `Moderation History for ${targetUser.tag}`, iconURL: targetUser.displayAvatarURL()})
                      .setDescription(infractions.map(inf =>
                        `**Case #${inf.id} | ${inf.type}** - <t:${Math.floor(new Date(inf.created_at).getTime() / 1000)}:R>\\n` +
                        `**Moderator:** <@${inf.moderator_id}>\\n` +
                        `**Reason:** ${inf.reason}`
                      ).join("\\n\\n"));

                    await interaction.editReply({embeds: [embed]});
                    break;
                }
                case 'purge': {
                    await interaction.deferReply({ephemeral: true});

                    const amount = interaction.options.getInteger("amount");
                    const filter = interaction.options.getString("filter");
                    const targetUser = interaction.options.getUser("user");
                    const searchText = interaction.options.getString("text");
                    const channel = interaction.channel;

                    if (channel.type !== ChannelType.GuildText) {
                      return interaction.editReply("This command can only be used in text channels.");
                    }

                    if (filter === "user" && !targetUser) {
                      return interaction.editReply("You must specify a user when using the \\\"User\\\" filter.");
                    }
                    if (filter === "text" && !searchText) {
                      return interaction.editReply("You must specify text to search for when using the \\\"Contains Text\\\" filter.");
                    }

                    try {
                      const fetchedMessages = await channel.messages.fetch({limit: amount});
                      let messagesToDelete;

                      switch (filter) {
                        case "all":
                          messagesToDelete = fetchedMessages;
                          break;
                        case "user":
                          messagesToDelete = fetchedMessages.filter(msg => msg.author.id === targetUser.id);
                          break;
                        case "bots":
                          messagesToDelete = fetchedMessages.filter(msg => msg.author.bot);
                          break;
                        case "text":
                          messagesToDelete = fetchedMessages.filter(msg => msg.content.toLowerCase().includes(searchText.toLowerCase()));
                          break;
                        case "links":
                          messagesToDelete = fetchedMessages.filter(msg => /https?:\\/\\/[^\\s]+/g.test(msg.content));
                          break;
                        case "files":
                          messagesToDelete = fetchedMessages.filter(msg => msg.attachments.size > 0);
                          break;
                        default:
                          messagesToDelete = fetchedMessages;
                      }

                      if (messagesToDelete.size === 0) {
                        return interaction.editReply("No messages found matching the specified filter.");
                      }

                      const deleted = await channel.bulkDelete(messagesToDelete, true);

                      const replyEmbed = new EmbedBuilder()
                        .setColor("#57F287")
                        .setDescription(`✅ Successfully cleaned **${deleted.size}** message(s) using the \`${filter}\` filter.`);

                      await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                      console.error("[Clean Command Error]", error);
                      await interaction.editReply("An error occurred. I may not have permission to delete messages, or the messages are older than 14 days.");
                    }
                    break;
                }
                case 'quarantine': {
                    await interaction.deferReply({ephemeral: true});

                    const user = interaction.options.getUser("user");
                    const member = interaction.guild.members.cache.get(user.id);
                    const enable = interaction.options.getBoolean("enable");
                    const guildId = interaction.guild.id;

                    if (!member) {
                        return interaction.reply({content: "That user is not in this server.", ephemeral: true});
                    }

                    try {
                        const [[quarantineConfig]] = await db.execute("SELECT is_enabled, quarantine_role_id FROM quarantine_config WHERE guild_id = ?", [guildId]);

                        if (!quarantineConfig || !quarantineConfig.is_enabled) {
                            return interaction.reply({content: "The quarantine system is not enabled for this server.", ephemeral: true});
                        }

                        const quarantineRoleId = quarantineConfig.quarantine_role_id;
                        if (!quarantineRoleId) {
                            return interaction.reply({content: "No quarantine role is configured for this server. Please configure it in the dashboard.", ephemeral: true});
                        }

                        const quarantineRole = interaction.guild.roles.cache.get(quarantineRoleId);
                        if (!quarantineRole) {
                            return interaction.reply({content: "The configured quarantine role was not found in this server. Please check your dashboard settings.", ephemeral: true});
                        }

                        if (enable) {
                            // Remove all other roles and add the quarantine role
                            const rolesToRemove = member.roles.cache.filter(role => !role.managed && role.id !== interaction.guild.id);
                            await member.roles.remove(rolesToRemove);
                            await member.roles.add(quarantineRole);
                            await interaction.reply({content: `${user.tag} has been quarantined.`, ephemeral: true});
                        } else {
                            await member.roles.remove(quarantineRole);
                            await interaction.reply({content: `${user.tag} has been released from quarantine.`, ephemeral: true});
                        }
                    } catch (error) {
                        logger.error("[Quarantine Command Error]", error);
                        await interaction.reply({content: "An error occurred while trying to toggle quarantine for the user.", ephemeral: true});
                    }
                    break;
                }
                case 'slowmode': {
                    await interaction.deferReply({ephemeral: true});
                    const durationStr = interaction.options.getString("duration").toLowerCase();
                    const reason = interaction.options.getString("reason") || "No reason provided.";
                    const channel = interaction.channel;

                    if (channel.type !== ChannelType.GuildText) {
                        return interaction.editReply({content: "This command can only be used in text channels."});
                    }

                    const seconds = parseTimeToSeconds(durationStr);

                    if (seconds === null) {
                        return interaction.editReply({content: "Invalid duration format. Use formats like `10m`, `2h`, `1d`."});
                    }

                    if (seconds > 21600) { // Discord's max is 6 hours (21600 seconds)
                        return interaction.editReply({content: "The maximum slowmode duration is 6 hours (6h)."});
                    }

                    try {
                        await channel.setRateLimitPerUser(seconds, reason);

                        const embed = new EmbedBuilder()
                            .setColor(seconds > 0 ? "#E67E22" : "#2ECC71");

                        if (seconds > 0) {
                            embed.setTitle("⏳ Channel Slowmode Enabled")
                                .setDescription(`Users must now wait **${durationStr}** between messages.`);
                        } else {
                            embed.setTitle("✅ Channel Slowmode Disabled")
                                .setDescription("The slowmode cooldown has been removed.");
                        }

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        logger.error("[Slowmode Command Error]", error);
                        await interaction.editReply({content: "Failed to set the slowmode. Do I have the Manage Channels permission?"});
                    }
                    break;
                }
                case 'lock': {
                    await interaction.deferReply({ephemeral: true});
                    const channel = interaction.channel;
                    const reason = interaction.options.getString("reason") || "No reason provided.";

                    if (channel.type !== ChannelType.GuildText) {
                        return interaction.editReply({content: "This command can only be used in text channels."});
                    }

                    try {
                        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                            SendMessages: false,
                        });

                        const embed = new EmbedBuilder()
                            .setColor("#E74C3C")
                            .setTitle("🔒 Channel Locked")
                            .setDescription(`This channel has been locked by a moderator.`)
                            .addFields({name: "Reason", value: reason})
                            .setTimestamp();

                        await channel.send({embeds: [embed]});
                        await interaction.editReply({content: "Channel locked successfully."});

                    } catch (error) {
                        logger.error("[Lock Command Error]", error);
                        await interaction.editReply({content: "Failed to lock the channel. Do I have the Manage Channels permission?"});
                    }
                    break;
                }
                case 'unlock': {
                    await interaction.deferReply({ephemeral: true});
                    const channel = interaction.channel;

                    if (channel.type !== ChannelType.GuildText) {
                        return interaction.editReply({content: "This command can only be used in text channels."});
                    }

                    try {
                        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                            SendMessages: null, // Use null to revert to the category/default permissions
                        });

                        const embed = new EmbedBuilder()
                            .setColor("#2ECC71")
                            .setTitle("🔓 Channel Unlocked")
                            .setDescription("This channel has been unlocked. You may now send messages.")
                            .setTimestamp();

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        logger.error("[Unlock Command Error]", error);
                        await interaction.editReply({content: "Failed to unlock the channel. Do I have the Manage Channels permission?"});
                    }
                    break;
                }
                case 'lockdown': {
                    await interaction.deferReply({ephemeral: true});

                    const password = interaction.options.getString("password");
                    const shouldUnlock = interaction.options.getBoolean("unlock") || false;
                    const memberRoles = interaction.member.roles.cache;

                    try {
                        // This is a placeholder for the new table `protected_actions_config`
                        // We will simulate fetching a password hash for the user's highest role that has one.
                        // const [protectedRoles] = await db.execute('SELECT role_id, password_hash FROM protected_actions_config WHERE guild_id = ?', [interaction.guild.id]);

                        // --- SIMULATED LOGIC START ---
                        const protectedRoles = [
                            // Example data you would have in your `protected_actions_config` table
                            {role_id: "YOUR_ADMIN_ROLE_ID", password_hash: "e4a23c3b5e...:..."} // Replace with a real role ID and hash
                        ];
                        // --- SIMULATED LOGIC END ---

                        const userProtectedRole = protectedRoles.find(p_role => memberRoles.has(p_role.role_id));

                        if (!userProtectedRole) {
                            return interaction.editReply({content: "You do not have a role configured for protected actions."});
                        }

                        // const isVerified = verifyPassword(password, userProtectedRole.password_hash);
                        const isVerified = (password === "override-password-123"); // Placeholder verification

                        if (!isVerified) {
                            logger.warn(`Failed lockdown attempt by ${interaction.user.tag}. Incorrect password.`, {guildId: interaction.guild.id, category: "security"});
                            return interaction.editReply({content: "❌ Incorrect password."});
                        }

                        const channel = interaction.channel;
                        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                            SendMessages: shouldUnlock
                        });

                        const action = shouldUnlock ? "unlocked" : "locked";
                        await interaction.editReply(`✅ Channel has been ${action}.`);
                        logger.info(`Channel ${channel.name} was ${action} by ${interaction.user.tag} using a protected command.`, {guildId: interaction.guild.id, category: "security"});

                    } catch (error) {
                        // This will likely fail if the table doesn't exist yet.
                        if (error.code !== "ER_NO_SUCH_TABLE") {
                            logger.error("[Lockdown Command Error]", error);
                        }
                        await interaction.editReply({content: "An error occurred, or this feature has not been fully configured by the bot owner yet."});
                    }
                    break;
                }
                case 'announce': {
                    await interaction.deferReply({ephemeral: true});

                    const channel = interaction.options.getChannel("channel");
                    const message = interaction.options.getString("message");
                    const title = interaction.options.getString("title");
                    let color = interaction.options.getString("color");
                    const mentionRole = interaction.options.getRole("mention");

                    // Validate color input
                    if (color && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color)) {
                      return interaction.editReply({content: "❌ Invalid color format. Please use a valid hex color code (e.g., #3498DB).", ephemeral: true});
                    }

                    try {
                      const announcementContent = {
                        content: mentionRole ? `${mentionRole}` : undefined,
                      };

                      if (title) {
                        // If a title is provided, send as an embed
                        const embed = new EmbedBuilder()
                          .setTitle(title)
                          .setDescription(message)
                          .setColor(color || "#5865F2") // Default color if none provided or invalid
                          .setTimestamp();

                        announcementContent.embeds = [embed];
                      } else {
                        // Otherwise, send as a plain message
                        announcementContent.content = `${announcementContent.content || ""} ${message}`.trim();
                      }

                      await channel.send(announcementContent);

                      await interaction.editReply(`✅ Announcement successfully sent to ${channel}.`);

                    } catch (error) {
                      console.error("[Announce Command Error]", error);
                      await interaction.editReply("Failed to send the announcement. Please check my permissions for that channel.");
                    }
                    break;
                }
                default:
                    await interaction.reply({ content: 'Invalid moderation subcommand.', ephemeral: true });
                    break;
            }
        } else if (subcommandGroup === 'backup') {
            try {
              if (subcommand === "create") {
                await interaction.deferReply({ephemeral: true});
                const name = interaction.options.getString("name");

                let snapshot;
                try {
                  snapshot = await createSnapshot(guild);
                } catch (snapshotError) {
                  logger.error(`[Backup Command] Error creating snapshot for guild ${guild.id}:`, {error: snapshotError});
                  return interaction.editReply({content: "❌ Failed to create backup snapshot. Please check bot permissions and try again."});
                }

                await db.execute(
                  "INSERT INTO server_backups (guild_id, snapshot_name, snapshot_json, created_by_id) VALUES (?, ?, ?, ?)",
                  [guild.id, name, JSON.stringify(snapshot), interaction.user.id]
                );

                await interaction.editReply(`✅ Successfully created backup named **${name}**.`);

              } else if (subcommand === "list") {
                await interaction.deferReply({ephemeral: true});
                const [backups] = await db.execute("SELECT id, snapshot_name, created_at, created_by_id FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC", [guild.id]);

                if (backups.length === 0) {
                  return interaction.editReply("No backups found for this server.");
                }

                const description = backups.map(b => `**ID:** \`${b.id}\`\\n**Name:** ${b.snapshot_name}\\n**Date:** ${new Date(b.created_at).toLocaleString()}`).join("\\n\\n");
                const embed = new EmbedBuilder()
                  .setTitle(`Backups for ${guild.name}`)
                  .setColor("#5865F2")
                  .setDescription(description);

                await interaction.editReply({embeds: [embed]});

              } else if (subcommand === "load") {
                const backupId = interaction.options.getString("backup_id");
                const [[backup]] = await db.execute("SELECT * FROM server_backups WHERE id = ? AND guild_id = ?", [backupId, guild.id]);

                if (!backup) {
                  return interaction.reply({content: "Backup not found.", ephemeral: true});
                }

                const confirmationEmbed = new EmbedBuilder()
                  .setTitle("⚠️ FINAL CONFIRMATION REQUIRED ⚠️")
                  .setDescription(`You are about to restore the server to the state from **${new Date(backup.created_at).toLocaleString()}** named **\\"${backup.snapshot_name}\\"**.\\n\\n**THIS WILL DELETE ALL CURRENT ROLES AND CHANNELS** and replace them with the ones from the backup. This action is irreversible.\\n\\nOnly the server owner can confirm this action.`)
                  .setColor("Red");

                const confirmButton = new ButtonBuilder().setCustomId(`backup_confirm_${backupId}`).setLabel("Confirm & Restore Server").setStyle(ButtonStyle.Danger);
                const cancelButton = new ButtonBuilder().setCustomId("backup_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary);
                const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

                await interaction.reply({embeds: [confirmationEmbed], components: [row], ephemeral: true});

              } else if (subcommand === "delete") {
                await interaction.deferReply({ephemeral: true});
                const backupId = interaction.options.getString("backup_id");
                const [result] = await db.execute("DELETE FROM server_backups WHERE id = ? AND guild_id = ?", [backupId, guild.id]);
                if (result.affectedRows > 0) {
                  await interaction.editReply(`✅ Successfully deleted backup with ID \`${backupId}\`.`);
                } else {
                  await interaction.editReply(`❌ No backup found with ID \`${backupId}\` for this server.`);
                }
              }
            } catch (error) {
              logger.error(`[Backup Command] Subcommand: ${subcommand}`, {error});
              await interaction.editReply({content: "An error occurred while executing this command."});
            }
        } else if (subcommandGroup === 'fun') {
            switch (subcommand) {
                case 'coinflip': {
                    const result = Math.random() < 0.5 ? "Heads" : "Tails";
                    const imageUrl = result === "Heads"
                        ? "https://i.imgur.com/vH3y3b9.png" // Example Heads image
                        : "https://i.imgur.com/wixK1sI.png"; // Example Tails image

                    const embed = new EmbedBuilder()
                        .setColor(result === "Heads" ? "#E67E22" : "#3498DB")
                        .setTitle("Coin Flip")
                        .setDescription(`The coin landed on... **${result}**!`)
                        .setThumbnail(imageUrl);

                    await interaction.reply({embeds: [embed]});
                    break;
                }
                case 'meme': {
                    await interaction.deferReply();

                    try {
                        // Fetching from a popular meme subreddit's JSON endpoint
                        const response = await axios.get("https://www.reddit.com/r/memes/random/.json");
                        const post = response.data[0].data.children[0].data;

                        if (!post || post.over_18) {
                            return interaction.editReply("Could not find a suitable meme, please try again.");
                        }

                        const embed = new EmbedBuilder()
                            .setColor("#FF4500") // Reddit Orange
                            .setTitle(post.title)
                            .setURL(`https://www.reddit.com${post.permalink}`)
                            .setImage(post.url)
                            .setFooter({text: `👍 ${post.score} | 💬 ${post.num_comments} | Posted in r/${post.subreddit}`});

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        console.error("[Meme Command Error]", error);
                        await interaction.editReply("Sorry, I couldn't fetch a meme right now. The meme-lords are resting.");
                    }
                    break;
                }
                case 'roll': {
                    await interaction.deferReply();
                    const sides = interaction.options.getInteger("sides") || 6;
                    const result = Math.floor(Math.random() * sides) + 1;

                    const embed = new EmbedBuilder()
                        .setColor("#2ECC71")
                        .setTitle(`🎲 Dice Roll (1-${sides})`)
                        .setDescription(`You rolled a **${result}**!`);

                    await interaction.editReply({embeds: [embed]});
                    break;
                }
                case 'cat': {
                    await interaction.deferReply();
                    try {
                        const response = await axios.get('https://api.thecatapi.com/v1/images/search');
                        const catImageUrl = response.data[0].url;

                        const embed = new EmbedBuilder()
                            .setColor('Random')
                            .setTitle('Meow!')
                            .setImage(catImageUrl)
                            .setFooter({text: 'Powered by thecatapi.com'});

                        await interaction.editReply({embeds: [embed]});
                    } catch (error) {
                        console.error('[Cat Command Error]', error);
                        await interaction.editReply('Sorry, I couldn\\'t fetch a cat picture right now.');
                    }
                    break;
                }
                default:
                    await interaction.reply({ content: 'Invalid fun subcommand.', ephemeral: true });
                    break;
            }
        } else if (subcommandGroup === 'events') {
            // Event management logic will go here
        } else if (subcommandGroup === 'core') {
            // Core commands logic will go here
        } else if (subcommandGroup === 'custom-command') {
            try {
              if (subcommand === "create") {
                await interaction.deferReply({ephemeral: true});
                const name = interaction.options.getString("name").toLowerCase();
                const actionType = interaction.options.getString("action-type");
                const actionContent = interaction.options.getString("response-or-role-id");
                const requiredRoles = interaction.options.getString("required-roles")?.split(",").map(id => id.trim());
                const allowedChannels = interaction.options.getString("allowed-channels")?.split(",").map(id => id.trim());

                await db.execute(
                  `INSERT INTO custom_commands (guild_id, command_name, response, action_type, action_content, required_roles, allowed_channels) 
                     VALUES (?, ?, ?, ?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE response=VALUES(response), action_type=VALUES(action_type), action_content=VALUES(action_content), required_roles=VALUES(required_roles), allowed_channels=VALUES(allowed_channels)`,
                  [guild.id, name, actionContent, actionType, actionContent, JSON.stringify(requiredRoles || []), JSON.stringify(allowedChannels || [])]
                );
                invalidateCommandCache(guild.id, name);
                await interaction.editReply(`✅ Advanced custom command \`${name}\` has been created/updated.`);

              } else if (subcommand === "remove") {
                await interaction.deferReply({ephemeral: true});
                const name = interaction.options.getString("name").toLowerCase();
                const [result] = await db.execute("DELETE FROM custom_commands WHERE guild_id = ? AND command_name = ?", [guild.id, name]);
                if (result.affectedRows > 0) {
                  invalidateCommandCache(guild.id, name);
                  await interaction.editReply(`🗑️ Custom command \`${name}\` has been deleted.`);
                } else {
                  await interaction.editReply(`❌ No custom command found with the name \`${name}\`.`);
                }

              } else if (subcommand === "list") {
                await interaction.deferReply({ephemeral: true});
                const [commands] = await db.execute("SELECT command_name, action_type FROM custom_commands WHERE guild_id = ? ORDER BY command_name", [guild.id]);
                if (commands.length === 0) {
                  return interaction.editReply("There are no custom commands on this server.");
                }
                const embed = new EmbedBuilder()
                  .setColor("#5865F2")
                  .setTitle(`Custom Commands for ${interaction.guild.name}`)
                  .setDescription(commands.map(cmd => `\`${cmd.command_name}\` (*${cmd.action_type}*)`).join("\\n"));
                await interaction.editReply({embeds: [embed]});
              }
            } catch (error) {
              if (error.code === "ER_BAD_FIELD_ERROR") {
                await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
              } else {
                logger.error("[CustomCommand Error]", error);
                await interaction.editReply({content: "An error occurred while managing custom commands."});
              }
            }
        } else {
            await interaction.reply({ content: 'Invalid manage subcommand group.', ephemeral: true });
        }
    },
};