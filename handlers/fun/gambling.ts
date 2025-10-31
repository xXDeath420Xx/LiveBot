import { EmbedBuilder, ChatInputCommandInteraction } from "discord.js";
import db from "../../utils/db";
import logger from "../../utils/logger";

interface EconomyConfig {
    currency_name: string;
    currency_emoji: string;
    max_bet_amount: number;
}

interface UserEconomy {
    guild_id: string;
    user_id: string;
    wallet: number;
    bank: number;
    total_earned: number;
}

function formatMoney(amount: number, config: EconomyConfig): string {
    return `${config.currency_emoji} ${amount.toLocaleString()}`;
}

export async function handleCoinflip(interaction: ChatInputCommandInteraction, config: EconomyConfig): Promise<void> {
    const betAmount = interaction.options.getInteger("amount")!;
    const userChoice = interaction.options.getString("choice")!;

    // Get user economy
    const [[userEconomy]] = await db.execute<UserEconomy[]>(
        "SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?",
        [interaction.guild!.id, interaction.user.id]
    );

    if (!userEconomy) {
        await interaction.reply({
            content: "❌ You don't have an economy account. Use `/economy balance` to create one.",
            ephemeral: true
        });
        return;
    }

    // Validate bet
    if (betAmount > userEconomy.wallet) {
        await interaction.reply({
            content: `❌ You don't have enough ${config.currency_name}! You only have ${formatMoney(userEconomy.wallet, config)}.`,
            ephemeral: true
        });
        return;
    }

    if (betAmount > config.max_bet_amount) {
        await interaction.reply({
            content: `❌ Maximum bet amount is ${formatMoney(config.max_bet_amount, config)}!`,
            ephemeral: true
        });
        return;
    }

    // Flip the coin
    const result = Math.random() < 0.5 ? "heads" : "tails";
    const won = result === userChoice;
    const winAmount = won ? betAmount : 0;
    const netChange = won ? betAmount : -betAmount;

    // Update balance
    await db.execute(
        "UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?",
        [netChange, won ? betAmount : 0, interaction.guild!.id, interaction.user.id]
    );

    // Log transaction
    await db.execute(
        `INSERT INTO gambling_history (guild_id, user_id, game_type, bet_amount, win_amount, result)
         VALUES (?, ?, 'coinflip', ?, ?, ?)`,
        [interaction.guild!.id, interaction.user.id, betAmount, winAmount, result]
    );

    await db.execute(
        `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description)
         VALUES (?, ?, 'gamble', ?, ?, ?, ?)`,
        [
            interaction.guild!.id,
            interaction.user.id,
            netChange,
            userEconomy.wallet,
            userEconomy.wallet + netChange,
            `Coinflip (${result}) - ${won ? "Won" : "Lost"}`
        ]
    );

    const embed = new EmbedBuilder()
        .setColor(won ? "#00FF00" : "#FF0000")
        .setTitle("🪙 Coinflip")
        .setDescription(`You bet on **${userChoice}**!\n\nThe coin landed on... **${result}**!`)
        .addFields(
            { name: "Bet Amount", value: formatMoney(betAmount, config), inline: true },
            { name: "Result", value: won ? `✅ Won ${formatMoney(winAmount, config)}` : `❌ Lost ${formatMoney(betAmount, config)}`, inline: true },
            { name: "New Balance", value: formatMoney(userEconomy.wallet + netChange, config), inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleDice(interaction: ChatInputCommandInteraction, config: EconomyConfig): Promise<void> {
    const betAmount = interaction.options.getInteger("amount")!;
    const prediction = interaction.options.getInteger("prediction")!;

    // Get user economy
    const [[userEconomy]] = await db.execute<UserEconomy[]>(
        "SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?",
        [interaction.guild!.id, interaction.user.id]
    );

    if (!userEconomy) {
        await interaction.reply({
            content: "❌ You don't have an economy account. Use `/economy balance` to create one.",
            ephemeral: true
        });
        return;
    }

    // Validate bet
    if (betAmount > userEconomy.wallet) {
        await interaction.reply({
            content: `❌ You don't have enough ${config.currency_name}! You only have ${formatMoney(userEconomy.wallet, config)}.`,
            ephemeral: true
        });
        return;
    }

    if (betAmount > config.max_bet_amount) {
        await interaction.reply({
            content: `❌ Maximum bet amount is ${formatMoney(config.max_bet_amount, config)}!`,
            ephemeral: true
        });
        return;
    }

    // Roll two dice
    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;
    const total = dice1 + dice2;

    const won = total === prediction;
    const multiplier = won ? 5 : 0; // 5x multiplier for exact prediction
    const winAmount = won ? betAmount * multiplier : 0;
    const netChange = won ? winAmount : -betAmount;

    // Update balance
    await db.execute(
        "UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?",
        [netChange, won ? winAmount : 0, interaction.guild!.id, interaction.user.id]
    );

    // Log transaction
    await db.execute(
        `INSERT INTO gambling_history (guild_id, user_id, game_type, bet_amount, win_amount, result)
         VALUES (?, ?, 'dice', ?, ?, ?)`,
        [interaction.guild!.id, interaction.user.id, betAmount, winAmount, `${dice1}+${dice2}=${total}`]
    );

    await db.execute(
        `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description)
         VALUES (?, ?, 'gamble', ?, ?, ?, ?)`,
        [
            interaction.guild!.id,
            interaction.user.id,
            netChange,
            userEconomy.wallet,
            userEconomy.wallet + netChange,
            `Dice (${total}) - ${won ? "Won" : "Lost"}`
        ]
    );

    const embed = new EmbedBuilder()
        .setColor(won ? "#00FF00" : "#FF0000")
        .setTitle("🎲 Dice Roll")
        .setDescription(`You predicted **${prediction}**!\n\n🎲 Dice 1: **${dice1}**\n🎲 Dice 2: **${dice2}**\n**Total: ${total}**`)
        .addFields(
            { name: "Bet Amount", value: formatMoney(betAmount, config), inline: true },
            { name: "Result", value: won ? `✅ Won ${formatMoney(winAmount, config)} (${multiplier}x)` : `❌ Lost ${formatMoney(betAmount, config)}`, inline: true },
            { name: "New Balance", value: formatMoney(userEconomy.wallet + netChange, config), inline: true }
        )
        .setFooter({ text: "Exact prediction pays 5x!" })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleSlots(interaction: ChatInputCommandInteraction, config: EconomyConfig): Promise<void> {
    const betAmount = interaction.options.getInteger("amount")!;

    // Get user economy
    const [[userEconomy]] = await db.execute<UserEconomy[]>(
        "SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?",
        [interaction.guild!.id, interaction.user.id]
    );

    if (!userEconomy) {
        await interaction.reply({
            content: "❌ You don't have an economy account. Use `/economy balance` to create one.",
            ephemeral: true
        });
        return;
    }

    // Validate bet
    if (betAmount > userEconomy.wallet) {
        await interaction.reply({
            content: `❌ You don't have enough ${config.currency_name}! You only have ${formatMoney(userEconomy.wallet, config)}.`,
            ephemeral: true
        });
        return;
    }

    if (betAmount > config.max_bet_amount) {
        await interaction.reply({
            content: `❌ Maximum bet amount is ${formatMoney(config.max_bet_amount, config)}!`,
            ephemeral: true
        });
        return;
    }

    // Slot symbols with weights
    const symbols = ["🍒", "🍋", "🍊", "🍇", "🔔", "💎", "7️⃣"];
    const weights = [30, 25, 20, 15, 7, 2, 1]; // Higher numbers are more common

    function getRandomSymbol(): string {
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        let random = Math.random() * totalWeight;

        for (let i = 0; i < symbols.length; i++) {
            random -= weights[i];
            if (random <= 0) {
                return symbols[i];
            }
        }
        return symbols[0];
    }

    const slot1 = getRandomSymbol();
    const slot2 = getRandomSymbol();
    const slot3 = getRandomSymbol();

    // Calculate winnings
    let multiplier = 0;
    let resultText = "";

    if (slot1 === slot2 && slot2 === slot3) {
        // All three match
        switch (slot1) {
            case "7️⃣":
                multiplier = 50;
                resultText = "🎰 **JACKPOT!** Three 7s!";
                break;
            case "💎":
                multiplier = 20;
                resultText = "💎 **DIAMONDS!** Three in a row!";
                break;
            case "🔔":
                multiplier = 10;
                resultText = "🔔 **BELLS!** Triple match!";
                break;
            default:
                multiplier = 5;
                resultText = `${slot1} **Triple match!**`;
                break;
        }
    } else if (slot1 === slot2 || slot2 === slot3 || slot1 === slot3) {
        // Two match
        multiplier = 2;
        resultText = "✨ **Two in a row!**";
    } else {
        // No match
        multiplier = 0;
        resultText = "❌ **No match**";
    }

    const won = multiplier > 0;
    const winAmount = won ? betAmount * multiplier : 0;
    const netChange = won ? winAmount - betAmount : -betAmount;

    // Update balance
    await db.execute(
        "UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?",
        [netChange, won ? winAmount : 0, interaction.guild!.id, interaction.user.id]
    );

    // Log transaction
    await db.execute(
        `INSERT INTO gambling_history (guild_id, user_id, game_type, bet_amount, win_amount, result)
         VALUES (?, ?, 'slots', ?, ?, ?)`,
        [interaction.guild!.id, interaction.user.id, betAmount, winAmount, `${slot1}${slot2}${slot3}`]
    );

    await db.execute(
        `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description)
         VALUES (?, ?, 'gamble', ?, ?, ?, ?)`,
        [
            interaction.guild!.id,
            interaction.user.id,
            netChange,
            userEconomy.wallet,
            userEconomy.wallet + netChange,
            `Slots (${slot1}${slot2}${slot3}) - ${won ? "Won" : "Lost"}`
        ]
    );

    const embed = new EmbedBuilder()
        .setColor(won ? "#00FF00" : "#FF0000")
        .setTitle("🎰 Slot Machine")
        .setDescription(`**[ ${slot1} | ${slot2} | ${slot3} ]**\n\n${resultText}`)
        .addFields(
            { name: "Bet Amount", value: formatMoney(betAmount, config), inline: true },
            { name: "Result", value: won ? `✅ Won ${formatMoney(winAmount, config)} (${multiplier}x)` : `❌ Lost ${formatMoney(betAmount, config)}`, inline: true },
            { name: "New Balance", value: formatMoney(userEconomy.wallet + netChange, config), inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleBlackjack(interaction: ChatInputCommandInteraction, config: EconomyConfig): Promise<void> {
    const betAmount = interaction.options.getInteger("amount")!;

    // Get user economy
    const [[userEconomy]] = await db.execute<UserEconomy[]>(
        "SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?",
        [interaction.guild!.id, interaction.user.id]
    );

    if (!userEconomy) {
        await interaction.reply({
            content: "❌ You don't have an economy account. Use `/economy balance` to create one.",
            ephemeral: true
        });
        return;
    }

    // Validate bet
    if (betAmount > userEconomy.wallet) {
        await interaction.reply({
            content: `❌ You don't have enough ${config.currency_name}! You only have ${formatMoney(userEconomy.wallet, config)}.`,
            ephemeral: true
        });
        return;
    }

    if (betAmount > config.max_bet_amount) {
        await interaction.reply({
            content: `❌ Maximum bet amount is ${formatMoney(config.max_bet_amount, config)}!`,
            ephemeral: true
        });
        return;
    }

    // Simple blackjack: draw two cards for player, two for dealer
    const cardValues = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 11]; // 11 = Ace

    function drawCard(): number {
        return cardValues[Math.floor(Math.random() * cardValues.length)];
    }

    function calculateTotal(cards: number[]): number {
        let total = cards.reduce((a, b) => a + b, 0);
        let aces = cards.filter(c => c === 11).length;

        // Convert aces from 11 to 1 if bust
        while (total > 21 && aces > 0) {
            total -= 10;
            aces--;
        }

        return total;
    }

    const playerCards = [drawCard(), drawCard()];
    const dealerCards = [drawCard(), drawCard()];

    const playerTotal = calculateTotal(playerCards);
    const dealerTotal = calculateTotal(dealerCards);

    // Determine winner
    let won = false;
    let multiplier = 0;
    let resultText = "";

    if (playerTotal === 21) {
        won = true;
        multiplier = 2.5;
        resultText = "🎉 **BLACKJACK!** You win!";
    } else if (playerTotal > 21) {
        won = false;
        resultText = "💥 **BUST!** You lose!";
    } else if (dealerTotal > 21) {
        won = true;
        multiplier = 2;
        resultText = "🎊 **Dealer busts!** You win!";
    } else if (playerTotal > dealerTotal) {
        won = true;
        multiplier = 2;
        resultText = "✅ **You win!**";
    } else if (playerTotal < dealerTotal) {
        won = false;
        resultText = "❌ **Dealer wins!** You lose!";
    } else {
        // Push (tie)
        won = true;
        multiplier = 1;
        resultText = "🤝 **Push!** It's a tie!";
    }

    const winAmount = won ? Math.floor(betAmount * multiplier) : 0;
    const netChange = won ? winAmount - betAmount : -betAmount;

    // Update balance
    await db.execute(
        "UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?",
        [netChange, won ? winAmount : 0, interaction.guild!.id, interaction.user.id]
    );

    // Log transaction
    await db.execute(
        `INSERT INTO gambling_history (guild_id, user_id, game_type, bet_amount, win_amount, result)
         VALUES (?, ?, 'blackjack', ?, ?, ?)`,
        [interaction.guild!.id, interaction.user.id, betAmount, winAmount, `P:${playerTotal} D:${dealerTotal}`]
    );

    await db.execute(
        `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description)
         VALUES (?, ?, 'gamble', ?, ?, ?, ?)`,
        [
            interaction.guild!.id,
            interaction.user.id,
            netChange,
            userEconomy.wallet,
            userEconomy.wallet + netChange,
            `Blackjack (${playerTotal} vs ${dealerTotal}) - ${won ? "Won" : "Lost"}`
        ]
    );

    const embed = new EmbedBuilder()
        .setColor(won ? "#00FF00" : "#FF0000")
        .setTitle("🃏 Blackjack")
        .setDescription(resultText)
        .addFields(
            { name: "👤 Your Hand", value: `Cards: ${playerCards.join(", ")}\n**Total: ${playerTotal}**`, inline: true },
            { name: "🤵 Dealer Hand", value: `Cards: ${dealerCards.join(", ")}\n**Total: ${dealerTotal}**`, inline: true }
        )
        .addFields(
            { name: "Bet Amount", value: formatMoney(betAmount, config), inline: true },
            { name: "Result", value: won ? `✅ Won ${formatMoney(winAmount, config)}` : `❌ Lost ${formatMoney(betAmount, config)}`, inline: true },
            { name: "New Balance", value: formatMoney(userEconomy.wallet + netChange, config), inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export async function handleRoulette(interaction: ChatInputCommandInteraction, config: EconomyConfig): Promise<void> {
    const betAmount = interaction.options.getInteger("amount")!;
    const betType = interaction.options.getString("bet")!;

    // Get user economy
    const [[userEconomy]] = await db.execute<UserEconomy[]>(
        "SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?",
        [interaction.guild!.id, interaction.user.id]
    );

    if (!userEconomy) {
        await interaction.reply({
            content: "❌ You don't have an economy account. Use `/economy balance` to create one.",
            ephemeral: true
        });
        return;
    }

    // Validate bet
    if (betAmount > userEconomy.wallet) {
        await interaction.reply({
            content: `❌ You don't have enough ${config.currency_name}! You only have ${formatMoney(userEconomy.wallet, config)}.`,
            ephemeral: true
        });
        return;
    }

    if (betAmount > config.max_bet_amount) {
        await interaction.reply({
            content: `❌ Maximum bet amount is ${formatMoney(config.max_bet_amount, config)}!`,
            ephemeral: true
        });
        return;
    }

    // Spin the wheel (0-36, with 0 being green)
    const number = Math.floor(Math.random() * 37);
    const isRed = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(number);
    const isBlack = number !== 0 && !isRed;
    const isGreen = number === 0;
    const isOdd = number % 2 !== 0 && number !== 0;
    const isEven = number % 2 === 0 && number !== 0;

    // Determine if player won
    let won = false;
    let multiplier = 0;

    switch (betType) {
        case "red":
            won = isRed;
            multiplier = 2;
            break;
        case "black":
            won = isBlack;
            multiplier = 2;
            break;
        case "green":
            won = isGreen;
            multiplier = 35;
            break;
        case "odd":
            won = isOdd;
            multiplier = 2;
            break;
        case "even":
            won = isEven;
            multiplier = 2;
            break;
    }

    const winAmount = won ? betAmount * multiplier : 0;
    const netChange = won ? winAmount - betAmount : -betAmount;

    // Update balance
    await db.execute(
        "UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?",
        [netChange, won ? winAmount : 0, interaction.guild!.id, interaction.user.id]
    );

    // Log transaction
    await db.execute(
        `INSERT INTO gambling_history (guild_id, user_id, game_type, bet_amount, win_amount, result)
         VALUES (?, ?, 'roulette', ?, ?, ?)`,
        [interaction.guild!.id, interaction.user.id, betAmount, winAmount, `${number} (${betType})`]
    );

    await db.execute(
        `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description)
         VALUES (?, ?, 'gamble', ?, ?, ?, ?)`,
        [
            interaction.guild!.id,
            interaction.user.id,
            netChange,
            userEconomy.wallet,
            userEconomy.wallet + netChange,
            `Roulette (${number}) - ${won ? "Won" : "Lost"}`
        ]
    );

    const colorEmoji = isGreen ? "🟢" : isRed ? "🔴" : "⚫";
    const resultText = `${colorEmoji} **${number}** (${isGreen ? "Green" : isRed ? "Red" : "Black"}${isOdd ? ", Odd" : isEven ? ", Even" : ""})`;

    const embed = new EmbedBuilder()
        .setColor(won ? "#00FF00" : "#FF0000")
        .setTitle("🎡 Roulette")
        .setDescription(`You bet on **${betType}**!\n\nThe wheel landed on...\n${resultText}`)
        .addFields(
            { name: "Bet Amount", value: formatMoney(betAmount, config), inline: true },
            { name: "Result", value: won ? `✅ Won ${formatMoney(winAmount, config)} (${multiplier}x)` : `❌ Lost ${formatMoney(betAmount, config)}`, inline: true },
            { name: "New Balance", value: formatMoney(userEconomy.wallet + netChange, config), inline: true }
        )
        .setFooter({ text: "Green pays 35x! Red/Black/Odd/Even pay 2x!" })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

module.exports = {
    handleCoinflip,
    handleDice,
    handleSlots,
    handleBlackjack,
    handleRoulette
};