import { EmbedBuilder } from 'discord.js';
import gamblingManager from '../../core/gambling-manager.js';
import economyManager from '../../core/economy-manager.js';

async function trackGambleAchievements(interaction, result) {
    if (!interaction.client.achievementManager) return;

    await interaction.client.achievementManager.trackAchievement(
        interaction.user.id,
        interaction.guild.id,
        'first_gamble',
        1
    );

    if (result.won && result.winAmount >= 10000) {
        await interaction.client.achievementManager.trackAchievement(
            interaction.user.id,
            interaction.guild.id,
            'big_win',
            1,
            { completed: true }
        );
    }

    if (result.newBalance >= 1000000) {
        await interaction.client.achievementManager.trackAchievement(
            interaction.user.id,
            interaction.guild.id,
            'millionaire',
            1,
            { completed: true }
        );
    }
}

export async function handleCoinflip(interaction) {
    const betAmount = interaction.options.getInteger('amount');
    const userChoice = interaction.options.getString('choice');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    const result = await gamblingManager.playCoinflip(
        interaction.guild.id,
        interaction.user.id,
        betAmount,
        userChoice
    );

    await trackGambleAchievements(interaction, result);

    const embed = new EmbedBuilder()
        .setColor(result.won ? '#00FF00' : '#FF0000')
        .setTitle('\ud83e\ude99 Coinflip')
        .setDescription(`You bet on **${result.userChoice}**!\n\nThe coin landed on... **${result.result}**!`)
        .addFields(
            { name: 'Bet Amount', value: economyManager.formatMoney(result.betAmount, config), inline: true },
            { name: 'Result', value: result.won ? `\u2705 Won ${economyManager.formatMoney(result.winAmount, config)}` : `\u274c Lost ${economyManager.formatMoney(result.betAmount, config)}`, inline: true },
            { name: 'New Balance', value: economyManager.formatMoney(result.newBalance, config), inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleDice(interaction) {
    const betAmount = interaction.options.getInteger('amount');
    const prediction = interaction.options.getInteger('prediction');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    const result = await gamblingManager.playDice(
        interaction.guild.id,
        interaction.user.id,
        betAmount,
        prediction
    );

    await trackGambleAchievements(interaction, result);

    const embed = new EmbedBuilder()
        .setColor(result.won ? '#00FF00' : '#FF0000')
        .setTitle('\ud83c\udfb2 Dice Roll')
        .setDescription(`You predicted **${result.prediction}**!\n\n\ud83c\udfb2 Dice 1: **${result.dice1}**\n\ud83c\udfb2 Dice 2: **${result.dice2}**\n**Total: ${result.total}**`)
        .addFields(
            { name: 'Bet Amount', value: economyManager.formatMoney(result.betAmount, config), inline: true },
            { name: 'Result', value: result.won ? `\u2705 Won ${economyManager.formatMoney(result.winAmount, config)} (${result.multiplier}x)` : `\u274c Lost ${economyManager.formatMoney(result.betAmount, config)}`, inline: true },
            { name: 'New Balance', value: economyManager.formatMoney(result.newBalance, config), inline: true }
        )
        .setFooter({ text: 'Exact prediction pays 5x!' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleSlots(interaction) {
    const betAmount = interaction.options.getInteger('amount');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    const result = await gamblingManager.playSlots(
        interaction.guild.id,
        interaction.user.id,
        betAmount
    );

    await trackGambleAchievements(interaction, result);

    const embed = new EmbedBuilder()
        .setColor(result.won ? '#00FF00' : '#FF0000')
        .setTitle('\ud83c\udfb0 Slot Machine')
        .setDescription(`**[ ${result.slot1} | ${result.slot2} | ${result.slot3} ]**\n\n${result.resultText}`)
        .addFields(
            { name: 'Bet Amount', value: economyManager.formatMoney(result.betAmount, config), inline: true },
            { name: 'Result', value: result.won ? `\u2705 Won ${economyManager.formatMoney(result.winAmount, config)} (${result.multiplier}x)` : `\u274c Lost ${economyManager.formatMoney(result.betAmount, config)}`, inline: true },
            { name: 'New Balance', value: economyManager.formatMoney(result.newBalance, config), inline: true }
        )
        .setFooter({ text: '7\ufe0f\u20e3 Jackpot: 50x | \ud83d\udc8e Diamonds: 20x | \ud83d\udd14 Bells: 10x | Triple: 5x | Double: 2x' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleBlackjack(interaction) {
    const betAmount = interaction.options.getInteger('amount');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    const result = await gamblingManager.playBlackjack(
        interaction.guild.id,
        interaction.user.id,
        betAmount
    );

    await trackGambleAchievements(interaction, result);

    const embed = new EmbedBuilder()
        .setColor(result.won ? '#00FF00' : '#FF0000')
        .setTitle('\ud83c\udccf Blackjack')
        .setDescription(result.resultText)
        .addFields(
            { name: '\ud83d\udc64 Your Hand', value: `Cards: ${result.playerCards.join(', ')}\n**Total: ${result.playerTotal}**`, inline: true },
            { name: '\ud83e\udd35 Dealer Hand', value: `Cards: ${result.dealerCards.join(', ')}\n**Total: ${result.dealerTotal}**`, inline: true }
        )
        .addFields(
            { name: 'Bet Amount', value: economyManager.formatMoney(result.betAmount, config), inline: true },
            { name: 'Result', value: result.won ? `\u2705 Won ${economyManager.formatMoney(result.winAmount, config)}` : `\u274c Lost ${economyManager.formatMoney(result.betAmount, config)}`, inline: true },
            { name: 'New Balance', value: economyManager.formatMoney(result.newBalance, config), inline: true }
        )
        .setFooter({ text: 'Blackjack pays 2.5x | Win pays 2x | Push returns your bet' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleRoulette(interaction) {
    const betAmount = interaction.options.getInteger('amount');
    const betType = interaction.options.getString('bet');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    const result = await gamblingManager.playRoulette(
        interaction.guild.id,
        interaction.user.id,
        betAmount,
        betType
    );

    await trackGambleAchievements(interaction, result);

    const resultText = `${result.colorEmoji} **${result.number}** (${result.color}${result.oddEven ? ', ' + result.oddEven : ''})`;

    const embed = new EmbedBuilder()
        .setColor(result.won ? '#00FF00' : '#FF0000')
        .setTitle('\ud83c\udfa1 Roulette')
        .setDescription(`You bet on **${result.betType}**!\n\nThe wheel landed on...\n${resultText}`)
        .addFields(
            { name: 'Bet Amount', value: economyManager.formatMoney(result.betAmount, config), inline: true },
            { name: 'Result', value: result.won ? `\u2705 Won ${economyManager.formatMoney(result.winAmount, config)} (${result.multiplier}x)` : `\u274c Lost ${economyManager.formatMoney(result.betAmount, config)}`, inline: true },
            { name: 'New Balance', value: economyManager.formatMoney(result.newBalance, config), inline: true }
        )
        .setFooter({ text: 'Green pays 35x! Red/Black/Odd/Even pay 2x!' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleHighLow(interaction) {
    const betAmount = interaction.options.getInteger('amount');
    const guess = interaction.options.getString('guess');
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    const result = await gamblingManager.playHighLow(
        interaction.guild.id,
        interaction.user.id,
        betAmount,
        guess
    );

    await trackGambleAchievements(interaction, result);

    const numberDisplay = result.number <= 50 ? `\ud83d\udfe2 **${result.number}** (Low)` : `\ud83d\udd34 **${result.number}** (High)`;

    const embed = new EmbedBuilder()
        .setColor(result.won ? '#00FF00' : '#FF0000')
        .setTitle('\ud83c\udfb2 High or Low')
        .setDescription(`You guessed **${result.guess}**!\n\nThe number was...\n${numberDisplay}`)
        .addFields(
            { name: 'Bet Amount', value: economyManager.formatMoney(result.betAmount, config), inline: true },
            { name: 'Result', value: result.won ? `\u2705 Won ${economyManager.formatMoney(result.winAmount, config)} (${result.multiplier}x)` : `\u274c Lost ${economyManager.formatMoney(result.betAmount, config)}`, inline: true },
            { name: 'New Balance', value: economyManager.formatMoney(result.newBalance, config), inline: true }
        )
        .setFooter({ text: 'Low: 1-50 | High: 51-100 | Win pays 1.9x' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleStats(interaction) {
    const stats = await gamblingManager.getGamblingStats(interaction.guild.id, interaction.user.id);
    const config = await economyManager.getEconomyConfig(interaction.guild.id);

    if (stats.length === 0) {
        await interaction.reply({
            content: '\u274c You haven\'t played any gambling games yet!',
            ephemeral: true
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle(`${interaction.user.username}'s Gambling Statistics`)
        .setThumbnail(interaction.user.displayAvatarURL());

    let totalGames = 0;
    let totalBet = 0;
    let totalWon = 0;

    const gameEmojis = {
        'coinflip': '\ud83e\ude99',
        'dice': '\ud83c\udfb2',
        'slots': '\ud83c\udfb0',
        'blackjack': '\ud83c\udccf',
        'roulette': '\ud83c\udfa1',
        'highlow': '\ud83c\udfb2'
    };

    for (const stat of stats) {
        totalGames += stat.total_games;
        totalBet += stat.total_bet;
        totalWon += stat.total_won;

        const winRate = ((stat.wins / stat.total_games) * 100).toFixed(1);
        const gameEmoji = gameEmojis[stat.game_type] || '\ud83c\udfae';

        embed.addFields({
            name: `${gameEmoji} ${stat.game_type.charAt(0).toUpperCase() + stat.game_type.slice(1)}`,
            value: `Games: ${stat.total_games} | Wins: ${stat.wins} | Losses: ${stat.losses}\nWin Rate: ${winRate}% | Net: ${economyManager.formatMoney(stat.net_profit, config)}`,
            inline: false
        });
    }

    const totalNetProfit = totalWon - totalBet;
    const overallWinRate = stats.reduce((acc, s) => acc + s.wins, 0) / totalGames * 100;

    embed.addFields({
        name: '\ud83d\udcca Overall Statistics',
        value: `Total Games: ${totalGames}\nTotal Bet: ${economyManager.formatMoney(totalBet, config)}\nTotal Won: ${economyManager.formatMoney(totalWon, config)}\nNet Profit/Loss: ${economyManager.formatMoney(totalNetProfit, config)}\nWin Rate: ${overallWinRate.toFixed(1)}%`,
        inline: false
    });

    await interaction.reply({ embeds: [embed] });
}
