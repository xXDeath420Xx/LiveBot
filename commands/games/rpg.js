/**
 * RPG Command - Modular D&D RPG System
 * Refactored into separate handler modules for maintainability
 */
import { SlashCommandBuilder } from 'discord.js';
import logger from '../../utils/logger.js';

// Import handlers
import {
    handleCharacter,
    handleInventory,
    handleRoll,
    handleCampaign,
    handleSession,
    handlePlay,
    handleSettings,
    handleSpell,
    handleResource,
    handleCondition,
    handleStats,
    handleAutocomplete,
    handleGuide,
    handleGuideButton,
    handleGuideSelectMenu,
    handleRest,
    handleStatroll
} from './rpg/handlers/index.js';

export default {
    data: new SlashCommandBuilder()
        .setName('rpg')
        .setDescription('D&D RPG system commands')

        // Character management
        .addSubcommandGroup(group =>
            group
                .setName('character')
                .setDescription('Character management')
                .addSubcommand(sub =>
                    sub.setName('create')
                        .setDescription('Create a new character')
                        .addStringOption(opt => opt.setName('name').setDescription('Character name').setRequired(true))
                        .addStringOption(opt => opt.setName('class').setDescription('Character class').setRequired(true)
                            .addChoices(
                                { name: 'Barbarian', value: 'barbarian' }, { name: 'Bard', value: 'bard' },
                                { name: 'Cleric', value: 'cleric' }, { name: 'Druid', value: 'druid' },
                                { name: 'Fighter', value: 'fighter' }, { name: 'Monk', value: 'monk' },
                                { name: 'Paladin', value: 'paladin' }, { name: 'Ranger', value: 'ranger' },
                                { name: 'Rogue', value: 'rogue' }, { name: 'Sorcerer', value: 'sorcerer' },
                                { name: 'Warlock', value: 'warlock' }, { name: 'Wizard', value: 'wizard' }
                            ))
                        .addStringOption(opt => opt.setName('species').setDescription('Race (e.g. elf, dwarf)').setRequired(false))
                        .addStringOption(opt => opt.setName('background').setDescription('Background (e.g. soldier)').setRequired(false))
                )
                .addSubcommand(sub => sub.setName('view').setDescription('View character information')
                    .addUserOption(opt => opt.setName('user').setDescription('User to view').setRequired(false)))
                .addSubcommand(sub => sub.setName('stats').setDescription('View detailed character statistics'))
                .addSubcommand(sub => sub.setName('delete').setDescription('Delete your character'))
                .addSubcommand(sub => sub.setName('import').setDescription('Import from D&D Beyond PDF')
                    .addAttachmentOption(opt => opt.setName('pdf').setDescription('D&D Beyond character sheet PDF').setRequired(true)))
        )

        // Inventory management
        .addSubcommandGroup(group =>
            group.setName('inventory').setDescription('Inventory management')
                .addSubcommand(sub => sub.setName('view').setDescription('View your inventory'))
                .addSubcommand(sub => sub.setName('equip').setDescription('Equip an item')
                    .addIntegerOption(opt => opt.setName('item_id').setDescription('Item ID').setRequired(true)))
                .addSubcommand(sub => sub.setName('unequip').setDescription('Unequip an item')
                    .addIntegerOption(opt => opt.setName('item_id').setDescription('Item ID').setRequired(true)))
        )

        // Dice Rolling
        .addSubcommandGroup(group =>
            group.setName('roll').setDescription('Dice rolling for D&D')
                .addSubcommand(sub => sub.setName('dice').setDescription('Roll dice (e.g., 2d6+3)')
                    .addStringOption(opt => opt.setName('notation').setDescription('Dice notation').setRequired(true))
                    .addStringOption(opt => opt.setName('advantage').setDescription('Advantage/Disadvantage').setRequired(false)
                        .addChoices({ name: 'Normal', value: 'normal' }, { name: 'Advantage', value: 'advantage' }, { name: 'Disadvantage', value: 'disadvantage' })))
                .addSubcommand(sub => sub.setName('ability').setDescription('Roll ability check')
                    .addStringOption(opt => opt.setName('ability').setDescription('Ability').setRequired(true)
                        .addChoices({ name: 'Strength', value: 'strength' }, { name: 'Dexterity', value: 'dexterity' },
                            { name: 'Constitution', value: 'constitution' }, { name: 'Intelligence', value: 'intelligence' },
                            { name: 'Wisdom', value: 'wisdom' }, { name: 'Charisma', value: 'charisma' }))
                    .addIntegerOption(opt => opt.setName('dc').setDescription('DC').setRequired(false).setMinValue(1).setMaxValue(30))
                    .addStringOption(opt => opt.setName('advantage').setDescription('Advantage').setRequired(false)
                        .addChoices({ name: 'Normal', value: 'normal' }, { name: 'Advantage', value: 'advantage' }, { name: 'Disadvantage', value: 'disadvantage' })))
                .addSubcommand(sub => sub.setName('skill').setDescription('Roll skill check')
                    .addStringOption(opt => opt.setName('skill').setDescription('Skill').setRequired(true)
                        .addChoices(
                            { name: 'Acrobatics', value: 'acrobatics' }, { name: 'Animal Handling', value: 'animal_handling' },
                            { name: 'Arcana', value: 'arcana' }, { name: 'Athletics', value: 'athletics' },
                            { name: 'Deception', value: 'deception' }, { name: 'History', value: 'history' },
                            { name: 'Insight', value: 'insight' }, { name: 'Intimidation', value: 'intimidation' },
                            { name: 'Investigation', value: 'investigation' }, { name: 'Medicine', value: 'medicine' },
                            { name: 'Nature', value: 'nature' }, { name: 'Perception', value: 'perception' },
                            { name: 'Performance', value: 'performance' }, { name: 'Persuasion', value: 'persuasion' },
                            { name: 'Religion', value: 'religion' }, { name: 'Sleight of Hand', value: 'sleight_of_hand' },
                            { name: 'Stealth', value: 'stealth' }, { name: 'Survival', value: 'survival' }))
                    .addIntegerOption(opt => opt.setName('dc').setDescription('DC').setRequired(false).setMinValue(1).setMaxValue(30))
                    .addStringOption(opt => opt.setName('advantage').setDescription('Advantage').setRequired(false)
                        .addChoices({ name: 'Normal', value: 'normal' }, { name: 'Advantage', value: 'advantage' }, { name: 'Disadvantage', value: 'disadvantage' })))
                .addSubcommand(sub => sub.setName('save').setDescription('Roll saving throw')
                    .addStringOption(opt => opt.setName('ability').setDescription('Save type').setRequired(true)
                        .addChoices({ name: 'STR Save', value: 'strength' }, { name: 'DEX Save', value: 'dexterity' },
                            { name: 'CON Save', value: 'constitution' }, { name: 'INT Save', value: 'intelligence' },
                            { name: 'WIS Save', value: 'wisdom' }, { name: 'CHA Save', value: 'charisma' }))
                    .addIntegerOption(opt => opt.setName('dc').setDescription('DC').setRequired(true).setMinValue(1).setMaxValue(30))
                    .addStringOption(opt => opt.setName('advantage').setDescription('Advantage').setRequired(false)
                        .addChoices({ name: 'Normal', value: 'normal' }, { name: 'Advantage', value: 'advantage' }, { name: 'Disadvantage', value: 'disadvantage' })))
                .addSubcommand(sub => sub.setName('initiative').setDescription('Roll initiative'))
        )

        // Campaign Management
        .addSubcommandGroup(group =>
            group.setName('campaign').setDescription('AI Dungeon Master campaigns')
                .addSubcommand(sub => sub.setName('create').setDescription('Create a campaign')
                    .addStringOption(opt => opt.setName('name').setDescription('Campaign name').setRequired(true))
                    .addStringOption(opt => opt.setName('type').setDescription('Type').setRequired(true)
                        .addChoices({ name: 'Homebrew', value: 'homebrew' }, { name: 'Official Module', value: 'official' }, { name: 'Hybrid', value: 'hybrid' }))
                    .addStringOption(opt => opt.setName('setting').setDescription('Setting').setRequired(false)
                        .addChoices({ name: 'Forgotten Realms', value: 'Forgotten Realms' }, { name: 'Eberron', value: 'Eberron' },
                            { name: 'Ravenloft', value: 'Ravenloft' }, { name: 'Custom', value: 'Custom' }))
                    .addStringOption(opt => opt.setName('theme').setDescription('Theme').setRequired(false)
                        .addChoices({ name: 'Classic Fantasy', value: 'classic fantasy' }, { name: 'Dark Fantasy', value: 'dark fantasy' },
                            { name: 'Heroic Epic', value: 'heroic epic' }, { name: 'Mystery', value: 'mystery' },
                            { name: 'Horror', value: 'horror' }, { name: 'Comedic', value: 'comedic' }))
                    .addStringOption(opt => opt.setName('difficulty').setDescription('Difficulty').setRequired(false)
                        .addChoices({ name: 'Easy', value: 'easy' }, { name: 'Normal', value: 'normal' },
                            { name: 'Hard', value: 'hard' }, { name: 'Deadly', value: 'deadly' })))
                .addSubcommand(sub => sub.setName('list').setDescription('List campaigns'))
                .addSubcommand(sub => sub.setName('join').setDescription('Join a campaign')
                    .addStringOption(opt => opt.setName('campaign').setDescription('Campaign').setRequired(true).setAutocomplete(true)))
                .addSubcommand(sub => sub.setName('leave').setDescription('Leave campaign'))
                .addSubcommand(sub => sub.setName('info').setDescription('View campaign details'))
                .addSubcommand(sub => sub.setName('modules').setDescription('View available modules'))
        )

        // Session Controls
        .addSubcommandGroup(group =>
            group.setName('session').setDescription('AI DM session controls')
                .addSubcommand(sub => sub.setName('start').setDescription('Start a session'))
                .addSubcommand(sub => sub.setName('join').setDescription('Join active session'))
                .addSubcommand(sub => sub.setName('end').setDescription('End session'))
                .addSubcommand(sub => sub.setName('recap').setDescription('Get story recap'))
        )

        // Play Commands
        .addSubcommandGroup(group =>
            group.setName('play').setDescription('AI DM gameplay')
                .addSubcommand(sub => sub.setName('action').setDescription('Describe your action')
                    .addStringOption(opt => opt.setName('action').setDescription('What do you do?').setRequired(true)))
                .addSubcommand(sub => sub.setName('say').setDescription('Speak in character')
                    .addStringOption(opt => opt.setName('dialogue').setDescription('What do you say?').setRequired(true)))
                .addSubcommand(sub => sub.setName('examine').setDescription('Examine something')
                    .addStringOption(opt => opt.setName('target').setDescription('What to examine?').setRequired(true)))
                .addSubcommand(sub => sub.setName('menu').setDescription('Quick actions menu'))
                .addSubcommand(sub => sub.setName('combat').setDescription('Combat action')
                    .addStringOption(opt => opt.setName('action').setDescription('Action').setRequired(true)
                        .addChoices({ name: 'Attack', value: 'attack' }, { name: 'Dodge', value: 'dodge' },
                            { name: 'Dash', value: 'dash' }, { name: 'Disengage', value: 'disengage' },
                            { name: 'Hide', value: 'hide' }, { name: 'Help', value: 'help' },
                            { name: 'Ready', value: 'ready' }, { name: 'Cast Spell', value: 'cast_spell' }))
                    .addStringOption(opt => opt.setName('target').setDescription('Target').setRequired(false))
                    .addStringOption(opt => opt.setName('details').setDescription('Weapon/spell').setRequired(false)))
                .addSubcommand(sub => sub.setName('explore').setDescription('Exploration action')
                    .addStringOption(opt => opt.setName('action').setDescription('Action').setRequired(true)
                        .addChoices({ name: 'Search', value: 'search' }, { name: 'Investigate', value: 'investigate' },
                            { name: 'Perception', value: 'perception' }, { name: 'Stealth', value: 'stealth' },
                            { name: 'Check Traps', value: 'check_traps' }, { name: 'Pick Lock', value: 'pick_lock' },
                            { name: 'Climb', value: 'climb' }, { name: 'Swim', value: 'swim' }))
                    .addStringOption(opt => opt.setName('target').setDescription('Focus').setRequired(false)))
                .addSubcommand(sub => sub.setName('social').setDescription('Social interaction')
                    .addStringOption(opt => opt.setName('action').setDescription('Action').setRequired(true)
                        .addChoices({ name: 'Persuade', value: 'persuade' }, { name: 'Intimidate', value: 'intimidate' },
                            { name: 'Deceive', value: 'deceive' }, { name: 'Insight', value: 'insight' },
                            { name: 'Performance', value: 'performance' }, { name: 'Animal Handling', value: 'animal_handling' }))
                    .addStringOption(opt => opt.setName('target').setDescription('Who?').setRequired(false))
                    .addStringOption(opt => opt.setName('message').setDescription('What do you say?').setRequired(false)))
                .addSubcommand(sub => sub.setName('rest').setDescription('Take a rest')
                    .addStringOption(opt => opt.setName('type').setDescription('Rest type').setRequired(true)
                        .addChoices({ name: 'Short Rest', value: 'short' }, { name: 'Long Rest', value: 'long' })))
                .addSubcommand(sub => sub.setName('roll').setDescription('Quick roll')
                    .addStringOption(opt => opt.setName('type').setDescription('Roll type').setRequired(true)
                        .addChoices(
                            { name: 'Perception', value: 'skill:perception' }, { name: 'Investigation', value: 'skill:investigation' },
                            { name: 'Stealth', value: 'skill:stealth' }, { name: 'Insight', value: 'skill:insight' },
                            { name: 'Persuasion', value: 'skill:persuasion' }, { name: 'Athletics', value: 'skill:athletics' },
                            { name: 'Acrobatics', value: 'skill:acrobatics' }, { name: 'Arcana', value: 'skill:arcana' },
                            { name: 'STR Save', value: 'save:strength' }, { name: 'DEX Save', value: 'save:dexterity' },
                            { name: 'CON Save', value: 'save:constitution' }, { name: 'INT Save', value: 'save:intelligence' },
                            { name: 'WIS Save', value: 'save:wisdom' }, { name: 'CHA Save', value: 'save:charisma' }))
                    .addStringOption(opt => opt.setName('advantage').setDescription('Roll type').setRequired(false)
                        .addChoices({ name: 'Normal', value: 'normal' }, { name: 'Advantage', value: 'advantage' }, { name: 'Disadvantage', value: 'disadvantage' })))
        )

        // Settings
        .addSubcommandGroup(group =>
            group.setName('settings').setDescription('RPG server settings')
                .addSubcommand(sub => sub.setName('channel').setDescription('Set RPG channel')
                    .addChannelOption(opt => opt.setName('channel').setDescription('Channel').setRequired(false)))
                .addSubcommand(sub => sub.setName('view').setDescription('View settings'))
        )

        // Spells
        .addSubcommandGroup(group =>
            group.setName('spell').setDescription('Spellcasting')
                .addSubcommand(sub => sub.setName('cast').setDescription('Cast a spell')
                    .addStringOption(opt => opt.setName('name').setDescription('Spell name').setRequired(true))
                    .addIntegerOption(opt => opt.setName('level').setDescription('Slot level').setRequired(false).setMinValue(0).setMaxValue(9)))
                .addSubcommand(sub => sub.setName('slots').setDescription('View spell slots'))
                .addSubcommand(sub => sub.setName('known').setDescription('View known spells'))
                .addSubcommand(sub => sub.setName('learn').setDescription('Learn a spell')
                    .addStringOption(opt => opt.setName('name').setDescription('Spell name').setRequired(true)))
                .addSubcommand(sub => sub.setName('prepare').setDescription('Prepare a spell')
                    .addStringOption(opt => opt.setName('name').setDescription('Spell name').setRequired(true)))
        )

        // Class Resources
        .addSubcommandGroup(group =>
            group.setName('resource').setDescription('Class resources')
                .addSubcommand(sub => sub.setName('view').setDescription('View resources'))
                .addSubcommand(sub => sub.setName('use').setDescription('Use a resource')
                    .addStringOption(opt => opt.setName('name').setDescription('Resource name').setRequired(true))
                    .addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(false).setMinValue(1)))
                .addSubcommand(sub => sub.setName('rest').setDescription('Rest to restore')
                    .addStringOption(opt => opt.setName('type').setDescription('Rest type').setRequired(true)
                        .addChoices({ name: 'Short Rest', value: 'short' }, { name: 'Long Rest', value: 'long' })))
        )

        // Conditions (includes death saves, exhaustion, inspiration from former /rpgstatus)
        .addSubcommandGroup(group =>
            group.setName('condition').setDescription('Status conditions & mechanics')
                .addSubcommand(sub => sub.setName('list').setDescription('View all conditions'))
                .addSubcommand(sub => sub.setName('info').setDescription('Get condition info')
                    .addStringOption(opt => opt.setName('name').setDescription('Condition name').setRequired(true)))
                .addSubcommand(sub => sub.setName('active').setDescription('View your conditions'))
                .addSubcommand(sub => sub.setName('deathsave').setDescription('Make a death saving throw (when at 0 HP)'))
                .addSubcommand(sub => sub.setName('exhaustion').setDescription('View or modify exhaustion level')
                    .addStringOption(opt => opt.setName('action').setDescription('Action to take').setRequired(false)
                        .addChoices(
                            { name: 'View current level', value: 'view' },
                            { name: 'Add 1 level (DM)', value: 'add' },
                            { name: 'Remove 1 level (DM)', value: 'remove' }
                        )))
                .addSubcommand(sub => sub.setName('inspiration').setDescription('View or use inspiration')
                    .addStringOption(opt => opt.setName('action').setDescription('Action to take').setRequired(false)
                        .addChoices(
                            { name: 'View status', value: 'view' },
                            { name: 'Use inspiration', value: 'use' },
                            { name: 'Grant inspiration (DM)', value: 'grant' }
                        )))
        )

        // Stats & Leaderboards
        .addSubcommandGroup(group =>
            group.setName('stats').setDescription('Statistics and achievements')
                .addSubcommand(sub => sub.setName('leaderboard').setDescription('View leaderboards')
                    .addStringOption(opt => opt.setName('type').setDescription('Type').setRequired(false)
                        .addChoices({ name: 'Level', value: 'level' }, { name: 'Wealth', value: 'gold' },
                            { name: 'Monster Slayer', value: 'monsters_killed' }, { name: 'Quest Master', value: 'quests_completed' },
                            { name: 'Dungeon Delver', value: 'dungeons_cleared' }, { name: 'PvP Wins', value: 'pvp_wins' },
                            { name: 'PvP Rating', value: 'pvp_elo' })))
                .addSubcommand(sub => sub.setName('achievements').setDescription('View achievements'))
                .addSubcommand(sub => sub.setName('progress').setDescription('View achievement progress'))
                .addSubcommand(sub => sub.setName('server').setDescription('View server stats'))
        )

        // Guide (absorbed from /rpghelp)
        .addSubcommandGroup(group =>
            group.setName('guide').setDescription('RPG help and guide pages')
                .addSubcommand(sub => sub.setName('overview').setDescription('Quick start guide and basics'))
                .addSubcommand(sub => sub.setName('character').setDescription('Character creation info'))
                .addSubcommand(sub => sub.setName('dice').setDescription('Stat rolling methods'))
                .addSubcommand(sub => sub.setName('combat').setDescription('AI Dungeon Master and combat info'))
        )

        // Rest & Recovery (absorbed from /rpgstatus rest)
        .addSubcommandGroup(group =>
            group.setName('rest').setDescription('Rest and recovery mechanics')
                .addSubcommand(sub => sub.setName('short').setDescription('Short rest - spend hit dice to heal')
                    .addIntegerOption(opt => opt.setName('hit_dice').setDescription('Hit dice to spend').setRequired(false)
                        .setMinValue(0).setMaxValue(20)))
                .addSubcommand(sub => sub.setName('long').setDescription('Long rest - full HP and resource recovery'))
        )

        // Stat Rolling (absorbed from /rpgstatus statroll)
        .addSubcommandGroup(group =>
            group.setName('statroll').setDescription('Roll ability scores for character creation')
                .addSubcommand(sub => sub.setName('roll').setDescription('Roll 4d6 drop lowest for each stat'))
                .addSubcommand(sub => sub.setName('standard').setDescription('Use standard array (15, 14, 13, 12, 10, 8)'))
                .addSubcommand(sub => sub.setName('pointbuy').setDescription('Point buy system guide (27 points)'))
        ),

    async execute(interaction) {
        const characterManager = interaction.client.rpgCharacterManager;
        const combatManager = interaction.client.rpgCombatManager;
        const questManager = interaction.client.rpgQuestManager;
        const shopManager = interaction.client.rpgShopManager;

        if (!characterManager || !combatManager || !questManager || !shopManager) {
            await interaction.reply({
                content: 'RPG system is not available.',
                ephemeral: true
            });
            return;
        }

        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (subcommandGroup) {
                case 'character':
                    await handleCharacter(interaction, subcommand, characterManager);
                    break;
                case 'inventory':
                    await handleInventory(interaction, subcommand, characterManager, shopManager);
                    break;
                case 'roll':
                    await handleRoll(interaction, subcommand, characterManager);
                    break;
                case 'campaign':
                    await handleCampaign(interaction, subcommand, characterManager);
                    break;
                case 'session':
                    await handleSession(interaction, subcommand, characterManager);
                    break;
                case 'play':
                    await handlePlay(interaction, subcommand, characterManager);
                    break;
                case 'settings':
                    await handleSettings(interaction, subcommand);
                    break;
                case 'spell':
                    await handleSpell(interaction, subcommand, characterManager);
                    break;
                case 'resource':
                    await handleResource(interaction, subcommand, characterManager);
                    break;
                case 'condition':
                    await handleCondition(interaction, subcommand, characterManager);
                    break;
                case 'stats':
                    await handleStats(interaction, subcommand);
                    break;
                case 'guide':
                    await handleGuide(interaction, subcommand);
                    break;
                case 'rest':
                    await handleRest(interaction, subcommand, characterManager);
                    break;
                case 'statroll':
                    await handleStatroll(interaction, subcommand, characterManager);
                    break;
                default:
                    await interaction.reply({ content: 'Unknown command group.', ephemeral: true });
            }
        } catch (error) {
            logger.error('[RPG] Command error', { error: error.message, subcommandGroup, subcommand });

            const errorMessage = 'An error occurred while processing your RPG command.';
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: errorMessage }).catch(() => {});
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
            }
        }
    },

    async autocomplete(interaction) {
        await handleAutocomplete(interaction);
    },

    // Handle button interactions for guide navigation (rpgguide:prev/next:topic)
    async handleButton(interaction, args) {
        await handleGuideButton(interaction, args);
    },

    // Handle select menu interactions for guide navigation (rpgguide:select)
    async handleSelectMenu(interaction, selected) {
        await handleGuideSelectMenu(interaction, selected);
    },

    category: 'games'
};
