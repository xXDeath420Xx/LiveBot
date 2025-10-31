"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../utils/logger"));
module.exports = {
    data: new discord_js_1.SlashCommandBuilder()
        .setName("rpg")
        .setDescription("D&D RPG system commands")
        // Character management
        .addSubcommandGroup(group => group
        .setName("character")
        .setDescription("Character management")
        .addSubcommand(sub => sub.setName("create").setDescription("Create a new character")
        .addStringOption(opt => opt.setName("name").setDescription("Character name").setRequired(true))
        .addStringOption(opt => opt.setName("class").setDescription("Character class").setRequired(true)
        .addChoices({ name: "Warrior", value: "warrior" }, { name: "Mage", value: "mage" }, { name: "Rogue", value: "rogue" }, { name: "Cleric", value: "cleric" }, { name: "Ranger", value: "ranger" }, { name: "Paladin", value: "paladin" })))
        .addSubcommand(sub => sub.setName("info").setDescription("View your character information"))
        .addSubcommand(sub => sub.setName("delete").setDescription("Delete your character"))
        .addSubcommand(sub => sub.setName("classes").setDescription("View available classes")))
        // Quest system
        .addSubcommandGroup(group => group
        .setName("quest")
        .setDescription("Quest system")
        .addSubcommand(sub => sub.setName("list").setDescription("View available quests"))
        .addSubcommand(sub => sub.setName("start").setDescription("Start a quest")
        .addIntegerOption(opt => opt.setName("quest_id").setDescription("Quest ID").setRequired(true)))
        .addSubcommand(sub => sub.setName("active").setDescription("View your active quests"))
        .addSubcommand(sub => sub.setName("complete").setDescription("Complete a quest")
        .addIntegerOption(opt => opt.setName("quest_id").setDescription("Quest ID").setRequired(true))))
        // Inventory
        .addSubcommandGroup(group => group
        .setName("inventory")
        .setDescription("Inventory management")
        .addSubcommand(sub => sub.setName("view").setDescription("View your inventory"))
        .addSubcommand(sub => sub.setName("use").setDescription("Use an item")
        .addIntegerOption(opt => opt.setName("item_id").setDescription("Item ID").setRequired(true))))
        // Travel & Exploration
        .addSubcommandGroup(group => group
        .setName("travel")
        .setDescription("Travel and exploration")
        .addSubcommand(sub => sub.setName("zones").setDescription("View available zones"))
        .addSubcommand(sub => sub.setName("go").setDescription("Travel to a zone")
        .addStringOption(opt => opt.setName("zone").setDescription("Zone name").setRequired(true)))
        .addSubcommand(sub => sub.setName("explore").setDescription("Explore current zone")))
        // Battle system
        .addSubcommandGroup(group => group
        .setName("battle")
        .setDescription("Combat system")
        .addSubcommand(sub => sub.setName("start").setDescription("Start a battle")
        .addIntegerOption(opt => opt.setName("enemy_id").setDescription("Enemy ID").setRequired(true)))
        .addSubcommand(sub => sub.setName("attack").setDescription("Attack in current battle"))
        .addSubcommand(sub => sub.setName("flee").setDescription("Flee from current battle"))
        .addSubcommand(sub => sub.setName("status").setDescription("View current battle status"))),
    async execute(interaction) {
        const dndManager = interaction.client.dndManager;
        if (!dndManager) {
            await interaction.reply({ content: "❌ RPG system is not available.", ephemeral: true });
            return;
        }
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        try {
            // CHARACTER COMMANDS
            if (subcommandGroup === "character") {
                if (subcommand === "create") {
                    const name = interaction.options.getString("name", true);
                    const className = interaction.options.getString("class", true);
                    await interaction.deferReply();
                    try {
                        const result = await dndManager.createCharacter(interaction.user.id, interaction.guild.id, name, className);
                        const embed = new discord_js_1.EmbedBuilder()
                            .setColor("#00FF00")
                            .setTitle(`✨ Character Created: ${name}`)
                            .setDescription(`You have created a level 1 ${className}!`)
                            .addFields({ name: "❤️ Health", value: `${result.health}/${result.health}`, inline: true }, { name: "💙 Mana", value: `${result.mana}/${result.mana}`, inline: true }, { name: "💰 Gold", value: "100", inline: true }, { name: "💪 Strength", value: result.strength.toString(), inline: true }, { name: "🏹 Dexterity", value: result.dexterity.toString(), inline: true }, { name: "🛡️ Constitution", value: result.constitution.toString(), inline: true }, { name: "🧠 Intelligence", value: result.intelligence.toString(), inline: true }, { name: "🔮 Wisdom", value: result.wisdom.toString(), inline: true }, { name: "✨ Charisma", value: result.charisma.toString(), inline: true })
                            .setFooter({ text: "Use /rpg character info to view your character anytime" });
                        await interaction.editReply({ embeds: [embed] });
                    }
                    catch (error) {
                        await interaction.editReply({ content: `❌ ${error.message}` });
                    }
                }
                else if (subcommand === "info") {
                    await interaction.deferReply();
                    const character = await dndManager.getCharacter(interaction.user.id, interaction.guild.id);
                    if (!character) {
                        await interaction.editReply({
                            content: "❌ You don't have a character yet. Create one with `/rpg character create`"
                        });
                        return;
                    }
                    const expNeeded = character.level * 100;
                    const embed = new discord_js_1.EmbedBuilder()
                        .setColor("#FFD700")
                        .setTitle(`${character.character_name} - Level ${character.level} ${character.class}`)
                        .addFields({ name: "❤️ Health", value: `${character.health}/${character.max_health}`, inline: true }, { name: "💙 Mana", value: `${character.mana}/${character.max_mana}`, inline: true }, { name: "⭐ Experience", value: `${character.experience}/${expNeeded}`, inline: true }, { name: "💰 Gold", value: character.gold.toString(), inline: true }, { name: "📍 Current Zone", value: character.current_zone, inline: true }, { name: "\u200b", value: "\u200b", inline: true }, { name: "💪 Strength", value: character.strength.toString(), inline: true }, { name: "🏹 Dexterity", value: character.dexterity.toString(), inline: true }, { name: "🛡️ Constitution", value: character.constitution.toString(), inline: true }, { name: "🧠 Intelligence", value: character.intelligence.toString(), inline: true }, { name: "🔮 Wisdom", value: character.wisdom.toString(), inline: true }, { name: "✨ Charisma", value: character.charisma.toString(), inline: true })
                        .setTimestamp();
                    await interaction.editReply({ embeds: [embed] });
                }
                else if (subcommand === "delete") {
                    const character = await dndManager.getCharacter(interaction.user.id, interaction.guild.id);
                    if (!character) {
                        await interaction.reply({
                            content: "❌ You don't have a character to delete.",
                            ephemeral: true
                        });
                        return;
                    }
                    await dndManager.deleteCharacter(interaction.user.id, interaction.guild.id);
                    await interaction.reply({
                        content: `⚠️ Your character **${character.character_name}** has been deleted.`,
                        ephemeral: true
                    });
                }
                else if (subcommand === "classes") {
                    const classes = dndManager.getAvailableClasses();
                    const embed = new discord_js_1.EmbedBuilder()
                        .setColor("#9B59B6")
                        .setTitle("📚 Available Classes")
                        .setDescription("Choose your path in the realm:");
                    classes.forEach(cls => {
                        const stats = cls.stats;
                        embed.addFields({
                            name: cls.name,
                            value: `HP: ${stats.health} | Mana: ${stats.mana} | STR: ${stats.strength} | DEX: ${stats.dexterity} | CON: ${stats.constitution} | INT: ${stats.intelligence} | WIS: ${stats.wisdom} | CHA: ${stats.charisma}`
                        });
                    });
                    await interaction.reply({ embeds: [embed] });
                }
            }
            // QUEST COMMANDS
            else if (subcommandGroup === "quest") {
                const character = await dndManager.getCharacter(interaction.user.id, interaction.guild.id);
                if (!character) {
                    await interaction.reply({
                        content: "❌ You need a character first. Create one with `/rpg character create`",
                        ephemeral: true
                    });
                    return;
                }
                if (subcommand === "active") {
                    await interaction.deferReply();
                    const quests = await dndManager.getActiveQuests(character.character_id);
                    if (quests.length === 0) {
                        await interaction.editReply({
                            content: "📜 You have no active quests. Start one with `/rpg quest start`"
                        });
                        return;
                    }
                    const embed = new discord_js_1.EmbedBuilder()
                        .setColor("#3498DB")
                        .setTitle("📜 Active Quests")
                        .setDescription(`${character.character_name}'s current quests:`);
                    quests.forEach(quest => {
                        embed.addFields({
                            name: `${quest.quest_name} (ID: ${quest.quest_id})`,
                            value: `Level ${quest.required_level} | ${quest.difficulty.toUpperCase()}\nProgress: ${quest.progress}%\nRewards: ${quest.reward_exp} EXP, ${quest.reward_gold} Gold`
                        });
                    });
                    await interaction.editReply({ embeds: [embed] });
                }
            }
            // INVENTORY COMMANDS
            else if (subcommandGroup === "inventory") {
                const character = await dndManager.getCharacter(interaction.user.id, interaction.guild.id);
                if (!character) {
                    await interaction.reply({
                        content: "❌ You need a character first. Create one with `/rpg character create`",
                        ephemeral: true
                    });
                    return;
                }
                if (subcommand === "view") {
                    await interaction.deferReply();
                    const items = await dndManager.getInventory(character.character_id);
                    if (items.length === 0) {
                        await interaction.editReply({ content: "🎒 Your inventory is empty." });
                        return;
                    }
                    const embed = new discord_js_1.EmbedBuilder()
                        .setColor("#E67E22")
                        .setTitle(`🎒 ${character.character_name}'s Inventory`)
                        .setDescription(`Total Items: ${items.length}`);
                    items.forEach(item => {
                        const equipped = item.equipped ? " ⚔️" : "";
                        embed.addFields({
                            name: `${item.item_name} (ID: ${item.item_id})${equipped}`,
                            value: `${item.item_type} | ${item.rarity.toUpperCase()} | Qty: ${item.quantity}\nValue: ${item.value} gold`,
                            inline: true
                        });
                    });
                    await interaction.editReply({ embeds: [embed] });
                }
            }
        }
        catch (error) {
            logger_1.default.error(`[RPG Command] Error: ${error.message}`);
            const replyMethod = interaction.deferred ? 'editReply' : 'reply';
            await interaction[replyMethod]({
                content: `❌ An error occurred: ${error.message}`,
                ephemeral: true
            });
        }
    },
    category: 'fun'
};
