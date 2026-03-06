import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits
} from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const STATUS_INFO = {
    pending: { emoji: '', name: 'Pending', color: '#FFA500' },
    seller_confirmed: { emoji: '', name: 'Seller Confirmed', color: '#3498DB' },
    buyer_confirmed: { emoji: '', name: 'Buyer Confirmed', color: '#3498DB' },
    both_confirmed: { emoji: '', name: 'Both Confirmed', color: '#27AE60' },
    completed: { emoji: '', name: 'Completed', color: '#00FF00' },
    cancelled: { emoji: '', name: 'Cancelled', color: '#95A5A6' },
    disputed: { emoji: '', name: 'Disputed', color: '#FF0000' }
};

// ── Internal helpers ──

function createButtonCollector(interaction, tradeId) {
    const collector = interaction.channel?.createMessageComponentCollector({
        filter: (i) => i.customId.startsWith(`trade_`) && i.customId.endsWith(`_${tradeId}`),
        time: 86400000 // 24 hours
    });

    collector?.on('collect', async (i) => {
        if (i.customId === `trade_confirm_${tradeId}`) {
            await handleButtonConfirm(i, tradeId);
        } else if (i.customId === `trade_cancel_${tradeId}`) {
            await handleButtonCancel(i, tradeId);
        }
    });
}

async function handleButtonConfirm(interaction, tradeId) {
    const [trades] = await pool.execute(
        'SELECT * FROM trade_escrow WHERE id = ?',
        [tradeId]
    );

    if (trades.length === 0) {
        return interaction.reply({ content: 'Trade not found.', ephemeral: true });
    }

    const trade = trades[0];
    const userId = interaction.user.id;

    if (userId !== trade.seller_id && userId !== trade.buyer_id) {
        return interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
    }

    if (trade.status === 'completed' || trade.status === 'cancelled') {
        return interaction.reply({ content: 'This trade has already been finalized.', ephemeral: true });
    }

    const isSeller = userId === trade.seller_id;
    const alreadyConfirmed = isSeller ? trade.seller_confirmed : trade.buyer_confirmed;

    if (alreadyConfirmed) {
        return interaction.reply({ content: 'You have already confirmed this trade.', ephemeral: true });
    }

    if (isSeller) {
        await pool.execute(
            'UPDATE trade_escrow SET seller_confirmed = TRUE, status = ? WHERE id = ?',
            [trade.buyer_confirmed ? 'both_confirmed' : 'seller_confirmed', tradeId]
        );
    } else {
        await pool.execute(
            'UPDATE trade_escrow SET buyer_confirmed = TRUE, status = ? WHERE id = ?',
            [trade.seller_confirmed ? 'both_confirmed' : 'buyer_confirmed', tradeId]
        );
    }

    if ((isSeller && trade.buyer_confirmed) || (!isSeller && trade.seller_confirmed)) {
        await pool.execute(
            'UPDATE trade_escrow SET status = "completed", completed_at = NOW() WHERE id = ?',
            [tradeId]
        );

        const completeEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle(' Trade Completed!')
            .setDescription(`Trade #${tradeId} has been successfully completed!`)
            .addFields(
                { name: 'Seller', value: `<@${trade.seller_id}>`, inline: true },
                { name: 'Buyer', value: `<@${trade.buyer_id}>`, inline: true }
            )
            .setFooter({ text: 'Leave a review with /engage trade review' })
            .setTimestamp();

        await interaction.update({ embeds: [completeEmbed], components: [] });
    } else {
        await interaction.reply({
            content: ` You have confirmed trade #${tradeId}. Waiting for the other party to confirm.`,
            ephemeral: true
        });
    }
}

async function handleButtonCancel(interaction, tradeId) {
    const [trades] = await pool.execute(
        'SELECT * FROM trade_escrow WHERE id = ?',
        [tradeId]
    );

    if (trades.length === 0) {
        return interaction.reply({ content: 'Trade not found.', ephemeral: true });
    }

    const trade = trades[0];
    const userId = interaction.user.id;

    if (userId !== trade.seller_id && userId !== trade.buyer_id) {
        return interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
    }

    if (trade.status === 'completed') {
        return interaction.reply({ content: 'Completed trades cannot be cancelled.', ephemeral: true });
    }

    await pool.execute(
        'UPDATE trade_escrow SET status = "cancelled" WHERE id = ?',
        [tradeId]
    );

    const cancelEmbed = new EmbedBuilder()
        .setColor('#95A5A6')
        .setTitle(' Trade Cancelled')
        .setDescription(`Trade #${tradeId} has been cancelled by ${interaction.user.tag}.`)
        .setTimestamp();

    await interaction.update({ embeds: [cancelEmbed], components: [] });
}

// ── Exported handlers ──

export async function handleCreate(interaction) {
    const partner = interaction.options.getUser('partner');
    const youOffer = interaction.options.getString('you_offer');
    const theyOffer = interaction.options.getString('they_offer');
    const description = interaction.options.getString('description') || '';

    if (partner.id === interaction.user.id) {
        return interaction.reply({ content: 'You cannot trade with yourself.', ephemeral: true });
    }

    if (partner.bot) {
        return interaction.reply({ content: 'You cannot trade with bots.', ephemeral: true });
    }

    const [existingTrades] = await pool.execute(
        `SELECT id FROM trade_escrow
         WHERE guild_id = ? AND status IN ('pending', 'seller_confirmed', 'buyer_confirmed')
         AND ((seller_id = ? AND buyer_id = ?) OR (seller_id = ? AND buyer_id = ?))`,
        [interaction.guild.id, interaction.user.id, partner.id, partner.id, interaction.user.id]
    );

    if (existingTrades.length > 0) {
        return interaction.reply({
            content: `You already have an active trade with ${partner.username}. Complete or cancel it first.`,
            ephemeral: true
        });
    }

    const [result] = await pool.execute(
        `INSERT INTO trade_escrow
        (guild_id, seller_id, buyer_id, trade_description, seller_offering, buyer_offering, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [interaction.guild.id, interaction.user.id, partner.id, description, youOffer, theyOffer]
    );

    const tradeId = result.insertId;

    const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle(' New Trade Created!')
        .setDescription(`Trade #${tradeId} between <@${interaction.user.id}> and <@${partner.id}>`)
        .addFields(
            { name: `${interaction.user.username} Offers`, value: youOffer, inline: true },
            { name: `${partner.username} Offers`, value: theyOffer, inline: true },
            { name: 'Status', value: ' Pending Confirmation', inline: false }
        )
        .setFooter({ text: 'Both parties must confirm with /engage trade confirm' })
        .setTimestamp();

    if (description) {
        embed.addFields({ name: 'Details', value: description, inline: false });
    }

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`trade_confirm_${tradeId}`)
                .setLabel('Confirm Trade')
                .setStyle(ButtonStyle.Success)
                .setEmoji(''),
            new ButtonBuilder()
                .setCustomId(`trade_cancel_${tradeId}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('')
        );

    await interaction.reply({ embeds: [embed], components: [row] });

    try {
        const dmEmbed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle(' New Trade Request!')
            .setDescription(`${interaction.user.tag} wants to trade with you in **${interaction.guild.name}**`)
            .addFields(
                { name: 'They Offer', value: youOffer, inline: true },
                { name: 'You Offer', value: theyOffer, inline: true },
                { name: 'Trade ID', value: `#${tradeId}`, inline: false }
            )
            .setFooter({ text: 'Use /engage trade confirm to accept or /engage trade cancel to decline' })
            .setTimestamp();

        await partner.send({ embeds: [dmEmbed] }).catch(() => {});
    } catch (e) {}

    logger.info('[Trade] Trade created', {
        tradeId,
        sellerId: interaction.user.id,
        buyerId: partner.id,
        guildId: interaction.guild.id
    });

    createButtonCollector(interaction, tradeId);
}

export async function handleConfirm(interaction) {
    const tradeId = interaction.options.getInteger('trade_id');

    const [trades] = await pool.execute(
        'SELECT * FROM trade_escrow WHERE id = ? AND guild_id = ?',
        [tradeId, interaction.guild.id]
    );

    if (trades.length === 0) {
        return interaction.reply({ content: 'Trade not found.', ephemeral: true });
    }

    const trade = trades[0];

    if (interaction.user.id !== trade.seller_id && interaction.user.id !== trade.buyer_id) {
        return interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
    }

    await handleButtonConfirm(interaction, tradeId);
}

export async function handleCancel(interaction) {
    const tradeId = interaction.options.getInteger('trade_id');

    const [trades] = await pool.execute(
        'SELECT * FROM trade_escrow WHERE id = ? AND guild_id = ?',
        [tradeId, interaction.guild.id]
    );

    if (trades.length === 0) {
        return interaction.reply({ content: 'Trade not found.', ephemeral: true });
    }

    const trade = trades[0];

    if (interaction.user.id !== trade.seller_id && interaction.user.id !== trade.buyer_id) {
        return interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
    }

    if (trade.status === 'completed') {
        return interaction.reply({ content: 'Completed trades cannot be cancelled.', ephemeral: true });
    }

    await pool.execute(
        'UPDATE trade_escrow SET status = "cancelled" WHERE id = ?',
        [tradeId]
    );

    await interaction.reply({
        content: ` Trade #${tradeId} has been cancelled.`,
        ephemeral: false
    });

    logger.info('[Trade] Trade cancelled', { tradeId, cancelledBy: interaction.user.id });
}

export async function handleDispute(interaction) {
    const tradeId = interaction.options.getInteger('trade_id');
    const reason = interaction.options.getString('reason');

    const [trades] = await pool.execute(
        'SELECT * FROM trade_escrow WHERE id = ? AND guild_id = ?',
        [tradeId, interaction.guild.id]
    );

    if (trades.length === 0) {
        return interaction.reply({ content: 'Trade not found.', ephemeral: true });
    }

    const trade = trades[0];

    if (interaction.user.id !== trade.seller_id && interaction.user.id !== trade.buyer_id) {
        return interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
    }

    if (trade.status === 'completed' || trade.status === 'cancelled') {
        return interaction.reply({ content: 'This trade has already been finalized.', ephemeral: true });
    }

    await pool.execute(
        'UPDATE trade_escrow SET status = "disputed", dispute_reason = ? WHERE id = ?',
        [reason, tradeId]
    );

    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle(' Trade Disputed!')
        .setDescription(`Trade #${tradeId} has been disputed by <@${interaction.user.id}>`)
        .addFields(
            { name: 'Reason', value: reason, inline: false },
            { name: 'Seller', value: `<@${trade.seller_id}>`, inline: true },
            { name: 'Buyer', value: `<@${trade.buyer_id}>`, inline: true }
        )
        .setFooter({ text: 'Staff will review and mediate this dispute' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    try {
        const [logConfig] = await pool.execute(
            `SELECT channel_id FROM logging_config WHERE guild_id = ? AND event_type = 'moderation' AND enabled = 1`,
            [interaction.guild.id]
        );

        if (logConfig.length > 0) {
            const channel = await interaction.guild.channels.fetch(logConfig[0].channel_id).catch(() => null);
            if (channel) {
                await channel.send({
                    content: '@here Trade dispute requires attention!',
                    embeds: [embed]
                });
            }
        }
    } catch (e) {}

    logger.info('[Trade] Trade disputed', {
        tradeId,
        disputedBy: interaction.user.id,
        reason
    });
}

export async function handleView(interaction) {
    const tradeId = interaction.options.getInteger('trade_id');

    const [trades] = await pool.execute(
        'SELECT * FROM trade_escrow WHERE id = ?',
        [tradeId]
    );

    if (trades.length === 0) {
        return interaction.reply({ content: 'Trade not found.', ephemeral: true });
    }

    const trade = trades[0];
    const statusInfo = STATUS_INFO[trade.status];

    const embed = new EmbedBuilder()
        .setColor(statusInfo.color)
        .setTitle(`${statusInfo.emoji} Trade #${trade.id}`)
        .addFields(
            { name: 'Seller', value: `<@${trade.seller_id}> ${trade.seller_confirmed ? '' : ''}`, inline: true },
            { name: 'Buyer', value: `<@${trade.buyer_id}> ${trade.buyer_confirmed ? '' : ''}`, inline: true },
            { name: 'Status', value: statusInfo.name, inline: true },
            { name: 'Seller Offers', value: trade.seller_offering, inline: false },
            { name: 'Buyer Offers', value: trade.buyer_offering, inline: false }
        )
        .setTimestamp(new Date(trade.created_at));

    if (trade.trade_description) {
        embed.addFields({ name: 'Details', value: trade.trade_description, inline: false });
    }

    if (trade.dispute_reason) {
        embed.addFields({ name: 'Dispute Reason', value: trade.dispute_reason, inline: false });
    }

    if (trade.resolution_notes) {
        embed.addFields({ name: 'Resolution', value: trade.resolution_notes, inline: false });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleListTrades(interaction) {
    const [trades] = await pool.execute(
        `SELECT * FROM trade_escrow
         WHERE guild_id = ? AND (seller_id = ? OR buyer_id = ?)
         AND status NOT IN ('completed', 'cancelled')
         ORDER BY created_at DESC LIMIT 10`,
        [interaction.guild.id, interaction.user.id, interaction.user.id]
    );

    if (trades.length === 0) {
        return interaction.reply({
            content: 'You have no active trades. Start one with `/engage trade create`!',
            ephemeral: true
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle(' Your Active Trades')
        .setTimestamp();

    let description = '';
    for (const trade of trades) {
        const statusInfo = STATUS_INFO[trade.status];
        const partner = trade.seller_id === interaction.user.id ? trade.buyer_id : trade.seller_id;
        description += `**#${trade.id}** ${statusInfo.emoji} with <@${partner}>\n`;
        description += `You: ${trade.seller_id === interaction.user.id ? trade.seller_offering : trade.buyer_offering}\n`;
        description += `They: ${trade.seller_id === interaction.user.id ? trade.buyer_offering : trade.seller_offering}\n\n`;
    }

    embed.setDescription(description);
    embed.setFooter({ text: 'Use /engage trade view <id> for details' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleHistory(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;

    await interaction.deferReply({ ephemeral: true });

    const [trades] = await pool.execute(
        `SELECT * FROM trade_escrow
         WHERE (seller_id = ? OR buyer_id = ?) AND status IN ('completed', 'cancelled')
         ORDER BY completed_at DESC LIMIT 15`,
        [targetUser.id, targetUser.id]
    );

    const [stats] = await pool.execute(
        `SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
            SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) as disputed
         FROM trade_escrow WHERE seller_id = ? OR buyer_id = ?`,
        [targetUser.id, targetUser.id]
    );

    const embed = new EmbedBuilder()
        .setColor('#27AE60')
        .setTitle(` ${targetUser.username}'s Trade History`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
            { name: 'Total Trades', value: `${stats[0].total}`, inline: true },
            { name: 'Completed', value: `${stats[0].completed}`, inline: true },
            { name: 'Cancelled', value: `${stats[0].cancelled}`, inline: true }
        )
        .setTimestamp();

    if (trades.length > 0) {
        let recent = '';
        for (const trade of trades.slice(0, 5)) {
            const statusInfo = STATUS_INFO[trade.status];
            const partner = trade.seller_id === targetUser.id ? trade.buyer_id : trade.seller_id;
            recent += `${statusInfo.emoji} #${trade.id} with <@${partner}>\n`;
        }
        embed.addFields({ name: 'Recent Trades', value: recent, inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleReview(interaction) {
    const tradeId = interaction.options.getInteger('trade_id');
    const rating = interaction.options.getInteger('rating');
    const comment = interaction.options.getString('comment') || '';

    const [trades] = await pool.execute(
        'SELECT * FROM trade_escrow WHERE id = ? AND status = "completed"',
        [tradeId]
    );

    if (trades.length === 0) {
        return interaction.reply({ content: 'Trade not found or not completed.', ephemeral: true });
    }

    const trade = trades[0];

    if (interaction.user.id !== trade.seller_id && interaction.user.id !== trade.buyer_id) {
        return interaction.reply({ content: 'You are not part of this trade.', ephemeral: true });
    }

    const reviewedUserId = interaction.user.id === trade.seller_id ? trade.buyer_id : trade.seller_id;

    try {
        await pool.execute(
            `INSERT INTO trade_reviews (trade_id, reviewer_id, reviewed_user_id, rating, review_text)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE rating = VALUES(rating), review_text = VALUES(review_text)`,
            [tradeId, interaction.user.id, reviewedUserId, rating, comment]
        );

        const stars = '';
        const ratingStars = stars.repeat(rating) + ''.repeat(5 - rating);

        await interaction.reply({
            content: ` Review submitted for <@${reviewedUserId}>: ${ratingStars}`,
            ephemeral: true
        });

        logger.info('[Trade] Review submitted', {
            tradeId,
            reviewerId: interaction.user.id,
            reviewedUserId,
            rating
        });
    } catch (error) {
        await interaction.reply({
            content: 'You have already reviewed this trade.',
            ephemeral: true
        });
    }
}

export async function handleResolve(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ content: 'This command is only available to staff.', ephemeral: true });
    }

    const tradeId = interaction.options.getInteger('trade_id');
    const resolution = interaction.options.getString('resolution');
    const notes = interaction.options.getString('notes');

    const [trades] = await pool.execute(
        'SELECT * FROM trade_escrow WHERE id = ?',
        [tradeId]
    );

    if (trades.length === 0) {
        return interaction.reply({ content: 'Trade not found.', ephemeral: true });
    }

    const trade = trades[0];

    let newStatus = 'completed';
    if (resolution === 'cancel') {
        newStatus = 'cancelled';
    }

    await pool.execute(
        `UPDATE trade_escrow
         SET status = ?, resolved_by = ?, resolution_notes = ?, completed_at = NOW()
         WHERE id = ?`,
        [newStatus, interaction.user.id, notes, tradeId]
    );

    const embed = new EmbedBuilder()
        .setColor('#27AE60')
        .setTitle(' Trade Resolved')
        .setDescription(`Trade #${tradeId} has been resolved by staff.`)
        .addFields(
            { name: 'Resolution', value: resolution.replace('_', ' ').toUpperCase(), inline: true },
            { name: 'Notes', value: notes, inline: false }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    try {
        const seller = await interaction.client.users.fetch(trade.seller_id).catch(() => null);
        const buyer = await interaction.client.users.fetch(trade.buyer_id).catch(() => null);

        const dmEmbed = new EmbedBuilder()
            .setColor('#27AE60')
            .setTitle(' Trade Dispute Resolved')
            .setDescription(`Your disputed trade #${tradeId} has been resolved.`)
            .addFields(
                { name: 'Resolution', value: resolution.replace('_', ' ').toUpperCase(), inline: true },
                { name: 'Staff Notes', value: notes, inline: false }
            )
            .setTimestamp();

        if (seller) await seller.send({ embeds: [dmEmbed] }).catch(() => {});
        if (buyer) await buyer.send({ embeds: [dmEmbed] }).catch(() => {});
    } catch (e) {}

    logger.info('[Trade] Dispute resolved', {
        tradeId,
        resolvedBy: interaction.user.id,
        resolution
    });
}

export async function handleReputation(interaction) {
    const user = interaction.options.getUser('user');

    await interaction.deferReply();

    const [stats] = await pool.execute(
        `SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) as disputed
         FROM trade_escrow WHERE seller_id = ? OR buyer_id = ?`,
        [user.id, user.id]
    );

    const [reviews] = await pool.execute(
        `SELECT AVG(rating) as avg_rating, COUNT(*) as review_count
         FROM trade_reviews WHERE reviewed_user_id = ?`,
        [user.id]
    );

    const [watchlist] = await pool.execute(
        `SELECT * FROM scammer_watchlist WHERE discord_id = ? AND entry_type = 'user'`,
        [user.id]
    );

    const isScammer = watchlist.length > 0;
    const avgRating = reviews[0].avg_rating ? parseFloat(reviews[0].avg_rating).toFixed(1) : 'N/A';
    const completionRate = stats[0].total > 0 ? ((stats[0].completed / stats[0].total) * 100).toFixed(0) : 'N/A';

    let trustLevel = '';
    if (isScammer) {
        trustLevel = ' KNOWN SCAMMER';
    } else if (stats[0].completed >= 20 && avgRating >= 4.5) {
        trustLevel = ' Trusted Trader';
    } else if (stats[0].completed >= 5 && avgRating >= 4.0) {
        trustLevel = ' Reliable Trader';
    } else if (stats[0].completed >= 1) {
        trustLevel = ' New Trader';
    } else {
        trustLevel = ' No Trade History';
    }

    const stars = avgRating !== 'N/A' ? '' + ''.repeat(Math.floor(avgRating)) + (avgRating % 1 >= 0.5 ? '' : '') : '';

    const embed = new EmbedBuilder()
        .setColor(isScammer ? '#FF0000' : '#27AE60')
        .setTitle(`${trustLevel}`)
        .setDescription(`**${user.username}**'s Trade Reputation`)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
            { name: 'Completed Trades', value: `${stats[0].completed}`, inline: true },
            { name: 'Completion Rate', value: `${completionRate}%`, inline: true },
            { name: 'Disputes', value: `${stats[0].disputed}`, inline: true },
            { name: 'Average Rating', value: avgRating !== 'N/A' ? `${avgRating}/5 ${stars}` : 'No reviews yet', inline: true },
            { name: 'Total Reviews', value: `${reviews[0].review_count}`, inline: true }
        )
        .setTimestamp();

    if (isScammer) {
        embed.addFields({
            name: ' WARNING',
            value: `This user is on the scammer watchlist!\n**Reason:** ${watchlist[0].reason}`,
            inline: false
        });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleVouch(interaction) {
    const trader = interaction.options.getUser('user');
    const type = interaction.options.getString('type');
    const rating = interaction.options.getInteger('rating');
    const comment = interaction.options.getString('comment') || null;

    if (trader.id === interaction.user.id) {
        return interaction.reply({ content: 'You cannot vouch for yourself.', ephemeral: true });
    }

    if (trader.bot) {
        return interaction.reply({ content: 'You cannot vouch for bots.', ephemeral: true });
    }

    const [existing] = await pool.execute(
        `SELECT * FROM trader_reputation
         WHERE guild_id = ? AND user_id = ? AND voucher_id = ?
         AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`,
        [interaction.guild.id, trader.id, interaction.user.id]
    );

    if (existing.length > 0) {
        return interaction.reply({
            content: 'You already vouched for this trader in the last 7 days.',
            ephemeral: true
        });
    }

    await pool.execute(
        `INSERT INTO trader_reputation (guild_id, user_id, voucher_id, trade_type, rating, comment)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [interaction.guild.id, trader.id, interaction.user.id, type, rating, comment]
    );

    const [repCount] = await pool.execute(
        `SELECT COUNT(*) as count, AVG(rating) as avg_rating
         FROM trader_reputation WHERE guild_id = ? AND user_id = ?`,
        [interaction.guild.id, trader.id]
    );

    const starsStr = ''.repeat(rating);
    const typeEmoji = type === 'purchase' ? '' : type === 'sale' ? '' : '';

    const embed = new EmbedBuilder()
        .setColor('#2ECC71')
        .setTitle(' Vouch Recorded!')
        .setDescription(`${interaction.user} vouched for ${trader}`)
        .addFields(
            { name: 'Transaction', value: `${typeEmoji} ${type.charAt(0).toUpperCase() + type.slice(1)}`, inline: true },
            { name: 'Rating', value: starsStr, inline: true },
            { name: `${trader.username}'s Stats`, value: `**${repCount[0].count}** vouches | **${parseFloat(repCount[0].avg_rating).toFixed(1)}** avg`, inline: true }
        )
        .setTimestamp();

    if (comment) {
        embed.addFields({ name: 'Comment', value: comment, inline: false });
    }

    await interaction.reply({ embeds: [embed] });

    logger.info('[Trade] Vouch recorded', {
        voucherId: interaction.user.id,
        traderId: trader.id,
        rating
    });
}

export async function handleLeaderboard(interaction) {
    await interaction.deferReply();

    const [leaders] = await pool.execute(
        `SELECT user_id, total_trades, avg_rating FROM (
            SELECT user_id, COUNT(*) as total_trades, AVG(rating) as avg_rating
            FROM trader_reputation WHERE guild_id = ?
            GROUP BY user_id
            UNION ALL
            SELECT seller_id as user_id, COUNT(*) as total_trades, 0 as avg_rating
            FROM trade_escrow WHERE guild_id = ? AND status = 'completed'
            GROUP BY seller_id
         ) combined
         GROUP BY user_id
         ORDER BY total_trades DESC, avg_rating DESC
         LIMIT 10`,
        [interaction.guild.id, interaction.guild.id]
    );

    if (leaders.length === 0) {
        return interaction.editReply({
            content: 'No traders with reputation yet! Be the first to build your trading history.'
        });
    }

    let leaderboardText = '';
    const medals = ['', '', ''];

    for (let i = 0; i < leaders.length; i++) {
        const leader = leaders[i];
        const medal = medals[i] || `**${i + 1}.**`;
        const starsStr = leader.avg_rating ? ''.repeat(Math.round(leader.avg_rating)) : '';
        leaderboardText += `${medal} <@${leader.user_id}> - **${leader.total_trades}** trades ${starsStr}\n`;
    }

    const embed = new EmbedBuilder()
        .setColor('#F1C40F')
        .setTitle(' Top Traders')
        .setDescription(leaderboardText)
        .setFooter({ text: 'Use /engage trade vouch or /engage trade create to build reputation' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}
