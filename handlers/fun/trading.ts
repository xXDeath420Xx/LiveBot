import { 
    EmbedBuilder, 
    ChatInputCommandInteraction, 
    Message, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    StringSelectMenuBuilder,
    User,
    TextChannel,
    Client,
    Guild,
    GuildMember,
    PermissionsBitField,
    Role,
    Collection
} from "discord.js";
import db from "../../utils/db";
import logger from "../../utils/logger";


// Store active trade sessions in memory
const activeTrades = new Map();

export async function handleOffer(interaction, config: any): Promise<any> {
    const recipient = interaction.options.getUser("user");

    // Validation
    if (recipient.bot) {
        return interaction.reply({
            content: "❌ You cannot trade with bots.",
            ephemeral: true
        });
    }

    if (recipient.id === interaction.user.id) {
        return interaction.reply({
            content: "❌ You cannot trade with yourself.",
            ephemeral: true
        });
    }

    // Check if users already have a pending trade
    const [[existingTrade]] = await db.execute(
        `SELECT id FROM trades
         WHERE guild_id = ? AND status = 'pending'
         AND ((initiator_id = ? AND recipient_id = ?) OR (initiator_id = ? AND recipient_id = ?))`,
        [interaction.guild.id, interaction.user.id, recipient.id, recipient.id, interaction.user.id]
    );

    if (existingTrade) {
        return interaction.reply({
            content: `❌ You already have a pending trade with ${recipient}! Use \`/trade view ${existingTrade.id}\` to view it.`,
            ephemeral: true
        });
    }

    // Create initial trade in database
    const [result] = await db.execute(
        `INSERT INTO trades (guild_id, initiator_id, recipient_id, initiator_offer, recipient_offer)
         VALUES (?, ?, ?, '{"currency": 0, "items": []}', '{"currency": 0, "items": []}')`,
        [interaction.guild.id, interaction.user.id, recipient.id]
    );

    const tradeId = result.insertId;

    // Create interactive trade setup
    const embed = new EmbedBuilder()
        .setColor("#FFD700")
        .setTitle("💱 New Trade Created")
        .setDescription(`Trade between ${interaction.user} and ${recipient}`)
        .addFields(
            { name: `${interaction.user.username}'s Offer`, value: "Nothing offered yet", inline: true },
            { name: `${recipient.username}'s Offer`, value: "Nothing offered yet", inline: true }
        )
        .setFooter({ text: `Trade ID: ${tradeId} • Both parties must add items and accept` })
        .setTimestamp();

    const buttons = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`trade_add_currency_${tradeId}`)
                .setLabel("Add Currency")
                .setStyle(ButtonStyle.Primary)
                .setEmoji("💰"),
            new ButtonBuilder()
                .setCustomId(`trade_add_item_${tradeId}`)
                .setLabel("Add Item")
                .setStyle(ButtonStyle.Primary)
                .setEmoji("📦"),
            new ButtonBuilder()
                .setCustomId(`trade_ready_${tradeId}`)
                .setLabel("Ready")
                .setStyle(ButtonStyle.Success)
                .setEmoji("✅"),
            new ButtonBuilder()
                .setCustomId(`trade_cancel_${tradeId}`)
                .setLabel("Cancel")
                .setStyle(ButtonStyle.Danger)
                .setEmoji("❌")
        );

    await interaction.reply({
        content: `${interaction.user} ${recipient}`,
        embeds: [embed],
        components: [buttons]
    });

    // Store trade session
    activeTrades.set(tradeId, {
        initiatorReady: false,
        recipientReady: false
    });

    // DM the recipient
    try {
        const dmEmbed = new EmbedBuilder()
            .setColor("#FFD700")
            .setTitle("💱 Trade Offer Received")
            .setDescription(`${interaction.user} wants to trade with you in **${interaction.guild.name}**!`)
            .addFields({ name: "Trade ID", value: `${tradeId}`, inline: true })
            .setFooter({ text: `Use /trade view ${tradeId} to view and accept` });

        await recipient.send({ embeds: [dmEmbed] });
    } catch (error) {
        // User has DMs disabled
    }
}

export async function handleView(interaction, config: any): Promise<any> {
    const tradeId = interaction.options.getInteger("trade_id");

    // Get trade details
    const [[trade]] = await db.execute(
        "SELECT * FROM trades WHERE id = ? AND guild_id = ?",
        [tradeId, interaction.guild.id]
    );

    if (!trade) {
        return interaction.reply({
            content: "❌ Trade not found.",
            ephemeral: true
        });
    }

    // Parse offers
    const initiatorOffer = JSON.parse(trade.initiator_offer);
    const recipientOffer = JSON.parse(trade.recipient_offer);

    // Format offers
    const initiatorOfferText = await formatOffer(initiatorOffer, config);
    const recipientOfferText = await formatOffer(recipientOffer, config);

    const initiator = await interaction.client.users.fetch(trade.initiator_id);
    const recipient = await interaction.client.users.fetch(trade.recipient_id);

    const embed = new EmbedBuilder()
        .setColor(trade.status === "pending" ? "#FFD700" : trade.status === "completed" ? "#00FF00" : "#FF0000")
        .setTitle(`💱 Trade #${tradeId}`)
        .setDescription(`Trade between ${initiator} and ${recipient}`)
        .addFields(
            { name: `${initiator.username}'s Offer`, value: initiatorOfferText || "Nothing offered", inline: true },
            { name: `${recipient.username}'s Offer`, value: recipientOfferText || "Nothing offered", inline: true }
        )
        .addFields({ name: "Status", value: `${getStatusEmoji(trade.status)} ${trade.status.toUpperCase()}`, inline: false })
        .setFooter({ text: `Trade ID: ${tradeId}` })
        .setTimestamp(trade.created_at);

    if (trade.completed_at) {
        embed.addFields({ name: "Completed At", value: new Date(trade.completed_at).toLocaleString(), inline: true });
    }

    const buttons = new ActionRowBuilder();

    if (trade.status === "pending") {
        if (trade.recipient_id === interaction.user.id) {
            buttons.addComponents(
                new ButtonBuilder()
                    .setCustomId(`trade_accept_${tradeId}`)
                    .setLabel("Accept")
                    .setStyle(ButtonStyle.Success)
                    .setEmoji("✅"),
                new ButtonBuilder()
                    .setCustomId(`trade_decline_${tradeId}`)
                    .setLabel("Decline")
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji("❌")
            );
        } else if (trade.initiator_id === interaction.user.id) {
            buttons.addComponents(
                new ButtonBuilder()
                    .setCustomId(`trade_cancel_${tradeId}`)
                    .setLabel("Cancel")
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji("❌")
            );
        }
    }

    await interaction.reply({
        embeds: [embed],
        components: buttons.components.length > 0 ? [buttons] : [],
        ephemeral: true
    });
}

export async function handleAccept(interaction, config: any): Promise<any> {
    await interaction.deferReply();

    const tradeId = interaction.options.getInteger("trade_id");

    // Get trade details
    const [[trade]] = await db.execute(
        "SELECT * FROM trades WHERE id = ? AND guild_id = ?",
        [tradeId, interaction.guild.id]
    );

    if (!trade) {
        return interaction.editReply({
            content: "❌ Trade not found."
        });
    }

    if (trade.status !== "pending") {
        return interaction.editReply({
            content: `❌ This trade is ${trade.status} and cannot be accepted.`
        });
    }

    if (trade.recipient_id !== interaction.user.id) {
        return interaction.editReply({
            content: "❌ Only the trade recipient can accept this trade."
        });
    }

    // Parse offers
    const initiatorOffer = JSON.parse(trade.initiator_offer);
    const recipientOffer = JSON.parse(trade.recipient_offer);

    try {
        await db.execute("START TRANSACTION");

        // Validate both users have the items and currency
        // Initiator validation
        const [[initiatorEconomy]] = await db.execute(
            "SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ?",
            [interaction.guild.id, trade.initiator_id]
        );

        if (!initiatorEconomy || initiatorEconomy.wallet < initiatorOffer.currency) {
            await db.execute("ROLLBACK");
            return interaction.editReply({
                content: "❌ Initiator doesn't have enough currency for this trade."
            });
        }

        // Validate initiator's items
        for (const item of initiatorOffer.items) {
            const [[inventoryItem]] = await db.execute(
                "SELECT quantity FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [interaction.guild.id, trade.initiator_id, item.item_id]
            );

            if (!inventoryItem || inventoryItem.quantity < item.quantity) {
                await db.execute("ROLLBACK");
                return interaction.editReply({
                    content: "❌ Initiator doesn't have all the offered items."
                });
            }
        }

        // Recipient validation
        const [[recipientEconomy]] = await db.execute(
            "SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ?",
            [interaction.guild.id, trade.recipient_id]
        );

        if (!recipientEconomy || recipientEconomy.wallet < recipientOffer.currency) {
            await db.execute("ROLLBACK");
            return interaction.editReply({
                content: "❌ You don't have enough currency for this trade."
            });
        }

        // Validate recipient's items
        for (const item of recipientOffer.items) {
            const [[inventoryItem]] = await db.execute(
                "SELECT quantity FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [interaction.guild.id, trade.recipient_id, item.item_id]
            );

            if (!inventoryItem || inventoryItem.quantity < item.quantity) {
                await db.execute("ROLLBACK");
                return interaction.editReply({
                    content: "❌ You don't have all the offered items."
                });
            }
        }

        // Execute trade - Currency exchange
        if (initiatorOffer.currency > 0) {
            await db.execute(
                "UPDATE user_economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ?",
                [initiatorOffer.currency, interaction.guild.id, trade.initiator_id]
            );
            await db.execute(
                "UPDATE user_economy SET wallet = wallet + ? WHERE guild_id = ? AND user_id = ?",
                [initiatorOffer.currency, interaction.guild.id, trade.recipient_id]
            );
        }

        if (recipientOffer.currency > 0) {
            await db.execute(
                "UPDATE user_economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ?",
                [recipientOffer.currency, interaction.guild.id, trade.recipient_id]
            );
            await db.execute(
                "UPDATE user_economy SET wallet = wallet + ? WHERE guild_id = ? AND user_id = ?",
                [recipientOffer.currency, interaction.guild.id, trade.initiator_id]
            );
        }

        // Execute trade - Item exchange
        for (const item of initiatorOffer.items) {
            // Remove from initiator
            const [[currentItem]] = await db.execute(
                "SELECT quantity FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [interaction.guild.id, trade.initiator_id, item.item_id]
            );

            if (currentItem.quantity === item.quantity) {
                await db.execute(
                    "DELETE FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                    [interaction.guild.id, trade.initiator_id, item.item_id]
                );
            } else {
                await db.execute(
                    "UPDATE user_inventory SET quantity = quantity - ? WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                    [item.quantity, interaction.guild.id, trade.initiator_id, item.item_id]
                );
            }

            // Add to recipient
            const [[recipientItem]] = await db.execute(
                "SELECT id FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [interaction.guild.id, trade.recipient_id, item.item_id]
            );

            if (recipientItem) {
                await db.execute(
                    "UPDATE user_inventory SET quantity = quantity + ? WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                    [item.quantity, interaction.guild.id, trade.recipient_id, item.item_id]
                );
            } else {
                await db.execute(
                    "INSERT INTO user_inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)",
                    [interaction.guild.id, trade.recipient_id, item.item_id, item.quantity]
                );
            }
        }

        for (const item of recipientOffer.items) {
            // Remove from recipient
            const [[currentItem]] = await db.execute(
                "SELECT quantity FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [interaction.guild.id, trade.recipient_id, item.item_id]
            );

            if (currentItem.quantity === item.quantity) {
                await db.execute(
                    "DELETE FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                    [interaction.guild.id, trade.recipient_id, item.item_id]
                );
            } else {
                await db.execute(
                    "UPDATE user_inventory SET quantity = quantity - ? WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                    [item.quantity, interaction.guild.id, trade.recipient_id, item.item_id]
                );
            }

            // Add to initiator
            const [[initiatorItem]] = await db.execute(
                "SELECT id FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [interaction.guild.id, trade.initiator_id, item.item_id]
            );

            if (initiatorItem) {
                await db.execute(
                    "UPDATE user_inventory SET quantity = quantity + ? WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                    [item.quantity, interaction.guild.id, trade.initiator_id, item.item_id]
                );
            } else {
                await db.execute(
                    "INSERT INTO user_inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)",
                    [interaction.guild.id, trade.initiator_id, item.item_id, item.quantity]
                );
            }
        }

        // Log transactions
        await db.execute(
            `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description, related_user_id)
             VALUES (?, ?, 'trade', ?, ?, ?, ?, ?)`,
            [
                interaction.guild.id,
                trade.initiator_id,
                recipientOffer.currency - initiatorOffer.currency,
                initiatorEconomy.wallet,
                initiatorEconomy.wallet + recipientOffer.currency - initiatorOffer.currency,
                `Trade #${tradeId}`,
                trade.recipient_id
            ]
        );

        await db.execute(
            `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description, related_user_id)
             VALUES (?, ?, 'trade', ?, ?, ?, ?, ?)`,
            [
                interaction.guild.id,
                trade.recipient_id,
                initiatorOffer.currency - recipientOffer.currency,
                recipientEconomy.wallet,
                recipientEconomy.wallet + initiatorOffer.currency - recipientOffer.currency,
                `Trade #${tradeId}`,
                trade.initiator_id
            ]
        );

        // Update trade status
        await db.execute(
            "UPDATE trades SET status = 'completed', completed_at = NOW() WHERE id = ?",
            [tradeId]
        );

        await db.execute("COMMIT");

        // Remove from active trades
        activeTrades.delete(tradeId);

        const embed = new EmbedBuilder()
            .setColor("#00FF00")
            .setTitle("✅ Trade Completed!")
            .setDescription(`Trade #${tradeId} has been successfully completed!`)
            .addFields(
                { name: "Initiator Received", value: await formatOffer(recipientOffer, config) || "Nothing", inline: true },
                { name: "Recipient Received", value: await formatOffer(initiatorOffer, config) || "Nothing", inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // Notify initiator
        try {
            const initiator = await interaction.client.users.fetch(trade.initiator_id);
            await initiator.send({ embeds: [embed] });
        } catch (error) {
            // User has DMs disabled
        }

    } catch (error) {
        await db.execute("ROLLBACK");
        logger.error("[Trade] Accept _error:", { error: _error.message, stack: _error.stack  });
        await interaction.editReply({
            content: "❌ An error occurred while processing the trade. No changes have been made."
        });
    }
}

export async function handleDecline(interaction, config: any): Promise<any> {
    const tradeId = interaction.options.getInteger("trade_id");

    // Get trade details
    const [[trade]] = await db.execute(
        "SELECT * FROM trades WHERE id = ? AND guild_id = ?",
        [tradeId, interaction.guild.id]
    );

    if (!trade) {
        return interaction.reply({
            content: "❌ Trade not found.",
            ephemeral: true
        });
    }

    if (trade.status !== "pending") {
        return interaction.reply({
            content: `❌ This trade is ${trade.status} and cannot be declined.`,
            ephemeral: true
        });
    }

    if (trade.recipient_id !== interaction.user.id) {
        return interaction.reply({
            content: "❌ Only the trade recipient can decline this trade.",
            ephemeral: true
        });
    }

    // Update status
    await db.execute(
        "UPDATE trades SET status = 'declined', updated_at = NOW() WHERE id = ?",
        [tradeId]
    );

    // Remove from active trades
    activeTrades.delete(tradeId);

    await interaction.reply({
        content: `❌ Trade #${tradeId} has been declined.`,
        ephemeral: true
    });

    // Notify initiator
    try {
        const initiator = await interaction.client.users.fetch(trade.initiator_id);
        await initiator.send(`❌ Your trade offer (#${tradeId}) to ${interaction.user} was declined.`);
    } catch (error) {
        // User has DMs disabled
    }
}

export async function handleCancel(interaction, config: any): Promise<any> {
    const tradeId = interaction.options.getInteger("trade_id");

    // Get trade details
    const [[trade]] = await db.execute(
        "SELECT * FROM trades WHERE id = ? AND guild_id = ?",
        [tradeId, interaction.guild.id]
    );

    if (!trade) {
        return interaction.reply({
            content: "❌ Trade not found.",
            ephemeral: true
        });
    }

    if (trade.status !== "pending") {
        return interaction.reply({
            content: `❌ This trade is ${trade.status} and cannot be cancelled.`,
            ephemeral: true
        });
    }

    if (trade.initiator_id !== interaction.user.id && trade.recipient_id !== interaction.user.id) {
        return interaction.reply({
            content: "❌ You are not part of this trade.",
            ephemeral: true
        });
    }

    // Update status
    await db.execute(
        "UPDATE trades SET status = 'cancelled', updated_at = NOW() WHERE id = ?",
        [tradeId]
    );

    // Remove from active trades
    activeTrades.delete(tradeId);

    await interaction.reply({
        content: `❌ Trade #${tradeId} has been cancelled.`,
        ephemeral: true
    });

    // Notify the other party
    const otherUserId = trade.initiator_id === interaction.user.id ? trade.recipient_id : trade.initiator_id;
    try {
        const otherUser = await interaction.client.users.fetch(otherUserId);
        await otherUser.send(`❌ Trade #${tradeId} with ${interaction.user} was cancelled.`);
    } catch (error) {
        // User has DMs disabled
    }
}

export async function handleList(interaction, config: any): Promise<any> {
    // Get user's pending trades
    const [trades] = await db.execute(
        `SELECT * FROM trades
         WHERE guild_id = ? AND (initiator_id = ? OR recipient_id = ?) AND status = 'pending'
         ORDER BY created_at DESC LIMIT 10`,
        [interaction.guild.id, interaction.user.id, interaction.user.id]
    );

    if (trades.length === 0) {
        return interaction.reply({
            content: "📋 You have no pending trades.",
            ephemeral: true
        });
    }

    const embed = new EmbedBuilder()
        .setColor("#FFD700")
        .setTitle("📋 Your Pending Trades")
        .setDescription(`You have ${trades.length} pending trade(s)`)
        .setFooter({ text: "Use /trade view <id> to view details" });

    for (const trade of trades) {
        const isInitiator = trade.initiator_id === interaction.user.id;
        const otherUserId = isInitiator ? trade.recipient_id : trade.initiator_id;
        const otherUser = await interaction.client.users.fetch(otherUserId);

        embed.addFields({
            name: `Trade #${trade.id} - ${isInitiator ? "You → " : "← "} ${otherUser.username}`,
            value: `Created: ${new Date(trade.created_at).toLocaleDateString()}\nUse \`/trade view ${trade.id}\` for details`,
            inline: false
        });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function formatOffer(offer, config: any): Promise<any> {
    let text = "";

    if (offer.currency > 0) {
        text += `${config.currency_emoji} ${offer.currency.toLocaleString()} ${config.currency_name}\n`;
    }

    if (offer.items && offer.items.length > 0) {
        for (const item of offer.items) {
            const [[itemData]] = await db.execute(
                "SELECT item_name, item_emoji FROM shop_items WHERE id = ?",
                [item.item_id]
            );

            if (itemData) {
                text += `${itemData.item_emoji} ${itemData.item_name} x${item.quantity}\n`;
            }
        }
    }

    return text.trim();
}

export function getStatusEmoji(status: any): any {
    const emojis = {
        "pending": "⏳",
        "accepted": "✅",
        "declined": "❌",
        "cancelled": "🚫",
        "completed": "✅"
    };
    return emojis[status] || "❓";
}

module.exports = {
    handleOffer,
    handleView,
    handleAccept,
    handleDecline,
    handleCancel,
    handleList,
    activeTrades
};
