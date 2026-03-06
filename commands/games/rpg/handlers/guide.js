/**
 * RPG Guide Handler - Paginated help/guide system
 * Absorbed from rpg-help.js (formerly /rpghelp)
 */
import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder
} from 'discord.js';

// Help pages content
const HELP_PAGES = {
    quickstart: {
        title: 'Quick Start Guide',
        emoji: '🚀',
        embed: () => new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🚀 RPG Quick Start')
            .setDescription('Get started with D&D 5e in 3 simple steps!')
            .addFields(
                {
                    name: '1️⃣ Create a Character',
                    value: '```\n/rpg character create name:Thorin class:fighter species:dwarf background:soldier\n```',
                    inline: false
                },
                {
                    name: '2️⃣ Start an Adventure',
                    value: '```\n/rpg session start\n```',
                    inline: false
                },
                {
                    name: '3️⃣ Take Actions',
                    value: 'After starting, just type what you want to do:\n> "I search the room for hidden doors"\n> "I attack the goblin with my sword"\n> "I try to persuade the guard to let us pass"',
                    inline: false
                }
            )
            .setFooter({ text: 'Use the menu below to explore more topics' })
    },

    character: {
        title: 'Character Creation',
        emoji: '🧙',
        embed: () => new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🧙 Character Creation')
            .setDescription('Build your hero with D&D 5e options!')
            .addFields(
                {
                    name: '⚔️ Classes (12 Available)',
                    value: 'Barbarian, Bard, Cleric, Druid, Fighter, Monk, Paladin, Ranger, Rogue, Sorcerer, Warlock, Wizard',
                    inline: false
                },
                {
                    name: '🧝 Races (30+ Supported)',
                    value: 'Human, Elf, Dwarf, Halfling, Dragonborn, Gnome, Half-Elf, Half-Orc, Tiefling, Aasimar, Goliath, Tabaxi, Kenku, Firbolg, Kobold, and more!',
                    inline: false
                },
                {
                    name: '📜 Backgrounds (15 Available)',
                    value: 'Acolyte, Criminal, Folk Hero, Noble, Sage, Soldier, Charlatan, Entertainer, Guild Artisan, Hermit, Outlander, Sailor, Spy, Urchin',
                    inline: false
                },
                {
                    name: '✨ Racial Bonuses (Auto-Applied)',
                    value: '• **Dwarf:** +2 CON, Darkvision, Dwarven Resilience\n• **Elf:** +2 DEX, Darkvision, Fey Ancestry\n• **Human:** +1 to all stats\n• **Tiefling:** +2 CHA, +1 INT, Darkvision',
                    inline: false
                }
            )
    },

    statrolling: {
        title: 'Stat Rolling',
        emoji: '🎲',
        embed: () => new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎲 Stat Rolling Methods')
            .setDescription('Three ways to generate your ability scores!')
            .addFields(
                {
                    name: '🎯 Option 1: Roll for Stats (Classic)',
                    value: '```\n/rpg statroll roll\n```\nRolls 4d6, drops the lowest die, 6 times.\n> Roll 1: [6, 5, 4, 2] → 6+5+4 = **15** (dropped 2)',
                    inline: false
                },
                {
                    name: '📊 Option 2: Standard Array',
                    value: '```\n/rpg statroll standard\n```\nUse the balanced array: **15, 14, 13, 12, 10, 8**',
                    inline: false
                },
                {
                    name: '🛠️ Option 3: Point Buy',
                    value: '```\n/rpg statroll pointbuy\n```\nBuild your stats with 27 points. All stats start at 8.',
                    inline: false
                }
            )
    },

    aidm: {
        title: 'AI Dungeon Master',
        emoji: '🐉',
        embed: () => new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🐉 AI Dungeon Master')
            .setDescription('How the AI DM creates your adventure!')
            .addFields(
                {
                    name: '🎬 Starting a Session',
                    value: '```\n/rpg session start\n```\nThe AI generates a unique scenario based on your character\'s class, race, level, and backstory.',
                    inline: false
                },
                {
                    name: '💬 Taking Actions',
                    value: 'Just type normally after starting:\n• **Actions:** "I kick down the door"\n• **Dialogue:** "I ask the merchant about the missing shipment"\n• **Combat:** "I cast fireball at the enemies"\n• **Exploration:** "I examine the strange runes"',
                    inline: false
                },
                {
                    name: '🎯 How the DM Responds',
                    value: '1. **Reads your action** and determines response\n2. **Calls for rolls** when needed (dice buttons appear)\n3. **Applies consequences** - damage, healing, status effects\n4. **Tracks the story** - NPCs remember you, locations persist\n5. **Uses D&D 5e rules** - proper DCs, saves, combat rules',
                    inline: false
                },
                {
                    name: '📈 Difficulty Classes (DC)',
                    value: 'DC 5: Very Easy • DC 10: Easy • DC 15: Medium\nDC 20: Hard • DC 25: Very Hard • DC 30: Nearly Impossible',
                    inline: false
                }
            )
    },

    mechanics: {
        title: 'D&D 5e Mechanics',
        emoji: '⚙️',
        embed: () => new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('⚙️ D&D 5e Mechanics')
            .setDescription('Death saves, exhaustion, inspiration, and more!')
            .addFields(
                {
                    name: '💀 Death Saving Throws',
                    value: '```\n/rpg condition deathsave\n```\n• Roll 10+ = Success, under 10 = Failure\n• **Nat 1** = 2 failures\n• **Nat 20** = Regain 1 HP instantly!\n• 3 successes = Stabilized\n• 3 failures = Dead',
                    inline: false
                },
                {
                    name: '😫 Exhaustion Levels',
                    value: '```\n/rpg condition exhaustion\n```\n1: Disadvantage on ability checks\n2: Speed halved\n3: Disadvantage on attacks/saves\n4: HP maximum halved\n5: Speed reduced to 0\n6: **Death**',
                    inline: false
                },
                {
                    name: '✨ Inspiration',
                    value: '```\n/rpg condition inspiration\n```\nGranted by the DM for great roleplay. Use it for advantage on any roll!',
                    inline: false
                }
            )
    },

    rest: {
        title: 'Rest & Recovery',
        emoji: '🛏️',
        embed: () => new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🛏️ Rest & Recovery')
            .setDescription('Heal up and restore your resources!')
            .addFields(
                {
                    name: '⏰ Short Rest (1 hour)',
                    value: '```\n/rpg rest short hit_dice:2\n```\nSpend hit dice to heal. Each die = 1dX + CON modifier.',
                    inline: false
                },
                {
                    name: '🌙 Long Rest (8 hours)',
                    value: '```\n/rpg rest long\n```\n• Full HP restored\n• All spell slots/mana restored\n• Recover half your hit dice\n• Reduce exhaustion by 1',
                    inline: false
                }
            )
    },

    inventory: {
        title: 'Inventory System',
        emoji: '🎒',
        embed: () => new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎒 Inventory System')
            .setDescription('Manage your items and equipment!')
            .addFields(
                {
                    name: '👁️ View Inventory',
                    value: '```\n/rpg inventory view\n```',
                    inline: false
                },
                {
                    name: '⚔️ Equip/Unequip Items',
                    value: '```\n/rpg inventory equip item_id:5\n/rpg inventory unequip item_id:5\n```',
                    inline: false
                },
                {
                    name: '📦 Item Sources',
                    value: '• **Loot drops** from defeated enemies\n• **Shop purchases** with gold\n• **Quest rewards**\n• **Found during exploration**',
                    inline: false
                }
            )
    },

    continuity: {
        title: 'Story Continuity',
        emoji: '📖',
        embed: () => new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📖 Story Continuity & Progression')
            .setDescription('How your adventure persists across sessions!')
            .addFields(
                {
                    name: '🔄 How Continuity Works',
                    value: '1. **Session History** - Narrative saved to database\n2. **Context Window** - AI receives recent history\n3. **Character Memory** - NPCs, locations tracked\n4. **Quest Progress** - Active quests persist',
                    inline: false
                },
                {
                    name: '💾 What Gets Saved',
                    value: '• Your last actions and DM responses\n• Current location and scene description\n• Active NPCs and their dispositions\n• Quest states (active, completed, failed)\n• World events that have occurred',
                    inline: false
                },
                {
                    name: '📈 XP & Leveling',
                    value: '• Earn XP from combat, quests, and roleplay\n• Level up automatically when XP threshold is met\n• Each level increases: HP, proficiency bonus, and unlocks features',
                    inline: false
                }
            )
    },

    commands: {
        title: 'Command Reference',
        emoji: '📋',
        embed: () => new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📋 Command Reference')
            .setDescription('All RPG commands at a glance!')
            .addFields(
                {
                    name: '👤 Character',
                    value: '`/rpg character create` - Make a new character\n`/rpg character view` - View character sheet\n`/rpg character stats` - Detailed statistics\n`/rpg character delete` - Delete character',
                    inline: false
                },
                {
                    name: '🎮 Gameplay',
                    value: '`/rpg session start` - Begin AI DM adventure\n`/rpg session end` - End with recap\n`/rpg inventory view` - Check items\n`/rpg roll dice` - Roll any dice',
                    inline: false
                },
                {
                    name: '⚙️ Status Commands',
                    value: '`/rpg rest short` - Take a short rest\n`/rpg rest long` - Take a long rest\n`/rpg condition deathsave` - Death saving throw\n`/rpg condition exhaustion` - Check exhaustion\n`/rpg statroll roll` - Roll stats (4d6 drop lowest)',
                    inline: false
                },
                {
                    name: '📖 Guide',
                    value: '`/rpg guide overview` - Quick start guide\n`/rpg guide character` - Character creation info\n`/rpg guide dice` - Stat rolling methods\n`/rpg guide combat` - AI DM and combat info',
                    inline: false
                }
            )
    },

    tips: {
        title: 'Tips & Tricks',
        emoji: '💡',
        embed: () => new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('💡 Tips for Best Experience')
            .setDescription('Get the most out of your RPG sessions!')
            .addFields(
                {
                    name: '1. Be Descriptive',
                    value: '"I carefully search under the bed" works better than just "search"',
                    inline: false
                },
                {
                    name: '2. Stay in Character',
                    value: 'The DM responds to roleplay with better narrative',
                    inline: false
                },
                {
                    name: '3. Use the Environment',
                    value: 'Reference things the DM describes in your actions',
                    inline: false
                },
                {
                    name: '4. Ask Questions',
                    value: '"Do I notice anything unusual?" triggers Perception checks',
                    inline: false
                },
                {
                    name: '5. Collaborate',
                    value: 'In multiplayer, coordinate with your party!',
                    inline: false
                }
            )
            .setFooter({ text: 'This RPG uses D&D 5e rules with an AI DM powered by Google Gemini' })
    }
};

const PAGE_ORDER = ['quickstart', 'character', 'statrolling', 'aidm', 'mechanics', 'rest', 'inventory', 'continuity', 'commands', 'tips'];

// Map guide subcommands to page groups for initial display
const SUBCOMMAND_PAGE_MAP = {
    overview: 'quickstart',
    character: 'character',
    dice: 'statrolling',
    combat: 'aidm'
};

/**
 * Handle guide subcommands
 */
export async function handleGuide(interaction, subcommand) {
    const startPage = SUBCOMMAND_PAGE_MAP[subcommand] || 'quickstart';
    const pageIndex = PAGE_ORDER.indexOf(startPage);

    await sendGuidePage(interaction, startPage, pageIndex);
}

/**
 * Handle guide button interactions
 */
export async function handleGuideButton(interaction, args) {
    const [action, currentPage] = args;
    const currentIndex = PAGE_ORDER.indexOf(currentPage);
    let newIndex = currentIndex;

    if (action === 'prev') {
        newIndex = currentIndex > 0 ? currentIndex - 1 : PAGE_ORDER.length - 1;
    } else if (action === 'next') {
        newIndex = currentIndex < PAGE_ORDER.length - 1 ? currentIndex + 1 : 0;
    }

    const newTopic = PAGE_ORDER[newIndex];
    await sendGuidePage(interaction, newTopic, newIndex, true);
}

/**
 * Handle guide select menu interactions
 */
export async function handleGuideSelectMenu(interaction, selected) {
    const topic = selected[0];
    const pageIndex = PAGE_ORDER.indexOf(topic);
    await sendGuidePage(interaction, topic, pageIndex, true);
}

async function sendGuidePage(interaction, topic, pageIndex, isUpdate = false) {
    const page = HELP_PAGES[topic];
    if (!page) {
        return interaction.reply({ content: 'Unknown help topic.', ephemeral: true });
    }

    const embed = page.embed();
    embed.setFooter({ text: `Page ${pageIndex + 1}/${PAGE_ORDER.length} • Use buttons or menu to navigate` });

    // Navigation buttons
    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`rpgguide:prev:${topic}`)
            .setLabel('◀ Previous')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`rpgguide:next:${topic}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
    );

    // Topic select menu
    const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('rpgguide:select')
            .setPlaceholder('Jump to topic...')
            .addOptions(
                PAGE_ORDER.map(key => ({
                    label: HELP_PAGES[key].title,
                    value: key,
                    emoji: HELP_PAGES[key].emoji,
                    default: key === topic
                }))
            )
    );

    const payload = { embeds: [embed], components: [navRow, selectRow] };

    if (isUpdate) {
        await interaction.update(payload);
    } else {
        await interaction.reply(payload);
    }
}
