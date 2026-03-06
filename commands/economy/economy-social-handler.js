import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import economyManager from '../../core/economy-manager.js';

export async function handleRob(interaction) {
    const target = interaction.options.getUser('user');

    if (target.bot) {
        await interaction.reply({ content: '\u274c You cannot rob bots!', ephemeral: true });
        return;
    }

    if (target.id === interaction.user.id) {
        await interaction.reply({ content: '\u274c You cannot rob yourself!', ephemeral: true });
        return;
    }

    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const result = await economyManager.robUser(interaction.guild.id, interaction.user.id, target.id);

    if (result.success) {
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('\ud83d\udcb0 Rob Successful!')
            .setDescription(`You successfully robbed ${target.username} and stole ${economyManager.formatMoney(result.stolenAmount, config)}!`);

        await interaction.reply({ embeds: [embed] });
    } else {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('\ud83d\ude94 Rob Failed!')
            .setDescription(`You got caught trying to rob ${target.username} and were fined ${economyManager.formatMoney(result.fine, config)}!`);

        await interaction.reply({ embeds: [embed] });
    }
}

export async function handleLeaderboard(interaction) {
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const rows = await economyManager.getLeaderboard(interaction.guild.id, 10);

    if (rows.length === 0) {
        await interaction.reply({ content: '\u274c No economy data available yet!', ephemeral: true });
        return;
    }

    let description = '';
    for (let i = 0; i < rows.length; i++) {
        const user = await interaction.client.users.fetch(rows[i].user_id).catch(() => null);
        const username = user ? user.username : 'Unknown User';
        const medal = i === 0 ? '\ud83e\udd47' : i === 1 ? '\ud83e\udd48' : i === 2 ? '\ud83e\udd49' : `${i + 1}.`;
        description += `${medal} **${username}** - ${economyManager.formatMoney(rows[i].net_worth, config)}\n`;
    }

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('\ud83d\udcb0 Richest Users')
        .setDescription(description)
        .setFooter({ text: `Currency: ${config.currency_name}` });

    await interaction.reply({ embeds: [embed] });
}

export async function handleTransactions(interaction) {
    const limit = interaction.options.getInteger('limit') || 10;
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const rows = await economyManager.getTransactions(interaction.guild.id, interaction.user.id, limit);

    if (rows.length === 0) {
        await interaction.reply({ content: '\u274c No transactions found!', ephemeral: true });
        return;
    }

    const typeEmojis = {
        'daily': '\ud83d\udcb5',
        'weekly': '\ud83d\udcb0',
        'work': '\ud83d\udcbc',
        'crime': '\ud83d\udd2b',
        'rob': '\ud83d\udcb0',
        'fine': '\ud83d\ude94',
        'shop_buy': '\ud83d\uded2',
        'shop_sell': '\ud83d\udcb8',
        'transfer': '\ud83d\udcb8',
        'reward': '\ud83c\udf81',
        'gamble': '\ud83c\udfb0'
    };

    let description = '';
    for (const tx of rows) {
        const typeEmoji = typeEmojis[tx.transaction_type] || '\ud83d\udcdd';
        const sign = tx.amount >= 0 ? '+' : '';
        const date = new Date(tx.created_at).toLocaleDateString();
        description += `${typeEmoji} ${sign}${economyManager.formatMoney(tx.amount, config)} - ${tx.description || tx.transaction_type} (${date})\n`;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('\ud83d\udcca Recent Transactions')
        .setDescription(description)
        .setFooter({ text: `Showing last ${rows.length} transactions` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleGive(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
            content: '\u274c You need Administrator permission to use this command!',
            ephemeral: true
        });
        return;
    }

    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    await economyManager.addCurrency(
        interaction.guild.id,
        target.id,
        amount,
        `Admin reward from ${interaction.user.username}`
    );

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\u2705 Currency Given')
        .setDescription(`Gave ${economyManager.formatMoney(amount, config)} to ${target.username}!`);

    await interaction.reply({ embeds: [embed] });
}

export async function handleRemove(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
            content: '\u274c You need Administrator permission to use this command!',
            ephemeral: true
        });
        return;
    }

    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    await economyManager.removeCurrency(
        interaction.guild.id,
        target.id,
        amount,
        `Admin removal by ${interaction.user.username}`
    );

    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('\u2705 Currency Removed')
        .setDescription(`Removed ${economyManager.formatMoney(amount, config)} from ${target.username}!`);

    await interaction.reply({ embeds: [embed] });
}
