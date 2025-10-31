import {
    SlashCommandBuilder,
    PermissionsBitField,
    ChannelType,
    EmbedBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    TextChannel,
    NewsChannel
} from "discord.js";
import db from "../utils/db";
import axios from "axios";
import logger from "../utils/logger";
import { RowDataPacket, ResultSetHeader } from "mysql2";

// Import API check functions - assuming these exist in TypeScript versions
const { getTikTokUser, getYouTubeChannelId } = require("../utils/api_checks.js");
const { logAuditEvent } = require("../utils/audit-log.js");

interface FeedRow extends RowDataPacket {
    subreddit?: string;
    channel_id: string;
    twitter_username?: string;
}

interface SubscriptionRow extends RowDataPacket {
    username: string;
}

interface YouTubeSubscriptionRow extends RowDataPacket {
    youtube_channel_id: string;
    channel_name: string;
}

interface StreamerRow extends RowDataPacket {
    streamer_id: number;
}

interface TikTokUser {
    userId: string;
    username: string;
    profileImageUrl: string;
}

interface YouTubeChannel {
    channelId: string;
    channelName: string;
}

interface CommandData {
    data: SlashCommandBuilder;
    autocomplete: (interaction: AutocompleteInteraction) => Promise<void>;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("feeds")
        .setDescription("Manage automated feeds for the server.")
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommandGroup(group =>
            group
                .setName('reddit')
                .setDescription('Manage Reddit feeds.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("add")
                        .setDescription("Adds a new Reddit feed to a channel.")
                        .addStringOption(option => option.setName("subreddit").setDescription("The name of the subreddit (e.g., announcements).").setRequired(true))
                        .addChannelOption(option => option.setName("channel").setDescription("The channel to post updates in.").addChannelTypes(ChannelType.GuildText).setRequired(true))
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("remove")
                        .setDescription("Removes a Reddit feed.")
                        .addStringOption(option => option.setName("subreddit").setDescription("The subreddit to remove.").setRequired(true).setAutocomplete(true))
                        .addChannelOption(option => option.setName("channel").setDescription("The channel the feed is in.").addChannelTypes(ChannelType.GuildText).setRequired(true))
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("list")
                        .setDescription("Lists all active Reddit feeds on the server.")
                )
        )
        .addSubcommandGroup(group =>
            group
                .setName('tiktok')
                .setDescription('Manage TikTok live announcements.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("add")
                        .setDescription("Announce new livestreams from a TikTok user.")
                        .addStringOption(option => option.setName("username").setDescription("The username of the TikTok user.").setRequired(true))
                        .addChannelOption(option => option.setName("channel").setDescription("The Discord channel to post announcements in.").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
                        .addStringOption(option => option.setName("custom_message").setDescription("Optional: Use {stream_title}, {stream_url}, {channel_name}."))
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("remove")
                        .setDescription("Stop announcing new livestreams from a TikTok user.")
                        .addStringOption(option => option.setName("username").setDescription("The username of the TikTok user to remove.").setRequired(true).setAutocomplete(true))
                )
        )
        .addSubcommandGroup(group =>
            group
                .setName('youtube')
                .setDescription('Manage YouTube video upload announcements.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("add")
                        .setDescription("Announce new video uploads from a YouTube channel.")
                        .addStringOption(option => option.setName("youtube_channel_id_or_url").setDescription("The ID or URL of the YouTube channel.").setRequired(true))
                        .addChannelOption(option => option.setName("channel").setDescription("The Discord channel to post announcements in.").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
                        .addStringOption(option => option.setName("custom_message").setDescription("Optional custom message. Use {video_title}, {video_url}, {channel_name}.")))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("remove")
                        .setDescription("Stop announcing new videos from a YouTube channel.")
                        .addStringOption(option => option.setName("youtube_channel_id").setDescription("The ID of the YouTube channel to remove.").setRequired(true).setAutocomplete(true)))
        )
        .addSubcommandGroup(group =>
            group
                .setName('twitter')
                .setDescription('Manage Twitter (X) feeds for the server.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("add")
                        .setDescription("Adds a new Twitter feed to a channel.")
                        .addStringOption(option => option.setName("username").setDescription("The Twitter @username (without the @).").setRequired(true))
                        .addChannelOption(option => option.setName("channel").setDescription("The channel to post tweets in.").addChannelTypes(ChannelType.GuildText).setRequired(true))
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName("remove")
                        .setDescription("Removes a Twitter feed.")
                        .addStringOption(option => option.setName("username").setDescription("The @username to remove.").setRequired(true).setAutocomplete(true))
                        .addChannelOption(option => option.setName("channel").setDescription("The channel the feed is in.").addChannelTypes(ChannelType.GuildText).setRequired(true))
                )
        ),

    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const focusedOption = interaction.options.getFocused(true);

        if (subcommandGroup === 'reddit' && focusedOption.name === 'subreddit') {
            const focusedValue = focusedOption.value;
            try {
                const [feeds] = await db.execute<FeedRow[]>(
                    "SELECT DISTINCT subreddit FROM reddit_feeds WHERE guild_id = ? AND subreddit LIKE ?",
                    [interaction.guild!.id, `${focusedValue}%`]
                );
                await interaction.respond(feeds.map(feed => ({ name: feed.subreddit!, value: feed.subreddit! })));
            } catch (error) {
                logger.error("[Reddit Command Autocomplete Error]", error as Record<string, any>);
                await interaction.respond([]);
            }
        } else if (subcommandGroup === 'tiktok' && focusedOption.name === 'username') {
            const focusedValue = focusedOption.value;
            try {
                const [subscriptions] = await db.execute<SubscriptionRow[]>(
                    `SELECT s.username
                             FROM subscriptions sub
                             JOIN streamers s ON sub.streamer_id = s.streamer_id
                             WHERE sub.guild_id = ? AND s.platform = 'tiktok' AND s.username LIKE ?`,
                    [interaction.guild!.id, `${focusedValue}%`]
                );
                await interaction.respond(subscriptions.map(sub => ({ name: sub.username, value: sub.username })));
            } catch (error) {
                logger.error("[TikTok Command Autocomplete Error]", error as Record<string, any>);
                await interaction.respond([]);
            }
        } else if (subcommandGroup === 'youtube' && focusedOption.name === 'youtube_channel_id') {
            const focusedValue = focusedOption.value;
            try {
                const [subscriptions] = await db.execute<YouTubeSubscriptionRow[]>(
                    "SELECT youtube_channel_id, channel_name FROM youtube_subscriptions WHERE guild_id = ? AND channel_name LIKE ?",
                    [interaction.guild!.id, `${focusedValue}%`]
                );
                await interaction.respond(subscriptions.map(sub => ({
                    name: `${sub.channel_name} (${sub.youtube_channel_id})`,
                    value: sub.youtube_channel_id
                })));
            } catch (error) {
                logger.error("[YouTube Command Autocomplete Error]", error as Record<string, any>);
                await interaction.respond([]);
            }
        } else if (subcommandGroup === 'twitter' && focusedOption.name === 'username') {
            const focusedValue = focusedOption.value;
            try {
                const [feeds] = await db.execute<FeedRow[]>(
                    "SELECT DISTINCT twitter_username FROM twitter_feeds WHERE guild_id = ? AND twitter_username LIKE ?",
                    [interaction.guild!.id, `${focusedValue}%`]
                );
                await interaction.respond(feeds.map(feed => ({
                    name: `@${feed.twitter_username}`,
                    value: feed.twitter_username!
                })));
            } catch (error) {
                logger.error("[Twitter Feed Autocomplete Error]", error as Record<string, any>);
                await interaction.respond([]);
            }
        }
    },

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild!.id;

        if (subcommandGroup === 'reddit') {
            await interaction.deferReply({ ephemeral: true });
            try {
                if (subcommand === "add") {
                    const subreddit = interaction.options.getString("subreddit", true).toLowerCase();
                    const channel = interaction.options.getChannel("channel", true) as TextChannel;

                    try {
                        await axios.get(`https://www.reddit.com/r/${subreddit}/new.json?limit=1`);
                    } catch (e: any) {
                        logger.warn(`[Reddit Command] Subreddit r/${subreddit} not found or inaccessible: ${e.message}`);
                        await interaction.editReply(`❌ The subreddit \`r/${subreddit}\` does not seem to exist or is private.`);
                        return;
                    }

                    await db.execute(
                        "INSERT INTO reddit_feeds (guild_id, subreddit, channel_id) VALUES (?, ?, ?)",
                        [guildId, subreddit, channel.id]
                    );
                    await interaction.editReply(`✅ Successfully created a feed for \`r/${subreddit}\` in ${channel}.`);
                } else if (subcommand === "remove") {
                    const subreddit = interaction.options.getString("subreddit", true);
                    const channel = interaction.options.getChannel("channel", true) as TextChannel;
                    const [result] = await db.execute<ResultSetHeader>(
                        "DELETE FROM reddit_feeds WHERE guild_id = ? AND subreddit = ? AND channel_id = ?",
                        [guildId, subreddit, channel.id]
                    );

                    if (result.affectedRows > 0) {
                        await interaction.editReply(`🗑️ Removed the feed for \`r/${subreddit}\` from ${channel}.`);
                    } else {
                        await interaction.editReply("❌ No feed found for that subreddit in that channel.");
                    }
                } else if (subcommand === "list") {
                    const [feeds] = await db.execute<FeedRow[]>(
                        "SELECT subreddit, channel_id FROM reddit_feeds WHERE guild_id = ?",
                        [guildId]
                    );
                    if (feeds.length === 0) {
                        await interaction.editReply("There are no Reddit feeds configured on this server.");
                        return;
                    }
                    const description = feeds.map(feed => `\`r/${feed.subreddit}\` -> <#${feed.channel_id}>`).join("\n");
                    const embed = new EmbedBuilder()
                        .setTitle("Active Reddit Feeds")
                        .setColor("#FF4500")
                        .setDescription(description);
                    await interaction.editReply({ embeds: [embed] });
                }
            } catch (error: any) {
                logger.error("[Reddit Command Error]", error as Record<string, any>);
                if (error.code === "ER_DUP_ENTRY") {
                    await interaction.editReply("A feed for that subreddit in that channel already exists.");
                } else {
                    await interaction.editReply("An error occurred while managing Reddit feeds.");
                }
            }
        } else if (subcommandGroup === 'tiktok') {
            await interaction.deferReply({ ephemeral: true });
            try {
                if (subcommand === "add") {
                    const username = interaction.options.getString("username", true);
                    const discordChannel = interaction.options.getChannel("channel", true) as TextChannel | NewsChannel;
                    const customMessage = interaction.options.getString("custom_message");

                    const tiktokUser: TikTokUser = await getTikTokUser(username);
                    if (!tiktokUser || !tiktokUser.userId) {
                        await interaction.editReply({ content: "Could not find a TikTok user with that username. Please check the name and try again." });
                        return;
                    }

                    await db.execute(
                        "INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), profile_image_url = VALUES(profile_image_url)",
                        ["tiktok", tiktokUser.userId, tiktokUser.username, tiktokUser.profileImageUrl]
                    );

                    const [[streamer]] = await db.execute<StreamerRow[]>(
                        "SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?",
                        ["tiktok", tiktokUser.userId]
                    );
                    if (!streamer) {
                        await interaction.editReply({ content: "There was an error adding the streamer to the database." });
                        return;
                    }

                    await db.execute(
                        "INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id), custom_message = VALUES(custom_message)",
                        [guildId, streamer.streamer_id, discordChannel.id, customMessage || null]
                    );

                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor("#57F287")
                            .setTitle("✅ TikTok User Added")
                            .setDescription(`I will now announce new livestreams from **${tiktokUser.username}** in ${discordChannel}.`)]
                    });

                } else if (subcommand === "remove") {
                    const username = interaction.options.getString("username", true);

                    const [[streamer]] = await db.execute<StreamerRow[]>(
                        "SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?",
                        ["tiktok", username]
                    );
                    if (!streamer) {
                        await interaction.editReply({ content: "That TikTok user was not configured for announcements on this server." });
                        return;
                    }

                    const [result] = await db.execute<ResultSetHeader>(
                        "DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?",
                        [guildId, streamer.streamer_id]
                    );

                    if (result.affectedRows > 0) {
                        await interaction.editReply({
                            embeds: [new EmbedBuilder()
                                .setColor("#ED4245")
                                .setTitle("✅ TikTok User Removed")
                                .setDescription(`I will no longer announce new livestreams for that TikTok user.`)]
                        });
                    } else {
                        await interaction.editReply({ content: "That TikTok user was not configured for announcements on this server, or was already removed." });
                    }
                }
            } catch (error) {
                logger.error("[TikTok Command Error]", error as Record<string, any>);
                await interaction.editReply({ content: "An _error occurred while processing your request." });
            }
        } else if (subcommandGroup === 'youtube') {
            await interaction.deferReply({ ephemeral: true });
            try {
                if (subcommand === "add") {
                    const youtubeIdentifier = interaction.options.getString("youtube_channel_id_or_url", true);
                    const discordChannel = interaction.options.getChannel("channel", true) as TextChannel | NewsChannel;
                    const customMessage = interaction.options.getString("custom_message");

                    const youtubeChannel: YouTubeChannel = await getYouTubeChannelId(youtubeIdentifier);
                    if (!youtubeChannel || !youtubeChannel.channelId) {
                        await interaction.editReply({ content: "Could not find a YouTube channel with that ID, URL, or username." });
                        return;
                    }

                    await db.execute(
                        "INSERT INTO youtube_subscriptions (guild_id, discord_channel_id, youtube_channel_id, channel_name, custom_message) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE youtube_channel_id=VALUES(youtube_channel_id), custom_message=VALUES(custom_message)",
                        [guildId, discordChannel.id, youtubeChannel.channelId, youtubeChannel.channelName, customMessage || null]
                    );

                    await logAuditEvent(interaction, "YouTube Subscription Added", `Started announcing new videos from **${youtubeChannel.channelName}** in ${discordChannel}.`);
                    await interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setColor("#57F287")
                            .setTitle("✅ YouTube Channel Added")
                            .setDescription(`I will now announce new videos from **${youtubeChannel.channelName}** in ${discordChannel}.`)]
                    });

                } else if (subcommand === "remove") {
                    const youtubeChannelId = interaction.options.getString("youtube_channel_id", true);
                    const [result] = await db.execute<ResultSetHeader>(
                        "DELETE FROM youtube_subscriptions WHERE guild_id = ? AND youtube_channel_id = ?",
                        [guildId, youtubeChannelId]
                    );

                    if (result.affectedRows > 0) {
                        await logAuditEvent(interaction, "YouTube Subscription Removed", `Stopped announcing new videos for channel ID **${youtubeChannelId}**.`);
                        await interaction.editReply({
                            embeds: [new EmbedBuilder()
                                .setColor("#ED4245")
                                .setTitle("✅ YouTube Channel Removed")
                                .setDescription(`I will no longer announce new videos for that YouTube channel.`)]
                        });
                    } else {
                        await interaction.editReply({ content: "That YouTube channel was not configured for announcements on this server." });
                    }
                }
            } catch (error) {
                logger.error("[YouTube Command Error]", error as Record<string, any>);
                await interaction.editReply({ content: "An _error occurred while processing your request." });
            }
        } else if (subcommandGroup === 'twitter') {
            await interaction.deferReply({ ephemeral: true });
            try {
                const username = interaction.options.getString("username", true).toLowerCase();
                const channel = interaction.options.getChannel("channel", true) as TextChannel;
                if (subcommand === "add") {
                    await db.execute(
                        "INSERT INTO twitter_feeds (guild_id, twitter_username, channel_id) VALUES (?, ?, ?)",
                        [interaction.guild!.id, username, channel.id]
                    );
                    await interaction.editReply(`✅ Successfully created a feed for \`@${username}\` in ${channel}. New tweets will be posted shortly.`);
                } else if (subcommand === "remove") {
                    const [result] = await db.execute<ResultSetHeader>(
                        "DELETE FROM twitter_feeds WHERE guild_id = ? AND twitter_username = ? AND channel_id = ?",
                        [interaction.guild!.id, username, channel.id]
                    );
                    if (result.affectedRows > 0) {
                        await interaction.editReply(`🗑️ Removed the feed for \`@${username}\` from ${channel}.`);
                    } else {
                        await interaction.editReply("❌ No feed found for that user in that channel.");
                    }
                }
            } catch (error: any) {
                if (error.code === "ER_DUP_ENTRY") {
                    await interaction.editReply("A feed for that Twitter user in that channel already exists.");
                } else {
                    logger.error("[Twitter Feed Command Error]", error as Record<string, any>);
                    await interaction.editReply("An error occurred while managing Twitter feeds.");
                }
            }
        }
    }
} as CommandData;