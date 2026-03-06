import { EmbedBuilder } from 'discord.js';
import economyManager from '../../core/economy-manager.js';

export async function handleBalance(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const economy = await economyManager.getOrCreateUserEconomy(interaction.guild.id, targetUser.id, config);

    const netWorth = economy.wallet + economy.bank;
    const bankUsage = ((economy.bank / economy.bank_capacity) * 100).toFixed(1);

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`${targetUser.username}'s Balance`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
            { name: '\ud83d\udcb5 Wallet', value: economyManager.formatMoney(economy.wallet, config), inline: true },
            { name: '\ud83c\udfe6 Bank', value: `${economyManager.formatMoney(economy.bank, config)} / ${economyManager.formatMoney(economy.bank_capacity, config)} (${bankUsage}%)`, inline: true },
            { name: '\ud83d\udcb0 Net Worth', value: economyManager.formatMoney(netWorth, config), inline: true }
        );

    if (economy.daily_streak > 0) {
        embed.addFields({ name: '\ud83d\udd25 Daily Streak', value: `${economy.daily_streak} days`, inline: true });
    }
    if (economy.work_streak > 0) {
        embed.addFields({ name: '\ud83d\udcbc Work Streak', value: `${economy.work_streak} times`, inline: true });
    }
    if (economy.prestige_level > 0) {
        embed.addFields({ name: '\u2b50 Prestige', value: `Level ${economy.prestige_level}`, inline: true });
    }

    await interaction.reply({ embeds: [embed] });
}

export async function handleDeposit(interaction) {
    const amount = interaction.options.getInteger('amount');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const result = await economyManager.deposit(interaction.guild.id, interaction.user.id, amount);

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\ud83c\udfe6 Deposit Successful')
        .setDescription(`Deposited ${economyManager.formatMoney(amount, config)} into your bank!`)
        .addFields(
            { name: '\ud83d\udcb5 New Wallet Balance', value: economyManager.formatMoney(result.newWallet, config), inline: true },
            { name: '\ud83c\udfe6 New Bank Balance', value: economyManager.formatMoney(result.newBank, config), inline: true }
        );

    await interaction.reply({ embeds: [embed] });
}

export async function handleWithdraw(interaction) {
    const amount = interaction.options.getInteger('amount');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const result = await economyManager.withdraw(interaction.guild.id, interaction.user.id, amount);

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\ud83c\udfe6 Withdrawal Successful')
        .setDescription(`Withdrew ${economyManager.formatMoney(amount, config)} from your bank!`)
        .addFields(
            { name: '\ud83d\udcb5 New Wallet Balance', value: economyManager.formatMoney(result.newWallet, config), inline: true },
            { name: '\ud83c\udfe6 New Bank Balance', value: economyManager.formatMoney(result.newBank, config), inline: true }
        );

    await interaction.reply({ embeds: [embed] });
}

export async function handleTransfer(interaction) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    if (target.bot) {
        await interaction.reply({ content: '\u274c You cannot transfer money to bots!', ephemeral: true });
        return;
    }

    if (target.id === interaction.user.id) {
        await interaction.reply({ content: '\u274c You cannot transfer money to yourself!', ephemeral: true });
        return;
    }

    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    await economyManager.transferCurrency(interaction.guild.id, interaction.user.id, target.id, amount);

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\ud83d\udcb8 Transfer Successful')
        .setDescription(`Transferred ${economyManager.formatMoney(amount, config)} to ${target.username}!`);

    await interaction.reply({ embeds: [embed] });
}
