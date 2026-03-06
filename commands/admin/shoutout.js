import { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('shoutout')
        .setDescription('Manage the auto-shoutout system')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)

        .addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('Remove all non-permanent streamers from the shoutout list')
        )

        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add Twitch usernames to the shoutout list for a 30-day rotation')
                .addStringOption(opt =>
                    opt.setName('usernames')
                        .setDescription('Comma-separated Twitch usernames (e.g. user1, user2, user3)')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('message')
                        .setDescription('Custom go-live message for all (vars: {username}, {game}, {url}, {title})')
                        .setRequired(false)
                )
        )

        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Show all current shoutout subscriptions')
        )

        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('View community support points leaderboard')
                .addStringOption(opt =>
                    opt.setName('month')
                        .setDescription('Month to view (YYYY-MM format, defaults to current month)')
                        .setRequired(false)
                )
                .addUserOption(opt =>
                    opt.setName('user')
                        .setDescription('Show a specific user\'s stats')
                        .setRequired(false)
                )
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        await interaction.deferReply({ ephemeral: true });

        // Get community support config for shoutout channel
        const [configs] = await pool.execute(
            'SELECT shoutout_channel_id FROM community_support_config WHERE guild_id = ?',
            [guildId]
        );

        if (!configs.length || !configs[0].shoutout_channel_id) {
            return interaction.editReply('No shoutout channel configured. Set up the community support system first.');
        }

        const shoutoutChannelId = configs[0].shoutout_channel_id;

        if (sub === 'list') {
            return handleList(interaction, guildId, shoutoutChannelId);
        } else if (sub === 'clear') {
            return handleClear(interaction, guildId, shoutoutChannelId);
        } else if (sub === 'add') {
            return handleAdd(interaction, guildId, shoutoutChannelId);
        } else if (sub === 'leaderboard') {
            return handleLeaderboard(interaction, guildId);
        }
    }
};

async function handleList(interaction, guildId, shoutoutChannelId) {
    const [subs] = await pool.execute(
        `SELECT s.permanent, st.username
         FROM subscriptions s
         JOIN streamers st ON s.streamer_id = st.streamer_id
         WHERE s.guild_id = ? AND s.announcement_channel_id = ?
         ORDER BY s.permanent DESC, st.username ASC`,
        [guildId, shoutoutChannelId]
    );

    if (subs.length === 0) {
        return interaction.editReply('No streamers in the shoutout list.');
    }

    const permanent = subs.filter(s => s.permanent);
    const rotating = subs.filter(s => !s.permanent);

    let desc = '';
    if (permanent.length > 0) {
        desc += '**Permanent:**\n' + permanent.map(s => `\u2B50 ${s.username}`).join('\n') + '\n\n';
    }
    if (rotating.length > 0) {
        desc += '**Rotation (removable):**\n' + rotating.map(s => `\u25CB ${s.username}`).join('\n');
    }

    const embed = new EmbedBuilder()
        .setColor(0x9146FF)
        .setTitle('Auto-Shoutout List')
        .setDescription(desc)
        .setFooter({ text: `${subs.length} total (${permanent.length} permanent, ${rotating.length} rotation)` });

    return interaction.editReply({ embeds: [embed] });
}

async function handleClear(interaction, guildId, shoutoutChannelId) {
    // Get non-permanent subscriptions for this channel
    const [toRemove] = await pool.execute(
        `SELECT s.subscription_id, st.username, s.streamer_id
         FROM subscriptions s
         JOIN streamers st ON s.streamer_id = st.streamer_id
         WHERE s.guild_id = ? AND s.announcement_channel_id = ? AND s.permanent = 0`,
        [guildId, shoutoutChannelId]
    );

    if (toRemove.length === 0) {
        return interaction.editReply('No non-permanent streamers to remove. Only permanent entries exist.');
    }

    // Delete them
    const ids = toRemove.map(r => r.subscription_id);
    await pool.execute(
        `DELETE FROM subscriptions WHERE subscription_id IN (${ids.map(() => '?').join(',')})`,
        ids
    );

    const names = toRemove.map(r => r.username).join(', ');
    logger.info(`[Shoutout] Cleared ${toRemove.length} non-permanent subscriptions in guild ${guildId}`);

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('Shoutout List Cleared')
        .setDescription(`Removed **${toRemove.length}** non-permanent streamer(s):\n${names}`)
        .setFooter({ text: 'Permanent streamers were not affected' });

    return interaction.editReply({ embeds: [embed] });
}

async function handleAdd(interaction, guildId, shoutoutChannelId) {
    const usernamesRaw = interaction.options.getString('usernames');
    const customMessage = interaction.options.getString('message') || null;

    const usernames = usernamesRaw
        .split(/[,\n]+/)
        .map(u => u.trim().toLowerCase().replace(/^@/, ''))
        .filter(u => u.length > 0);

    if (usernames.length === 0) {
        return interaction.editReply('No valid usernames provided.');
    }

    const { getTwitchUser } = await import('../../utils/platforms/twitch-api.js');

    const added = [];
    const failed = [];
    const existing = [];

    const defaultMessage = 'Top supporter of the month is live! Go show them love and support';

    for (const username of usernames) {
        try {
            const twitchUser = await getTwitchUser(username);
            if (!twitchUser) {
                failed.push({ username, reason: 'not found on Twitch' });
                continue;
            }

            // Check/create streamer
            const [existingStreamer] = await pool.execute(
                'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
                ['twitch', twitchUser.id]
            );

            let streamerId;
            if (existingStreamer.length > 0) {
                streamerId = existingStreamer[0].streamer_id;
            } else {
                const [result] = await pool.execute(
                    `INSERT INTO streamers (platform, platform_user_id, username, profile_image_url)
                     VALUES ('twitch', ?, ?, ?)`,
                    [twitchUser.id, twitchUser.login, twitchUser.profile_image_url || null]
                );
                streamerId = result.insertId;
            }

            // Check if already subscribed
            const [existingSub] = await pool.execute(
                'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                [guildId, streamerId]
            );

            if (existingSub.length > 0) {
                existing.push(twitchUser.login);
                continue;
            }

            // Add subscription (non-permanent, self-cleaning)
            await pool.execute(
                `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message, delete_on_end, permanent)
                 VALUES (?, ?, ?, ?, 1, 0)`,
                [guildId, streamerId, shoutoutChannelId, customMessage || defaultMessage]
            );

            added.push(twitchUser.login);

            // Small delay for Twitch API rate limits
            await new Promise(r => setTimeout(r, 200));
        } catch (error) {
            failed.push({ username, reason: error.message });
        }
    }

    logger.info(`[Shoutout] Added ${added.length} streamers to shoutout in guild ${guildId}`);

    let desc = '';
    if (added.length > 0) {
        desc += `**Added (${added.length}):**\n${added.join(', ')}\n\n`;
    }
    if (existing.length > 0) {
        desc += `**Already in list (${existing.length}):**\n${existing.join(', ')}\n\n`;
    }
    if (failed.length > 0) {
        desc += `**Failed (${failed.length}):**\n${failed.map(f => `${f.username}: ${f.reason}`).join('\n')}`;
    }

    const embed = new EmbedBuilder()
        .setColor(added.length > 0 ? 0x57F287 : 0xED4245)
        .setTitle('Shoutout Add Results')
        .setDescription(desc)
        .setFooter({ text: 'These are non-permanent and can be cleared with /shoutout clear' });

    return interaction.editReply({ embeds: [embed] });
}

async function handleLeaderboard(interaction, guildId) {
    const { getLeaderboard, getUserStats } = await import('../../core/community-support-manager.js');

    const monthRaw = interaction.options.getString('month');
    const targetUser = interaction.options.getUser('user');

    // Validate/default month
    let monthKey;
    if (monthRaw) {
        if (!/^\d{4}-\d{2}$/.test(monthRaw)) {
            return interaction.editReply('Invalid month format. Use YYYY-MM (e.g. 2026-02).');
        }
        monthKey = monthRaw;
    } else {
        const now = new Date();
        monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    const [year, month] = monthKey.split('-');
    const monthName = new Date(parseInt(year), parseInt(month) - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

    // Single user stats
    if (targetUser) {
        const stats = await getUserStats(guildId, targetUser.id, monthKey);

        const embed = new EmbedBuilder()
            .setColor(0x9146FF)
            .setTitle('Community Support Stats')
            .setDescription(`Stats for <@${targetUser.id}> in **${monthName}**`)
            .setThumbnail(targetUser.displayAvatarURL({ size: 64 }))
            .addFields(
                { name: 'Total Points', value: `**${stats.total_points || 0}**`, inline: true },
                { name: 'Raids', value: `${stats.raid_count || 0}`, inline: true },
                { name: 'Supports', value: `${stats.support_count || 0}`, inline: true },
                { name: 'Total Entries', value: `${stats.total_entries || 0}`, inline: true }
            );

        return interaction.editReply({ embeds: [embed] });
    }

    // Full leaderboard
    const leaderboard = await getLeaderboard(guildId, monthKey, 10);

    if (leaderboard.length === 0) {
        const embed = new EmbedBuilder()
            .setColor(0x9146FF)
            .setTitle('Community Support Leaderboard')
            .setDescription(`No entries for **${monthName}** yet.`);
        return interaction.editReply({ embeds: [embed] });
    }

    // Resolve display names
    const entries = [];
    for (let i = 0; i < leaderboard.length; i++) {
        const entry = leaderboard[i];
        let displayName = `<@${entry.user_id}>`;
        try {
            const member = await interaction.guild.members.fetch(entry.user_id);
            displayName = member.displayName;
        } catch {
            // Fallback to mention
        }

        const rankBadge = i === 0 ? '\uD83E\uDD47' : i === 1 ? '\uD83E\uDD48' : i === 2 ? '\uD83E\uDD49' : `\`${i + 1}.\``;
        entries.push(
            `${rankBadge} **${displayName}** — **${entry.total_points}** pts *(${entry.raid_count} raids, ${entry.support_count} supports)*`
        );
    }

    const embed = new EmbedBuilder()
        .setColor(0x9146FF)
        .setTitle('Community Support Leaderboard')
        .setDescription(`**${monthName}**\n\n${entries.join('\n')}`)
        .setFooter({ text: `Top ${leaderboard.length} supporters` });

    return interaction.editReply({ embeds: [embed] });
}
