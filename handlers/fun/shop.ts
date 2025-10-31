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


export async function handleBrowse(interaction, config: any): Promise<any> {
    const category = interaction.options.getString("category") || "all";

    // Build query based on category
    let query = `
        SELECT s.*,
               COALESCE((SELECT SUM(quantity) FROM user_inventory WHERE item_id = s.id AND guild_id = ?), 0) as total_owned,
               COALESCE((SELECT quantity FROM user_inventory WHERE item_id = s.id AND guild_id = ? AND user_id = ?), 0) as user_owned
        FROM shop_items s
        WHERE (s.guild_id = ? OR s.guild_id IS NULL) AND s.is_active = TRUE
    `;
    const params = [interaction.guild.id, interaction.guild.id, interaction.user.id, interaction.guild.id];

    if (category !== "all") {
        query += " AND s.item_type = ?";
        params.push(category);
    }

    query += " ORDER BY s.item_type, s.price ASC LIMIT 25";

    const [items] = await db.execute(query, params);

    if (items.length === 0) {
        return interaction.reply({
            content: "🛒 The shop is currently empty. Check back later!",
            ephemeral: true
        });
    }

    const embed = new EmbedBuilder()
        .setColor("#00D9FF")
        .setTitle(`🛒 Shop - ${category === "all" ? "All Items" : getCategoryName(category)}`)
        .setDescription(`Browse available items and purchase with ${config.currency_emoji} ${config.currency_name}!`)
        .setFooter({ text: `Use /shop buy <item_id> to purchase • You have ${config.currency_emoji} in your wallet` });

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
            const stockInfo = item.stock === -1 ? "Unlimited" : `${item.stock} left`;
            const ownedInfo = item.user_owned > 0 ? ` (You own: ${item.user_owned})` : "";
            const maxPerUser = item.max_per_user !== -1 ? ` [Max: ${item.max_per_user}]` : "";

            fieldValue += `**ID: ${item.id}** ${item.item_emoji} **${item.item_name}**\n`;
            fieldValue += `${item.item_description}\n`;
            fieldValue += `Price: ${formatMoney(item.price, config)} | Stock: ${stockInfo}${maxPerUser}${ownedInfo}\n\n`;
        });

        embed.addFields({
            name: `${getTypeEmoji(type)} ${getCategoryName(type)}`,
            value: fieldValue || "No items available",
            inline: false
        });
    }

    // Get user's current wallet balance
    const [[userEconomy]] = await db.execute(
        "SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ?",
        [interaction.guild.id, interaction.user.id]
    );

    if (userEconomy) {
        embed.setFooter({ text: `Use /shop buy <item_id> to purchase • You have ${formatMoney(userEconomy.wallet, config)} in your wallet` });
    }

    await interaction.reply({ embeds: [embed] });
}

export async function handleBuy(interaction, config: any): Promise<any> {
    await interaction.deferReply();

    const itemId = interaction.options.getInteger("item_id");
    const quantity = interaction.options.getInteger("quantity") || 1;

    // Get item details
    const [[item]] = await db.execute(
        `SELECT * FROM shop_items
         WHERE id = ? AND (guild_id = ? OR guild_id IS NULL) AND is_active = TRUE`,
        [itemId, interaction.guild.id]
    );

    if (!item) {
        return interaction.editReply({
            content: "❌ Item not found or is not available for purchase."
        });
    }

    // Check if item meets level requirement
    if (item.required_level > 0) {
        const [[userLevel]] = await db.execute(
            "SELECT level FROM user_levels WHERE guild_id = ? AND user_id = ?",
            [interaction.guild.id, interaction.user.id]
        );

        if (!userLevel || userLevel.level < item.required_level) {
            return interaction.editReply({
                content: `❌ You need to be level ${item.required_level} to purchase this item.`
            });
        }
    }

    // Check if item requires a prerequisite item
    if (item.required_item_id) {
        const [[hasRequired]] = await db.execute(
            "SELECT id FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
            [interaction.guild.id, interaction.user.id, item.required_item_id]
        );

        if (!hasRequired) {
            const [[requiredItem]] = await db.execute(
                "SELECT item_name FROM shop_items WHERE id = ?",
                [item.required_item_id]
            );

            return interaction.editReply({
                content: `❌ You need to own **${requiredItem?.item_name || "a prerequisite item"}** to purchase this item.`
            });
        }
    }

    // Check stock
    if (item.stock !== -1 && item.stock < quantity) {
        return interaction.editReply({
            content: `❌ Not enough stock available. Only ${item.stock} left in stock.`
        });
    }

    // Check max per user
    if (item.max_per_user !== -1) {
        const [[userInventory]] = await db.execute(
            "SELECT COALESCE(quantity, 0) as quantity FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
            [interaction.guild.id, interaction.user.id, itemId]
        );

        const currentOwned = userInventory?.quantity || 0;
        if (currentOwned + quantity > item.max_per_user) {
            return interaction.editReply({
                content: `❌ You can only own a maximum of ${item.max_per_user} of this item. You currently own ${currentOwned}.`
            });
        }
    }

    // Get user economy
    const [[userEconomy]] = await db.execute(
        "SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?",
        [interaction.guild.id, interaction.user.id]
    );

    if (!userEconomy) {
        return interaction.editReply({
            content: "❌ You don't have an economy account. Use `/economy balance` to create one."
        });
    }

    // Calculate total cost
    const totalCost = item.price * quantity;

    if (userEconomy.wallet < totalCost) {
        return interaction.editReply({
            content: `❌ You don't have enough ${config.currency_name}! You need ${formatMoney(totalCost, config)} but only have ${formatMoney(userEconomy.wallet, config)}.`
        });
    }

    // Process purchase
    try {
        await db.execute("START TRANSACTION");

        // Deduct money
        await db.execute(
            "UPDATE user_economy SET wallet = wallet - ?, total_spent = total_spent + ? WHERE guild_id = ? AND user_id = ?",
            [totalCost, totalCost, interaction.guild.id, interaction.user.id]
        );

        // Add item to inventory
        const [[existingItem]] = await db.execute(
            "SELECT * FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
            [interaction.guild.id, interaction.user.id, itemId]
        );

        if (existingItem) {
            await db.execute(
                "UPDATE user_inventory SET quantity = quantity + ? WHERE guild_id = ? AND user_id = ? AND item_id = ?",
                [quantity, interaction.guild.id, interaction.user.id, itemId]
            );
        } else {
            await db.execute(
                "INSERT INTO user_inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)",
                [interaction.guild.id, interaction.user.id, itemId, quantity]
            );
        }

        // Update stock if not unlimited
        if (item.stock !== -1) {
            await db.execute(
                "UPDATE shop_items SET stock = stock - ? WHERE id = ?",
                [quantity, itemId]
            );
        }

        // Log transaction
        await db.execute(
            `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description, related_item_id)
             VALUES (?, ?, 'shop_buy', ?, ?, ?, ?, ?)`,
            [
                interaction.guild.id,
                interaction.user.id,
                -totalCost,
                userEconomy.wallet,
                userEconomy.wallet - totalCost,
                `Purchased ${quantity}x ${item.item_name}`,
                itemId
            ]
        );

        await db.execute("COMMIT");

        // If item is a role, grant it
        if (item.item_type === "role" && item.role_id) {
            try {
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const role = await interaction.guild.roles.fetch(item.role_id);
                if (role) {
                    await member.roles.add(role);
                }
            } catch (error) {
                logger.error("[Shop] Failed to grant role:", { error: _error.message  });
            }
        }

        const embed = new EmbedBuilder()
            .setColor("#00FF00")
            .setTitle("✅ Purchase Successful!")
            .setDescription(`You purchased **${quantity}x ${item.item_emoji} ${item.item_name}**`)
            .addFields(
                { name: "Total Cost", value: formatMoney(totalCost, config), inline: true },
                { name: "Remaining Balance", value: formatMoney(userEconomy.wallet - totalCost, config), inline: true }
            )
            .setTimestamp();

        if (item.item_type === "role") {
            embed.addFields({ name: "👑 Role Granted", value: `The role has been automatically applied!`, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        await db.execute("ROLLBACK");
        logger.error("[Shop] Purchase _error:", { error: _error.message, stack: _error.stack  });
        await interaction.editReply({
            content: "❌ An error occurred while processing your purchase. Your balance has not been changed."
        });
    }
}

export async function handleSell(interaction, config: any): Promise<any> {
    await interaction.deferReply();

    const itemId = interaction.options.getInteger("item_id");
    const quantity = interaction.options.getInteger("quantity") || 1;

    // Get item details
    const [[item]] = await db.execute(
        "SELECT * FROM shop_items WHERE id = ?",
        [itemId]
    );

    if (!item) {
        return interaction.editReply({
            content: "❌ Item not found."
        });
    }

    if (!item.sellable) {
        return interaction.editReply({
            content: `❌ **${item.item_name}** cannot be sold back to the shop.`
        });
    }

    if (item.sell_value <= 0) {
        return interaction.editReply({
            content: `❌ **${item.item_name}** has no sell value.`
        });
    }

    // Check user inventory
    const [[userInventory]] = await db.execute(
        "SELECT * FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?",
        [interaction.guild.id, interaction.user.id, itemId]
    );

    if (!userInventory || userInventory.quantity < quantity) {
        return interaction.editReply({
            content: `❌ You don't have enough of this item to sell. You own: ${userInventory?.quantity || 0}`
        });
    }

    // Get user economy
    const [[userEconomy]] = await db.execute(
        "SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?",
        [interaction.guild.id, interaction.user.id]
    );

    if (!userEconomy) {
        return interaction.editReply({
            content: "❌ You don't have an economy account."
        });
    }

    // Calculate sell value
    const totalValue = item.sell_value * quantity;

    try {
        await db.execute("START TRANSACTION");

        // Add money
        await db.execute(
            "UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?",
            [totalValue, totalValue, interaction.guild.id, interaction.user.id]
        );

        // Remove item from inventory
        if (userInventory.quantity === quantity) {
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

        // Restore stock if not unlimited
        if (item.stock !== -1) {
            await db.execute(
                "UPDATE shop_items SET stock = stock + ? WHERE id = ?",
                [quantity, itemId]
            );
        }

        // Log transaction
        await db.execute(
            `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description, related_item_id)
             VALUES (?, ?, 'shop_sell', ?, ?, ?, ?, ?)`,
            [
                interaction.guild.id,
                interaction.user.id,
                totalValue,
                userEconomy.wallet,
                userEconomy.wallet + totalValue,
                `Sold ${quantity}x ${item.item_name}`,
                itemId
            ]
        );

        await db.execute("COMMIT");

        const embed = new EmbedBuilder()
            .setColor("#00FF00")
            .setTitle("✅ Sale Successful!")
            .setDescription(`You sold **${quantity}x ${item.item_emoji} ${item.item_name}**`)
            .addFields(
                { name: "Total Value", value: formatMoney(totalValue, config), inline: true },
                { name: "New Balance", value: formatMoney(userEconomy.wallet + totalValue, config), inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        await db.execute("ROLLBACK");
        logger.error("[Shop] Sell _error:", { error: _error.message, stack: _error.stack  });
        await interaction.editReply({
            content: "❌ An error occurred while processing your sale. No changes have been made."
        });
    }
}

export async function handleInfo(interaction, config: any): Promise<any> {
    const itemId = interaction.options.getInteger("item_id");

    // Get item details with inventory info
    const [[item]] = await db.execute(
        `SELECT s.*,
                COALESCE((SELECT quantity FROM user_inventory WHERE item_id = s.id AND guild_id = ? AND user_id = ?), 0) as user_owned,
                COALESCE((SELECT SUM(quantity) FROM user_inventory WHERE item_id = s.id AND guild_id = ?), 0) as total_owned
         FROM shop_items s
         WHERE s.id = ? AND (s.guild_id = ? OR s.guild_id IS NULL)`,
        [interaction.guild.id, interaction.user.id, interaction.guild.id, itemId, interaction.guild.id]
    );

    if (!item) {
        return interaction.reply({
            content: "❌ Item not found.",
            ephemeral: true
        });
    }

    const embed = new EmbedBuilder()
        .setColor("#00D9FF")
        .setTitle(`${item.item_emoji} ${item.item_name}`)
        .setDescription(item.item_description || "No description available.")
        .addFields(
            { name: "💰 Price", value: formatMoney(item.price, config), inline: true },
            { name: "📦 Type", value: getCategoryName(item.item_type), inline: true },
            { name: "📊 Stock", value: item.stock === -1 ? "Unlimited" : `${item.stock} remaining`, inline: true }
        );

    if (item.sell_value > 0 && item.sellable) {
        embed.addFields({ name: "💵 Sell Value", value: formatMoney(item.sell_value, config), inline: true });
    }

    if (item.max_per_user !== -1) {
        embed.addFields({ name: "⚠️ Max Per User", value: `${item.max_per_user}`, inline: true });
    }

    if (item.required_level > 0) {
        embed.addFields({ name: "🎖️ Required Level", value: `Level ${item.required_level}`, inline: true });
    }

    if (item.user_owned > 0) {
        embed.addFields({ name: "✅ You Own", value: `${item.user_owned}`, inline: true });
    }

    embed.addFields({ name: "🌍 Total Owned (Server)", value: `${item.total_owned}`, inline: true });

    const properties = [];
    if (item.usable) properties.push("🔧 Usable");
    if (item.tradeable) properties.push("🔄 Tradeable");
    if (item.sellable) properties.push("💵 Sellable");
    if (properties.length > 0) {
        embed.addFields({ name: "Properties", value: properties.join(" • "), inline: false });
    }

    if (item.item_type === "role" && item.role_id) {
        embed.addFields({ name: "👑 Role Reward", value: `Grants <@&${item.role_id}> when purchased`, inline: false });
    }

    embed.setFooter({ text: `Item ID: ${item.id} • Use /shop buy ${item.id} to purchase` });

    await interaction.reply({ embeds: [embed] });
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
    handleBrowse,
    handleBuy,
    handleSell,
    handleInfo
};
