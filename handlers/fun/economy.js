"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleBalance = handleBalance;
exports.handleDaily = handleDaily;
exports.handleWeekly = handleWeekly;
exports.handleWork = handleWork;
exports.handleCrime = handleCrime;
exports.handleRob = handleRob;
exports.handleDeposit = handleDeposit;
exports.handleWithdraw = handleWithdraw;
exports.handleTransfer = handleTransfer;
exports.handleLeaderboard = handleLeaderboard;
exports.handleTransactions = handleTransactions;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../../utils/db"));
// ============================================
// HELPER FUNCTIONS
// ============================================
async function getOrCreateUserEconomy(guildId, userId, config) {
    const [[user]] = await db_1.default.execute('SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    if (user)
        return user;
    // Create new economy profile
    await db_1.default.execute(`INSERT INTO user_economy (guild_id, user_id, wallet, bank, bank_capacity)
         VALUES (?, ?, ?, 0, ?)`, [guildId, userId, config.starting_balance, config.starting_balance * 10]);
    const [[newUser]] = await db_1.default.execute('SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return newUser;
}
async function logTransaction(guildId, userId, type, amount, balanceBefore, balanceAfter, description = null, relatedUserId = null, relatedItemId = null) {
    await db_1.default.execute(`INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description, related_user_id, related_item_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [guildId, userId, type, amount, balanceBefore, balanceAfter, description, relatedUserId, relatedItemId]);
}
function formatMoney(amount, config) {
    return `${config.currency_emoji} ${amount.toLocaleString()} ${config.currency_name}`;
}
// ============================================
// COMMAND HANDLERS
// ============================================
async function handleBalance(interaction, config) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const economy = await getOrCreateUserEconomy(interaction.guild.id, targetUser.id, config);
    const netWorth = economy.wallet + economy.bank;
    const bankUsage = ((economy.bank / economy.bank_capacity) * 100).toFixed(1);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`${targetUser.username}'s Balance`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields({ name: '💵 Wallet', value: formatMoney(economy.wallet, config), inline: true }, { name: '🏦 Bank', value: `${formatMoney(economy.bank, config)} / ${formatMoney(economy.bank_capacity, config)} (${bankUsage}%)`, inline: true }, { name: '💰 Net Worth', value: formatMoney(netWorth, config), inline: true });
    if (economy.daily_streak > 0) {
        embed.addFields({ name: '🔥 Daily Streak', value: `${economy.daily_streak} days`, inline: true });
    }
    if (economy.work_streak > 0) {
        embed.addFields({ name: '💼 Work Streak', value: `${economy.work_streak} times`, inline: true });
    }
    if (economy.prestige_level > 0) {
        embed.addFields({ name: '⭐ Prestige', value: `Level ${economy.prestige_level}`, inline: true });
    }
    await interaction.reply({ embeds: [embed] });
}
async function handleDaily(interaction, config) {
    const economy = await getOrCreateUserEconomy(interaction.guild.id, interaction.user.id, config);
    // Check cooldown
    if (economy.last_daily) {
        const lastDaily = new Date(economy.last_daily);
        const now = new Date();
        const timeDiff = now.getTime() - lastDaily.getTime();
        const hoursSince = timeDiff / (1000 * 60 * 60);
        if (hoursSince < 24) {
            const hoursLeft = Math.ceil(24 - hoursSince);
            await interaction.reply({
                content: `⏰ You already claimed your daily reward! Come back in ${hoursLeft} hours.`,
                ephemeral: true
            });
            return;
        }
        // Check if streak continues (within 48 hours)
        if (hoursSince <= 48) {
            await db_1.default.execute('UPDATE user_economy SET daily_streak = daily_streak + 1 WHERE guild_id = ? AND user_id = ?', [interaction.guild.id, interaction.user.id]);
            economy.daily_streak += 1;
        }
        else {
            // Streak broken
            await db_1.default.execute('UPDATE user_economy SET daily_streak = 1 WHERE guild_id = ? AND user_id = ?', [interaction.guild.id, interaction.user.id]);
            economy.daily_streak = 1;
        }
    }
    else {
        // First daily
        economy.daily_streak = 1;
    }
    // Calculate reward with streak bonus
    const baseAmount = config.daily_amount;
    const streakBonus = Math.min(economy.daily_streak * 50, 1000); // Max 1000 bonus
    const totalAmount = baseAmount + streakBonus;
    // Add to wallet
    await db_1.default.execute('UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ?, last_daily = NOW() WHERE guild_id = ? AND user_id = ?', [totalAmount, totalAmount, interaction.guild.id, interaction.user.id]);
    await logTransaction(interaction.guild.id, interaction.user.id, 'daily', totalAmount, economy.wallet, economy.wallet + totalAmount, `Daily reward with ${economy.daily_streak}x streak`);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('💵 Daily Reward Claimed!')
        .setDescription(`You received ${formatMoney(totalAmount, config)}!`)
        .addFields({ name: 'Base Amount', value: formatMoney(baseAmount, config), inline: true }, { name: 'Streak Bonus', value: formatMoney(streakBonus, config), inline: true }, { name: '🔥 Current Streak', value: `${economy.daily_streak} days`, inline: true })
        .setFooter({ text: 'Come back in 24 hours for your next reward!' });
    await interaction.reply({ embeds: [embed] });
}
async function handleWeekly(interaction, config) {
    const economy = await getOrCreateUserEconomy(interaction.guild.id, interaction.user.id, config);
    // Check cooldown (7 days)
    if (economy.last_weekly) {
        const lastWeekly = new Date(economy.last_weekly);
        const now = new Date();
        const daysSince = (now.getTime() - lastWeekly.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince < 7) {
            const daysLeft = Math.ceil(7 - daysSince);
            await interaction.reply({
                content: `⏰ You already claimed your weekly reward! Come back in ${daysLeft} days.`,
                ephemeral: true
            });
            return;
        }
    }
    const amount = config.weekly_amount;
    await db_1.default.execute('UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ?, last_weekly = NOW() WHERE guild_id = ? AND user_id = ?', [amount, amount, interaction.guild.id, interaction.user.id]);
    await logTransaction(interaction.guild.id, interaction.user.id, 'weekly', amount, economy.wallet, economy.wallet + amount, 'Weekly reward');
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('💰 Weekly Reward Claimed!')
        .setDescription(`You received ${formatMoney(amount, config)}!`)
        .setFooter({ text: 'Come back in 7 days for your next reward!' });
    await interaction.reply({ embeds: [embed] });
}
async function handleWork(interaction, config) {
    const economy = await getOrCreateUserEconomy(interaction.guild.id, interaction.user.id, config);
    // Check cooldown
    if (economy.last_work) {
        const lastWork = new Date(economy.last_work);
        const now = new Date();
        const secondsSince = (now.getTime() - lastWork.getTime()) / 1000;
        if (secondsSince < config.work_cooldown) {
            const secondsLeft = Math.ceil(config.work_cooldown - secondsSince);
            const minutesLeft = Math.ceil(secondsLeft / 60);
            await interaction.reply({
                content: `⏰ You're tired! Rest for ${minutesLeft} more minutes before working again.`,
                ephemeral: true
            });
            return;
        }
    }
    // Random work scenarios
    const jobs = [
        { name: 'Pizza Delivery', emoji: '🍕' },
        { name: 'Dog Walking', emoji: '🐕' },
        { name: 'Car Wash', emoji: '🚗' },
        { name: 'Lawn Mowing', emoji: '🌿' },
        { name: 'Grocery Bagging', emoji: '🛒' },
        { name: 'Package Delivery', emoji: '📦' },
        { name: 'Babysitting', emoji: '👶' },
        { name: 'Tutoring', emoji: '📚' }
    ];
    const job = jobs[Math.floor(Math.random() * jobs.length)];
    const amount = Math.floor(Math.random() * (config.work_max_amount - config.work_min_amount + 1)) + config.work_min_amount;
    // Work streak bonus
    const streakBonus = Math.min(economy.work_streak * 10, 500);
    const totalAmount = amount + streakBonus;
    await db_1.default.execute('UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ?, last_work = NOW(), work_streak = work_streak + 1 WHERE guild_id = ? AND user_id = ?', [totalAmount, totalAmount, interaction.guild.id, interaction.user.id]);
    await logTransaction(interaction.guild.id, interaction.user.id, 'work', totalAmount, economy.wallet, economy.wallet + totalAmount, `Worked as ${job.name}`);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(`${job.emoji} ${job.name}`)
        .setDescription(`You worked hard and earned ${formatMoney(totalAmount, config)}!`)
        .addFields({ name: 'Base Pay', value: formatMoney(amount, config), inline: true }, { name: 'Streak Bonus', value: formatMoney(streakBonus, config), inline: true }, { name: '💼 Work Streak', value: `${economy.work_streak + 1} times`, inline: true });
    await interaction.reply({ embeds: [embed] });
}
async function handleCrime(interaction, config) {
    const economy = await getOrCreateUserEconomy(interaction.guild.id, interaction.user.id, config);
    // Check cooldown (30 minutes)
    if (economy.last_crime) {
        const lastCrime = new Date(economy.last_crime);
        const now = new Date();
        const minutesSince = (now.getTime() - lastCrime.getTime()) / (1000 * 60);
        if (minutesSince < 30) {
            const minutesLeft = Math.ceil(30 - minutesSince);
            await interaction.reply({
                content: `⏰ The heat is still on! Wait ${minutesLeft} more minutes before committing another crime.`,
                ephemeral: true
            });
            return;
        }
    }
    const success = Math.random() < config.crime_success_rate;
    const crimes = [
        { name: 'Robbed a bank', emoji: '🏦' },
        { name: 'Stole a car', emoji: '🚗' },
        { name: 'Pickpocketed someone', emoji: '👛' },
        { name: 'Sold contraband', emoji: '📦' },
        { name: 'Hacked a system', emoji: '💻' }
    ];
    const crime = crimes[Math.floor(Math.random() * crimes.length)];
    const amount = Math.floor(Math.random() * (config.crime_max_amount - config.crime_min_amount + 1)) + config.crime_min_amount;
    if (success) {
        await db_1.default.execute('UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ?, last_crime = NOW() WHERE guild_id = ? AND user_id = ?', [amount, amount, interaction.guild.id, interaction.user.id]);
        await logTransaction(interaction.guild.id, interaction.user.id, 'crime', amount, economy.wallet, economy.wallet + amount, `Successfully ${crime.name.toLowerCase()}`);
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#00FF00')
            .setTitle(`${crime.emoji} Crime Successful!`)
            .setDescription(`You ${crime.name.toLowerCase()} and got away with ${formatMoney(amount, config)}!`);
        await interaction.reply({ embeds: [embed] });
    }
    else {
        const fine = Math.floor(amount * config.crime_fine_multiplier);
        const actualFine = Math.min(fine, economy.wallet); // Can't take more than they have
        await db_1.default.execute('UPDATE user_economy SET wallet = wallet - ?, last_crime = NOW() WHERE guild_id = ? AND user_id = ?', [actualFine, interaction.guild.id, interaction.user.id]);
        await logTransaction(interaction.guild.id, interaction.user.id, 'fine', -actualFine, economy.wallet, economy.wallet - actualFine, `Caught trying to ${crime.name.toLowerCase()}`);
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('🚔 Busted!')
            .setDescription(`You got caught ${crime.name.toLowerCase()} and were fined ${formatMoney(actualFine, config)}!`);
        await interaction.reply({ embeds: [embed] });
    }
}
async function handleRob(interaction, config) {
    const target = interaction.options.getUser('user');
    if (target.bot) {
        await interaction.reply({ content: '❌ You cannot rob bots!', ephemeral: true });
        return;
    }
    if (target.id === interaction.user.id) {
        await interaction.reply({ content: '❌ You cannot rob yourself!', ephemeral: true });
        return;
    }
    const robberEconomy = await getOrCreateUserEconomy(interaction.guild.id, interaction.user.id, config);
    const targetEconomy = await getOrCreateUserEconomy(interaction.guild.id, target.id, config);
    // Check robber's cooldown
    if (robberEconomy.last_rob) {
        const lastRob = new Date(robberEconomy.last_rob);
        const now = new Date();
        const hoursSince = (now.getTime() - lastRob.getTime()) / (1000 * 60 * 60);
        if (hoursSince < 1) {
            const minutesLeft = Math.ceil((1 - hoursSince) * 60);
            await interaction.reply({
                content: `⏰ You need to wait ${minutesLeft} more minutes before robbing again!`,
                ephemeral: true
            });
            return;
        }
    }
    // Target must have at least 500 in wallet
    if (targetEconomy.wallet < 500) {
        await interaction.reply({
            content: `❌ ${target.username} doesn't have enough money in their wallet to rob! (Minimum: ${formatMoney(500, config)})`,
            ephemeral: true
        });
        return;
    }
    const success = Math.random() < config.rob_success_rate;
    if (success) {
        const maxSteal = Math.min(targetEconomy.wallet, config.rob_max_amount);
        const minSteal = Math.min(config.rob_min_amount, maxSteal);
        const stolenAmount = Math.floor(Math.random() * (maxSteal - minSteal + 1)) + minSteal;
        // Transfer money
        await db_1.default.execute('UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ?, last_rob = NOW() WHERE guild_id = ? AND user_id = ?', [stolenAmount, stolenAmount, interaction.guild.id, interaction.user.id]);
        await db_1.default.execute('UPDATE user_economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ?', [stolenAmount, interaction.guild.id, target.id]);
        await logTransaction(interaction.guild.id, interaction.user.id, 'rob', stolenAmount, robberEconomy.wallet, robberEconomy.wallet + stolenAmount, `Successfully robbed ${target.username}`, target.id);
        await logTransaction(interaction.guild.id, target.id, 'rob', -stolenAmount, targetEconomy.wallet, targetEconomy.wallet - stolenAmount, `Robbed by ${interaction.user.username}`, interaction.user.id);
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('💰 Rob Successful!')
            .setDescription(`You successfully robbed ${target.username} and stole ${formatMoney(stolenAmount, config)}!`);
        await interaction.reply({ embeds: [embed] });
    }
    else {
        const fine = config.rob_fine_amount;
        const actualFine = Math.min(fine, robberEconomy.wallet);
        await db_1.default.execute('UPDATE user_economy SET wallet = wallet - ?, last_rob = NOW() WHERE guild_id = ? AND user_id = ?', [actualFine, interaction.guild.id, interaction.user.id]);
        await logTransaction(interaction.guild.id, interaction.user.id, 'fine', -actualFine, robberEconomy.wallet, robberEconomy.wallet - actualFine, `Failed to rob ${target.username}`, target.id);
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('🚔 Rob Failed!')
            .setDescription(`You got caught trying to rob ${target.username} and were fined ${formatMoney(actualFine, config)}!`);
        await interaction.reply({ embeds: [embed] });
    }
}
async function handleDeposit(interaction, config) {
    const amount = interaction.options.getInteger('amount');
    const economy = await getOrCreateUserEconomy(interaction.guild.id, interaction.user.id, config);
    if (amount > economy.wallet) {
        await interaction.reply({
            content: `❌ You don't have ${formatMoney(amount, config)} in your wallet!`,
            ephemeral: true
        });
        return;
    }
    const spaceInBank = economy.bank_capacity - economy.bank;
    if (amount > spaceInBank) {
        await interaction.reply({
            content: `❌ Your bank only has space for ${formatMoney(spaceInBank, config)} more! Upgrade your bank capacity.`,
            ephemeral: true
        });
        return;
    }
    await db_1.default.execute('UPDATE user_economy SET wallet = wallet - ?, bank = bank + ? WHERE guild_id = ? AND user_id = ?', [amount, amount, interaction.guild.id, interaction.user.id]);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('🏦 Deposit Successful')
        .setDescription(`Deposited ${formatMoney(amount, config)} into your bank!`)
        .addFields({ name: '💵 New Wallet Balance', value: formatMoney(economy.wallet - amount, config), inline: true }, { name: '🏦 New Bank Balance', value: formatMoney(economy.bank + amount, config), inline: true });
    await interaction.reply({ embeds: [embed] });
}
async function handleWithdraw(interaction, config) {
    const amount = interaction.options.getInteger('amount');
    const economy = await getOrCreateUserEconomy(interaction.guild.id, interaction.user.id, config);
    if (amount > economy.bank) {
        await interaction.reply({
            content: `❌ You don't have ${formatMoney(amount, config)} in your bank!`,
            ephemeral: true
        });
        return;
    }
    await db_1.default.execute('UPDATE user_economy SET wallet = wallet + ?, bank = bank - ? WHERE guild_id = ? AND user_id = ?', [amount, amount, interaction.guild.id, interaction.user.id]);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('🏦 Withdrawal Successful')
        .setDescription(`Withdrew ${formatMoney(amount, config)} from your bank!`)
        .addFields({ name: '💵 New Wallet Balance', value: formatMoney(economy.wallet + amount, config), inline: true }, { name: '🏦 New Bank Balance', value: formatMoney(economy.bank - amount, config), inline: true });
    await interaction.reply({ embeds: [embed] });
}
async function handleTransfer(interaction, config) {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (target.bot) {
        await interaction.reply({ content: '❌ You cannot transfer money to bots!', ephemeral: true });
        return;
    }
    if (target.id === interaction.user.id) {
        await interaction.reply({ content: '❌ You cannot transfer money to yourself!', ephemeral: true });
        return;
    }
    if (!config.allow_gifting) {
        await interaction.reply({ content: '❌ Transfers are disabled in this server!', ephemeral: true });
        return;
    }
    const senderEconomy = await getOrCreateUserEconomy(interaction.guild.id, interaction.user.id, config);
    if (amount > senderEconomy.wallet) {
        await interaction.reply({
            content: `❌ You don't have ${formatMoney(amount, config)} in your wallet!`,
            ephemeral: true
        });
        return;
    }
    const targetEconomy = await getOrCreateUserEconomy(interaction.guild.id, target.id, config);
    // Transfer money
    await db_1.default.execute('UPDATE user_economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ?', [amount, interaction.guild.id, interaction.user.id]);
    await db_1.default.execute('UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?', [amount, amount, interaction.guild.id, target.id]);
    await logTransaction(interaction.guild.id, interaction.user.id, 'transfer', -amount, senderEconomy.wallet, senderEconomy.wallet - amount, `Transferred to ${target.username}`, target.id);
    await logTransaction(interaction.guild.id, target.id, 'transfer', amount, targetEconomy.wallet, targetEconomy.wallet + amount, `Received from ${interaction.user.username}`, interaction.user.id);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('💸 Transfer Successful')
        .setDescription(`Transferred ${formatMoney(amount, config)} to ${target.username}!`);
    await interaction.reply({ embeds: [embed] });
}
async function handleLeaderboard(interaction, config) {
    const [rows] = await db_1.default.execute(`SELECT user_id, wallet, bank, (wallet + bank) as net_worth
         FROM user_economy
         WHERE guild_id = ?
         ORDER BY net_worth DESC
         LIMIT 10`, [interaction.guild.id]);
    if (rows.length === 0) {
        await interaction.reply({ content: '❌ No economy data available yet!', ephemeral: true });
        return;
    }
    let description = '';
    for (let i = 0; i < rows.length; i++) {
        const user = await interaction.client.users.fetch(rows[i].user_id).catch(() => null);
        const username = user ? user.username : 'Unknown User';
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        description += `${medal} **${username}** - ${formatMoney(rows[i].net_worth, config)}\n`;
    }
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('💰 Richest Users')
        .setDescription(description)
        .setFooter({ text: `Currency: ${config.currency_name}` });
    await interaction.reply({ embeds: [embed] });
}
async function handleTransactions(interaction, config) {
    const limit = interaction.options.getInteger('limit') || 10;
    const [rows] = await db_1.default.execute(`SELECT * FROM economy_transactions
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`, [interaction.guild.id, interaction.user.id, limit]);
    if (rows.length === 0) {
        await interaction.reply({ content: '❌ No transactions found!', ephemeral: true });
        return;
    }
    let description = '';
    for (const tx of rows) {
        const typeEmojis = {
            'daily': '💵',
            'weekly': '💰',
            'work': '💼',
            'crime': '🔫',
            'rob': '💰',
            'fine': '🚔',
            'shop_buy': '🛒',
            'shop_sell': '💸',
            'transfer': '💸',
            'reward': '🎁'
        };
        const typeEmoji = typeEmojis[tx.transaction_type] || '📝';
        const sign = tx.amount >= 0 ? '+' : '';
        const date = new Date(tx.created_at).toLocaleDateString();
        description += `${typeEmoji} ${sign}${formatMoney(tx.amount, config)} - ${tx.description || tx.transaction_type} (${date})\n`;
    }
    const embed = new discord_js_1.EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('📊 Recent Transactions')
        .setDescription(description)
        .setFooter({ text: `Showing last ${rows.length} transactions` });
    await interaction.reply({ embeds: [embed], ephemeral: true });
}
module.exports = {
    handleBalance,
    handleDaily,
    handleWeekly,
    handleWork,
    handleCrime,
    handleRob,
    handleDeposit,
    handleWithdraw,
    handleTransfer,
    handleLeaderboard,
    handleTransactions
};
