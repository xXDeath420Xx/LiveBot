"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const pending_interactions_1 = require("../interactions/pending-interactions");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const twitchApi = __importStar(require("../utils/twitch-api"));
const kickApi = __importStar(require("../utils/kick-api"));
const api_checks_1 = require("../utils/api_checks");
const tls_manager_1 = require("../utils/tls-manager");
const browserManager_1 = require("../utils/browserManager");
const axios_1 = __importDefault(require("axios"));
const Papa = __importStar(require("papaparse"));
const apiChecks = __importStar(require("../utils/api_checks"));
async function sendPaginatedEmbed(interaction, pages) {
    if (!pages || pages.length === 0) {
        return;
    }
    let currentPage = 0;
    const uniqueId = `listpage:${interaction.id}`;
    const createButtons = (ended = false) => new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId(`prev:${uniqueId}`).setLabel("◀").setStyle(discord_js_1.ButtonStyle.Secondary).setDisabled(currentPage === 0 || ended), new discord_js_1.ButtonBuilder().setCustomId(`next:${uniqueId}`).setLabel("▶").setStyle(discord_js_1.ButtonStyle.Secondary).setDisabled(currentPage >= pages.length - 1 || ended));
    const message = await interaction.editReply({
        embeds: [pages[currentPage]],
        components: pages.length > 1 ? [createButtons()] : []
    });
    if (!message || pages.length <= 1) {
        return;
    }
    const collector = message.createMessageComponentCollector({
        componentType: discord_js_1.ComponentType.Button,
        time: 300000
    });
    collector.on("collect", async (i) => {
        if (i.user.id !== interaction.user.id) {
            await i.reply({
                content: "You cannot use these buttons.",
                flags: discord_js_1.MessageFlags.Ephemeral
            });
            return;
        }
        i.customId.startsWith("next") ? currentPage++ : currentPage--;
        await i.update({ embeds: [pages[currentPage]], components: [createButtons()] });
    });
    collector.on("end", (collected, reason) => {
        if (reason === "time") {
            message.edit({ components: [createButtons(true)] }).catch(e => logger_1.default.warn(`[List Streamers] Failed to disable pagination buttons: ${e.message}`));
        }
    });
}
module.exports = {
    data: new discord_js_1.SlashCommandBuilder()
        .setName('streamer')
        .setDescription('Manage streamer profiles and subscriptions.')
        .setDefaultMemberPermissions(discord_js_1.PermissionsBitField.Flags.ManageGuild)
        .addSubcommand(subcommand => subcommand
        .setName('add')
        .setDescription('Adds a streamer to the notification list using an interactive form.')
        .addStringOption(option => option
        .setName("username")
        .setDescription("The streamer's username or channel ID. Must be the same on all chosen platforms.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('remove')
        .setDescription('Removes a streamer and all their subscriptions from this server.'))
        .addSubcommand(subcommand => subcommand
        .setName('edit')
        .setDescription('Edit settings for a specific streamer subscription.')
        .addStringOption(option => option
        .setName("username")
        .setDescription("The username of the streamer to edit.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('list')
        .setDescription('Lists all tracked streamers and their live status.'))
        .addSubcommand(subcommand => subcommand
        .setName('check-live')
        .setDescription("Instantly lists all currently live streamers for this server."))
        .addSubcommand(subcommand => subcommand
        .setName('massadd')
        .setDescription('Adds multiple streamers from a platform.')
        .addStringOption(o => o.setName("platform").setDescription("The platform to add streamers to.").setRequired(true).addChoices({ name: "Twitch", value: "twitch" }, { name: "YouTube", value: "youtube" }, { name: "Kick", value: "kick" }, { name: "TikTok", value: "tiktok" }, { name: "Trovo", value: "trovo" }, { name: "Facebook", value: "facebook" }, { name: "Instagram", value: "instagram" }))
        .addStringOption(o => o.setName("usernames").setDescription("A comma-separated list of usernames or Channel IDs.").setRequired(true))
        .addChannelOption(o => o.setName("channel").setDescription("Announce all streamers in this list to a specific channel.").addChannelTypes(discord_js_1.ChannelType.GuildText, discord_js_1.ChannelType.GuildAnnouncement).setRequired(false))
        .addStringOption(o => o.setName("nickname").setDescription("Apply a custom webhook nickname to all streamers in this list."))
        .addAttachmentOption(o => o.setName("avatar").setDescription("Apply a custom webhook avatar to all streamers in this list.").setRequired(false)))
        .addSubcommand(subcommand => subcommand
        .setName('massremove')
        .setDescription('Removes multiple streamers and purges their active announcements.')
        .addStringOption(o => o.setName("platform").setDescription("The platform to remove streamers from.").setRequired(true).addChoices({ name: "Twitch", value: "twitch" }, { name: "YouTube", value: "youtube" }, { name: "Kick", value: "kick" }, { name: "TikTok", value: "tiktok" }, { name: "Trovo", value: "trovo" }, { name: "Facebook", value: "facebook" }, { name: "Instagram", value: "instagram" }))
        .addStringOption(o => o.setName("usernames").setDescription("A comma-separated list of usernames.").setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('importcsv')
        .setDescription('Bulk adds/updates streamer subscriptions from a CSV file.')
        .addAttachmentOption(o => o.setName("csvfile")
        .setDescription("CSV Headers: platform,username,announcement_channel_id,discord_user_id,etc.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('exportcsv')
        .setDescription('Exports all streamer subscriptions on this server to a CSV file.'))
        .addSubcommand(subcommand => subcommand
        .setName('clear')
        .setDescription('⚠️ Deletes ALL tracked streamers from this server and purges their announcements.')),
    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const subcommand = interaction.options.getSubcommand(false);
        if (subcommand === 'edit' && focusedOption.name === "username") {
            const focusedValue = focusedOption.value;
            try {
                const [streamers] = await db_1.default.execute("SELECT username FROM streamers WHERE guild_id = ? AND username LIKE ? LIMIT 25", [interaction.guild?.id, `%${focusedValue}%`]);
                await interaction.respond(streamers.map(s => ({ name: s.username, value: s.username })));
            }
            catch (error) {
                await interaction.respond([]);
            }
        }
    },
    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guild = interaction.guild;
        switch (subcommand) {
            case 'add': {
                await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
                const username = interaction.options.getString("username", true);
                const discordUser = interaction.options.getUser("user");
                const avatar = interaction.options.get("avatar")?.attachment;
                let avatarUrl = null;
                if (avatar) {
                    if (!avatar.contentType?.startsWith("image/")) {
                        await interaction.editReply({ content: "The provided avatar must be an image file (PNG, JPG, GIF)." });
                        return;
                    }
                    const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                    if (!tempUploadChannelId) {
                        await interaction.editReply({ content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file." });
                        return;
                    }
                    try {
                        const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                        if (!tempChannel || !tempChannel.isTextBased()) {
                            throw new Error("Temporary upload channel is not a text channel or was not found.");
                        }
                        const tempMessage = await tempChannel.send({ files: [{ attachment: avatar.url, name: avatar.name }] });
                        avatarUrl = tempMessage.attachments.first()?.url || null;
                    }
                    catch (uploadError) {
                        console.error("[Add Streamer Command] Error uploading temporary avatar to Discord:", uploadError);
                        await interaction.editReply({ content: `Failed to upload custom avatar: ${uploadError.message}. Please check bot's permissions or TEMP_UPLOAD_CHANNEL_ID.` });
                        return;
                    }
                }
                const interactionId = interaction.id;
                pending_interactions_1.pendingInteractions.set(interactionId, {
                    username,
                    discordUserId: discordUser?.id || null,
                    avatarUrl,
                    guildId: interaction.guild.id
                });
                setTimeout(() => pending_interactions_1.pendingInteractions.delete(interactionId), 15 * 60 * 1000);
                const platformSelect = new discord_js_1.StringSelectMenuBuilder()
                    .setCustomId(`addstreamer_platforms_${interactionId}`)
                    .setPlaceholder("Select the platform(s) to add this streamer on")
                    .setMinValues(1)
                    .setMaxValues(7)
                    .addOptions([
                    { label: "Twitch", value: "twitch", emoji: "🟣" },
                    { label: "Kick", value: "kick", emoji: "🟢" },
                    { label: "YouTube", value: "youtube", emoji: "🔴" },
                    { label: "TikTok", value: "tiktok", emoji: "⚫" },
                    { label: "Trovo", value: "trovo", emoji: "🟢" },
                    { label: "Facebook", value: "facebook", emoji: "🔵" },
                    { label: "Instagram", value: "instagram", emoji: "🟣" },
                ]);
                const row = new discord_js_1.ActionRowBuilder().addComponents(platformSelect);
                await interaction.editReply({
                    content: `Adding streamer \`${username}\`. Please select the platforms below to continue.`,
                    components: [row]
                });
                break;
            }
            case 'remove': {
                const guildId = interaction.guild.id;
                const [streamers] = await db_1.default.execute(`SELECT s.streamer_id, s.username, s.platform
                     FROM streamers s
                              JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
                     WHERE sub.guild_id = ?
                     GROUP BY s.streamer_id, s.username, s.platform`, [guildId]);
                if (streamers.length === 0) {
                    await interaction.reply({ content: "There are no streamers configured for this server.", flags: discord_js_1.MessageFlags.Ephemeral });
                    return;
                }
                const options = streamers.map(s => ({
                    label: `${s.username} on ${s.platform.charAt(0).toUpperCase() + s.platform.slice(1)}`,
                    value: s.streamer_id.toString(),
                }));
                const selectMenu = new discord_js_1.StringSelectMenuBuilder()
                    .setCustomId("remove_streamer_select")
                    .setPlaceholder("Select streamers to remove")
                    .setMinValues(1)
                    .setMaxValues(Math.min(options.length, 25))
                    .addOptions(options);
                const row = new discord_js_1.ActionRowBuilder().addComponents(selectMenu);
                const replyMessage = await interaction.reply({
                    content: "Please select the streamer(s) you want to remove:",
                    components: [row],
                    flags: discord_js_1.MessageFlags.Ephemeral
                });
                const filter = (i) => i.customId === "remove_streamer_select" && i.user.id === interaction.user.id;
                const collector = replyMessage.createMessageComponentCollector({
                    componentType: discord_js_1.ComponentType.StringSelect,
                    time: 60000
                });
                collector.on("collect", async (i) => {
                    await i.deferUpdate();
                    const streamerIdsToRemove = i.values;
                    if (!streamerIdsToRemove || streamerIdsToRemove.length === 0) {
                        await i.editReply({ content: "No streamers selected. Operation cancelled.", components: [] });
                        return;
                    }
                    try {
                        await db_1.default.query("START TRANSACTION");
                        const placeholders = streamerIdsToRemove.map(() => "?").join(",");
                        const [subscriptionsResult] = await db_1.default.query(`DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id IN (${placeholders})`, [guildId, ...streamerIdsToRemove]);
                        await db_1.default.query("COMMIT");
                        const removedCount = subscriptionsResult.affectedRows;
                        await i.editReply({ content: `Successfully removed ${removedCount} subscription(s) for the selected streamer(s) from this server.`, components: [] });
                    }
                    catch (error) {
                        await db_1.default.query("ROLLBACK");
                        logger_1.default.error("[RemoveStreamer Error]", error);
                        await i.editReply({ content: "An error occurred while removing the streamer(s). The operation has been cancelled.", components: [] });
                    }
                    finally {
                        collector.stop();
                    }
                });
                collector.on("end", (collected, reason) => {
                    if (reason === "time" && collected.size === 0) {
                        interaction.editReply({ content: "Time has run out, no streamers were removed.", components: [] })
                            .catch(e => logger_1.default.warn(`[RemoveStreamer] Failed to edit reply after timeout: ${e.message}`));
                    }
                });
                break;
            }
            case 'edit': {
                await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
                const username = interaction.options.getString("username", true);
                const guildId = interaction.guild.id;
                try {
                    const [subscriptions] = await db_1.default.execute(`
                        SELECT sub.subscription_id, sub.announcement_channel_id, s.platform, s.username, s.streamer_id
                        FROM subscriptions sub
                                 JOIN streamers s ON sub.streamer_id = s.streamer_id
                        WHERE sub.guild_id = ? AND s.username = ? AND sub.team_subscription_id IS NULL
                    `, [guildId, username]);
                    if (subscriptions.length === 0) {
                        await interaction.editReply({ content: `No editable (non-team) subscriptions found for "${username}" in this server.` });
                        return;
                    }
                    const options = await Promise.all(subscriptions.map(async (sub) => {
                        const channel = sub.announcement_channel_id ?
                            await interaction.guild.channels.fetch(sub.announcement_channel_id).catch(() => null) : null;
                        const channelName = channel ? `#${channel.name}` : "Server Default";
                        return {
                            label: `${sub.platform.toUpperCase()} in ${channelName}`,
                            description: `ID: ${sub.subscription_id}`,
                            value: sub.subscription_id.toString(),
                        };
                    }));
                    const selectMenu = new discord_js_1.StringSelectMenuBuilder()
                        .setCustomId(`editstreamer_select_${interaction.id}`)
                        .setPlaceholder("Select a subscription to edit")
                        .addOptions(options);
                    const row = new discord_js_1.ActionRowBuilder().addComponents(selectMenu);
                    const reply = await interaction.editReply({
                        content: `Found ${subscriptions.length} subscription(s) for "${username}". Please select one to edit.`,
                        components: [row]
                    });
                    const filter = (i) => i.customId === `editstreamer_select_${interaction.id}` && i.user.id === interaction.user.id;
                    const collector = reply.createMessageComponentCollector({
                        componentType: discord_js_1.ComponentType.StringSelect,
                        time: 60000
                    });
                    collector.on("collect", async (i) => {
                        await i.deferUpdate();
                        const subscriptionId = i.values[0];
                        const [[subDetails]] = await db_1.default.execute("SELECT * FROM subscriptions WHERE subscription_id = ?", [subscriptionId]);
                        if (!subDetails) {
                            await i.update({ content: "Could not find subscription details. Please try again.", components: [] });
                            return;
                        }
                        const modal = new discord_js_1.ModalBuilder()
                            .setCustomId(`editstreamer_modal_${subscriptionId}`)
                            .setTitle("Edit Subscription");
                        const messageInput = new discord_js_1.TextInputBuilder()
                            .setCustomId("custom_message")
                            .setLabel("Custom Announcement Message")
                            .setStyle(discord_js_1.TextInputStyle.Paragraph)
                            .setValue(subDetails.custom_message || "")
                            .setRequired(false);
                        const nicknameInput = new discord_js_1.TextInputBuilder()
                            .setCustomId("override_nickname")
                            .setLabel("Custom Webhook Name")
                            .setStyle(discord_js_1.TextInputStyle.Short)
                            .setValue(subDetails.override_nickname || "")
                            .setRequired(false);
                        const avatarInput = new discord_js_1.TextInputBuilder()
                            .setCustomId("override_avatar_url")
                            .setLabel("Custom Webhook Avatar URL")
                            .setStyle(discord_js_1.TextInputStyle.Short)
                            .setValue(subDetails.override_avatar_url || "")
                            .setRequired(false);
                        modal.addComponents(new discord_js_1.ActionRowBuilder().addComponents(messageInput), new discord_js_1.ActionRowBuilder().addComponents(nicknameInput), new discord_js_1.ActionRowBuilder().addComponents(avatarInput));
                        await i.showModal(modal);
                        collector.stop();
                    });
                    collector.on("end", async (collected, reason) => {
                        if (reason === "time" && collected.size === 0) {
                            interaction.editReply({ content: "You did not make a selection in time.", components: [] })
                                .catch(e => logger_1.default.warn(`[EditStreamer] Failed to edit reply after timeout: ${e.message}`));
                        }
                    });
                }
                catch (error) {
                    logger_1.default.error("Error executing editstreamer command:", { error });
                    await interaction.editReply({ content: "An error occurred while fetching subscription data." });
                }
                break;
            }
            case 'list': {
                await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
                try {
                    const [allStreamers] = await db_1.default.execute(`
                                SELECT s.platform, s.username, s.discord_user_id, s.platform_user_id,
                                       a.announcement_id IS NOT NULL AS isLive
                                FROM subscriptions sub
                                         JOIN streamers s ON sub.streamer_id = s.streamer_id
                                         LEFT JOIN announcements a ON s.streamer_id = a.streamer_id AND sub.guild_id = a.guild_id
                                WHERE sub.guild_id = ?
                                GROUP BY s.streamer_id, s.platform, s.username, s.discord_user_id, s.platform_user_id, isLive
                                ORDER BY isLive DESC, s.platform, s.username`, [interaction.guild.id]);
                    if (allStreamers.length === 0) {
                        await interaction.editReply({ content: "No streamers are tracked on this server." });
                        return;
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
                                case "facebook":
                                    url = `https://www.facebook.com/gaming/${s.username}`;
                                    break;
                                case "instagram":
                                    url = `https://www.instagram.com/${s.username}`;
                                    break;
                                default:
                                    url = null;
                            }
                            const usernameDisplay = url ? `[**${(0, discord_js_1.escapeMarkdown)(s.username)}**](${url})` : `**${(0, discord_js_1.escapeMarkdown)(s.username)}**`;
                            return `${status} ${usernameDisplay} (${s.platform}) ${user}`;
                        }).join("\n");
                        pages.push(new discord_js_1.EmbedBuilder()
                            .setTitle(`Tracked Streamers (${liveCount} Live / ${totalCount} Total)`)
                            .setColor(liveCount > 0 ? "#57F287" : "#ED4245")
                            .setDescription(description)
                            .setFooter({ text: `Page ${Math.floor(i / pageSize) + 1} of ${Math.ceil(totalCount / pageSize)}` }));
                    }
                    await sendPaginatedEmbed(interaction, pages);
                }
                catch (e) {
                    logger_1.default.error("[List Streamers Command Error]", e);
                    await interaction.editReply({ content: "An error occurred while fetching the list." }).catch(() => { });
                }
                break;
            }
            case 'check-live': {
                await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
                let browser;
                try {
                    const [subscriptions] = await db_1.default.execute(`
                                SELECT s.streamer_id, s.platform, s.username, s.discord_user_id, s.platform_user_id
                                FROM subscriptions sub
                                         JOIN streamers s ON sub.streamer_id = s.streamer_id
                                WHERE sub.guild_id = ?`, [interaction.guild.id]);
                    if (subscriptions.length === 0) {
                        await interaction.editReply("There are no streamers being tracked on this server.");
                        return;
                    }
                    const uniqueStreamersMap = new Map();
                    subscriptions.forEach(streamer => {
                        uniqueStreamersMap.set(streamer.streamer_id, streamer);
                    });
                    const streamersToCheck = Array.from(uniqueStreamersMap.values());
                    if (streamersToCheck.some(s => ["tiktok", "youtube", "trovo", "facebook", "instagram"].includes(s.platform))) {
                        browser = await (0, browserManager_1.getBrowser)();
                    }
                    const checkPromises = streamersToCheck.map(async (streamer) => {
                        let liveData = { isLive: false };
                        if (streamer.platform === "twitch") {
                            liveData = await apiChecks.checkTwitch(streamer);
                        }
                        else if (streamer.platform === "kick") {
                            liveData = await apiChecks.checkKick(streamer.username);
                        }
                        else if (streamer.platform === "youtube" && browser) {
                            liveData = await apiChecks.checkYouTube(streamer.platform_user_id);
                        }
                        else if (streamer.platform === "tiktok" && browser) {
                            liveData = await apiChecks.checkTikTok(streamer.username);
                        }
                        else if (streamer.platform === "trovo" && browser) {
                            liveData = await apiChecks.checkTrovo(streamer.username);
                        }
                        else if (streamer.platform === "facebook" && browser) {
                            liveData = await apiChecks.checkFacebook(streamer.username);
                        }
                        else if (streamer.platform === "instagram" && browser) {
                            liveData = await apiChecks.checkInstagram(streamer.username);
                        }
                        if (liveData.isLive) {
                            return { ...streamer, ...liveData };
                        }
                        return null;
                    });
                    const results = await Promise.allSettled(checkPromises);
                    const liveStreamers = results
                        .filter(result => result.status === "fulfilled" && result.value !== null)
                        .map(result => result.value);
                    if (liveStreamers.length === 0) {
                        const embed = new discord_js_1.EmbedBuilder()
                            .setColor("#ED4245")
                            .setTitle("No One is Live")
                            .setDescription("None of the tracked streamers on this server are currently live.");
                        await interaction.editReply({ embeds: [embed] });
                        return;
                    }
                    const platformEmojis = {
                        twitch: "🟣", kick: "🟢", youtube: "🔴", tiktok: "⚫",
                        trovo: "🟢", facebook: "🔵", instagram: "🟣", default: "⚪"
                    };
                    const descriptionLines = liveStreamers.sort((a, b) => a.username.localeCompare(b.username)).map(s => {
                        const statusEmoji = platformEmojis[s.platform] || platformEmojis.default;
                        const discordLink = s.discord_user_id ? ` (<@${s.discord_user_id}>)` : "";
                        const platformName = s.platform.charAt(0).toUpperCase() + s.platform.slice(1);
                        return `${statusEmoji} [**${(0, discord_js_1.escapeMarkdown)(s.username)}**](${s.url}) (${platformName})${discordLink}`;
                    });
                    const embed = new discord_js_1.EmbedBuilder()
                        .setColor("#57F287")
                        .setTitle(`🟢 ${liveStreamers.length} Streamer(s) Currently Live`)
                        .setDescription(descriptionLines.join("\n"))
                        .setTimestamp();
                    await interaction.editReply({ embeds: [embed] });
                }
                catch (e) {
                    console.error("--- Critical Error in /check-live ---", e);
                    await interaction.editReply({ content: "A critical error occurred while fetching live statuses." });
                }
                break;
            }
            case 'massadd': {
                await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
                const platform = interaction.options.getString("platform", true);
                const channelOverride = interaction.options.get("channel")?.channel;
                const nickname = interaction.options.getString("nickname");
                const avatarAttachment = interaction.options.get("avatar")?.attachment;
                const usernames = [...new Set(interaction.options.getString("usernames", true).split(",").map(name => name.trim()).filter(Boolean))];
                if (usernames.length === 0) {
                    await interaction.editReply("Please provide at least one username.");
                    return;
                }
                const added = [], updated = [], failed = [];
                let browser = null;
                let finalAvatarUrl = null;
                try {
                    if (avatarAttachment) {
                        if (!avatarAttachment.contentType?.startsWith("image/")) {
                            await interaction.editReply({ content: "The provided avatar must be an image file (PNG, JPG, GIF)." });
                            return;
                        }
                        const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                        if (!tempUploadChannelId) {
                            logger_1.default.error("[Mass Add Streamer] TEMP_UPLOAD_CHANNEL_ID is not configured.");
                            await interaction.editReply({ content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file." });
                            return;
                        }
                        try {
                            const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                            if (!tempChannel || !tempChannel.isTextBased()) {
                                throw new Error("Temporary upload channel is not a text channel or was not found.");
                            }
                            const tempMessage = await tempChannel.send({ files: [{ attachment: avatarAttachment.url, name: avatarAttachment.name }] });
                            finalAvatarUrl = tempMessage.attachments.first()?.url || null;
                        }
                        catch (uploadError) {
                            logger_1.default.error("[Mass Add Streamer] Error uploading temporary avatar to Discord:", uploadError);
                            await interaction.editReply({ content: "Failed to upload custom avatar. Please check bot's permissions or TEMP_UPLOAD_CHANNEL_ID." });
                            return;
                        }
                    }
                    if (platform === "youtube") {
                        browser = await (0, browserManager_1.getBrowser)();
                    }
                    for (const username of usernames) {
                        const correctedDiscordId = null;
                        try {
                            let streamerInfo = null;
                            if (platform === "twitch") {
                                const u = await twitchApi.getTwitchUser(username);
                                if (u)
                                    streamerInfo = { puid: u.id, dbUsername: u.login };
                            }
                            else if (platform === "kick") {
                                const u = await kickApi.getKickUser(username);
                                if (u)
                                    streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username };
                            }
                            else if (platform === "youtube") {
                                const c = await (0, api_checks_1.getYouTubeChannelId)(username);
                                if (c?.channelId)
                                    streamerInfo = { puid: c.channelId, dbUsername: c.channelName || username };
                            }
                            else if (platform === "facebook") {
                                const u = await (0, api_checks_1.getFacebookUser)(username);
                                if (u)
                                    streamerInfo = { puid: username, dbUsername: u.username };
                            }
                            else if (platform === "instagram") {
                                const u = await (0, api_checks_1.getInstagramUser)(username);
                                if (u)
                                    streamerInfo = { puid: username, dbUsername: u.username };
                            }
                            else if (["tiktok", "trovo"].includes(platform)) {
                                streamerInfo = { puid: username, dbUsername: username };
                            }
                            if (!streamerInfo || !streamerInfo.puid) {
                                failed.push(`${username} (Not Found)`);
                                continue;
                            }
                            const [[existingStreamer]] = await db_1.default.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", [platform, streamerInfo.puid]);
                            let streamerId = existingStreamer?.streamer_id;
                            if (!streamerId) {
                                const [result] = await db_1.default.execute("INSERT INTO streamers (platform,username,platform_user_id,discord_user_id) VALUES (?,?,?,?)", [platform, streamerInfo.dbUsername, streamerInfo.puid, correctedDiscordId]);
                                streamerId = result.insertId;
                            }
                            const announcementChannel = channelOverride?.id || null;
                            const [[existingSubscription]] = await db_1.default.execute("SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?", [interaction.guild.id, streamerId, announcementChannel]);
                            if (existingSubscription) {
                                await db_1.default.execute(`UPDATE subscriptions SET override_nickname = ?, override_avatar_url = IF(? IS NOT NULL, ?, override_avatar_url) WHERE subscription_id = ?`, [nickname || null, finalAvatarUrl, finalAvatarUrl, existingSubscription.subscription_id]);
                                updated.push(username);
                            }
                            else {
                                await db_1.default.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?, ?)`, [interaction.guild.id, streamerId, announcementChannel, nickname || null, finalAvatarUrl]);
                                added.push(username);
                            }
                        }
                        catch (e) {
                            logger_1.default.error(`[Mass Add Streamer] Error for ${username}:`, e);
                            failed.push(`${username} (API/DB Error)`);
                        }
                    }
                }
                catch (e) {
                    logger_1.default.error("[Mass Add Streamer] Main Error:", e);
                    await interaction.editReply({ content: `A critical error occurred processing the command: ${e.message}` });
                    return;
                }
                finally {
                    if (browser)
                        await browser.close();
                    await (0, tls_manager_1.exitCycleTLSInstance)();
                }
                const embed = new discord_js_1.EmbedBuilder().setTitle("Mass Add Report").setColor("#5865F2");
                const field = (l) => l.length > 0 ? l.join(", ").substring(0, 1020) : "None";
                embed.addFields({ name: `✅ Added (${[...new Set(added)].length} subscriptions)`, value: field(added) }, { name: `🔄 Updated (${[...new Set(updated)].length} subscriptions)`, value: field(updated) }, { name: `❌ Failed (${[...new Set(failed)].length} rows)`, value: field(failed) });
                let footerText = [];
                if (channelOverride)
                    footerText.push(`Channel: #${channelOverride.name}`);
                if (nickname)
                    footerText.push(`Nickname: ${nickname}`);
                if (finalAvatarUrl)
                    footerText.push(`Avatar URL provided`);
                if (footerText.length > 0)
                    embed.setFooter({ text: `Applied to all successful entries: ${footerText.join(' | ')}` });
                await interaction.editReply({ embeds: [embed] });
                break;
            }
            case 'massremove': {
                await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
                const platform = interaction.options.getString("platform", true);
                const usernames = [...new Set(interaction.options.getString("usernames", true).split(",").map(name => name.trim().toLowerCase()).filter(Boolean))];
                const guildId = interaction.guild.id;
                if (usernames.length === 0) {
                    await interaction.editReply("Please provide at least one username.");
                    return;
                }
                const removed = [], failed = [];
                let purgedMessageCount = 0;
                try {
                    const usernamePlaceholders = usernames.map(() => "?").join(", ");
                    const [streamers] = await db_1.default.execute(`SELECT streamer_id, LOWER(username) as lower_username FROM streamers WHERE platform = ? AND LOWER(username) IN (${usernamePlaceholders})`, [platform, ...usernames]);
                    const streamerMap = new Map(streamers.map(s => [s.lower_username, s.streamer_id]));
                    const idsToRemove = [];
                    for (const username of usernames) {
                        if (streamerMap.has(username)) {
                            idsToRemove.push(streamerMap.get(username));
                            removed.push(username);
                        }
                        else {
                            failed.push(`${username} (Not Found)`);
                        }
                    }
                    if (idsToRemove.length > 0) {
                        const idPlaceholders = idsToRemove.map(() => "?").join(", ");
                        const [announcementsToPurge] = await db_1.default.execute(`SELECT message_id, channel_id FROM announcements WHERE guild_id = ? AND streamer_id IN (${idPlaceholders})`, [guildId, ...idsToRemove]);
                        if (announcementsToPurge.length > 0) {
                            const purgePromises = announcementsToPurge.map(ann => {
                                return interaction.client.channels.fetch(ann.channel_id)
                                    .then(channel => channel?.messages.delete(ann.message_id))
                                    .catch(e => logger_1.default.warn(`[Mass Remove Streamer] Failed to delete message ${ann.message_id} in channel ${ann.channel_id}: ${e.message}`));
                            });
                            await Promise.allSettled(purgePromises);
                            purgedMessageCount = announcementsToPurge.length;
                        }
                        await db_1.default.execute(`DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id IN (${idPlaceholders})`, [guildId, ...idsToRemove]);
                    }
                    const embed = new discord_js_1.EmbedBuilder().setTitle("Mass Remove Report").setColor("#f04747");
                    const field = (l) => {
                        const content = l.length > 0 ? l.join(", ") : "None";
                        return content.length > 1024 ? content.substring(0, 1020) + "..." : content;
                    };
                    embed.addFields({ name: `✅ Removed (${removed.length})`, value: field(removed) }, { name: `❌ Failed (${failed.length})`, value: field(failed) }, { name: `🗑️ Announcements Purged`, value: `${purgedMessageCount} message(s)` });
                    await interaction.editReply({ embeds: [embed] });
                }
                catch (error) {
                    logger_1.default.error("[Mass Remove Streamer Command Error]", error);
                    await interaction.editReply("An error occurred while trying to remove streamers. Please try again later.");
                }
                break;
            }
            case 'importcsv': {
                const file = interaction.options.get("csvfile")?.attachment;
                if (!file.name.endsWith(".csv")) {
                    await interaction.reply({ content: "Invalid file type. Must be a `.csv` file.", flags: discord_js_1.MessageFlags.Ephemeral });
                    return;
                }
                await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
                const added = [], updated = [], failed = [];
                let browser = null;
                try {
                    const fileContent = await axios_1.default.get(file.url, { responseType: "text" }).then(res => res.data);
                    const { data: rows } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
                    if (!rows || rows.length === 0) {
                        await interaction.editReply({ content: "CSV is empty or does not contain valid data rows." });
                        return;
                    }
                    const platformsInCsv = new Set(rows.map((r) => r.platform).filter(Boolean));
                    if (platformsInCsv.has("youtube")) {
                        browser = await (0, browserManager_1.getBrowser)();
                    }
                    for (const row of rows) {
                        const { platform, username, discord_user_id, custom_message, override_nickname, override_avatar_url, announcement_channel_id } = row;
                        if (!platform || !username) {
                            failed.push(`(Skipped row: missing platform/username)`);
                            continue;
                        }
                        let correctedDiscordId = /^[0-9]+$/.test(discord_user_id) ? discord_user_id : null;
                        if (discord_user_id && !correctedDiscordId) {
                            failed.push(`${username} (Invalid Discord ID)`);
                        }
                        try {
                            let [[streamer]] = await db_1.default.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?", [platform, username]);
                            let streamerId = streamer?.streamer_id;
                            if (!streamerId) {
                                let streamerInfo = null;
                                // Same platform checks as massadd...
                                if (platform === "twitch") {
                                    const u = await twitchApi.getTwitchUser(username);
                                    if (u)
                                        streamerInfo = { puid: u.id, dbUsername: u.login };
                                }
                                else if (["tiktok", "trovo"].includes(platform)) {
                                    streamerInfo = { puid: username, dbUsername: username };
                                }
                                // ... other platforms
                                if (!streamerInfo || !streamerInfo.puid) {
                                    failed.push(`${username} (Not Found)`);
                                    continue;
                                }
                                const [result] = await db_1.default.execute("INSERT INTO streamers (platform, username, platform_user_id, discord_user_id) VALUES (?, ?, ?, ?)", [platform, streamerInfo.dbUsername, streamerInfo.puid, correctedDiscordId]);
                                streamerId = result.insertId;
                            }
                            const announcementChannel = announcement_channel_id || null;
                            const [[existingSubscription]] = await db_1.default.execute("SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?", [interaction.guild.id, streamerId, announcementChannel]);
                            if (existingSubscription) {
                                await db_1.default.execute(`UPDATE subscriptions SET custom_message = ?, override_nickname = ?, override_avatar_url = ? WHERE subscription_id = ?`, [custom_message || null, override_nickname || null, override_avatar_url || null, existingSubscription.subscription_id]);
                                updated.push(`${username} (Channel: ${announcementChannel || "Default"})`);
                            }
                            else {
                                await db_1.default.execute(`INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?, ?, ?)`, [interaction.guild.id, streamerId, announcementChannel, custom_message || null, override_nickname || null, override_avatar_url || null]);
                                added.push(`${username} (Channel: ${announcementChannel || "Default"})`);
                            }
                        }
                        catch (err) {
                            logger_1.default.error("[Import CSV] Row Error for " + username + ":", err);
                            failed.push(`${username}(DB Error)`);
                        }
                    }
                }
                catch (e) {
                    logger_1.default.error("[Import CSV] Main Error:", e);
                    await interaction.editReply({ content: "A critical error occurred processing the file." });
                    return;
                }
                finally {
                    if (browser)
                        await browser.close();
                    await (0, tls_manager_1.exitCycleTLSInstance)();
                }
                const embed = new discord_js_1.EmbedBuilder().setTitle("CSV Import Complete").setColor("#5865F2");
                const field = (l) => l.length > 0 ? [...new Set(l)].join(", ").substring(0, 1020) : "None";
                embed.addFields({ name: `✅ Added (${[...new Set(added)].length} subscriptions)`, value: field(added) }, { name: `🔄 Updated (${[...new Set(updated)].length} subscriptions)`, value: field(updated) }, { name: `❌ Failed (${[...new Set(failed)].length} rows)`, value: field(failed) });
                await interaction.editReply({ embeds: [embed] });
                break;
            }
            case 'exportcsv': {
                await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
                try {
                    const [subscriptions] = await db_1.default.execute(`SELECT
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
                         ORDER BY s.platform, s.username, sub.announcement_channel_id`, [interaction.guild.id]);
                    if (subscriptions.length === 0) {
                        await interaction.editReply("There are no streamer subscriptions to export from this server.");
                        return;
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
                    const attachment = new discord_js_1.AttachmentBuilder(Buffer.from(csv), { name: `streamers_export_${interaction.guild.id}.csv` });
                    await interaction.editReply({
                        content: `Here is the export of ${subscriptions.length} streamer subscriptions.`,
                        files: [attachment]
                    });
                }
                catch (error) {
                    logger_1.default.error("[Export CSV Error]", error);
                    await interaction.editReply("An error occurred while exporting the streamer list.");
                }
                break;
            }
            case 'clear': {
                const embed = new discord_js_1.EmbedBuilder()
                    .setTitle("⚠️ Confirmation Required")
                    .setDescription("This will remove **ALL** streamer subscriptions and delete **ALL** active live announcements from this server. This action cannot be undone.")
                    .setColor("#FF0000");
                const confirmButton = new discord_js_1.ButtonBuilder()
                    .setCustomId("confirm_clear")
                    .setLabel("Yes, delete everything")
                    .setStyle(discord_js_1.ButtonStyle.Danger);
                const cancelButton = new discord_js_1.ButtonBuilder()
                    .setCustomId("cancel_clear")
                    .setLabel("Cancel")
                    .setStyle(discord_js_1.ButtonStyle.Secondary);
                const row = new discord_js_1.ActionRowBuilder().addComponents(confirmButton, cancelButton);
                const response = await interaction.reply({
                    embeds: [embed],
                    components: [row],
                    flags: discord_js_1.MessageFlags.Ephemeral
                });
                const collectorFilter = (i) => i.user.id === interaction.user.id;
                try {
                    const confirmation = await response.awaitMessageComponent({ filter: collectorFilter, time: 60000 });
                    if (confirmation.customId === "confirm_clear") {
                        await confirmation.update({ content: "⚙️ Processing... Deleting announcements and subscriptions now.", embeds: [], components: [] });
                        try {
                            let purgedMessageCount = 0;
                            const [announcementsToPurge] = await db_1.default.execute(`SELECT message_id, channel_id FROM announcements WHERE guild_id = ?`, [interaction.guild.id]);
                            if (announcementsToPurge.length > 0) {
                                const purgePromises = announcementsToPurge.map(ann => {
                                    return interaction.client.channels.fetch(ann.channel_id)
                                        .then(channel => channel?.messages.delete(ann.message_id))
                                        .catch(e => logger_1.default.warn(`Failed to delete message ${ann.message_id} in channel ${ann.channel_id}: ${e.message}`));
                                });
                                await Promise.allSettled(purgePromises);
                                purgedMessageCount = announcementsToPurge.length;
                            }
                            const [result] = await db_1.default.execute("DELETE FROM subscriptions WHERE guild_id = ?", [interaction.guild.id]);
                            await interaction.editReply({
                                content: `✅ **Operation Complete!**\nRemoved **${result.affectedRows}** streamer subscriptions.\nPurged **${purgedMessageCount}** active announcement message(s).`,
                            });
                        }
                        catch (dbError) {
                            logger_1.default.error("[Clear Streamers Command Error] Database error:", dbError);
                            await interaction.editReply({ content: "❌ An error occurred while trying to clear the server. Please try again later." });
                        }
                    }
                    else if (confirmation.customId === "cancel_clear") {
                        await confirmation.update({
                            content: "Action cancelled.",
                            embeds: [],
                            components: []
                        });
                    }
                }
                catch (e) {
                    logger_1.default.error("[Clear Streamers Command Error] Confirmation timeout or error:", e);
                    await interaction.editReply({ content: "Confirmation not received within 1 minute, cancelling.", embeds: [], components: [] });
                }
                break;
            }
            default:
                await interaction.reply({ content: 'Invalid streamer subcommand.', flags: discord_js_1.MessageFlags.Ephemeral });
                break;
        }
    },
    category: 'streaming'
};
