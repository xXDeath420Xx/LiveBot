import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import shopManager from '../../core/shop-manager.js';
import economyManager from '../../core/economy-manager.js';
import logger from '../../utils/logger.js';

export async function handleBrowse(interaction) {
    const category = interaction.options.getString('category') || 'all';
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const items = await shopManager.getShopItems(interaction.guild.id, category, 25);

    if (items.length === 0) {
        await interaction.reply({
            content: '\ud83d\uded2 The shop is currently empty. Check back later!',
            ephemeral: true
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#00D9FF')
        .setTitle(`\ud83d\uded2 Shop - ${category === 'all' ? 'All Items' : shopManager.getCategoryName(category)}`)
        .setDescription(`Browse available items and purchase with ${config.currency_emoji} ${config.currency_name}!`);

    const groupedItems = {};
    items.forEach(item => {
        if (!groupedItems[item.item_type]) {
            groupedItems[item.item_type] = [];
        }
        groupedItems[item.item_type].push(item);
    });

    for (const [type, typeItems] of Object.entries(groupedItems)) {
        let fieldValue = '';
        for (const item of typeItems) {
            const stockInfo = item.stock === -1 ? 'Unlimited' : `${item.stock} left`;
            const maxPerUser = item.max_per_user !== -1 ? ` [Max: ${item.max_per_user}]` : '';

            fieldValue += `**ID: ${item.id}** ${item.item_emoji || '\ud83d\udce6'} **${item.item_name}**\n`;
            fieldValue += `${item.item_description || 'No description'}\n`;
            fieldValue += `Price: ${economyManager.formatMoney(item.price, config)} | Stock: ${stockInfo}${maxPerUser}\n\n`;
        }

        embed.addFields({
            name: `${shopManager.getTypeEmoji(type)} ${shopManager.getCategoryName(type)}`,
            value: fieldValue || 'No items available',
            inline: false
        });
    }

    const userEconomy = await economyManager.getBalance(interaction.guild.id, interaction.user.id);
    embed.setFooter({ text: `Use /economy shop buy <item_id> to purchase \u2022 You have ${economyManager.formatMoney(userEconomy.wallet, config)} in your wallet` });

    await interaction.reply({ embeds: [embed] });
}

export async function handleBuy(interaction) {
    await interaction.deferReply();

    const itemId = interaction.options.getInteger('item_id');
    const quantity = interaction.options.getInteger('quantity') || 1;
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    const result = await shopManager.purchaseItem(interaction.guild.id, interaction.user.id, itemId, quantity);

    if (result.item.item_type === 'role' && result.item.role_id) {
        try {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const role = await interaction.guild.roles.fetch(result.item.role_id);
            if (role) {
                await member.roles.add(role);
            }
        } catch (error) {
            logger.error('[Shop] Failed to grant role:', { error: error.message });
        }
    }

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\u2705 Purchase Successful!')
        .setDescription(`You purchased **${quantity}x ${result.item.item_emoji || '\ud83d\udce6'} ${result.item.item_name}**`)
        .addFields(
            { name: 'Total Cost', value: economyManager.formatMoney(result.totalCost, config), inline: true },
            { name: 'Remaining Balance', value: economyManager.formatMoney(result.newBalance, config), inline: true }
        )
        .setTimestamp();

    if (result.item.item_type === 'role') {
        embed.addFields({ name: '\ud83d\udc51 Role Granted', value: 'The role has been automatically applied!', inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleSell(interaction) {
    await interaction.deferReply();

    const itemId = interaction.options.getInteger('item_id');
    const quantity = interaction.options.getInteger('quantity') || 1;
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    const result = await shopManager.sellItem(interaction.guild.id, interaction.user.id, itemId, quantity);

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\u2705 Sale Successful!')
        .setDescription(`You sold **${quantity}x ${result.item.item_emoji || '\ud83d\udce6'} ${result.item.item_name}**`)
        .addFields(
            { name: 'Total Value', value: economyManager.formatMoney(result.totalValue, config), inline: true },
            { name: 'New Balance', value: economyManager.formatMoney(result.newBalance, config), inline: true }
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleInventory(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const items = await shopManager.getUserInventory(interaction.guild.id, targetUser.id);

    if (items.length === 0) {
        await interaction.reply({
            content: `${targetUser.id === interaction.user.id ? 'Your' : targetUser.username + '\'s'} inventory is empty!`,
            ephemeral: true
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle(`${targetUser.username}'s Inventory`)
        .setThumbnail(targetUser.displayAvatarURL());

    const groupedItems = {};
    items.forEach(item => {
        if (!groupedItems[item.item_type]) {
            groupedItems[item.item_type] = [];
        }
        groupedItems[item.item_type].push(item);
    });

    for (const [type, typeItems] of Object.entries(groupedItems)) {
        let fieldValue = '';
        for (const item of typeItems) {
            const sellValue = item.sellable && item.sell_value > 0 ? ` (Sell: ${economyManager.formatMoney(item.sell_value, config)})` : '';
            fieldValue += `**ID: ${item.item_id}** ${item.item_emoji || '\ud83d\udce6'} **${item.item_name}** x${item.quantity}${sellValue}\n`;
        }

        embed.addFields({
            name: `${shopManager.getTypeEmoji(type)} ${shopManager.getCategoryName(type)}`,
            value: fieldValue,
            inline: false
        });
    }

    await interaction.reply({ embeds: [embed] });
}

export async function handleInfo(interaction) {
    const itemId = interaction.options.getInteger('item_id');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const item = await shopManager.getShopItem(itemId, interaction.guild.id);

    if (!item) {
        await interaction.reply({
            content: '\u274c Item not found.',
            ephemeral: true
        });
        return;
    }

    const userQuantity = await shopManager.getUserItemQuantity(interaction.guild.id, interaction.user.id, itemId);

    const embed = new EmbedBuilder()
        .setColor('#00D9FF')
        .setTitle(`${item.item_emoji || '\ud83d\udce6'} ${item.item_name}`)
        .setDescription(item.item_description || 'No description available.')
        .addFields(
            { name: '\ud83d\udcb0 Price', value: economyManager.formatMoney(item.price, config), inline: true },
            { name: '\ud83d\udce6 Type', value: shopManager.getCategoryName(item.item_type), inline: true },
            { name: '\ud83d\udcca Stock', value: item.stock === -1 ? 'Unlimited' : `${item.stock} remaining`, inline: true }
        );

    if (item.sell_value > 0 && item.sellable) {
        embed.addFields({ name: '\ud83d\udcb5 Sell Value', value: economyManager.formatMoney(item.sell_value, config), inline: true });
    }

    if (item.max_per_user !== -1) {
        embed.addFields({ name: '\u26a0\ufe0f Max Per User', value: `${item.max_per_user}`, inline: true });
    }

    if (item.required_level > 0) {
        embed.addFields({ name: '\ud83c\udf96\ufe0f Required Level', value: `Level ${item.required_level}`, inline: true });
    }

    if (userQuantity > 0) {
        embed.addFields({ name: '\u2705 You Own', value: `${userQuantity}`, inline: true });
    }

    embed.addFields({ name: '\ud83c\udf0d Total Owned (Server)', value: `${item.total_owned || 0}`, inline: true });

    const properties = [];
    if (item.usable) properties.push('\ud83d\udd27 Usable');
    if (item.tradeable) properties.push('\ud83d\udd04 Tradeable');
    if (item.sellable) properties.push('\ud83d\udcb5 Sellable');
    if (properties.length > 0) {
        embed.addFields({ name: 'Properties', value: properties.join(' \u2022 '), inline: false });
    }

    if (item.item_type === 'role' && item.role_id) {
        embed.addFields({ name: '\ud83d\udc51 Role Reward', value: `Grants <@&${item.role_id}> when purchased`, inline: false });
    }

    embed.setFooter({ text: `Item ID: ${item.id} \u2022 Use /economy shop buy ${item.id} to purchase` });

    await interaction.reply({ embeds: [embed] });
}

export async function handleUse(interaction) {
    const itemId = interaction.options.getInteger('item_id');
    const result = await shopManager.useItem(interaction.guild.id, interaction.user.id, itemId);

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\u2705 Item Used!')
        .setDescription(`You used **${result.item.item_emoji || '\ud83d\udce6'} ${result.item.item_name}**`)
        .addFields(
            { name: 'Remaining', value: `${result.remainingQuantity}`, inline: true }
        );

    if (result.item.item_type === 'consumable') {
        embed.addFields({ name: 'Effect', value: 'The item has been consumed!', inline: false });
    }

    await interaction.reply({ embeds: [embed] });
}

export async function handleCreate(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
            content: '\u274c You need Administrator permission to use this command!',
            ephemeral: true
        });
        return;
    }

    const name = interaction.options.getString('name');
    const price = interaction.options.getInteger('price');
    const type = interaction.options.getString('type');
    const description = interaction.options.getString('description') || 'No description';
    const emoji = interaction.options.getString('emoji') || '\ud83d\udce6';
    const stock = interaction.options.getInteger('stock') ?? -1;
    const role = interaction.options.getRole('role');

    const itemData = {
        name,
        description,
        emoji,
        type,
        price,
        sellValue: Math.floor(price * 0.5),
        stock,
        roleId: role ? role.id : null
    };

    const item = await shopManager.createShopItem(interaction.guild.id, itemData);
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\u2705 Shop Item Created!')
        .setDescription(`**${item.item_emoji} ${item.item_name}** has been added to the shop!`)
        .addFields(
            { name: 'Item ID', value: `${item.id}`, inline: true },
            { name: 'Price', value: economyManager.formatMoney(item.price, config), inline: true },
            { name: 'Type', value: shopManager.getCategoryName(item.item_type), inline: true }
        );

    await interaction.reply({ embeds: [embed] });
}

export async function handleDelete(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
            content: '\u274c You need Administrator permission to use this command!',
            ephemeral: true
        });
        return;
    }

    const itemId = interaction.options.getInteger('item_id');
    await shopManager.deleteShopItem(itemId, interaction.guild.id);

    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('\u2705 Shop Item Deleted!')
        .setDescription(`Item ID ${itemId} has been removed from the shop.`);

    await interaction.reply({ embeds: [embed] });
}

export async function handleEdit(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
            content: '\u274c You need Administrator permission to use this command!',
            ephemeral: true
        });
        return;
    }

    const itemId = interaction.options.getInteger('item_id');
    const updates = {};

    const price = interaction.options.getInteger('price');
    const stock = interaction.options.getInteger('stock');
    const description = interaction.options.getString('description');

    if (price !== null) updates.price = price;
    if (stock !== null) updates.stock = stock;
    if (description !== null) updates.item_description = description;

    if (Object.keys(updates).length === 0) {
        await interaction.reply({
            content: '\u274c No changes specified!',
            ephemeral: true
        });
        return;
    }

    await shopManager.updateShopItem(itemId, interaction.guild.id, updates);
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\u2705 Shop Item Updated!')
        .setDescription(`Item ID ${itemId} has been updated.`);

    if (price !== null) {
        embed.addFields({ name: 'New Price', value: economyManager.formatMoney(price, config), inline: true });
    }
    if (stock !== null) {
        embed.addFields({ name: 'New Stock', value: stock === -1 ? 'Unlimited' : `${stock}`, inline: true });
    }

    await interaction.reply({ embeds: [embed] });
}
