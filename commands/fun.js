"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
// Import all handler modules - assuming these will be converted to TypeScript later
const reputationHandlers = require("../handlers/fun/reputation");
const leaderboardHandlers = require("../handlers/fun/leaderboard");
const giveawayHandlers = require("../handlers/fun/giveaway");
const rankHandlers = require("../handlers/fun/rank");
const economyHandlers = require("../handlers/fun/economy");
const shopHandlers = require("../handlers/fun/shop");
const inventoryHandlers = require("../handlers/fun/inventory");
const gamblingHandlers = require("../handlers/fun/gambling");
const tradingHandlers = require("../handlers/fun/trading");
const triviaHandlers = require("../handlers/fun/trivia");
const hangmanHandlers = require("../handlers/fun/hangman");
const countingHandlers = require("../handlers/fun/counting");
module.exports = {
    data: new discord_js_1.SlashCommandBuilder()
        .setName("fun")
        .setDescription("Collection of fun, games, and economy commands")
        // Reputation group
        .addSubcommandGroup(group => group
        .setName("rep")
        .setDescription("Manage reputation points")
        .addSubcommand(sub => sub.setName("give").setDescription("Give a reputation point to a user").addUserOption(opt => opt.setName("user").setDescription("User to give reputation to").setRequired(true)))
        .addSubcommand(sub => sub.setName("check").setDescription("Check reputation score").addUserOption(opt => opt.setName("user").setDescription("User to check (defaults to you)"))))
        // Leaderboard group
        .addSubcommandGroup(group => group
        .setName("leaderboard")
        .setDescription("View various leaderboards")
        .addSubcommand(sub => sub.setName("rep").setDescription("Reputation leaderboard"))
        .addSubcommand(sub => sub.setName("xp").setDescription("XP/Level leaderboard")))
        // Giveaway group
        .addSubcommandGroup(group => group
        .setName("giveaway")
        .setDescription("Manage server giveaways")
        .addSubcommand(sub => sub.setName("start").setDescription("Start a new giveaway").addStringOption(opt => opt.setName("duration").setDescription("Duration (e.g., 10m, 2h, 1d)").setRequired(true)).addIntegerOption(opt => opt.setName("winners").setDescription("Number of winners").setRequired(true).setMinValue(1)).addStringOption(opt => opt.setName("prize").setDescription("What winners receive").setRequired(true)))
        .addSubcommand(sub => sub.setName("end").setDescription("End giveaway early").addStringOption(opt => opt.setName("message-id").setDescription("Giveaway message ID").setRequired(true)))
        .addSubcommand(sub => sub.setName("reroll").setDescription("Select new winner").addStringOption(opt => opt.setName("message-id").setDescription("Giveaway message ID").setRequired(true)))
        .addSubcommand(sub => sub.setName("list").setDescription("List active giveaways"))
        .addSubcommand(sub => sub.setName("cancel").setDescription("Cancel giveaway").addStringOption(opt => opt.setName("message-id").setDescription("Giveaway message ID").setRequired(true))))
        // Economy group
        .addSubcommandGroup(group => group
        .setName("economy")
        .setDescription("Economy and currency management")
        .addSubcommand(sub => sub.setName("balance").setDescription("Check your balance").addUserOption(opt => opt.setName("user").setDescription("User to check")))
        .addSubcommand(sub => sub.setName("daily").setDescription("Claim daily reward"))
        .addSubcommand(sub => sub.setName("weekly").setDescription("Claim weekly reward"))
        .addSubcommand(sub => sub.setName("work").setDescription("Work for money"))
        .addSubcommand(sub => sub.setName("crime").setDescription("Commit a crime for money"))
        .addSubcommand(sub => sub.setName("rob").setDescription("Rob another user").addUserOption(opt => opt.setName("user").setDescription("User to rob").setRequired(true)))
        .addSubcommand(sub => sub.setName("deposit").setDescription("Deposit to bank").addIntegerOption(opt => opt.setName("amount").setDescription("Amount to deposit").setRequired(true).setMinValue(1)))
        .addSubcommand(sub => sub.setName("withdraw").setDescription("Withdraw from bank").addIntegerOption(opt => opt.setName("amount").setDescription("Amount to withdraw").setRequired(true).setMinValue(1)))
        .addSubcommand(sub => sub.setName("transfer").setDescription("Transfer money").addUserOption(opt => opt.setName("user").setDescription("User to transfer to").setRequired(true)).addIntegerOption(opt => opt.setName("amount").setDescription("Amount to transfer").setRequired(true).setMinValue(1)))
        .addSubcommand(sub => sub.setName("leaderboard").setDescription("Economy leaderboard"))
        .addSubcommand(sub => sub.setName("transactions").setDescription("View transaction history").addIntegerOption(opt => opt.setName("limit").setDescription("Number of transactions (5-25)").setMinValue(5).setMaxValue(25))))
        // Shop group
        .addSubcommandGroup(group => group
        .setName("shop")
        .setDescription("Browse and purchase items")
        .addSubcommand(sub => sub.setName("browse").setDescription("Browse shop items").addStringOption(opt => opt.setName("category").setDescription("Filter by category").addChoices({ name: "📦 All", value: "all" }, { name: "👑 Roles", value: "role" }, { name: "🍕 Consumables", value: "consumable" }, { name: "💎 Collectibles", value: "collectible" }, { name: "🔧 Tools", value: "tool" }, { name: "🎨 Decorations", value: "decoration" })))
        .addSubcommand(sub => sub.setName("buy").setDescription("Purchase item").addIntegerOption(opt => opt.setName("item_id").setDescription("Item ID").setRequired(true)).addIntegerOption(opt => opt.setName("quantity").setDescription("Quantity (default: 1)").setMinValue(1)))
        .addSubcommand(sub => sub.setName("sell").setDescription("Sell item back").addIntegerOption(opt => opt.setName("item_id").setDescription("Item ID").setRequired(true)).addIntegerOption(opt => opt.setName("quantity").setDescription("Quantity (default: 1)").setMinValue(1)))
        .addSubcommand(sub => sub.setName("info").setDescription("View item details").addIntegerOption(opt => opt.setName("item_id").setDescription("Item ID").setRequired(true))))
        // Inventory group
        .addSubcommandGroup(group => group
        .setName("inventory")
        .setDescription("Manage your inventory")
        .addSubcommand(sub => sub.setName("view").setDescription("View inventory").addUserOption(opt => opt.setName("user").setDescription("User to view")).addStringOption(opt => opt.setName("filter").setDescription("Filter by type").addChoices({ name: "📦 All", value: "all" }, { name: "👑 Roles", value: "role" }, { name: "🍕 Consumables", value: "consumable" }, { name: "💎 Collectibles", value: "collectible" }, { name: "🔧 Tools", value: "tool" }, { name: "🎨 Decorations", value: "decoration" })))
        .addSubcommand(sub => sub.setName("use").setDescription("Use consumable item").addIntegerOption(opt => opt.setName("item_id").setDescription("Item ID").setRequired(true)).addIntegerOption(opt => opt.setName("quantity").setDescription("Quantity (default: 1)").setMinValue(1)))
        .addSubcommand(sub => sub.setName("equip").setDescription("Equip/unequip tool or decoration").addIntegerOption(opt => opt.setName("item_id").setDescription("Item ID").setRequired(true)))
        .addSubcommand(sub => sub.setName("gift").setDescription("Gift item to user").addUserOption(opt => opt.setName("user").setDescription("User to gift to").setRequired(true)).addIntegerOption(opt => opt.setName("item_id").setDescription("Item ID").setRequired(true)).addIntegerOption(opt => opt.setName("quantity").setDescription("Quantity (default: 1)").setMinValue(1))))
        // Gamble group
        .addSubcommandGroup(group => group
        .setName("gamble")
        .setDescription("Gambling games")
        .addSubcommand(sub => sub.setName("coinflip").setDescription("Flip a coin").addIntegerOption(opt => opt.setName("amount").setDescription("Amount to bet").setRequired(true).setMinValue(1)).addStringOption(opt => opt.setName("choice").setDescription("Heads or tails").setRequired(true).addChoices({ name: "🪙 Heads", value: "heads" }, { name: "🪙 Tails", value: "tails" })))
        .addSubcommand(sub => sub.setName("dice").setDescription("Roll dice").addIntegerOption(opt => opt.setName("amount").setDescription("Amount to bet").setRequired(true).setMinValue(1)).addIntegerOption(opt => opt.setName("prediction").setDescription("Predict result (2-12)").setRequired(true).setMinValue(2).setMaxValue(12)))
        .addSubcommand(sub => sub.setName("slots").setDescription("Play slots").addIntegerOption(opt => opt.setName("amount").setDescription("Amount to bet").setRequired(true).setMinValue(1)))
        .addSubcommand(sub => sub.setName("blackjack").setDescription("Play blackjack").addIntegerOption(opt => opt.setName("amount").setDescription("Amount to bet").setRequired(true).setMinValue(1)))
        .addSubcommand(sub => sub.setName("roulette").setDescription("Play roulette").addIntegerOption(opt => opt.setName("amount").setDescription("Amount to bet").setRequired(true).setMinValue(1)).addStringOption(opt => opt.setName("bet").setDescription("What to bet on").setRequired(true).addChoices({ name: "🔴 Red", value: "red" }, { name: "⚫ Black", value: "black" }, { name: "🟢 Green (0)", value: "green" }, { name: "1️⃣ Odd", value: "odd" }, { name: "2️⃣ Even", value: "even" }))))
        // Trade group
        .addSubcommandGroup(group => group
        .setName("trade")
        .setDescription("Trade items and currency")
        .addSubcommand(sub => sub.setName("offer").setDescription("Create trade offer").addUserOption(opt => opt.setName("user").setDescription("User to trade with").setRequired(true)))
        .addSubcommand(sub => sub.setName("view").setDescription("View trade details").addIntegerOption(opt => opt.setName("trade_id").setDescription("Trade ID").setRequired(true)))
        .addSubcommand(sub => sub.setName("accept").setDescription("Accept pending trade").addIntegerOption(opt => opt.setName("trade_id").setDescription("Trade ID").setRequired(true)))
        .addSubcommand(sub => sub.setName("decline").setDescription("Decline trade").addIntegerOption(opt => opt.setName("trade_id").setDescription("Trade ID").setRequired(true)))
        .addSubcommand(sub => sub.setName("cancel").setDescription("Cancel your trade").addIntegerOption(opt => opt.setName("trade_id").setDescription("Trade ID").setRequired(true)))
        .addSubcommand(sub => sub.setName("list").setDescription("View pending trades")))
        // Trivia group
        .addSubcommandGroup(group => group
        .setName("trivia")
        .setDescription("Play trivia games")
        .addSubcommand(sub => sub.setName("start").setDescription("Start trivia game").addStringOption(opt => opt.setName("category").setDescription("Category").addChoices({ name: "🎲 Random", value: "random" }, { name: "🧠 General", value: "general" }, { name: "🔬 Science", value: "science" }, { name: "📜 History", value: "history" }, { name: "🌍 Geography", value: "geography" }, { name: "🎬 Entertainment", value: "entertainment" }, { name: "⚽ Sports", value: "sports" }, { name: "💻 Technology", value: "technology" }, { name: "🎵 Music", value: "music" }, { name: "🎨 Art", value: "art" }, { name: "🎮 Gaming", value: "gaming" })).addStringOption(opt => opt.setName("difficulty").setDescription("Difficulty").addChoices({ name: "🌱 Easy", value: "easy" }, { name: "⚡ Medium", value: "medium" }, { name: "🔥 Hard", value: "hard" })).addIntegerOption(opt => opt.setName("questions").setDescription("Number of questions (1-10)").setMinValue(1).setMaxValue(10)))
        .addSubcommand(sub => sub.setName("stats").setDescription("View trivia stats").addUserOption(opt => opt.setName("user").setDescription("User to view")))
        .addSubcommand(sub => sub.setName("leaderboard").setDescription("Trivia leaderboard")))
        // Hangman group
        .addSubcommandGroup(group => group
        .setName("hangman")
        .setDescription("Word guessing game")
        .addSubcommand(sub => sub.setName("start").setDescription("Start hangman game").addStringOption(opt => opt.setName("difficulty").setDescription("Difficulty").addChoices({ name: "🌱 Easy (4-5 letters)", value: "easy" }, { name: "⚡ Medium (6-8 letters)", value: "medium" }, { name: "🔥 Hard (9+ letters)", value: "hard" })).addStringOption(opt => opt.setName("category").setDescription("Category").addChoices({ name: "🎲 Random", value: "random" }, { name: "🍎 Food", value: "food" }, { name: "🌳 Nature", value: "nature" }, { name: "🎵 Music", value: "music" }, { name: "⚽ Sports", value: "sports" }, { name: "🐘 Animals", value: "animals" }, { name: "💻 Technology", value: "technology" }, { name: "📦 General", value: "general" })))
        .addSubcommand(sub => sub.setName("guess").setDescription("Guess letter or word").addStringOption(opt => opt.setName("guess").setDescription("Letter or full word").setRequired(true).setMaxLength(20)))
        .addSubcommand(sub => sub.setName("give-up").setDescription("Give up and reveal answer"))
        .addSubcommand(sub => sub.setName("stats").setDescription("View hangman stats").addUserOption(opt => opt.setName("user").setDescription("User to view"))))
        // Counting subcommands (admin only)
        .addSubcommandGroup(group => group
        .setName("counting")
        .setDescription("Manage counting game channels")
        .addSubcommand(sub => sub.setName("setup").setDescription("Setup counting channel").addChannelOption(opt => opt.setName("channel").setDescription("Channel to use").setRequired(true)).addIntegerOption(opt => opt.setName("start").setDescription("Starting number (default: 1)").setMinValue(0)))
        .addSubcommand(sub => sub.setName("disable").setDescription("Disable counting").addChannelOption(opt => opt.setName("channel").setDescription("Channel to disable").setRequired(true)))
        .addSubcommand(sub => sub.setName("reset").setDescription("Reset count to 0").addChannelOption(opt => opt.setName("channel").setDescription("Channel to reset")))
        .addSubcommand(sub => sub.setName("stats").setDescription("View counting stats").addChannelOption(opt => opt.setName("channel").setDescription("Channel to view")))
        .addSubcommand(sub => sub.setName("leaderboard").setDescription("Counting leaderboard").addChannelOption(opt => opt.setName("channel").setDescription("Channel to view"))))
        // Rank subcommand (standalone)
        .addSubcommand(sub => sub.setName("rank").setDescription("Check rank and XP").addUserOption(opt => opt.setName("user").setDescription("User to check"))),
    async execute(interaction) {
        const subcommandGroup = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand();
        try {
            // Route to appropriate handler based on subcommand group
            switch (subcommandGroup) {
                case "rep":
                    await interaction.deferReply();
                    if (subcommand === "give")
                        await reputationHandlers.handleGive(interaction);
                    else if (subcommand === "check")
                        await reputationHandlers.handleCheck(interaction);
                    break;
                case "leaderboard":
                    await interaction.deferReply();
                    if (subcommand === "rep")
                        await leaderboardHandlers.handleRep(interaction);
                    else if (subcommand === "xp")
                        await leaderboardHandlers.handleXp(interaction);
                    break;
                case "giveaway":
                    await interaction.deferReply({ ephemeral: true });
                    if (subcommand === "start")
                        await giveawayHandlers.handleStart(interaction);
                    else if (subcommand === "end")
                        await giveawayHandlers.handleEnd(interaction);
                    else if (subcommand === "reroll")
                        await giveawayHandlers.handleReroll(interaction);
                    else if (subcommand === "list")
                        await giveawayHandlers.handleList(interaction);
                    else if (subcommand === "cancel")
                        await giveawayHandlers.handleCancel(interaction);
                    break;
                case "economy":
                    // Get economy config
                    const [[ecoConfig]] = await db_1.default.execute("SELECT * FROM economy_config WHERE guild_id = ?", [interaction.guild.id]);
                    if (!ecoConfig || !ecoConfig.enabled) {
                        await interaction.reply({ content: "❌ Economy system is not enabled in this server.", ephemeral: true });
                        return;
                    }
                    await interaction.deferReply();
                    if (subcommand === "balance")
                        await economyHandlers.handleBalance(interaction, ecoConfig);
                    else if (subcommand === "daily")
                        await economyHandlers.handleDaily(interaction, ecoConfig);
                    else if (subcommand === "weekly")
                        await economyHandlers.handleWeekly(interaction, ecoConfig);
                    else if (subcommand === "work")
                        await economyHandlers.handleWork(interaction, ecoConfig);
                    else if (subcommand === "crime")
                        await economyHandlers.handleCrime(interaction, ecoConfig);
                    else if (subcommand === "rob")
                        await economyHandlers.handleRob(interaction, ecoConfig);
                    else if (subcommand === "deposit")
                        await economyHandlers.handleDeposit(interaction, ecoConfig);
                    else if (subcommand === "withdraw")
                        await economyHandlers.handleWithdraw(interaction, ecoConfig);
                    else if (subcommand === "transfer")
                        await economyHandlers.handleTransfer(interaction, ecoConfig);
                    else if (subcommand === "leaderboard")
                        await economyHandlers.handleLeaderboard(interaction, ecoConfig);
                    else if (subcommand === "transactions")
                        await economyHandlers.handleTransactions(interaction, ecoConfig);
                    break;
                case "shop":
                    const [[shopConfig]] = await db_1.default.execute("SELECT * FROM economy_config WHERE guild_id = ?", [interaction.guild.id]);
                    if (!shopConfig || !shopConfig.enabled) {
                        await interaction.reply({ content: "❌ Economy system is not enabled in this server.", ephemeral: true });
                        return;
                    }
                    if (subcommand === "browse")
                        await shopHandlers.handleBrowse(interaction, shopConfig);
                    else if (subcommand === "buy")
                        await shopHandlers.handleBuy(interaction, shopConfig);
                    else if (subcommand === "sell")
                        await shopHandlers.handleSell(interaction, shopConfig);
                    else if (subcommand === "info")
                        await shopHandlers.handleInfo(interaction, shopConfig);
                    break;
                case "inventory":
                    const [[invConfig]] = await db_1.default.execute("SELECT * FROM economy_config WHERE guild_id = ?", [interaction.guild.id]);
                    if (!invConfig || !invConfig.enabled) {
                        await interaction.reply({ content: "❌ Economy system is not enabled in this server.", ephemeral: true });
                        return;
                    }
                    if (subcommand === "view")
                        await inventoryHandlers.handleView(interaction, invConfig);
                    else if (subcommand === "use")
                        await inventoryHandlers.handleUse(interaction, invConfig);
                    else if (subcommand === "equip")
                        await inventoryHandlers.handleEquip(interaction, invConfig);
                    else if (subcommand === "gift")
                        await inventoryHandlers.handleGift(interaction, invConfig);
                    break;
                case "gamble":
                    const [[gambleConfig]] = await db_1.default.execute("SELECT * FROM economy_config WHERE guild_id = ?", [interaction.guild.id]);
                    if (!gambleConfig || !gambleConfig.enabled) {
                        await interaction.reply({ content: "❌ Economy system is not enabled in this server.", ephemeral: true });
                        return;
                    }
                    if (subcommand === "coinflip")
                        await gamblingHandlers.handleCoinflip(interaction, gambleConfig);
                    else if (subcommand === "dice")
                        await gamblingHandlers.handleDice(interaction, gambleConfig);
                    else if (subcommand === "slots")
                        await gamblingHandlers.handleSlots(interaction, gambleConfig);
                    else if (subcommand === "blackjack")
                        await gamblingHandlers.handleBlackjack(interaction, gambleConfig);
                    else if (subcommand === "roulette")
                        await gamblingHandlers.handleRoulette(interaction, gambleConfig);
                    break;
                case "trade":
                    const [[tradeConfig]] = await db_1.default.execute("SELECT * FROM economy_config WHERE guild_id = ?", [interaction.guild.id]);
                    if (!tradeConfig || !tradeConfig.enabled) {
                        await interaction.reply({ content: "❌ Economy system is not enabled in this server.", ephemeral: true });
                        return;
                    }
                    if (!tradeConfig.allow_trading) {
                        await interaction.reply({ content: "❌ Trading is disabled in this server.", ephemeral: true });
                        return;
                    }
                    if (subcommand === "offer")
                        await tradingHandlers.handleOffer(interaction, tradeConfig);
                    else if (subcommand === "view")
                        await tradingHandlers.handleView(interaction, tradeConfig);
                    else if (subcommand === "accept")
                        await tradingHandlers.handleAccept(interaction, tradeConfig);
                    else if (subcommand === "decline")
                        await tradingHandlers.handleDecline(interaction, tradeConfig);
                    else if (subcommand === "cancel")
                        await tradingHandlers.handleCancel(interaction, tradeConfig);
                    else if (subcommand === "list")
                        await tradingHandlers.handleList(interaction, tradeConfig);
                    break;
                case "trivia":
                    if (subcommand === "start")
                        await triviaHandlers.handleStart(interaction);
                    else if (subcommand === "stats")
                        await triviaHandlers.handleStats(interaction);
                    else if (subcommand === "leaderboard")
                        await triviaHandlers.handleLeaderboard(interaction);
                    break;
                case "hangman":
                    if (subcommand === "start")
                        await hangmanHandlers.handleStart(interaction);
                    else if (subcommand === "guess")
                        await hangmanHandlers.handleGuess(interaction);
                    else if (subcommand === "give-up")
                        await hangmanHandlers.handleGiveUp(interaction);
                    else if (subcommand === "stats")
                        await hangmanHandlers.handleStats(interaction);
                    break;
                case "counting":
                    // Counting requires manage channels permission
                    const member = interaction.member;
                    if (!member.permissions.has(discord_js_1.PermissionFlagsBits.ManageChannels)) {
                        await interaction.reply({ content: "❌ You need Manage Channels permission to use counting commands.", ephemeral: true });
                        return;
                    }
                    if (subcommand === "setup")
                        await countingHandlers.handleSetup(interaction);
                    else if (subcommand === "disable")
                        await countingHandlers.handleDisable(interaction);
                    else if (subcommand === "reset")
                        await countingHandlers.handleReset(interaction);
                    else if (subcommand === "stats")
                        await countingHandlers.handleStats(interaction);
                    else if (subcommand === "leaderboard")
                        await countingHandlers.handleLeaderboard(interaction);
                    break;
                case null:
                    // Standalone subcommands (no group)
                    if (subcommand === "rank") {
                        await interaction.deferReply();
                        await rankHandlers.handleRank(interaction);
                    }
                    break;
                default:
                    await interaction.reply({ content: "❌ Unknown subcommand group.", ephemeral: true });
            }
        }
        catch (error) {
            logger_1.default.error("[Fun Command Error]", error);
            const errorMessage = "❌ An error occurred while processing your request.";
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            }
            else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
    // Export handler for button interactions (trivia)
    async handleButtonInteraction(interaction) {
        return await triviaHandlers.handleButton(interaction);
    },
    // Export handler for message events (counting)
    async handleMessage(message) {
        return await countingHandlers.handleMessage(message);
    },
    category: "Fun"
};
