import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export async function handleStatsCommunity(interaction) {
    await interaction.deferReply();
    const guildId = interaction.guild.id;

    const [
        [journalStats],
        [entryStats],
        [harvestStats],
        [tradeStats],
        [mediumStats],
        [stageStats]
    ] = await Promise.all([
        pool.execute(
            `SELECT
                COUNT(*) as total_journals,
                COUNT(DISTINCT user_id) as unique_growers,
                SUM(CASE WHEN is_active = TRUE THEN 1 ELSE 0 END) as active_grows,
                SUM(CASE WHEN current_stage = 'complete' THEN 1 ELSE 0 END) as completed_grows
             FROM grow_journals WHERE guild_id = ?`,
            [guildId]
        ),
        pool.execute(
            `SELECT COUNT(*) as total_entries
             FROM journal_entries je
             JOIN grow_journals gj ON je.journal_id = gj.id
             WHERE gj.guild_id = ?`,
            [guildId]
        ),
        pool.execute(
            `SELECT COUNT(*) as total_harvests
             FROM grow_harvest_stats WHERE guild_id = ?`,
            [guildId]
        ),
        pool.execute(
            `SELECT
                COUNT(*) as total_trades,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_trades
             FROM trade_escrow WHERE guild_id = ?`,
            [guildId]
        ),
        pool.execute(
            `SELECT grow_medium, COUNT(*) as count
             FROM grow_journals WHERE guild_id = ?
             GROUP BY grow_medium ORDER BY count DESC LIMIT 3`,
            [guildId]
        ),
        pool.execute(
            `SELECT current_stage, COUNT(*) as count
             FROM grow_journals WHERE guild_id = ? AND is_active = TRUE
             GROUP BY current_stage ORDER BY count DESC`,
            [guildId]
        )
    ]);

    const embed = new EmbedBuilder()
        .setColor('#228B22')
        .setTitle(` ${interaction.guild.name} Grow Community Stats`)
        .setThumbnail(interaction.guild.iconURL())
        .addFields(
            { name: ' Unique Growers', value: `${journalStats[0].unique_growers}`, inline: true },
            { name: ' Total Journals', value: `${journalStats[0].total_journals}`, inline: true },
            { name: ' Active Grows', value: `${journalStats[0].active_grows}`, inline: true },
            { name: ' Completed Grows', value: `${journalStats[0].completed_grows}`, inline: true },
            { name: ' Total Entries', value: `${entryStats[0].total_entries}`, inline: true },
            { name: ' Harvests Logged', value: `${harvestStats[0].total_harvests}`, inline: true }
        )
        .setTimestamp();

    if (mediumStats.length > 0) {
        const mediumNames = { soil: 'Soil', coco: 'Coco', hydro: 'Hydro', dwc: 'DWC', aero: 'Aero', other: 'Other' };
        const mediumText = mediumStats.map(m =>
            `${mediumNames[m.grow_medium] || m.grow_medium}: ${m.count}`
        ).join(' | ');
        embed.addFields({ name: ' Popular Mediums', value: mediumText, inline: false });
    }

    if (stageStats.length > 0) {
        const stageEmojis = { germination: '', seedling: '', vegetative: '', transition: '', flowering: '', harvest: '', cure: '', complete: '' };
        const stageText = stageStats.map(s =>
            `${stageEmojis[s.current_stage] || ''} ${s.current_stage}: ${s.count}`
        ).join('\n');
        embed.addFields({ name: ' Active Grow Stages', value: stageText, inline: false });
    }

    if (tradeStats[0].total_trades > 0) {
        embed.addFields({
            name: ' Trade Activity',
            value: `${tradeStats[0].completed_trades}/${tradeStats[0].total_trades} trades completed`,
            inline: false
        });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleStatsLeaderboard(interaction) {
    const type = interaction.options.getString('type');
    await interaction.deferReply();

    let leaderboardData = [];
    let title = '';
    let emoji = '';

    switch (type) {
        case 'active':
            [leaderboardData] = await pool.execute(
                `SELECT user_id, COUNT(*) as count
                 FROM grow_journals WHERE guild_id = ? AND is_active = TRUE
                 GROUP BY user_id ORDER BY count DESC LIMIT 10`,
                [interaction.guild.id]
            );
            title = 'Most Active Growers';
            emoji = '';
            break;

        case 'completed':
            [leaderboardData] = await pool.execute(
                `SELECT user_id, COUNT(*) as count
                 FROM grow_journals WHERE guild_id = ? AND current_stage = 'complete'
                 GROUP BY user_id ORDER BY count DESC LIMIT 10`,
                [interaction.guild.id]
            );
            title = 'Most Grows Completed';
            emoji = '';
            break;

        case 'harvests':
            [leaderboardData] = await pool.execute(
                `SELECT user_id, COUNT(*) as count
                 FROM grow_harvest_stats WHERE guild_id = ?
                 GROUP BY user_id ORDER BY count DESC LIMIT 10`,
                [interaction.guild.id]
            );
            title = 'Best Harvesters';
            emoji = '';
            break;

        case 'entries':
            [leaderboardData] = await pool.execute(
                `SELECT gj.user_id, COUNT(je.id) as count
                 FROM grow_journals gj
                 JOIN journal_entries je ON gj.id = je.journal_id
                 WHERE gj.guild_id = ?
                 GROUP BY gj.user_id ORDER BY count DESC LIMIT 10`,
                [interaction.guild.id]
            );
            title = 'Most Dedicated Journalers';
            emoji = '';
            break;

        case 'traders':
            [leaderboardData] = await pool.execute(
                `SELECT
                    CASE WHEN seller_id = user_id THEN seller_id ELSE buyer_id END as user_id,
                    COUNT(*) as count
                 FROM (
                    SELECT seller_id as user_id, seller_id, buyer_id FROM trade_escrow WHERE guild_id = ? AND status = 'completed'
                    UNION ALL
                    SELECT buyer_id as user_id, seller_id, buyer_id FROM trade_escrow WHERE guild_id = ? AND status = 'completed'
                 ) trades
                 GROUP BY user_id ORDER BY count DESC LIMIT 10`,
                [interaction.guild.id, interaction.guild.id]
            );
            title = 'Top Traders';
            emoji = '';
            break;
    }

    if (leaderboardData.length === 0) {
        return interaction.editReply({ content: 'No data available for this leaderboard yet!' });
    }

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`${emoji} ${title}`)
        .setTimestamp();

    let description = '';
    const medals = ['', '', ''];

    for (let i = 0; i < leaderboardData.length; i++) {
        const entry = leaderboardData[i];
        const medal = i < 3 ? medals[i] : `**${i + 1}.**`;
        description += `${medal} <@${entry.user_id}> - **${entry.count}**\n`;
    }

    embed.setDescription(description);
    await interaction.editReply({ embeds: [embed] });
}

export async function handleStatsStrains(interaction) {
    await interaction.deferReply();

    const [strainStats] = await pool.execute(
        `SELECT strain_name, COUNT(*) as grow_count,
                SUM(CASE WHEN current_stage = 'complete' THEN 1 ELSE 0 END) as completed_count
         FROM grow_journals WHERE guild_id = ? AND strain_name IS NOT NULL
         GROUP BY strain_name ORDER BY grow_count DESC LIMIT 15`,
        [interaction.guild.id]
    );

    if (strainStats.length === 0) {
        return interaction.editReply({
            content: 'No strain data available yet. Start a journal with `/grow journal create`!'
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle(' Popular Strains in This Community')
        .setTimestamp();

    let description = '';
    for (let i = 0; i < strainStats.length; i++) {
        const strain = strainStats[i];
        const rank = i < 3 ? ['', '', ''][i] : `${i + 1}.`;
        const completionRate = strain.grow_count > 0
            ? Math.round((strain.completed_count / strain.grow_count) * 100)
            : 0;
        description += `${rank} **${strain.strain_name}** - ${strain.grow_count} grows (${completionRate}% completed)\n`;
    }

    embed.setDescription(description);
    embed.setFooter({ text: 'Based on journals in this server' });

    await interaction.editReply({ embeds: [embed] });
}

export async function handleStatsPersonal(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    await interaction.deferReply();
    const userId = targetUser.id;

    const [
        [journalStats],
        [entryStats],
        [favoriteStrain],
        [favoriteMedium],
        [tradeStats],
        [reviewStats]
    ] = await Promise.all([
        pool.execute(
            `SELECT
                COUNT(*) as total_journals,
                SUM(CASE WHEN is_active = TRUE THEN 1 ELSE 0 END) as active_grows,
                SUM(CASE WHEN current_stage = 'complete' THEN 1 ELSE 0 END) as completed_grows,
                AVG(CASE WHEN current_stage = 'complete' THEN DATEDIFF(updated_at, start_date) END) as avg_grow_days
             FROM grow_journals WHERE user_id = ?`,
            [userId]
        ),
        pool.execute(
            `SELECT COUNT(*) as total_entries
             FROM journal_entries je
             JOIN grow_journals gj ON je.journal_id = gj.id
             WHERE gj.user_id = ?`,
            [userId]
        ),
        pool.execute(
            `SELECT strain_name, COUNT(*) as count
             FROM grow_journals WHERE user_id = ? AND strain_name IS NOT NULL
             GROUP BY strain_name ORDER BY count DESC LIMIT 1`,
            [userId]
        ),
        pool.execute(
            `SELECT grow_medium, COUNT(*) as count
             FROM grow_journals WHERE user_id = ?
             GROUP BY grow_medium ORDER BY count DESC LIMIT 1`,
            [userId]
        ),
        pool.execute(
            `SELECT
                COUNT(*) as total_trades,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_trades
             FROM trade_escrow WHERE seller_id = ? OR buyer_id = ?`,
            [userId, userId]
        ),
        pool.execute(
            `SELECT AVG(rating) as avg_rating, COUNT(*) as review_count
             FROM trade_reviews WHERE reviewed_user_id = ?`,
            [userId]
        )
    ]);

    const embed = new EmbedBuilder()
        .setColor('#27AE60')
        .setTitle(` ${targetUser.username}'s Grow Profile`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
            { name: ' Total Journals', value: `${journalStats[0].total_journals}`, inline: true },
            { name: ' Active Grows', value: `${journalStats[0].active_grows}`, inline: true },
            { name: ' Completed', value: `${journalStats[0].completed_grows}`, inline: true },
            { name: ' Journal Entries', value: `${entryStats[0].total_entries}`, inline: true }
        )
        .setTimestamp();

    if (journalStats[0].avg_grow_days) {
        embed.addFields({ name: ' Avg Grow Time', value: `${Math.round(journalStats[0].avg_grow_days)} days`, inline: true });
    }

    if (favoriteStrain.length > 0) {
        embed.addFields({ name: ' Favorite Strain', value: favoriteStrain[0].strain_name, inline: true });
    }

    if (favoriteMedium.length > 0) {
        const mediumNames = { soil: 'Soil', coco: 'Coco', hydro: 'Hydro', dwc: 'DWC', aero: 'Aero', other: 'Other' };
        embed.addFields({ name: ' Preferred Medium', value: mediumNames[favoriteMedium[0].grow_medium] || favoriteMedium[0].grow_medium, inline: true });
    }

    if (tradeStats[0].total_trades > 0) {
        const avgRating = reviewStats[0].avg_rating ? parseFloat(reviewStats[0].avg_rating).toFixed(1) : 'N/A';
        embed.addFields({ name: ' Trade Reputation', value: `${tradeStats[0].completed_trades} trades | ${avgRating}/5 rating`, inline: false });
    }

    let badges = [];
    if (journalStats[0].completed_grows >= 10) badges.push(' Master Grower');
    else if (journalStats[0].completed_grows >= 5) badges.push(' Experienced');
    else if (journalStats[0].completed_grows >= 1) badges.push(' First Harvest');
    if (entryStats[0].total_entries >= 100) badges.push(' Dedicated Journalist');
    if (tradeStats[0].completed_trades >= 10) badges.push(' Trusted Trader');

    if (badges.length > 0) {
        embed.addFields({ name: 'Badges', value: badges.join(' '), inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleStatsTrends(interaction) {
    await interaction.deferReply();

    const [recentJournals] = await pool.execute(
        `SELECT DATE(created_at) as date, COUNT(*) as count
         FROM grow_journals WHERE guild_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         GROUP BY DATE(created_at) ORDER BY date DESC`,
        [interaction.guild.id]
    );

    const [stageTransitions] = await pool.execute(
        `SELECT current_stage, COUNT(*) as count
         FROM grow_journals WHERE guild_id = ? AND updated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
         GROUP BY current_stage`,
        [interaction.guild.id]
    );

    const [recentHarvests] = await pool.execute(
        `SELECT COUNT(*) as count
         FROM grow_harvest_stats
         WHERE guild_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
        [interaction.guild.id]
    );

    const [growTypeStats] = await pool.execute(
        `SELECT grow_type, COUNT(*) as count
         FROM grow_journals WHERE guild_id = ?
         GROUP BY grow_type ORDER BY count DESC`,
        [interaction.guild.id]
    );

    const embed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle(' Community Growing Trends')
        .setTimestamp();

    const totalNewJournals = recentJournals.reduce((sum, r) => sum + r.count, 0);
    embed.addFields({
        name: ' Last 30 Days',
        value: `**${totalNewJournals}** new journals started\n**${recentHarvests[0].count}** harvests completed`,
        inline: false
    });

    if (stageTransitions.length > 0) {
        const stageEmojis = { germination: '', seedling: '', vegetative: '', transition: '', flowering: '', harvest: '', cure: '', complete: '' };
        const stageText = stageTransitions.map(s =>
            `${stageEmojis[s.current_stage] || ''} ${s.current_stage}: ${s.count}`
        ).join(' | ');
        embed.addFields({ name: ' Active This Week (by stage)', value: stageText, inline: false });
    }

    if (growTypeStats.length > 0) {
        const typeEmojis = { indoor: '', outdoor: '', greenhouse: '' };
        const typeText = growTypeStats.map(t =>
            `${typeEmojis[t.grow_type] || ''} ${t.grow_type}: ${t.count}`
        ).join(' | ');
        embed.addFields({ name: ' Grow Types', value: typeText, inline: false });
    }

    const month = new Date().getMonth();
    let seasonTip = '';
    if (month >= 2 && month <= 4) seasonTip = ' Spring is here! Great time to start outdoor grows.';
    else if (month >= 5 && month <= 7) seasonTip = ' Summer growing season! Outdoor plants are thriving.';
    else if (month >= 8 && month <= 10) seasonTip = ' Fall harvest season approaching for outdoor growers!';
    else seasonTip = ' Winter months - perfect for indoor grows!';
    embed.addFields({ name: 'Seasonal Tip', value: seasonTip, inline: false });

    await interaction.editReply({ embeds: [embed] });
}
