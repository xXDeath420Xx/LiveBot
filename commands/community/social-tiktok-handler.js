import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getUserVideos, getUserProfile } from '../../utils/platforms/tiktok.js';
import pool from '../../utils/db.js';

function formatNumber(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

export async function handleTiktokLookup(interaction) {
    await interaction.deferReply();

    const username = interaction.options.getString('username').replace('@', '').toLowerCase();

    try {
        const [profile, videos] = await Promise.all([
            getUserProfile(username),
            getUserVideos(username, 5)
        ]);

        if (!profile && videos.length === 0) {
            return interaction.editReply({
                content: `Could not find TikTok user **@${username}**. Make sure the username is correct.`,
                ephemeral: true
            });
        }

        const totalViews = videos.reduce((sum, v) => sum + (v.view_count || 0), 0);
        const totalLikes = videos.reduce((sum, v) => sum + (v.like_count || 0), 0);
        const avgViews = videos.length > 0 ? Math.round(totalViews / videos.length) : 0;

        const [tracked] = await pool.execute(
            `SELECT s.username, COUNT(v.id) as video_count
             FROM streamers s
             LEFT JOIN tiktok_video_posts v ON s.streamer_id = v.streamer_id
             WHERE LOWER(s.username) = ? AND s.platform = 'tiktok'
             GROUP BY s.streamer_id`,
            [username]
        );

        const isTracked = tracked.length > 0;
        const trackedVideoCount = isTracked ? tracked[0].video_count : 0;

        const embed = new EmbedBuilder()
            .setColor('#FF0050')
            .setTitle(`${profile?.nickname || username}'s TikTok`)
            .setURL(`https://www.tiktok.com/@${username}`)
            .setThumbnail(profile?.avatarUrl || videos[0]?.author?.avatar || null);

        if (profile) {
            embed.addFields(
                { name: 'Followers', value: formatNumber(profile.followerCount), inline: true },
                { name: 'Videos', value: formatNumber(profile.videoCount), inline: true },
                { name: 'Tracked Videos', value: trackedVideoCount.toString(), inline: true }
            );
        }

        if (videos.length > 0) {
            embed.addFields(
                { name: 'Recent Stats (Last 5 Videos)', value: '\u200b', inline: false },
                { name: 'Total Views', value: formatNumber(totalViews), inline: true },
                { name: 'Total Likes', value: formatNumber(totalLikes), inline: true },
                { name: 'Avg Views', value: formatNumber(avgViews), inline: true }
            );

            const latest = videos[0];
            const latestTitle = latest.title?.substring(0, 100) || 'Untitled';
            embed.addFields({
                name: 'Latest Video',
                value: `[${latestTitle}](${latest.url})\n\ud83d\udc41 ${formatNumber(latest.view_count)} \u2022 \u2764\ufe0f ${formatNumber(latest.like_count)} \u2022 \ud83d\udcac ${formatNumber(latest.comment_count)}`,
                inline: false
            });
        }

        if (isTracked) {
            embed.setFooter({ text: '\u2713 This user is being tracked for video notifications' });
        } else {
            embed.setFooter({ text: 'Use /social streamer add to track this user\'s videos' });
        }

        embed.setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('View on TikTok').setStyle(ButtonStyle.Link).setURL(`https://www.tiktok.com/@${username}`),
            new ButtonBuilder().setLabel('View Analytics').setStyle(ButtonStyle.Link).setURL(`https://certifriedmultitool.com/analytics/${username}`)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
    } catch (error) {
        console.error('[TikTok] Error:', error);
        await interaction.editReply({
            content: `An error occurred while looking up **@${username}**. Please try again later.`,
            ephemeral: true
        });
    }
}
