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


export async function handleView(interaction, config: any): Promise<any> {
    const targetUser = interaction.options.getUser("user") || interaction.user;
    const filter = interaction.options.getString("filter") || "all";

    // Build query
    let query = `
        SELECT i.*, s.item_name, s.item_description, s.item_emoji, s.item_type,
               s.price, s.sell_value, s.sellable, s.usable, s.tradeable
        FROM user_inventory i
        JOIN shop_items s ON i.item_id = s.id
        WHERE i.guild_id = ? AND i.user_id = ?
    `;
    const params = [interaction.guild.id, targetUser.id];

    if (filter !== "all") {
        query += " AND s.item_type = ?";
        params.push(filter);
    }

    query += " ORDER BY s.item_type, s.item_name ASC";

    const [items] = await db.execute(query, params);

    if (items.length === 0) {
        return interaction.reply({
            content: targetUser.id === interaction.user.id
                ? "🎒 Your inventory is empty! Visit `/shop browse` to purchase items."
                : `🎒 ${targetUser.username}'s inventory is empty.`,
            ephemeral: true
        });
    }

    // Calculate total inventory value
    let totalValue = 0;
    items.forEach(item => {
        totalValue += (item.sell_value || 0) * item.quantity;
    });

    const embed = new EmbedBuilder()
        .setColor("#9B59B6")
        .setTitle(`🎒 ${targetUser.username}'s Inventory`)
        .setDescription(`${filter === "all" ? "All items" : getCategoryName(filter)} owned`)
        .setThumbnail(targetUser.displayAvatarURL())
        .setFooter({ text: `Total Items: ${items.length} • Inventory Value: ${formatMoney(totalValue, config)}` });

    // Group items by type
    const groupedItems = {};
    items.forEach(item => {
        if (!groupedItems[item.item_type]) {
            groupedItems[item.item_type] = [];
        }
        groupedItems[item.item_type].push(item);
    });

    // Add fields for each type
    for (const [type, typeItems] of Object.entries(groupedItems)) {
        let fieldValue = "";

        typeItems.forEach(item => {
            const equippedText = item.is_equipped ? " **(Equipped)**" : "";
            const valueText = item.sellable && item.sell_value > 0
                ? ` | Value: ${formatMoney(item.sell_value * item.quantity, config)}`
                : "";
            const usedText = item.use_count > 0 ? ` | Used ${item.use_count}x` : "";

            fieldValue += `**ID: ${item.item_id}** ${item.item_emoji} **${item.item_name}** x${item.quantity}${equippedText}\n`;

            if (targetUser.id === interaction.user.id) {
                const properties = [];
                if (item.usable) properties.push("🔧 Usable");
                if (item.tradeable) properties.push("🔄 Tradeable");
                if (item.sellable) properties.push("💵 Sellable");

                fieldValue += `${properties.join(" • ")}${valueText}${usedText}\n\n`;
            } else {
                fieldValue += `\n`;
            }
        });

        embed.addFields({
            name: `${getTypeEmoji(type)} ${getCategoryName(type)}`,
            value: fieldValue || "No items",
            inline: false
        });
    }

    await interaction.reply({ embeds: [embed] });
}

export async function handleUse(interaction, config: any): Promise<any> {
    await interaction.deferReply();

    const itemId = interaction.options.getInteger("item_id");
    const quantity = interaction.options.getInteger("quantity") || 1;

    // Get item from user's inventory
    const [[inventoryItem]] = await db.execute(
        `SELECT i.*, s.item_name, s.item_emoji, s.item_type, s.usable, s.item_description
         FROM user_inventory i
         JOIN shop_items s ON i.item_id = s.id
         WHERE i.guild_id = ? AND i.user_id = ? AND i.item_id = ?`,
        [interaction.guild.id, interaction.user.id, itemId]
    );

    if (!inventoryItem) {
        return interaction.editReply({
            content: "❌ You don't own this item."
        });
    }

    if (!inventoryItem.usable) {
        return interaction.editReply({
            content: `❌ **${inventoryItem.item_name}** is not a usable item.`
        });
    }

    if (inventoryItem.quantity < quantity) {
        return interaction.editReply({
            content: `❌ You don't have enough of this item. You own: ${inventoryItem.quantity}`
        });
    }

    // Item effects based on item name (can be expanded)
    let effectMessage = "";
    let removeItem = false;

    switch (inventoryItem.item_name) {
        case "Cookie":
            effectMessage = "You ate a delicious cookie! 🍪 *Yum!*";
            removeItem = true;
            break;

        case "Pizza":
            effectMessage = "You devoured a hot slice of pizza! 🍕 *So good!*";
            removeItem = true;
            break;

        case "Lottery Ticket":
            // Random chance to win money
            const won = Math.random() < 0.15; // 15% win rate
            if (won) {
                const winAmount = Math.floor(Math.random() * 5000) + 1000;
                await db.execute(
                    "UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?",
                    [winAmount, winAmount, interaction.guild.id, interaction.user.id]
                );

                const [[userEconomy]] = await db.execute(
                    "SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ?",
                    [interaction.guild.id, interaction.user.id]
                );

                await db.execute(
                    `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description, related_item_id)
                     VALUES (?, ?, 'reward', ?, ?, ?, ?, ?)`,
                    [
                        interaction.guild.id,
                        interaction.user.id,
                        winAmount,
                        userEconomy.wallet - winAmount,
                        userEconomy.wallet,
                        `Won lottery ticket`,
                        itemId
                    ]
                );

                effectMessage = `🎉 **YOU WON!** You scratched the lottery ticket and won ${formatMoney(winAmount, config)}!`;
            } else {
                effectMessage = "😢 You scratched the lottery ticket but didn't win anything. Better luck next time!";
            }
            removeItem = true;
            break;

        case "Gift Box":
            // Random item reward
            const [availableItems] = await db.execute(
                `SELECT id, item_name, item_emoji FROM shop_items
                 WHERE (guild_id = ? OR guild_id IS NULL)
                 AND is_active = TRUE
                 AND price BETWEEN 50 AND 1000
                 ORDER BY RAND() LIMIT 1`,
                [interaction.guild.id]
            );

            if (availableItems.length > 0) {
                const randomItem = availableItems[0];
                const randomQuantity = Math.floor(Math.random() * 3) + 1;

                // Add random item to inventory
                const [[existingItem]] = await db.execute(
                    "SELECT * FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                    [interaction.guild.id, interaction.user.id, randomItem.id]
                );

                if (existingItem) {
                    await db.execute(
                        "UPDATE user_inventory SET quantity = quantity + ? WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                        [randomQuantity, interaction.guild.id, interaction.user.id, randomItem.id]
                    );
                } else {
                    await db.execute(
                        "INSERT INTO user_inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)",
                        [interaction.guild.id, interaction.user.id, randomItem.id, randomQuantity]
                    );
                }

                effectMessage = `🎁 You opened the gift box and received **${randomQuantity}x ${randomItem.item_emoji} ${randomItem.item_name}**!`;
            } else {
                effectMessage = "🎁 You opened the gift box but it was empty!";
            }
            removeItem = true;
            break;

        case "Bank Note":
            // Increase bank capacity
            await db.execute(
                "UPDATE user_economy SET bank_capacity = bank_capacity + 10000 WHERE guild_id = ? AND user_id = ?",
                [interaction.guild.id, interaction.user.id]
            );
            effectMessage = "💳 You used a Bank Note! Your bank capacity has increased by 10,000!";
            removeItem = true;
            break;

        default:
            effectMessage = `✅ You used **${inventoryItem.item_name}**!`;
            removeItem = true;
            break;
    }

    // Update inventory
    try {
        if (removeItem) {
            if (inventoryItem.quantity === quantity) {
                await db.execute(
                    "DELETE FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                    [interaction.guild.id, interaction.user.id, itemId]
                );
            } else {
                await db.execute(
                    "UPDATE user_inventory SET quantity = quantity - ?, use_count = use_count + ?, last_used = NOW() WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                    [quantity, quantity, interaction.guild.id, interaction.user.id, itemId]
                );
            }
        } else {
            await db.execute(
                "UPDATE user_inventory SET use_count = use_count + ?, last_used = NOW() WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [quantity, interaction.guild.id, interaction.user.id, itemId]
            );
        }

        const embed = new EmbedBuilder()
            .setColor("#9B59B6")
            .setTitle(`${inventoryItem.item_emoji} Used ${inventoryItem.item_name}`)
            .setDescription(effectMessage)
            .addFields({ name: "Quantity Used", value: `${quantity}`, inline: true })
            .setTimestamp();

        if (inventoryItem.quantity - quantity > 0) {
            embed.addFields({ name: "Remaining", value: `${inventoryItem.quantity - quantity}`, inline: true });
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error("[Inventory] Use item _error:", { error: _error.message, stack: _error.stack  });
        await interaction.editReply({
            content: "❌ An error occurred while using the item."
        });
    }
}

export async function handleEquip(interaction, config: any): Promise<any> {
    await interaction.deferReply();

    const itemId = interaction.options.getInteger("item_id");

    // Get item from user's inventory
    const [[inventoryItem]] = await db.execute(
        `SELECT i.*, s.item_name, s.item_emoji, s.item_type
         FROM user_inventory i
         JOIN shop_items s ON i.item_id = s.id
         WHERE i.guild_id = ? AND i.user_id = ? AND i.item_id = ?`,
        [interaction.guild.id, interaction.user.id, itemId]
    );

    if (!inventoryItem) {
        return interaction.editReply({
            content: "❌ You don't own this item."
        });
    }

    if (inventoryItem.item_type !== "tool" && inventoryItem.item_type !== "decoration") {
        return interaction.editReply({
            content: `❌ **${inventoryItem.item_name}** cannot be equipped. Only tools and decorations can be equipped.`
        });
    }

    // Toggle equipped status
    const newEquippedStatus = !inventoryItem.is_equipped;

    // If equipping, unequip other items of the same type
    if (newEquippedStatus) {
        await db.execute(
            `UPDATE user_inventory i
             JOIN shop_items s ON i.item_id = s.id
             SET i.is_equipped = FALSE
             WHERE i.guild_id = ? AND i.user_id = ? AND s.item_type = ? AND i.item_id != ?`,
            [interaction.guild.id, interaction.user.id, inventoryItem.item_type, itemId]
        );
    }

    // Update equipped status
    await db.execute(
        "UPDATE user_inventory SET is_equipped = ? WHERE guild_id = ? AND user_id = ? AND item_id = ?",
        [newEquippedStatus, interaction.guild.id, interaction.user.id, itemId]
    );

    const embed = new EmbedBuilder()
        .setColor(newEquippedStatus ? "#00FF00" : "#FF9900")
        .setTitle(`${inventoryItem.item_emoji} ${newEquippedStatus ? "Equipped" : "Unequipped"}`)
        .setDescription(`**${inventoryItem.item_name}** has been ${newEquippedStatus ? "equipped" : "unequipped"}!`)
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleGift(interaction, config: any): Promise<any> {
    await interaction.deferReply();

    const recipient = interaction.options.getUser("user");
    const itemId = interaction.options.getInteger("item_id");
    const quantity = interaction.options.getInteger("quantity") || 1;

    // Validation
    if (recipient.bot) {
        return interaction.editReply({
            content: "❌ You cannot gift items to bots."
        });
    }

    if (recipient.id === interaction.user.id) {
        return interaction.editReply({
            content: "❌ You cannot gift items to yourself."
        });
    }

    // Check if gifting is allowed
    if (!config.allow_gifting) {
        return interaction.editReply({
            content: "❌ Gifting is disabled in this server."
        });
    }

    // Get item from sender's inventory
    const [[senderItem]] = await db.execute(
        `SELECT i.*, s.item_name, s.item_emoji, s.tradeable
         FROM user_inventory i
         JOIN shop_items s ON i.item_id = s.id
         WHERE i.guild_id = ? AND i.user_id = ? AND i.item_id = ?`,
        [interaction.guild.id, interaction.user.id, itemId]
    );

    if (!senderItem) {
        return interaction.editReply({
            content: "❌ You don't own this item."
        });
    }

    if (!senderItem.tradeable) {
        return interaction.editReply({
            content: `❌ **${senderItem.item_name}** cannot be gifted.`
        });
    }

    if (senderItem.quantity < quantity) {
        return interaction.editReply({
            content: `❌ You don't have enough of this item. You own: ${senderItem.quantity}`
        });
    }

    try {
        await db.execute("START TRANSACTION");

        // Remove from sender
        if (senderItem.quantity === quantity) {
            await db.execute(
                "DELETE FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [interaction.guild.id, interaction.user.id, itemId]
            );
        } else {
            await db.execute(
                "UPDATE user_inventory SET quantity = quantity - ? WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [quantity, interaction.guild.id, interaction.user.id, itemId]
            );
        }

        // Add to recipient
        const [[recipientItem]] = await db.execute(
            "SELECT * FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
            [interaction.guild.id, recipient.id, itemId]
        );

        if (recipientItem) {
            await db.execute(
                "UPDATE user_inventory SET quantity = quantity + ? WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [quantity, interaction.guild.id, recipient.id, itemId]
            );
        } else {
            await db.execute(
                "INSERT INTO user_inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)",
                [interaction.guild.id, recipient.id, itemId, quantity]
            );
        }

        await db.execute("COMMIT");

        const embed = new EmbedBuilder()
            .setColor("#00FF00")
            .setTitle("🎁 Gift Sent!")
            .setDescription(`You gifted **${quantity}x ${senderItem.item_emoji} ${senderItem.item_name}** to ${recipient}!`)
            .addFields(
                { name: "Recipient", value: recipient.username, inline: true },
                { name: "Quantity", value: `${quantity}`, inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // Try to DM the recipient
        try {
            const dmEmbed = new EmbedBuilder()
                .setColor("#00FF00")
                .setTitle("🎁 You Received a Gift!")
                .setDescription(`${interaction.user} gifted you **${quantity}x ${senderItem.item_emoji} ${senderItem.item_name}** in **${interaction.guild.name}**!`)
                .setTimestamp();

            await recipient.send({ embeds: [dmEmbed] });
        } catch (error) {
            // User has DMs disabled, ignore
        }

    } catch (error) {
        await db.execute("ROLLBACK");
        logger.error("[Inventory] Gift _error:", { error: _error.message, stack: _error.stack  });
        await interaction.editReply({
            content: "❌ An error occurred while gifting the item."
        });
    }
}

export function formatMoney(amount, config: any): any {
    return `${config.currency_emoji} ${amount.toLocaleString()}`;
}

export function getCategoryName(type: any): any {
    const categories = {
        "role": "Roles",
        "consumable": "Consumables",
        "collectible": "Collectibles",
        "tool": "Tools",
        "decoration": "Decorations"
    };
    return categories[type] || type;
}

export function getTypeEmoji(type: any): any {
    const emojis = {
        "role": "👑",
        "consumable": "🍕",
        "collectible": "💎",
        "tool": "🔧",
        "decoration": "🎨"
    };
    return emojis[type] || "📦";
}

module.exports = {
    handleView,
    handleUse,
    handleEquip,
    handleGift
};
