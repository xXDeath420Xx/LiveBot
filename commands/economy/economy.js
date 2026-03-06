import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import * as earnHandlers from './economy-earn-handler.js';
import * as bankHandlers from './economy-bank-handler.js';
import * as socialHandlers from './economy-social-handler.js';
import * as gambleHandlers from './economy-gamble-handler.js';
import * as shopHandlers from './economy-shop-handler.js';
import * as petHandlers from './economy-pet-handler.js';

const { PET_TYPES } = petHandlers;

export default {
    category: 'economy',
    data: new SlashCommandBuilder()
        .setName('economy')
        .setDescription('Economy system - earn, bank, gamble, shop, and pets')

        // ── Earn group ──
        .addSubcommandGroup(group =>
            group
                .setName('earn')
                .setDescription('Earn money through rewards and work')
                .addSubcommand(sub =>
                    sub.setName('daily')
                        .setDescription('Claim your daily reward')
                )
                .addSubcommand(sub =>
                    sub.setName('weekly')
                        .setDescription('Claim your weekly reward')
                )
                .addSubcommand(sub =>
                    sub.setName('work')
                        .setDescription('Work for money')
                )
                .addSubcommand(sub =>
                    sub.setName('crime')
                        .setDescription('Commit a crime for money (risky!)')
                )
        )

        // ── Bank group ──
        .addSubcommandGroup(group =>
            group
                .setName('bank')
                .setDescription('Check balance, deposit, withdraw, and transfer')
                .addSubcommand(sub =>
                    sub.setName('balance')
                        .setDescription('Check your or another user\'s balance')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('The user to check (leave empty for yourself)')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('deposit')
                        .setDescription('Deposit money into your bank')
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to deposit').setRequired(true).setMinValue(1)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('withdraw')
                        .setDescription('Withdraw money from your bank')
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to withdraw').setRequired(true).setMinValue(1)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('transfer')
                        .setDescription('Transfer money to another user')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('The user to send money to').setRequired(true)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to transfer').setRequired(true).setMinValue(1)
                        )
                )
        )

        // ── Social group ──
        .addSubcommandGroup(group =>
            group
                .setName('social')
                .setDescription('Rob users, leaderboard, transactions, and admin tools')
                .addSubcommand(sub =>
                    sub.setName('rob')
                        .setDescription('Rob another user (risky!)')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('The user to rob').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('leaderboard')
                        .setDescription('View the richest users in the server')
                )
                .addSubcommand(sub =>
                    sub.setName('transactions')
                        .setDescription('View your recent transactions')
                        .addIntegerOption(opt =>
                            opt.setName('limit').setDescription('Number of transactions to show (1-50)').setMinValue(1).setMaxValue(50)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('give')
                        .setDescription('Give currency to a user (Admin only)')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('The user to give currency to').setRequired(true)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to give').setRequired(true).setMinValue(1)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('remove')
                        .setDescription('Remove currency from a user (Admin only)')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('The user to remove currency from').setRequired(true)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to remove').setRequired(true).setMinValue(1)
                        )
                )
        )

        // ── Gamble group ──
        .addSubcommandGroup(group =>
            group
                .setName('gamble')
                .setDescription('Gambling games - coinflip, dice, slots, blackjack, roulette')
                .addSubcommand(sub =>
                    sub.setName('coinflip')
                        .setDescription('Flip a coin and bet on heads or tails')
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
                        )
                        .addStringOption(opt =>
                            opt.setName('choice').setDescription('Your choice').setRequired(true)
                                .addChoices(
                                    { name: 'Heads', value: 'heads' },
                                    { name: 'Tails', value: 'tails' }
                                )
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('dice')
                        .setDescription('Roll two dice and predict the total')
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('prediction').setDescription('Predict the total (2-12)').setRequired(true).setMinValue(2).setMaxValue(12)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('slots')
                        .setDescription('Play the slot machine')
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('blackjack')
                        .setDescription('Play blackjack against the dealer')
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('roulette')
                        .setDescription('Spin the roulette wheel')
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
                        )
                        .addStringOption(opt =>
                            opt.setName('bet').setDescription('Your bet').setRequired(true)
                                .addChoices(
                                    { name: 'Red', value: 'red' },
                                    { name: 'Black', value: 'black' },
                                    { name: 'Green (0)', value: 'green' },
                                    { name: 'Odd', value: 'odd' },
                                    { name: 'Even', value: 'even' }
                                )
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('highlow')
                        .setDescription('Guess if the number will be high (51-100) or low (1-50)')
                        .addIntegerOption(opt =>
                            opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)
                        )
                        .addStringOption(opt =>
                            opt.setName('guess').setDescription('Your guess').setRequired(true)
                                .addChoices(
                                    { name: 'High (51-100)', value: 'high' },
                                    { name: 'Low (1-50)', value: 'low' }
                                )
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('stats')
                        .setDescription('View your gambling statistics')
                )
        )

        // ── Shop group ──
        .addSubcommandGroup(group =>
            group
                .setName('shop')
                .setDescription('Browse, buy, sell items and manage inventory')
                .addSubcommand(sub =>
                    sub.setName('browse')
                        .setDescription('Browse available items in the shop')
                        .addStringOption(opt =>
                            opt.setName('category').setDescription('Filter by category')
                                .addChoices(
                                    { name: 'All Items', value: 'all' },
                                    { name: 'Roles', value: 'role' },
                                    { name: 'Consumables', value: 'consumable' },
                                    { name: 'Collectibles', value: 'collectible' },
                                    { name: 'Tools', value: 'tool' },
                                    { name: 'Decorations', value: 'decoration' }
                                )
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('buy')
                        .setDescription('Purchase an item from the shop')
                        .addIntegerOption(opt =>
                            opt.setName('item_id').setDescription('The ID of the item to purchase').setRequired(true).setMinValue(1)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('quantity').setDescription('Quantity to purchase (default: 1)').setMinValue(1).setMaxValue(100)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('sell')
                        .setDescription('Sell an item back to the shop')
                        .addIntegerOption(opt =>
                            opt.setName('item_id').setDescription('The ID of the item to sell').setRequired(true).setMinValue(1)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('quantity').setDescription('Quantity to sell (default: 1)').setMinValue(1).setMaxValue(100)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('inventory')
                        .setDescription('View your or another user\'s inventory')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('The user to check (leave empty for yourself)')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('info')
                        .setDescription('View detailed information about an item')
                        .addIntegerOption(opt =>
                            opt.setName('item_id').setDescription('The ID of the item').setRequired(true).setMinValue(1)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('use')
                        .setDescription('Use a consumable item')
                        .addIntegerOption(opt =>
                            opt.setName('item_id').setDescription('The ID of the item to use').setRequired(true).setMinValue(1)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('create')
                        .setDescription('Create a new shop item (Admin only)')
                        .addStringOption(opt =>
                            opt.setName('name').setDescription('Item name').setRequired(true)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('price').setDescription('Item price').setRequired(true).setMinValue(1)
                        )
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('Item type').setRequired(true)
                                .addChoices(
                                    { name: 'Role', value: 'role' },
                                    { name: 'Consumable', value: 'consumable' },
                                    { name: 'Collectible', value: 'collectible' },
                                    { name: 'Tool', value: 'tool' },
                                    { name: 'Decoration', value: 'decoration' }
                                )
                        )
                        .addStringOption(opt =>
                            opt.setName('description').setDescription('Item description')
                        )
                        .addStringOption(opt =>
                            opt.setName('emoji').setDescription('Item emoji')
                        )
                        .addIntegerOption(opt =>
                            opt.setName('stock').setDescription('Stock amount (-1 for unlimited)').setMinValue(-1)
                        )
                        .addRoleOption(opt =>
                            opt.setName('role').setDescription('Role to grant (for role items)')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('delete')
                        .setDescription('Delete a shop item (Admin only)')
                        .addIntegerOption(opt =>
                            opt.setName('item_id').setDescription('The ID of the item to delete').setRequired(true).setMinValue(1)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('edit')
                        .setDescription('Edit a shop item (Admin only)')
                        .addIntegerOption(opt =>
                            opt.setName('item_id').setDescription('The ID of the item to edit').setRequired(true).setMinValue(1)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('price').setDescription('New price').setMinValue(1)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('stock').setDescription('New stock amount (-1 for unlimited)').setMinValue(-1)
                        )
                        .addStringOption(opt =>
                            opt.setName('description').setDescription('New description')
                        )
                )
        )

        // ── Pet group ──
        .addSubcommandGroup(group =>
            group
                .setName('pet')
                .setDescription('Virtual pet system - adopt, care for, and play with pets')
                .addSubcommand(sub =>
                    sub.setName('adopt')
                        .setDescription('Adopt a new pet')
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('Pet type').setRequired(true)
                                .addChoices(
                                    ...PET_TYPES.map(type => ({ name: type.charAt(0).toUpperCase() + type.slice(1), value: type }))
                                )
                        )
                        .addStringOption(opt =>
                            opt.setName('name').setDescription('Pet name').setRequired(true).setMaxLength(20)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('View your pet')
                )
                .addSubcommand(sub =>
                    sub.setName('feed')
                        .setDescription('Feed your pet')
                )
                .addSubcommand(sub =>
                    sub.setName('play')
                        .setDescription('Play with your pet')
                )
                .addSubcommand(sub =>
                    sub.setName('sleep')
                        .setDescription('Let your pet rest')
                )
        ),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (group) {
                case 'earn':
                    switch (subcommand) {
                        case 'daily': return await earnHandlers.handleDaily(interaction);
                        case 'weekly': return await earnHandlers.handleWeekly(interaction);
                        case 'work': return await earnHandlers.handleWork(interaction);
                        case 'crime': return await earnHandlers.handleCrime(interaction);
                    }
                    break;

                case 'bank':
                    switch (subcommand) {
                        case 'balance': return await bankHandlers.handleBalance(interaction);
                        case 'deposit': return await bankHandlers.handleDeposit(interaction);
                        case 'withdraw': return await bankHandlers.handleWithdraw(interaction);
                        case 'transfer': return await bankHandlers.handleTransfer(interaction);
                    }
                    break;

                case 'social':
                    switch (subcommand) {
                        case 'rob': return await socialHandlers.handleRob(interaction);
                        case 'leaderboard': return await socialHandlers.handleLeaderboard(interaction);
                        case 'transactions': return await socialHandlers.handleTransactions(interaction);
                        case 'give': return await socialHandlers.handleGive(interaction);
                        case 'remove': return await socialHandlers.handleRemove(interaction);
                    }
                    break;

                case 'gamble':
                    switch (subcommand) {
                        case 'coinflip': return await gambleHandlers.handleCoinflip(interaction);
                        case 'dice': return await gambleHandlers.handleDice(interaction);
                        case 'slots': return await gambleHandlers.handleSlots(interaction);
                        case 'blackjack': return await gambleHandlers.handleBlackjack(interaction);
                        case 'roulette': return await gambleHandlers.handleRoulette(interaction);
                        case 'highlow': return await gambleHandlers.handleHighLow(interaction);
                        case 'stats': return await gambleHandlers.handleStats(interaction);
                    }
                    break;

                case 'shop':
                    switch (subcommand) {
                        case 'browse': return await shopHandlers.handleBrowse(interaction);
                        case 'buy': return await shopHandlers.handleBuy(interaction);
                        case 'sell': return await shopHandlers.handleSell(interaction);
                        case 'inventory': return await shopHandlers.handleInventory(interaction);
                        case 'info': return await shopHandlers.handleInfo(interaction);
                        case 'use': return await shopHandlers.handleUse(interaction);
                        case 'create': return await shopHandlers.handleCreate(interaction);
                        case 'delete': return await shopHandlers.handleDelete(interaction);
                        case 'edit': return await shopHandlers.handleEdit(interaction);
                    }
                    break;

                case 'pet':
                    switch (subcommand) {
                        case 'adopt': return await petHandlers.handleAdopt(interaction);
                        case 'view': return await petHandlers.handleView(interaction);
                        case 'feed': return await petHandlers.handleFeed(interaction);
                        case 'play': return await petHandlers.handlePlay(interaction);
                        case 'sleep': return await petHandlers.handleSleep(interaction);
                    }
                    break;
            }
        } catch (error) {
            console.error('[Economy Command Error]', error);
            const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
            return interaction[method]({
                content: `\u274c Error: ${error.message}`,
                ephemeral: true
            });
        }
    }
};
