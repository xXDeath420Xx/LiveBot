import {
    SlashCommandBuilder,
    EmbedBuilder,
    ChannelType,
    PermissionsBitField,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    GuildMember,
    TextChannel,
    CategoryChannel,
    Role,
    GuildBasedChannel,
    AttachmentBuilder
} from 'discord.js';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import dotenv from 'dotenv';
import logger from '../utils/logger';
import db from '../utils/db';
import axios from 'axios';
import { Buffer } from 'buffer';

dotenv.config();

// Import only if available, otherwise mock
let predictStreamerSchedule: any, getCachedPrediction: any, endPoll: any;
try {
    const schedulePredictor = require('../core/schedule-predictor');
    predictStreamerSchedule = schedulePredictor.predictStreamerSchedule;
    getCachedPrediction = schedulePredictor.getCachedPrediction;
} catch {
    predictStreamerSchedule = async () => ({ error: 'Schedule predictor not available' });
    getCachedPrediction = async () => null;
}

try {
    const pollManager = require('../core/poll-manager');
    endPoll = pollManager.endPoll;
} catch {
    endPoll = async () => {};
}

// Interfaces
interface Tag extends RowDataPacket {
    tag_name: string;
    tag_content: string;
    creator_id: string;
    created_at: Date;
}

interface Poll extends RowDataPacket {
    id: number;
    guild_id: string;
    channel_id: string;
    message_id: string;
    question: string;
    options: string;
    ends_at: Date;
    is_active: boolean;
}

interface SavedEmbed extends RowDataPacket {
    embed_name: string;
    embed_json: string;
}

interface Streamer extends RowDataPacket {
    streamer_id: number;
    username: string;
    platform: string;
    discord_user_id?: string;
}

interface StreamSession extends RowDataPacket {
    start_time: Date;
    end_time: Date;
    game_name?: string;
    username?: string;
}

interface ManualSchedule extends RowDataPacket {
    monday?: string;
    tuesday?: string;
    wednesday?: string;
    thursday?: string;
    friday?: string;
    saturday?: string;
    sunday?: string;
}

interface AfkStatus extends RowDataPacket {
    guild_id: string;
    user_id: string;
    message: string;
    timestamp: Date;
}

// Unused interfaces - kept for future implementation
// interface StatdockConfig extends RowDataPacket {
//     guild_id: string;
//     channel_id: string;
//     template: string;
// }

interface StatroleConfig extends RowDataPacket {
    guild_id: string;
    role_id: string;
    activity_type: 'messages' | 'voice_minutes';
    threshold: number;
    period_days: number;
}

// interface StarboardConfig extends RowDataPacket {
//     guild_id: string;
//     channel_id: string;
//     star_threshold: number;
// }

// Helper function to format duration
function formatDuration(seconds: number): string {
    if (seconds < 60) {
        return `${Math.floor(seconds)} sec`;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

// Time string parser (e.g., "1m", "1h", "2d")
function parseTime(timeStr: string): Date | null {
    const match = timeStr.match(/^(\d+)(s|m|h|d)$/);
    if (!match || !match[1] || !match[2]) {
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

const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

const answers = [
    "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes – definitely.", "You may rely on it.",
    "As I see it, yes.", "Most likely.", "Outlook good.", "Yes.", "Signs point to yes.",
    "Reply hazy, try again.", "Ask again later.", "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.",
    "Don't count on it.", "My reply is no.", "My sources say no.", "Outlook not so good.", "Very doubtful."
];

const data = new SlashCommandBuilder()
    .setName('utility')
    .setDescription('Provides a collection of utility commands.')
    .addSubcommand(subcommand =>
        subcommand.setName('userinfo')
            .setDescription('Displays information about a user.')
            .addUserOption(option => option.setName('user').setDescription('The user to get info about (defaults to you).'))
    )
    .addSubcommand(subcommand =>
        subcommand.setName('serverinfo')
            .setDescription('Displays detailed information about the current server.')
    )
    .addSubcommand(subcommand =>
        subcommand.setName('help')
            .setDescription('Displays a list of available commands.')
            .addStringOption(option => option.setName("command").setDescription("Get detailed information about a specific command.").setRequired(false))
    )
    .addSubcommandGroup(group =>
        group.setName("poll")
            .setDescription("Create and manage polls")
            .addSubcommand(subcommand =>
                subcommand.setName("create")
                    .setDescription("Creates a poll for users to vote on.")
                    .addStringOption(option => option.setName("question").setDescription("The poll question.").setRequired(true))
                    .addStringOption(option => option.setName("duration").setDescription("How long the poll should last (e.g., 5m, 1h, 1d).").setRequired(true))
                    .addStringOption(option => option.setName("choice1").setDescription("The first choice.").setRequired(true))
                    .addStringOption(option => option.setName("choice2").setDescription("The second choice.").setRequired(true))
                    .addStringOption(option => option.setName("choice3").setDescription("The third choice."))
                    .addStringOption(option => option.setName("choice4").setDescription("The fourth choice."))
                    .addStringOption(option => option.setName("choice5").setDescription("The fifth choice."))
                    .addStringOption(option => option.setName("choice6").setDescription("The sixth choice."))
                    .addStringOption(option => option.setName("choice7").setDescription("The seventh choice."))
                    .addStringOption(option => option.setName("choice8").setDescription("The eighth choice."))
                    .addStringOption(option => option.setName("choice9").setDescription("The ninth choice."))
                    .addStringOption(option => option.setName("choice10").setDescription("The tenth choice."))
            )
            .addSubcommand(subcommand =>
                subcommand.setName("end")
                    .setDescription("Ends an active poll early and shows results.")
                    .addStringOption(option => option.setName("message-id").setDescription("The message ID of the poll to end.").setRequired(true))
            )
            .addSubcommand(subcommand =>
                subcommand.setName("list")
                    .setDescription("Lists all active polls on this server.")
            )
            .addSubcommand(subcommand =>
                subcommand.setName("results")
                    .setDescription("Shows the current results of an active poll without ending it.")
                    .addStringOption(option => option.setName("message-id").setDescription("The message ID of the poll.").setRequired(true))
            )
    )
    .addSubcommand(subcommand =>
        subcommand.setName('define')
            .setDescription('Looks up a word or phrase on Urban Dictionary.')
            .addStringOption(option => option.setName('term').setDescription('The word or phrase to look up.').setRequired(true))
    )
    .addSubcommandGroup(group =>
        group.setName("find")
            .setDescription("Finds users, roles, or channels in the server.")
            .addSubcommand(subcommand => subcommand.setName("user").setDescription("Finds a user by their username or nickname.").addStringOption(option => option.setName("query").setDescription("The name to search for.").setRequired(true)))
            .addSubcommand(subcommand => subcommand.setName("role").setDescription("Finds a role by its name.").addStringOption(option => option.setName("query").setDescription("The name to search for.").setRequired(true)))
            .addSubcommand(subcommand => subcommand.setName("channel").setDescription("Finds a channel by its name.").addStringOption(option => option.setName("query").setDescription("The name to search for.").setRequired(true)))
    )
    .addSubcommand(subcommand =>
        subcommand.setName('invites')
            .setDescription('Shows your or another user\'s invite statistics.')
            .addUserOption(option => option.setName('user').setDescription('The user to check stats for (defaults to you).'))
    )
    .addSubcommand(subcommand =>
        subcommand.setName('weather')
            .setDescription('Checks the current weather for a specified location.')
            .addStringOption(option => option.setName('location').setDescription('The city to get the weather for (e.g., London, New York).').setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand.setName('schedule')
            .setDescription('Displays a streamer\'s official or predicted weekly schedule.')
            .addUserOption(option => option.setName('user').setDescription('The streamer to check the schedule for.').setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand.setName('scan')
            .setDescription('Scans the server for other bots and lists their registered slash commands.')
    )
    .addSubcommandGroup(group =>
        group.setName("tag")
            .setDescription("Shows a tag. Use subcommands to manage tags.")
            .addSubcommand(subcommand => subcommand.setName("show").setDescription("Shows a specific tag.").addStringOption(option => option.setName("name").setDescription("The name of the tag to show.").setAutocomplete(true).setRequired(true)))
            .addSubcommand(subcommand => subcommand.setName("create").setDescription("Creates a new tag.").addStringOption(option => option.setName("name").setDescription("The name for the new tag.").setRequired(true)).addStringOption(option => option.setName("content").setDescription("The content of the tag.").setRequired(true)))
            .addSubcommand(subcommand => subcommand.setName("edit").setDescription("Edits a tag you created.").addStringOption(option => option.setName("name").setDescription("The name of the tag to edit.").setAutocomplete(true).setRequired(true)).addStringOption(option => option.setName("content").setDescription("The new content for the tag.").setRequired(true)))
            .addSubcommand(subcommand => subcommand.setName("delete").setDescription("Deletes a tag you created.").addStringOption(option => option.setName("name").setDescription("The name of the tag to delete.").setAutocomplete(true).setRequired(true)))
            .addSubcommand(subcommand => subcommand.setName("list").setDescription("Lists all tags on the server."))
            .addSubcommand(subcommand => subcommand.setName("info").setDescription("Shows info about a specific tag.").addStringOption(option => option.setName("name").setDescription("The name of the tag.").setAutocomplete(true).setRequired(true)))
    )
    .addSubcommand(subcommand =>
        subcommand.setName('8ball')
            .setDescription('Asks the magic 8-ball a question.')
            .addStringOption(option => option.setName('question').setDescription('The yes-or-no question you want to ask.').setRequired(true))
    )
    .addSubcommand(subcommand =>
        subcommand.setName('cat')
            .setDescription('Sends a random picture of a cat.')
    )
    .addSubcommand(subcommand =>
        subcommand.setName("afk")
            .setDescription("Sets or removes your AFK status.")
            .addStringOption(option => option.setName("message").setDescription("The message to display when someone mentions you (optional)."))
    )
    .addSubcommand(subcommand =>
        subcommand.setName("privacy")
            .setDescription("Set your personal announcement privacy preference.")
            .addStringOption(option => option.setName("level")
                .setDescription("Choose your default privacy level for announcements.")
                .setRequired(true)
                .addChoices(
                    { name: "Public", value: "public" },
                    { name: "Members Only", value: "members" },
                    { name: "Subscribers Only", value: "subscribers" }
                )
            )
    )
    .addSubcommand(subcommand =>
        subcommand.setName('embed')
            .setDescription('Post a pre-saved embed from the dashboard builder.')
            .addStringOption(option => option.setName("name")
                .setDescription("The name of the saved embed to post.")
                .setRequired(true)
                .setAutocomplete(true)
            )
            .addChannelOption(option => option.setName("channel")
                .setDescription("The channel to post the embed in. Defaults to the current channel.")
                .setRequired(false)
            )
    )
    .addSubcommandGroup(group =>
        group.setName('statdock')
            .setDescription('Manage dynamic channel name counters.')
            .addSubcommand(subcommand => subcommand.setName("add")
                .setDescription("Creates a new statdock channel.")
                .addStringOption(option => option.setName("template")
                    .setDescription("The name template. Use {members}, {online}, {bots}. e.g., \"👥 Members: {members}\"")
                    .setRequired(true)
                )
                .addChannelOption(option => option.setName("category")
                    .setDescription("Optional category to create the channel in.")
                    .addChannelTypes(ChannelType.GuildCategory)
                    .setRequired(false)
                )
            )
            .addSubcommand(subcommand => subcommand.setName("remove")
                .setDescription("Removes a statdock channel.")
                .addChannelOption(option => option.setName("channel")
                    .setDescription("The statdock channel to remove.")
                    .setRequired(true)
                )
            )
    )
    .addSubcommandGroup(group =>
        group.setName('statrole')
            .setDescription('Manage roles automatically assigned by activity.')
            .addSubcommand(subcommand => subcommand.setName("add")
                .setDescription("Assign a role based on activity metrics.")
                .addRoleOption(option => option.setName("role").setDescription("The role to assign.").setRequired(true))
                .addStringOption(option => option.setName("activity-type")
                    .setDescription("The type of activity to track.")
                    .setRequired(true)
                    .addChoices(
                        { name: "Messages Sent", value: "messages" },
                        { name: "Minutes in Voice", value: "voice_minutes" }
                    )
                )
                .addIntegerOption(option => option.setName("threshold").setDescription("The amount of activity required.").setRequired(true))
                .addIntegerOption(option => option.setName("period-days").setDescription("The number of days to measure activity over.").setRequired(true))
            )
            .addSubcommand(subcommand => subcommand.setName("remove")
                .setDescription("Stops automatically assigning a role based on activity.")
                .addRoleOption(option => option.setName("role").setDescription("The role to remove from the system.").setRequired(true))
            )
            .addSubcommand(subcommand => subcommand.setName("list").setDescription("Lists all configured activity-based roles."))
    )
    .addSubcommandGroup(group =>
        group.setName('starboard')
            .setDescription('Manages the server starboard.')
            .addSubcommand(subcommand => subcommand.setName("setup")
                .setDescription("Sets up the starboard channel.")
                .addChannelOption(option => option.setName("channel")
                    .setDescription("The channel to post starred messages in.")
                    .addChannelTypes(ChannelType.GuildText)
                    .setRequired(true)
                )
                .addIntegerOption(option => option.setName("threshold")
                    .setDescription("The number of stars required to post a message (default: 3).")
                    .setMinValue(1)
                )
            )
            .addSubcommand(subcommand => subcommand.setName("disable").setDescription("Disables the starboard."))
    )
    .addSubcommandGroup(group =>
        group.setName('stats')
            .setDescription('Displays streaming analytics.')
            .addSubcommand(subcommand => subcommand.setName("streamer")
                .setDescription("Shows analytics for a specific streamer on this server.")
                .addUserOption(option => option.setName("user").setDescription("The Discord user to see stats for.").setRequired(true))
            )
            .addSubcommand(subcommand => subcommand.setName("server").setDescription("Shows aggregate streaming analytics for the entire server."))
    );

async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focusedOption = interaction.options.getFocused(true);
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    if (subcommandGroup === 'tag' && focusedOption.name === "name") {
        const focusedValue = focusedOption.value;
        try {
            const [tags] = await db.execute<Tag[]>(
                "SELECT tag_name FROM tags WHERE guild_id = ? AND tag_name LIKE ? LIMIT 25",
                [interaction.guild!.id, `${focusedValue}%`]
            );
            await interaction.respond(tags.map(tag => ({ name: tag.tag_name, value: tag.tag_name })));
        } catch (error) {
            console.error(("[Tag Autocomplete Error]", error as any));
            await interaction.respond([]);
        }
    } else if (subcommand === 'embed' && focusedOption.name === 'name') {
        const focusedValue = focusedOption.value;
        try {
            const [embeds] = await db.execute<SavedEmbed[]>(
                "SELECT embed_name FROM saved_embeds WHERE guild_id = ? AND embed_name LIKE ? LIMIT 25",
                [interaction.guild!.id, `${focusedValue}%`]
            );
            await interaction.respond(embeds.map(e => ({ name: e.embed_name, value: e.embed_name })));
        } catch (error) {
            logger.error('[Embed Autocomplete Error]', error as Record<string, any>);
            await interaction.respond([]);
        }
    }
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a guild.', ephemeral: true });
        return;
    }

    if (subcommandGroup === 'find') {
        await interaction.deferReply({ ephemeral: true });
        const query = interaction.options.getString("query", true).toLowerCase();
        const guild = interaction.guild;
        const embed = new EmbedBuilder().setColor("#3498DB");

        try {
            if (subcommand === "user") {
                await guild.members.fetch();
                const members = guild.members.cache
                    .filter(member =>
                        member.user.username.toLowerCase().includes(query) ||
                        (member.nickname && member.nickname.toLowerCase().includes(query))
                    )
                    .first(20);

                embed.setTitle(`🔍 User Search Results for "${query}"`);
                if (members.length === 0) {
                    embed.setDescription("No users found.");
                } else {
                    embed.setDescription(members.map(m => `• ${m.user.tag} (${m.id})`).join("\n"));
                }
            } else if (subcommand === "role") {
                const roles = guild.roles.cache
                    .filter(role => role.name.toLowerCase().includes(query))
                    .first(20);

                embed.setTitle(`🔍 Role Search Results for "${query}"`);
                if (roles.length === 0) {
                    embed.setDescription("No roles found.");
                } else {
                    embed.setDescription(roles.map(r => `• ${r.name} (${r.id})`).join("\n"));
                }
            } else if (subcommand === "channel") {
                const channels = guild.channels.cache
                    .filter(channel => channel.name.toLowerCase().includes(query))
                    .first(20);

                embed.setTitle(`🔍 Channel Search Results for "${query}"`);
                if (channels.length === 0) {
                    embed.setDescription("No channels found.");
                } else {
                    embed.setDescription(channels.map(c => `• ${c.name} (${c.id})`).join("\n"));
                }
            }
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            logger.error("[Find Command Error]", error as Record<string, any>);
            await interaction.editReply("An _error occurred while performing the search.");
        }
    } else if (subcommandGroup === 'tag') {
        const guildId = interaction.guild?.id;
        const userId = interaction.user.id;
        let tagName: string | undefined;

        if (subcommand !== "list") {
            tagName = interaction.options.getString("name", true);
        }

        try {
            await interaction.deferReply({ ephemeral: true });

            if (subcommand === "show") {
                const [[tag]] = await db.execute<Tag[]>(
                    "SELECT tag_content FROM tags WHERE guild_id = ? AND tag_name = ?",
                    [guildId, tagName]
                );
                if (!tag) {
                    await interaction.editReply({ content: `Tag \`${tagName}\` not found.` });
                    return;
                }
                await interaction.editReply(tag.tag_content);
            } else if (subcommand === "create") {
                const content = interaction.options.getString("content", true);
                await db.execute(
                    "INSERT INTO tags (guild_id, tag_name, tag_content, creator_id) VALUES (?, ?, ?, ?)",
                    [guildId, tagName, content, userId]
                );
                await interaction.editReply(`✅ Tag \`${tagName}\` created successfully.`);
            } else if (subcommand === "edit") {
                const newContent = interaction.options.getString("content", true);
                const [result] = await db.execute<ResultSetHeader>(
                    "UPDATE tags SET tag_content = ? WHERE guild_id = ? AND tag_name = ? AND creator_id = ?",
                    [newContent, guildId, tagName, userId]
                );
                if (result.affectedRows > 0) {
                    await interaction.editReply(`✅ Tag \`${tagName}\` updated.`);
                } else {
                    await interaction.editReply(`❌ Tag \`${tagName}\` not found, or you don't have permission to edit it.`);
                }
            } else if (subcommand === "delete") {
                const member = interaction.member as GuildMember;
                const hasAdminPerms = member.permissions.has(PermissionsBitField.Flags.ManageGuild);
                let query = "DELETE FROM tags WHERE guild_id = ? AND tag_name = ? AND creator_id = ?";
                let params: (string | undefined)[] = [guildId, tagName, userId];

                if (hasAdminPerms) {
                    query = "DELETE FROM tags WHERE guild_id = ? AND tag_name = ?";
                    params = [guildId, tagName];
                }

                const [result] = await db.execute<ResultSetHeader>(query, params);
                if (result.affectedRows > 0) {
                    await interaction.editReply(`🗑️ Tag \`${tagName}\` deleted.`);
                } else {
                    await interaction.editReply(`❌ Tag \`${tagName}\` not found, or you don't have permission to delete it.`);
                }
            } else if (subcommand === "list") {
                const [tags] = await db.execute<Tag[]>(
                    "SELECT tag_name FROM tags WHERE guild_id = ? ORDER BY tag_name ASC",
                    [guildId]
                );
                if (tags.length === 0) {
                    await interaction.editReply("This server has no tags.");
                    return;
                }
                const tagList = tags.map(t => `\`${t.tag_name}\``).join(", ");
                const embed = new EmbedBuilder()
                    .setTitle(`Tags on ${interaction.guild?.name}`)
                    .setDescription(tagList.substring(0, 4000));
                await interaction.editReply({ embeds: [embed] });
            } else if (subcommand === "info") {
                const [[tag]] = await db.execute<Tag[]>(
                    "SELECT creator_id, created_at FROM tags WHERE guild_id = ? AND tag_name = ?",
                    [guildId, tagName]
                );
                if (!tag) {
                    await interaction.editReply(`Tag \`${tagName}\` not found.`);
                    return;
                }
                const creator = await interaction.client.users.fetch(tag.creator_id);
                const embed = new EmbedBuilder()
                    .setTitle(`Info for tag: ${tagName}`)
                    .addFields(
                        { name: "Creator", value: `${creator.tag} (${creator.id})`, inline: true },
                        { name: "Created", value: `<t:${Math.floor(new Date(tag.created_at).getTime() / 1000)}:R>`, inline: true }
                    );
                await interaction.editReply({ embeds: [embed] });
            }
        } catch (error: any) {
            if (error.code === "ER_DUP_ENTRY") {
                await interaction.editReply(`A tag with the name \`${tagName}\` already exists.`);
            } else {
                console.error(("[Tag Command Error]", error as any));
                await interaction.editReply('An error occurred while managing tags.');
            }
        }
    } else if (subcommandGroup === 'poll') {
        const pollSubcommand = interaction.options.getSubcommand();
        await interaction.deferReply({ ephemeral: true });

        try {
            if (pollSubcommand === "create") {
                const question = interaction.options.getString("question", true);
                const duration = interaction.options.getString("duration", true);
                const endsAt = parseTime(duration);

                if (!endsAt) {
                    await interaction.editReply({ content: 'Invalid duration format. Use formats like `30m`, `2h`, `1d`.' });
                    return;
                }

                const choices: string[] = [];
                for (let i = 1; i <= 10; i++) {
                    const choice = interaction.options.getString(`choice${i}`);
                    if (choice) choices.push(choice);
                }

                if (choices.length < 2) {
                    await interaction.editReply({ content: "Please provide at least two choices for the poll." });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor("#3498DB")
                    .setAuthor({ name: `${interaction.user.tag} started a poll`, iconURL: interaction.user.displayAvatarURL() })
                    .setTitle(question)
                    .setDescription(choices.map((c, i) => `${numberEmojis[i]} ${c}`).join("\n\n"))
                    .addFields({ name: "Ends", value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>` })
                    .setTimestamp();

                const channel = interaction.channel as TextChannel;
                const pollMessage = await channel.send({ embeds: [embed] });
                await interaction.editReply({ content: "Poll created!" });

                for (let i = 0; i < choices.length; i++) {
                    const emoji = numberEmojis[i];
                    if (emoji) {
                        await pollMessage.react(emoji);
                    }
                }

                await db.execute(
                    "INSERT INTO polls (guild_id, channel_id, message_id, question, options, ends_at) VALUES (?, ?, ?, ?, ?, ?)",
                    [interaction.guild?.id, interaction.channel!.id, pollMessage.id, question, JSON.stringify(choices), endsAt]
                );

            } else if (pollSubcommand === "end") {
                const messageId = interaction.options.getString("message-id", true);
                const [[poll]] = await db.execute<Poll[]>(
                    "SELECT * FROM polls WHERE message_id = ? AND guild_id = ? AND is_active = 1",
                    [messageId, interaction.guild?.id]
                );

                if (!poll) {
                    await interaction.editReply({ content: "❌ No active poll found with that message ID." });
                    return;
                }

                if (endPoll) {
                    await endPoll(poll);
                }
                await interaction.editReply({ content: "✅ Poll ended successfully!" });

            } else if (pollSubcommand === "list") {
                const [polls] = await db.execute<Poll[]>(
                    "SELECT * FROM polls WHERE guild_id = ? AND is_active = 1 ORDER BY ends_at ASC",
                    [interaction.guild?.id]
                );

                if (polls.length === 0) {
                    await interaction.editReply({ content: "There are no active polls on this server." });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor("#3498DB")
                    .setTitle("📊 Active Polls")
                    .setDescription(polls.map(p =>
                        `**${p.question}**\nEnds: <t:${Math.floor(new Date(p.ends_at).getTime() / 1000)}:R>\n[Jump to Poll](https://discord.com/channels/${interaction.guild?.id ?? "unknown"}/${p.channel_id}/${p.message_id})`
                    ).join("\n\n"));

                await interaction.editReply({ embeds: [embed] });

            } else if (pollSubcommand === "results") {
                const messageId = interaction.options.getString("message-id", true);
                const [[poll]] = await db.execute<Poll[]>(
                    "SELECT * FROM polls WHERE message_id = ? AND guild_id = ?",
                    [messageId, interaction.guild?.id]
                );

                if (!poll) {
                    await interaction.editReply({ content: "❌ No poll found with that message ID." });
                    return;
                }

                const channel = await interaction.guild?.channels.fetch(poll.channel_id).catch(() => null) as TextChannel | null;
                if (!channel) {
                    await interaction.editReply({ content: "❌ Poll channel not found." });
                    return;
                }

                const message = await channel.messages.fetch(poll.message_id).catch(() => null);
                if (!message) {
                    await interaction.editReply({ content: "❌ Poll message not found." });
                    return;
                }

                const options = JSON.parse(poll.options);
                const results: { option: string; votes: number }[] = [];
                let totalVotes = 0;

                for (let i = 0; i < options.length; i++) {
                    const emoji = numberEmojis[i];
                    const reaction = emoji ? message.reactions.cache.get(emoji) : undefined;
                    const count = reaction ? reaction.count - 1 : 0;
                    results.push({ option: options[i], votes: count });
                    totalVotes += count;
                }

                results.sort((a, b) => b.votes - a.votes);

                const resultsDescription = results.map((res, i) => {
                    const percentage = totalVotes > 0 ? ((res.votes / totalVotes) * 100).toFixed(1) : "0";
                    return `${i === 0 ? '🏆 ' : ''}**${res.option}**: ${res.votes} votes (${percentage}%)`;
                }).join('\n');

                const embed = new EmbedBuilder()
                    .setColor("#3498DB")
                    .setTitle(`Current Results: ${poll.question}`)
                    .setDescription(resultsDescription)
                    .setFooter({ text: `Total Votes: ${totalVotes} | ${poll.is_active ? 'Poll is still active' : 'Poll has ended'}` });

                await interaction.editReply({ embeds: [embed] });
            }
        } catch (error) {
            logger.error("[Poll Command Error]", error as Record<string, any>);
            await interaction.editReply({ content: "An _error occurred while managing the poll." });
        }
    } else if (subcommandGroup === 'statdock') {
        await interaction.deferReply({ ephemeral: true });
        try {
            if (subcommand === "add") {
                const template = interaction.options.getString("template", true);
                const category = interaction.options.getChannel("category") as CategoryChannel | null;

                const newChannel = await interaction.guild?.channels.create({
                    name: "Loading...",
                    type: ChannelType.GuildVoice,
                    parent: category?.id || undefined,
                    permissionOverwrites: [{
                        id: interaction.guild?.roles.everyone,
                        deny: [PermissionsBitField.Flags.Connect]
                    }]
                });

                await db.execute(
                    "INSERT INTO statdocks_config (guild_id, channel_id, template) VALUES (?, ?, ?)",
                    [interaction.guild?.id, newChannel.id, template]
                );
                await interaction.editReply(`✅ Statdock channel ${newChannel} created! It will update shortly.`);
            } else if (subcommand === "remove") {
                const channel = interaction.options.getChannel("channel", true) as GuildBasedChannel;
                const [result] = await db.execute<ResultSetHeader>(
                    "DELETE FROM statdocks_config WHERE guild_id = ? AND channel_id = ?",
                    [interaction.guild?.id, channel.id]
                );

                if (result.affectedRows > 0) {
                    await channel.delete().catch(e => logger.warn(`Failed to delete statdock channel ${channel.id}:`, e));
                    await interaction.editReply(`🗑️ Statdock channel has been removed.`);
                } else {
                    await interaction.editReply(`❌ That channel is not a configured statdock.`);
                }
            }
        } catch (error) {
            logger.error("[Statdock Command Error]", error as Record<string, any>);
            await interaction.editReply("An _error occurred while managing statdocks.");
        }
    } else if (subcommandGroup === 'statrole') {
        await interaction.deferReply({ ephemeral: true });
        try {
            if (subcommand === "add") {
                const role = interaction.options.getRole("role", true) as Role;
                const activityType = interaction.options.getString("activity-type", true) as 'messages' | 'voice_minutes';
                const threshold = interaction.options.getInteger("threshold", true);
                const periodDays = interaction.options.getInteger("period-days", true);

                const botMember = interaction.guild?.members.me!;
                if (!role.editable || role.position >= botMember.roles.highest.position) {
                    await interaction.editReply("I cannot manage this role. Please make sure it is below my highest role.");
                    return;
                }

                await db.execute(
                    "INSERT INTO statroles_config (guild_id, role_id, activity_type, threshold, period_days) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE activity_type=VALUES(activity_type), threshold=VALUES(threshold), period_days=VALUES(period_days)",
                    [interaction.guild?.id, role.id, activityType, threshold, periodDays]
                );
                await interaction.editReply(`✅ Okay! I will now assign the **${role.name}** role to members who have **${threshold} ${activityType === "messages" ? "messages" : "minutes in voice"}** over the last **${periodDays} days**.`);
            } else if (subcommand === "remove") {
                const role = interaction.options.getRole("role", true) as Role;
                const [result] = await db.execute<ResultSetHeader>(
                    "DELETE FROM statroles_config WHERE guild_id = ? AND role_id = ?",
                    [interaction.guild?.id, role.id]
                );

                if (result.affectedRows > 0) {
                    await interaction.editReply(`🗑️ The **${role.name}** role will no longer be automatically assigned.`);
                } else {
                    await interaction.editReply(`❌ That role was not configured as a statrole.`);
                }
            } else if (subcommand === "list") {
                const [roles] = await db.execute<StatroleConfig[]>(
                    "SELECT * FROM statroles_config WHERE guild_id = ?",
                    [interaction.guild?.id]
                );

                if (roles.length === 0) {
                    await interaction.editReply("There are no activity-based roles configured on this server.");
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor("#5865F2")
                    .setTitle("Activity-Based Roles")
                    .setDescription(roles.map(r =>
                        `> <@&${r.role_id}>: **${r.threshold}** ${r.activity_type === "messages" ? "messages" : "minutes in voice"} / **${r.period_days}** days`
                    ).join("\n"));
                await interaction.editReply({ embeds: [embed] });
            }
        } catch (error) {
            logger.error("[Statrole Command Error]", error as Record<string, any>);
            await interaction.editReply("An _error occurred while managing stat roles.");
        }
    } else if (subcommandGroup === 'starboard') {
        await interaction.deferReply({ ephemeral: true });
        try {
            if (subcommand === "setup") {
                const channel = interaction.options.getChannel("channel", true) as TextChannel;
                const threshold = interaction.options.getInteger("threshold") || 3;

                await db.execute(
                    "INSERT INTO starboard_config (guild_id, channel_id, star_threshold) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), star_threshold = VALUES(star_threshold)",
                    [interaction.guild?.id, channel.id, threshold]
                );
                await interaction.editReply(`✅ Starboard enabled! Messages with ${threshold} or more ⭐ reactions will be posted in ${channel}.`);
            } else if (subcommand === "disable") {
                await db.execute("DELETE FROM starboard_config WHERE guild_id = ?", [interaction.guild?.id]);
                await interaction.editReply("🗑️ The starboard has been disabled.");
            }
        } catch (error) {
            logger.error("[Starboard Command Error]", error as Record<string, any>);
            await interaction.editReply({ content: "An _error occurred while managing the starboard." });
        }
    } else if (subcommandGroup === 'stats') {
        await interaction.deferReply();

        if (subcommand === "streamer") {
            const user = interaction.options.getUser("user", true);
            const [[streamer]] = await db.execute<Streamer[]>(
                "SELECT streamer_id FROM streamers WHERE discord_user_id = ?",
                [user.id]
            );

            if (!streamer) {
                await interaction.editReply({ content: `That user is not linked to any streamer profiles on this bot.` });
                return;
            }

            const [sessions] = await db.execute<StreamSession[]>(
                "SELECT start_time, end_time, game_name FROM stream_sessions WHERE streamer_id = ? AND guild_id = ? AND end_time IS NOT NULL",
                [streamer.streamer_id, interaction.guild?.id]
            );

            if (sessions.length === 0) {
                await interaction.editReply({ content: `No completed stream sessions found for ${user.tag} on this server.` });
                return;
            }

            let totalDuration = 0;
            const gameTime: Record<string, number> = {};
            const dayCount: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };

            for (const session of sessions) {
                const start = new Date(session.start_time);
                const end = new Date(session.end_time);
                const duration = (end.getTime() - start.getTime()) / 1000;
                totalDuration += duration;

                if (session.game_name) {
                    gameTime[session.game_name] = (gameTime[session.game_name] || 0) + duration;
                }
                const dayOfWeek = start.getDay();
                if (dayOfWeek !== undefined && dayOfWeek !== null) {
                    dayCount[dayOfWeek] = (dayCount[dayOfWeek] || 0) + 1;
                }
            }

            const topGames = Object.entries(gameTime).sort((a, b) => b[1] - a[1]).slice(0, 5);
            const topDays = Object.entries(dayCount).sort((a, b) => b[1] - a[1]);
            const avgDuration = totalDuration / sessions.length;

            const embed = new EmbedBuilder()
                .setColor("#5865F2")
                .setTitle(`Stream Stats for ${user.username}`)
                .setThumbnail(user.displayAvatarURL())
                .addFields(
                    { name: "Total Stream Time", value: formatDuration(totalDuration), inline: true },
                    { name: "Average Session", value: formatDuration(avgDuration), inline: true },
                    { name: "Total Sessions", value: sessions.length.toString(), inline: true },
                    { name: "Top Games Streamed", value: topGames.length > 0 ? topGames.map((g, i) => `${i + 1}. ${g[0]} (${formatDuration(g[1])})`).join("\n") : "No games tracked.", inline: false },
                    { name: "Most Active Days", value: topDays.map(d => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parseInt(d[0])]}`).join(", "), inline: false }
                );
            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === "server") {
            const [sessions] = await db.execute<StreamSession[]>(
                "SELECT ss.start_time, ss.end_time, ss.game_name, s.username FROM stream_sessions ss JOIN streamers s ON ss.streamer_id = s.streamer_id WHERE ss.guild_id = ? AND ss.end_time IS NOT NULL",
                [interaction.guild?.id]
            );

            if (sessions.length === 0) {
                await interaction.editReply({ content: `No completed stream sessions found for this server.` });
                return;
            }

            let totalDuration = 0;
            const gameTime: Record<string, number> = {};
            const streamerTime: Record<string, number> = {};

            for (const session of sessions) {
                const duration = (new Date(session.end_time).getTime() - new Date(session.start_time).getTime()) / 1000;
                totalDuration += duration;

                if (session.game_name) {
                    gameTime[session.game_name] = (gameTime[session.game_name] || 0) + duration;
                }
                if (session.username) {
                    streamerTime[session.username] = (streamerTime[session.username] || 0) + duration;
                }
            }

            const topGames = Object.entries(gameTime).sort((a, b) => b[1] - a[1]).slice(0, 3);
            const topStreamers = Object.entries(streamerTime).sort((a, b) => b[1] - a[1]).slice(0, 3);

            const embed = new EmbedBuilder()
                .setColor("#5865F2")
                .setTitle(`Server Stream Stats for ${interaction.guild?.name}`)
                .setThumbnail(interaction.guild?.iconURL())
                .addFields(
                    { name: "Total Stream Time", value: formatDuration(totalDuration), inline: true },
                    { name: "Total Sessions", value: sessions.length.toString(), inline: true },
                    { name: "\u200B", value: "\u200B", inline: true },
                    { name: "🏆 Top Streamers (by time)", value: topStreamers.length > 0 ? topStreamers.map((s, i) => `${i + 1}. ${s[0]} (${formatDuration(s[1])})`).join("\n") : "No streamers tracked.", inline: false },
                    { name: "🎮 Top Games Streamed", value: topGames.length > 0 ? topGames.map((g, i) => `${i + 1}. ${g[0]} (${formatDuration(g[1])})`).join("\n") : "No games tracked.", inline: false }
                );
            await interaction.editReply({ embeds: [embed] });
        }
    } else {
        // Handle individual subcommands
        switch (subcommand) {
            case 'userinfo': {
                await interaction.deferReply();
                const targetUser = interaction.options.getUser("user") || interaction.user;
                const member = await interaction.guild?.members.fetch(targetUser.id).catch(() => null);

                if (!member) {
                    await interaction.editReply("Could not find that user in the server.");
                    return;
                }

                const roles = member.roles.cache
                    .sort((a, b) => b.position - a.position)
                    .map(role => role.toString())
                    .slice(0, -1);

                const embed = new EmbedBuilder()
                    .setColor(member.displayHexColor || "#95A5A6")
                    .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
                    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
                    .addFields(
                        { name: "User", value: `${member.user} (${member.id})`, inline: false },
                        { name: "Nickname", value: member.nickname || "None", inline: true },
                        { name: "Bot Account", value: member.user.bot ? "Yes" : "No", inline: true },
                        { name: "Joined Server", value: `<t:${Math.floor((member.joinedTimestamp || 0) / 1000)}:R>`, inline: true },
                        { name: "Account Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                        { name: `Roles [${roles.length}]`, value: roles.length > 0 ? roles.join(", ").substring(0, 1024) : "None", inline: false }
                    )
                    .setFooter({ text: `Requested by ${interaction.user.tag}` })
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
                break;
            }

            case 'serverinfo': {
                await interaction.deferReply();
                const guild = interaction.guild;
                const owner = await guild.fetchOwner();
                const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size;
                const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size;
                const categories = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size;
                const totalMembers = guild.memberCount;
                const humanMembers = guild.members.cache.filter(member => !member.user.bot).size;
                const botMembers = totalMembers - humanMembers;
                const roleCount = guild.roles.cache.size;
                const verificationLevels = ["None", "Low", "Medium", "High", "Very High"];
                const explicitContentFilters = ["Disabled", "Members without roles", "All members"];

                const embed = new EmbedBuilder()
                    .setColor("#3498DB")
                    .setTitle(`Server Info: ${guild.name}`)
                    .setThumbnail(guild.iconURL({ size: 256 }))
                    .addFields(
                        { name: "Owner", value: `${owner.user.tag} (${owner.id})`, inline: false },
                        { name: "Server ID", value: guild.id, inline: false },
                        { name: "Created On", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: false },
                        { name: "Members", value: `**Total:** ${totalMembers}\n**Humans:** ${humanMembers}\n**Bots:** ${botMembers}`, inline: true },
                        { name: "Channels", value: `**Text:** ${textChannels}\n**Voice:** ${voiceChannels}\n**Categories:** ${categories}`, inline: true },
                        { name: "Roles", value: `${roleCount}`, inline: true },
                        { name: "Verification Level", value: verificationLevels[guild.verificationLevel] ?? "Unknown", inline: true },
                        { name: "Explicit Content Filter", value: explicitContentFilters[guild.explicitContentFilter] ?? "Unknown", inline: true }
                    )
                    .setFooter({ text: `Requested by ${interaction.user.tag}` })
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
                break;
            }

            case 'help': {
                const commandName = interaction.options.getString("command");

                if (!commandName) {
                    // General help overview
                    const embed = new EmbedBuilder()
                        .setColor("#5865F2")
                        .setTitle("🤖 CertiFried MultiTool - Command Help")
                        .setDescription("Professional Discord bot with live streaming notifications, moderation, levels, music, and more.\n\n**[📊 Web Dashboard](https://www.certifriedmultitool.com/)** - Manage your server settings online")
                        .addFields(
                            { name: "📺 Stream Announcements", value: "`/streamer` - Manage multi-platform stream notifications\n`/team` - Manage streamer teams\n`/utility schedule` - View streamer schedules\n`/utility stats` - View streaming analytics", inline: false },
                            { name: "🎵 Music & Entertainment", value: "`/music` - Music player commands\n`/musicpanel` - Interactive music control panel\n`/aidj` - AI-powered music recommendations\n`/fun` - Fun and games commands\n`/utility 8ball` - Magic 8-ball predictions\n`/utility cat` - Random cat pictures", inline: false },
                            { name: "🛡️ Moderation & Server Management", value: "`/manage` - Server management tools\n`/timedmod` - Temporary moderation actions\n`/lockdown` - Emergency lockdown controls\n`/raid` - Anti-raid protection\n`/admin` - Advanced admin tools", inline: false },
                            { name: "👥 User Systems", value: "`/rank` - Level and XP system\n`/birthday` - Birthday tracking\n`/events` - Event management\n`/utility invites` - Invite tracking\n`/utility afk` - AFK status system", inline: false },
                            { name: "📝 Forms & Tickets", value: "`/form` - Custom form builder\n`/ticket` - Support ticket system\n`/modmail` - Direct modmail system", inline: false },
                            { name: "💬 Communications", value: "`/autoresponder` - Auto-response triggers\n`/suggest` - Suggestion system\n`/feeds` - Social media feed integration", inline: false },
                            { name: "🔧 Utilities", value: "`/utility` - General utility commands\n`/weather` - Weather information\n`/config` - Bot configuration\n`/utility tag` - Custom text tags\n`/utility poll` - Create polls", inline: false },
                            { name: "⚙️ Admin Tools", value: "`/utility find` - Search users/roles/channels\n`/utility scan` - Scan server bots\n`/utility statdock` - Dynamic stat channels\n`/utility statrole` - Activity-based roles\n`/utility starboard` - Message starboard", inline: false }
                        )
                        .setFooter({ text: "Use /utility help <command> for detailed information about a specific command" })
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });
                } else {
                    // Detailed help for specific command
                    const commandHelp: Record<string, { title: string; description: string; usage: string; examples: string[] }> = {
                        "streamer": {
                            title: "Stream Announcements",
                            description: "Manage live stream notifications for Twitch, YouTube, Kick, Trovo, Facebook, TikTok, Instagram, and Spotify.",
                            usage: "`/streamer add <platform> <username>` - Add a streamer\n`/streamer remove <username>` - Remove a streamer\n`/streamer list` - View all tracked streamers\n`/streamer customize` - Customize announcement settings",
                            examples: [
                                "`/streamer add platform:twitch username:ninja`",
                                "`/streamer customize username:ninja message:🔴 {streamer} is live!`"
                            ]
                        },
                        "team": {
                            title: "Streamer Teams",
                            description: "Organize streamers into teams for bulk management and team-based announcements.",
                            usage: "`/team create <name>` - Create a team\n`/team add <team> <streamer>` - Add streamer to team\n`/team subscribe <team>` - Subscribe to team notifications\n`/team list` - View all teams",
                            examples: [
                                "`/team create name:GamingSquad`",
                                "`/team add team:GamingSquad streamer:ninja`"
                            ]
                        },
                        "music": {
                            title: "Music Player",
                            description: "Full-featured music player supporting YouTube, Spotify, SoundCloud, and more.",
                            usage: "`/music play <query>` - Play a song\n`/music pause` - Pause playback\n`/music skip` - Skip current song\n`/music queue` - View queue\n`/music volume <level>` - Adjust volume",
                            examples: [
                                "`/music play query:Never Gonna Give You Up`",
                                "`/music volume level:50`"
                            ]
                        },
                        "aidj": {
                            title: "AI DJ",
                            description: "AI-powered music recommendations and playlist generation based on mood and preferences.",
                            usage: "`/aidj recommend <mood>` - Get AI song recommendations\n`/aidj playlist <theme>` - Generate themed playlist",
                            examples: [
                                "`/aidj recommend mood:energetic`",
                                "`/aidj playlist theme:workout`"
                            ]
                        },
                        "rank": {
                            title: "Leveling System",
                            description: "XP and leveling system with customizable rewards and leaderboards.",
                            usage: "`/rank` - View your rank\n`/rank user:<@user>` - View another user's rank\n`/rank leaderboard` - Server leaderboard\n`/rank rewards` - Configure level rewards",
                            examples: [
                                "`/rank`",
                                "`/rank leaderboard`"
                            ]
                        },
                        "form": {
                            title: "Form Builder",
                            description: "Create custom forms for applications, surveys, feedback, and more.",
                            usage: "`/form create <name>` - Create a new form\n`/form question add` - Add form question\n`/form publish` - Publish form\n`/form responses` - View responses",
                            examples: [
                                "`/form create name:Staff Application`",
                                "`/form question add form:Staff Application question:What is your experience?`"
                            ]
                        },
                        "ticket": {
                            title: "Support Tickets",
                            description: "Advanced ticket system for user support and assistance.",
                            usage: "`/ticket setup` - Set up ticket system\n`/ticket close` - Close a ticket\n`/ticket transcript` - Get ticket transcript",
                            examples: [
                                "`/ticket setup category:Support`",
                                "`/ticket close reason:Resolved`"
                            ]
                        },
                        "modmail": {
                            title: "Modmail System",
                            description: "Private communication channel between users and server staff.",
                            usage: "`/modmail setup` - Configure modmail\n`/modmail reply` - Reply to modmail\n`/modmail close` - Close modmail thread",
                            examples: [
                                "`/modmail setup channel:#modmail-inbox`",
                                "`/modmail reply message:Thank you for contacting us!`"
                            ]
                        },
                        "manage": {
                            title: "Server Management",
                            description: "Comprehensive server management and moderation tools.",
                            usage: "`/manage kick <user> [reason]` - Kick user\n`/manage ban <user> [reason]` - Ban user\n`/manage mute <user> <duration>` - Mute user\n`/manage role <user> <role>` - Manage roles",
                            examples: [
                                "`/manage kick user:@spammer reason:Spam`",
                                "`/manage mute user:@rulebreaker duration:1h reason:Breaking rules`"
                            ]
                        },
                        "poll": {
                            title: "Poll System",
                            description: "Create interactive polls with multiple options and automatic result tracking.",
                            usage: "`/utility poll create <question> <duration> <choices>` - Create poll\n`/utility poll end <message-id>` - End poll early\n`/utility poll results <message-id>` - View results\n`/utility poll list` - List active polls",
                            examples: [
                                "`/utility poll create question:Favorite color? duration:1h choice1:Red choice2:Blue`",
                                "`/utility poll results message-id:123456789`"
                            ]
                        },
                        "tag": {
                            title: "Custom Tags",
                            description: "Create and manage custom text snippets that can be quickly recalled.",
                            usage: "`/utility tag show <name>` - Display a tag\n`/utility tag create <name> <content>` - Create tag\n`/utility tag edit <name> <content>` - Edit tag\n`/utility tag list` - List all tags",
                            examples: [
                                "`/utility tag create name:rules content:Read our rules at #rules`",
                                "`/utility tag show name:rules`"
                            ]
                        },
                        "schedule": {
                            title: "Stream Schedules",
                            description: "View streamer schedules - either official manual schedules or AI-predicted schedules based on streaming history.",
                            usage: "`/utility schedule <user>` - View schedule for a linked streamer",
                            examples: [
                                "`/utility schedule user:@streamer`"
                            ]
                        },
                        "stats": {
                            title: "Streaming Analytics",
                            description: "View detailed streaming statistics and analytics for streamers and servers.",
                            usage: "`/utility stats streamer <user>` - Individual streamer stats\n`/utility stats server` - Server-wide streaming stats",
                            examples: [
                                "`/utility stats streamer user:@streamer`",
                                "`/utility stats server`"
                            ]
                        },
                        "weather": {
                            title: "Weather Information",
                            description: "Get current weather conditions for any location worldwide.",
                            usage: "`/utility weather <location>` - Check weather",
                            examples: [
                                "`/utility weather location:London`",
                                "`/utility weather location:New York`"
                            ]
                        },
                        "userinfo": {
                            title: "User Information",
                            description: "Display detailed information about a Discord user.",
                            usage: "`/utility userinfo [user]` - Get user info (defaults to yourself)",
                            examples: [
                                "`/utility userinfo`",
                                "`/utility userinfo user:@someone`"
                            ]
                        },
                        "serverinfo": {
                            title: "Server Information",
                            description: "Display detailed statistics and information about the current server.",
                            usage: "`/utility serverinfo` - Get server information",
                            examples: [
                                "`/utility serverinfo`"
                            ]
                        }
                    };

                    const helpData = commandHelp[commandName.toLowerCase()];

                    if (helpData) {
                        const embed = new EmbedBuilder()
                            .setColor("#5865F2")
                            .setTitle(`📖 ${helpData.title}`)
                            .setDescription(helpData.description)
                            .addFields(
                                { name: "Usage", value: helpData.usage, inline: false },
                                { name: "Examples", value: helpData.examples.join("\n"), inline: false }
                            )
                            .setFooter({ text: "Manage settings via the web dashboard at certifriedmultitool.com" })
                            .setTimestamp();

                        await interaction.reply({ embeds: [embed], ephemeral: true });
                    } else {
                        await interaction.reply({
                            content: `❌ No help information found for command \`${commandName}\`.\n\nUse \`/utility help\` without arguments to see all available commands.`,
                            ephemeral: true
                        });
                    }
                }
                break;
            }

            case 'define': {
                await interaction.deferReply();
                const term = interaction.options.getString("term", true);
                try {
                    const response = await axios.get(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(term)}`);
                    const results = response.data.list;

                    if (!results || results.length === 0) {
                        await interaction.editReply(`No definitions found for **${term}**.`);
                        return;
                    }

                    const definition = results.sort((a: any, b: any) => b.thumbs_up - a.thumbs_up)[0];
                    const cleanDefinition = definition.definition.replace(/[\[\]]/g, "");
                    const cleanExample = definition.example ? definition.example.replace(/[\[\]]/g, "") : "No example provided.";

                    const embed = new EmbedBuilder()
                        .setColor("#1D2439")
                        .setTitle(definition.word)
                        .setURL(definition.permalink)
                        .setAuthor({ name: "Urban Dictionary", iconURL: "https://i.imgur.com/vdoHnaG.png" })
                        .addFields(
                            { name: "Definition", value: cleanDefinition.substring(0, 1024), inline: false },
                            { name: "Example", value: cleanExample.substring(0, 1024), inline: false },
                            { name: "Rating", value: `👍 ${definition.thumbs_up} | 👎 ${definition.thumbs_down}`, inline: true }
                        );
                    await interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    console.error(("[Define Command Error]", error as any));
                    await interaction.editReply("Sorry, I couldn't connect to the dictionary service right now.");
                }
                break;
            }

            case 'invites': {
                await interaction.deferReply();
                const user = interaction.options.getUser("user") || interaction.user;
                const guildId = interaction.guild?.id;

                interface InviteCount extends RowDataPacket {
                    count: number;
                }

                try {
                    const [[joinsResult]] = await db.execute<InviteCount[]>(
                        "SELECT COUNT(*) as count FROM invite_tracker_logs WHERE guild_id = ? AND inviter_id = ? AND event_type = 'join'",
                        [guildId, user.id]
                    );
                    const [[leavesResult]] = await db.execute<InviteCount[]>(
                        "SELECT COUNT(*) as count FROM invite_tracker_logs WHERE guild_id = ? AND inviter_id = ? AND event_type = 'leave'",
                        [guildId, user.id]
                    );

                    const totalJoins = joinsResult?.count || 0;
                    const totalLeaves = leavesResult?.count || 0;
                    const realInvites = totalJoins - totalLeaves;

                    const embed = new EmbedBuilder()
                        .setColor("#5865F2")
                        .setAuthor({ name: `${user.username}'s Invite Stats`, iconURL: user.displayAvatarURL() })
                        .setDescription(`**${realInvites}** real invites`)
                        .addFields(
                            { name: "✅ Joins", value: `${totalJoins}`, inline: true },
                            { name: "❌ Leaves", value: `${totalLeaves}`, inline: true }
                        );
                    await interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    logger.error("[Invites Command Error]", error as Record<string, any>);
                    await interaction.editReply({ content: "An _error occurred while fetching invite stats." });
                }
                break;
            }

            case 'weather': {
                await interaction.deferReply();
                const location = interaction.options.getString("location", true);
                try {
                    const response = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
                    const weather = response.data.current_condition[0];
                    const area = response.data.nearest_area[0];
                    const locationName = `${area.areaName[0].value}, ${area.region[0].value}, ${area.country[0].value}`;

                    const embed = new EmbedBuilder()
                        .setColor("#3498DB")
                        .setTitle(`Weather for ${locationName}`)
                        .setThumbnail(`https://wttr.in/_(${location}).png?format=v2`)
                        .addFields(
                            { name: "Condition", value: weather.weatherDesc[0].value, inline: true },
                            { name: "Temperature", value: `${weather.temp_F}°F / ${weather.temp_C}°C`, inline: true },
                            { name: "Feels Like", value: `${weather.FeelsLikeF}°F / ${weather.FeelsLikeC}°C`, inline: true },
                            { name: "Wind", value: `${weather.windspeedMiles} mph`, inline: true },
                            { name: "Humidity", value: `${weather.humidity}%`, inline: true },
                            { name: "Observation Time", value: weather.observation_time, inline: true }
                        )
                        .setFooter({ text: "Weather data from wttr.in" });
                    await interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    logger.error("[Weather Command Error]", error as Record<string, any>);
                    await interaction.editReply("Could not fetch weather information for that location. Please check the spelling and try again.");
                }
                break;
            }

            case 'schedule': {
                await interaction.deferReply();
                const user = interaction.options.getUser("user", true);
                try {
                    const [[streamer]] = await db.execute<Streamer[]>(
                        "SELECT streamer_id, username, platform FROM streamers WHERE discord_user_id = ?",
                        [user.id]
                    );

                    if (!streamer) {
                        await interaction.editReply({ content: `That user is not linked to any streamer profiles on this bot.` });
                        return;
                    }

                    // Check for manual schedule first
                    const [[manualSchedule]] = await db.execute<ManualSchedule[]>(
                        "SELECT * FROM manual_schedules WHERE streamer_id = ?",
                        [streamer.streamer_id]
                    );

                    if (manualSchedule && Object.values(manualSchedule).some(day => day)) {
                        const embed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setTitle(`Official Schedule for ${user.username}`)
                            .setThumbnail(user.displayAvatarURL())
                            .setDescription("This is the official schedule as set by the streamer.");

                        const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
                        for (const day of days) {
                            embed.addFields({
                                name: day.charAt(0).toUpperCase() + day.slice(1),
                                value: (manualSchedule as any)[day] || "Not Streaming",
                                inline: true
                            });
                        }
                        await interaction.editReply({ embeds: [embed] });
                        return;
                    }

                    // Try to get cached AI prediction
                    let prediction = await getCachedPrediction(streamer.streamer_id);

                    // If no cache or expired, generate new prediction
                    if (!prediction) {
                        const result = await predictStreamerSchedule(streamer.streamer_id, 30);
                        if (result.error) {
                            await interaction.editReply({ content: `Could not generate schedule prediction: ${result.message || result.error}` });
                            return;
                        }
                        prediction = result;
                    }

                    // Build enhanced embed with AI predictions
                    const embed = new EmbedBuilder()
                        .setColor("#5865F2")
                        .setTitle(`🤖 AI-Predicted Schedule for ${streamer.username}`)
                        .setThumbnail(user.displayAvatarURL())
                        .setDescription(`**Platform:** ${streamer.platform.charAt(0).toUpperCase() + streamer.platform.slice(1)}\n**Consistency:** ${prediction.prediction.consistency.toUpperCase()}\n\n${prediction.prediction.recommendation}`)
                        .setFooter({ text: `Based on ${prediction.dataPoints} streams • AI-powered prediction` });

                    // Add most likely days
                    if (prediction.prediction.mostLikelyDays && prediction.prediction.mostLikelyDays.length > 0) {
                        const daysField = prediction.prediction.mostLikelyDays
                            .sort((a: any, b: any) => b.confidence - a.confidence)
                            .map((day: any) => `**${day.day}** - ${day.confidence}% confident (${day.timeRange})`)
                            .join('\n');
                        embed.addFields({ name: `📅 Most Likely Stream Days (${prediction.prediction.weeklyFrequency} per week)`, value: daysField, inline: false });
                    }

                    // Add patterns
                    if (prediction.prediction.patterns && prediction.prediction.patterns.length > 0) {
                        embed.addFields({ name: '🔍 Detected Patterns', value: prediction.prediction.patterns.map((p: string) => `• ${p}`).join('\n'), inline: false });
                    }

                    await interaction.editReply({ embeds: [embed] });

                } catch (error) {
                    logger.error("[Schedule Command Error]", error as Record<string, any>);
                    await interaction.editReply({ content: "An _error occurred while generating the schedule." });
                }
                break;
            }

            case 'scan': {
                await interaction.deferReply({ ephemeral: true });
                try {
                    const members = await interaction.guild?.members.fetch();
                    const bots = members.filter(member => member.user.bot);

                    if (bots.size === 0) {
                        await interaction.editReply("I couldn't find any other bots in this server.");
                        return;
                    }

                    const allCommands = await interaction.guild?.commands.fetch();
                    logger.info(`[Scan Command] Fetched a total of ${allCommands.size} application commands from the guild "${interaction.guild?.name}".`);

                    const botData: any[] = [];
                    let commandCount = 0;

                    for (const [botId, botMember] of bots) {
                        const botCommands = allCommands.filter(cmd => cmd.applicationId === botId);
                        if (botCommands.size > 0) {
                            commandCount += botCommands.size;
                            botData.push({
                                name: botMember.user.username,
                                id: botId,
                                commands: botCommands.map(cmd => ({
                                    name: cmd.name,
                                    description: cmd.description,
                                    options: cmd.options.map(opt => ({
                                        name: opt.name,
                                        type: opt.type,
                                        description: opt.description,
                                    }))
                                }))
                            });
                        }
                    }

                    if (commandCount === 0) {
                        await interaction.editReply("Found some bots, but none of them seem to have any slash commands registered in this server.");
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setTitle(`🤖 Bot Scan Report`)
                        .setDescription(`Found **${botData.length}** bots with a total of **${commandCount}** slash commands in this server.`)
                        .setColor("#0099ff")
                        .setTimestamp();

                    await interaction.editReply({ embeds: [embed] });

                    const jsonData = JSON.stringify(botData, null, 2);
                    const buffer = Buffer.from(jsonData, "utf-8");
                    const attachment = new AttachmentBuilder(buffer, { name: "bot_scan_report.json" });

                    await interaction.followUp({
                        content: "Here is the full structured report:",
                        files: [attachment],
                        ephemeral: true,
                    });
                } catch (error) {
                    logger.error("[Scan Command Error]", error as Record<string, any>);
                    await interaction.editReply({ content: "An _error occurred while scanning for bots." });
                }
                break;
            }

            case '8ball': {
                const question = interaction.options.getString("question", true);
                const answer = answers[Math.floor(Math.random() * answers.length)];
                const embed = new EmbedBuilder()
                    .setColor("#2C2F33")
                    .setTitle("🎱 Magic 8-Ball")
                    .addFields(
                        { name: "Your Question", value: question, inline: false },
                        { name: "The 8-Ball Says...", value: `**${answer}**`, inline: false }
                    );
                await interaction.reply({ embeds: [embed] });
                break;
            }

            case 'cat': {
                await interaction.deferReply();
                try {
                    const response = await axios.get("https://api.thecatapi.com/v1/images/search");
                    const catImage = response.data[0].url;
                    const embed = new EmbedBuilder()
                        .setColor("#9B59B6")
                        .setTitle("🐱 Here is a random cat!")
                        .setImage(catImage)
                        .setFooter({ text: "Powered by thecatapi.com" });
                    await interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    console.error(("[Cat Command Error]", error as any));
                    await interaction.editReply("Sorry, I couldn't fetch a cat picture right now.");
                }
                break;
            }

            case 'afk': {
                await interaction.deferReply({ ephemeral: true });
                const message = interaction.options.getString("message") || "AFK";
                const guildId = interaction.guild?.id;
                const userId = interaction.user.id;

                try {
                    const [[existingAfk]] = await db.execute<AfkStatus[]>(
                        "SELECT * FROM afk_statuses WHERE guild_id = ? AND user_id = ?",
                        [guildId, userId]
                    );

                    if (existingAfk) {
                        await db.execute(
                            "DELETE FROM afk_statuses WHERE guild_id = ? AND user_id = ?",
                            [guildId, userId]
                        );
                        await interaction.editReply("Welcome back! Your AFK status has been removed.");
                    } else {
                        await db.execute(
                            "INSERT INTO afk_statuses (guild_id, user_id, message, timestamp) VALUES (?, ?, ?, NOW())",
                            [guildId, userId, message]
                        );
                        await interaction.editReply(`You are now set as AFK with the message: "${message}".`);
                    }
                } catch (error) {
                    console.error(("[AFK Command Error]", error as any));
                    await interaction.editReply("An _error occurred while setting your AFK status.");
                }
                break;
            }

            case 'privacy': {
                const userId = interaction.user.id;
                const privacyLevel = interaction.options.getString("level", true);

                try {
                    await db.execute(
                        "INSERT INTO user_preferences (discord_user_id, privacy_level) VALUES (?, ?) ON DUPLICATE KEY UPDATE privacy_level = VALUES(privacy_level)",
                        [userId, privacyLevel]
                    );
                    await interaction.reply({ content: `Your privacy preference has been set to **${privacyLevel}**.`, ephemeral: true });
                } catch (error) {
                    logger.error("Error setting user privacy preference:", error as Record<string, any>);
                    await interaction.reply({ content: "There was an _error saving your preference.", ephemeral: true });
                }
                break;
            }

            case 'embed': {
                await interaction.deferReply({ ephemeral: true });
                const embedName = interaction.options.getString("name", true);
                const channel = interaction.options.getChannel("channel") as TextChannel || interaction.channel as TextChannel;

                try {
                    const [[savedEmbed]] = await db.execute<SavedEmbed[]>(
                        "SELECT embed_json FROM saved_embeds WHERE guild_id = ? AND embed_name = ?",
                        [interaction.guild?.id, embedName]
                    );

                    if (!savedEmbed) {
                        await interaction.editReply(`❌ An embed with the name \`${embedName}\` was not found.`);
                        return;
                    }

                    const embedData = JSON.parse(savedEmbed.embed_json);
                    const embed = new EmbedBuilder(embedData);
                    await channel.send({ embeds: [embed] });
                    await interaction.editReply(`✅ Embed \`${embedName}\` has been posted in ${channel}.`);
                } catch (error) {
                    logger.error("[Embed Command Error]", error as Record<string, any>);
                    await interaction.editReply("An _error occurred while trying to post the embed.");
                }
                break;
            }

            default:
                await interaction.reply({ content: 'Invalid utility subcommand.', ephemeral: true });
                break;
        }
    }
}

// Export using CommonJS pattern
module.exports = {
    data,
    autocomplete,
    execute,
    category: 'utility'
};