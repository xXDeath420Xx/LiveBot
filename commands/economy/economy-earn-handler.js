import { EmbedBuilder } from 'discord.js';
import economyManager from '../../core/economy-manager.js';

export async function handleDaily(interaction) {
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const result = await economyManager.claimDaily(interaction.guild.id, interaction.user.id);

    if (interaction.client.achievementManager) {
        if (result.streak >= 7) {
            await interaction.client.achievementManager.trackAchievement(
                interaction.user.id,
                interaction.guild.id,
                'daily_dedication',
                result.streak
            );
        }
    }

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\ud83d\udcb5 Daily Reward Claimed!')
        .setDescription(`You received ${economyManager.formatMoney(result.totalAmount, config)}!`)
        .addFields(
            { name: 'Base Amount', value: economyManager.formatMoney(result.baseAmount, config), inline: true },
            { name: 'Streak Bonus', value: economyManager.formatMoney(result.streakBonus, config), inline: true },
            { name: '\ud83d\udd25 Current Streak', value: `${result.streak} days`, inline: true }
        )
        .setFooter({ text: 'Come back in 24 hours for your next reward!' });

    await interaction.reply({ embeds: [embed] });
}

export async function handleWeekly(interaction) {
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const result = await economyManager.claimWeekly(interaction.guild.id, interaction.user.id);

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('\ud83d\udcb0 Weekly Reward Claimed!')
        .setDescription(`You received ${economyManager.formatMoney(result.amount, config)}!`)
        .setFooter({ text: 'Come back in 7 days for your next reward!' });

    await interaction.reply({ embeds: [embed] });
}

export async function handleWork(interaction) {
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const result = await economyManager.work(interaction.guild.id, interaction.user.id);

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(`${result.job.emoji} ${result.job.name}`)
        .setDescription(`You worked hard and earned ${economyManager.formatMoney(result.totalAmount, config)}!`)
        .addFields(
            { name: 'Base Pay', value: economyManager.formatMoney(result.baseAmount, config), inline: true },
            { name: 'Streak Bonus', value: economyManager.formatMoney(result.streakBonus, config), inline: true },
            { name: '\ud83d\udcbc Work Streak', value: `${result.streak} times`, inline: true }
        );

    await interaction.reply({ embeds: [embed] });
}

export async function handleCrime(interaction) {
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const result = await economyManager.commitCrime(interaction.guild.id, interaction.user.id);

    if (result.success) {
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle(`${result.crime.emoji} Crime Successful!`)
            .setDescription(`You ${result.crime.name.toLowerCase()} and got away with ${economyManager.formatMoney(result.amount, config)}!`);

        await interaction.reply({ embeds: [embed] });
    } else {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('\ud83d\ude94 Busted!')
            .setDescription(`You got caught ${result.crime.name.toLowerCase()} and were fined ${economyManager.formatMoney(result.fine, config)}!`);

        await interaction.reply({ embeds: [embed] });
    }
}
