import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';

const POKEMON_PER_PAGE = 15;
const SHINY_CHANCE = 4096; // 1 in 4096
const SPAWN_COOLDOWN = 60000; // 60 seconds between spawns per channel
const SPAWN_EXPIRES = 300000; // 5 minutes to catch spawned Pokemon
const ADVENTURE_COOLDOWN = 1800000; // 30 minutes
const XP_PER_LEVEL = 100;
const XP_PER_CATCH = 50;
const XP_BATTLE_WIN = 100;
const XP_BATTLE_LOSE = 25;

// Dynamic spawn rate constants
const ACTIVITY_WINDOW = 300000; // 5 minutes to track active users
const BASE_SPAWN_RATE = 0.05; // 5% base rate for low activity
const MAX_SPAWN_RATE = 0.25; // 25% max rate for high activity
const ACTIVITY_THRESHOLD_LOW = 5; // Low activity threshold
const ACTIVITY_THRESHOLD_MEDIUM = 15; // Medium activity threshold
const ACTIVITY_THRESHOLD_HIGH = 30; // High activity threshold

// Track last spawn time per channel and user activity
const lastSpawnTime = new Map();
const adventureCooldowns = new Map();
const activeTrades = new Map();
const userActivity = new Map(); // Track user activity per guild: guildId -> Map(userId -> timestamp)

// Nature list
const NATURES = [
    'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
    'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
    'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
    'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
    'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky'
];

// Starter Pokemon IDs by generation
const STARTERS = {
    gen1: { bulbasaur: 1, charmander: 4, squirtle: 7 },
    gen2: { chikorita: 152, cyndaquil: 155, totodile: 158 },
    gen3: { treecko: 252, torchic: 255, mudkip: 258 },
    gen4: { turtwig: 387, chimchar: 390, piplup: 393 },
    gen5: { snivy: 495, tepig: 498, oshawott: 501 },
    gen6: { chespin: 650, fennekin: 653, froakie: 656 },
    gen7: { rowlet: 722, litten: 725, popplio: 728 },
    gen8: { grookey: 810, scorbunny: 813, sobble: 816 },
    gen9: { sprigatito: 906, fuecoco: 909, quaxly: 912 }
};

// Type effectiveness chart
const TYPE_CHART = {
    Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
    Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
    Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
    Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
    Grass: { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
    Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
    Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
    Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
    Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
    Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
    Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
    Bug: { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
    Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
    Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
    Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
    Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
    Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
    Fairy: { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 }
};

export default {
    category: 'games',
    data: new SlashCommandBuilder()
        .setName('pokemon')
        .setDescription('Pokemon catching and battling system')
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Start your Pokemon journey')
                .addStringOption(option =>
                    option.setName('starter')
                        .setDescription('Choose your starter Pokemon')
                        .setRequired(true)
                        .addChoices(
                            { name: '🌱 Bulbasaur (Gen 1)', value: 'gen1_bulbasaur' },
                            { name: '🔥 Charmander (Gen 1)', value: 'gen1_charmander' },
                            { name: '💧 Squirtle (Gen 1)', value: 'gen1_squirtle' },
                            { name: '🌱 Chikorita (Gen 2)', value: 'gen2_chikorita' },
                            { name: '🔥 Cyndaquil (Gen 2)', value: 'gen2_cyndaquil' },
                            { name: '💧 Totodile (Gen 2)', value: 'gen2_totodile' },
                            { name: '🌱 Treecko (Gen 3)', value: 'gen3_treecko' },
                            { name: '🔥 Torchic (Gen 3)', value: 'gen3_torchic' },
                            { name: '💧 Mudkip (Gen 3)', value: 'gen3_mudkip' },
                            { name: '🌱 Turtwig (Gen 4)', value: 'gen4_turtwig' },
                            { name: '🔥 Chimchar (Gen 4)', value: 'gen4_chimchar' },
                            { name: '💧 Piplup (Gen 4)', value: 'gen4_piplup' },
                            { name: '🌱 Snivy (Gen 5)', value: 'gen5_snivy' },
                            { name: '🔥 Tepig (Gen 5)', value: 'gen5_tepig' },
                            { name: '💧 Oshawott (Gen 5)', value: 'gen5_oshawott' },
                            { name: '🌱 Chespin (Gen 6)', value: 'gen6_chespin' },
                            { name: '🔥 Fennekin (Gen 6)', value: 'gen6_fennekin' },
                            { name: '💧 Froakie (Gen 6)', value: 'gen6_froakie' },
                            { name: '🌱 Rowlet (Gen 7)', value: 'gen7_rowlet' },
                            { name: '🔥 Litten (Gen 7)', value: 'gen7_litten' },
                            { name: '💧 Popplio (Gen 7)', value: 'gen7_popplio' },
                            { name: '🌱 Grookey (Gen 8)', value: 'gen8_grookey' },
                            { name: '🔥 Scorbunny (Gen 8)', value: 'gen8_scorbunny' },
                            { name: '💧 Sobble (Gen 8)', value: 'gen8_sobble' },
                            { name: '🌱 Sprigatito (Gen 9)', value: 'gen9_sprigatito' }
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('setchannel')
                .setDescription('Set the dedicated Pokemon channel (Admin only)')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('Channel for Pokemon spawns')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('catch')
                .setDescription('Catch a spawned Pokemon')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('Name of the Pokemon to catch')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('View your Pokemon collection'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('View detailed info about a Pokemon')
                .addIntegerOption(option =>
                    option.setName('number')
                        .setDescription('Pokemon number from your collection')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('select')
                .setDescription('Select your active Pokemon')
                .addIntegerOption(option =>
                    option.setName('number')
                        .setDescription('Pokemon number to select')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('favorite')
                .setDescription('Toggle favorite status')
                .addIntegerOption(option =>
                    option.setName('number')
                        .setDescription('Pokemon number')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('nickname')
                .setDescription('Give your Pokemon a nickname')
                .addIntegerOption(option =>
                    option.setName('number')
                        .setDescription('Pokemon number')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('New nickname (leave empty to remove)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('release')
                .setDescription('Release a Pokemon')
                .addIntegerOption(option =>
                    option.setName('number')
                        .setDescription('Pokemon number to release')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('evolve')
                .setDescription('Evolve a Pokemon')
                .addIntegerOption(option =>
                    option.setName('number')
                        .setDescription('Pokemon number to evolve')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('battle')
                .setDescription('Battle another trainer')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('User to battle')
                        .setRequired(true)))
        .addSubcommandGroup(group =>
            group
                .setName('market')
                .setDescription('Pokemon marketplace')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('list')
                        .setDescription('View all market listings'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('sell')
                        .setDescription('List a Pokemon for sale')
                        .addIntegerOption(option =>
                            option.setName('number')
                                .setDescription('Pokemon number to sell')
                                .setRequired(true))
                        .addIntegerOption(option =>
                            option.setName('price')
                                .setDescription('Price in Pokecoins')
                                .setRequired(true)
                                .setMinValue(1)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('buy')
                        .setDescription('Purchase a Pokemon from the market')
                        .addIntegerOption(option =>
                            option.setName('listing_id')
                                .setDescription('Market listing ID')
                                .setRequired(true))))
        .addSubcommandGroup(group =>
            group
                .setName('trade')
                .setDescription('Trade Pokemon with other trainers')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('start')
                        .setDescription('Start a trade with another user')
                        .addUserOption(option =>
                            option.setName('user')
                                .setDescription('User to trade with')
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('offer')
                        .setDescription('Offer a Pokemon in your active trade')
                        .addIntegerOption(option =>
                            option.setName('number')
                                .setDescription('Pokemon number to offer')
                                .setRequired(true)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('confirm')
                        .setDescription('Confirm and complete the trade'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('cancel')
                        .setDescription('Cancel your active trade')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('adventure')
                .setDescription('Go on an adventure to find wild Pokemon'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('index')
                .setDescription('Browse all Pokemon')
                .addStringOption(option =>
                    option.setName('search')
                        .setDescription('Search for Pokemon by name')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('dex')
                .setDescription('View your Pokedex'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('inventory')
                .setDescription('View your items and currency'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('daily')
                .setDescription('Claim your daily rewards'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('spawninfo')
                .setDescription('View current spawn rate and server activity'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('spawnconfig')
                .setDescription('Configure spawn rate settings (Admin only)')
                .addBooleanOption(option =>
                    option.setName('enabled')
                        .setDescription('Enable or disable Pokemon spawning')
                        .setRequired(false))
                .addNumberOption(option =>
                    option.setName('min_rate')
                        .setDescription('Minimum spawn rate (0.01-0.50, e.g., 0.05 = 5%)')
                        .setMinValue(0.01)
                        .setMaxValue(0.50)
                        .setRequired(false))
                .addNumberOption(option =>
                    option.setName('max_rate')
                        .setDescription('Maximum spawn rate (0.01-0.50, e.g., 0.25 = 25%)')
                        .setMinValue(0.01)
                        .setMaxValue(0.50)
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('activity_tracking')
                        .setDescription('Enable/disable activity-based spawn rates')
                        .setRequired(false))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const group = interaction.options.getSubcommandGroup();

        try {
            if (group === 'market') {
                switch (subcommand) {
                    case 'list':
                        await handleMarketList(interaction);
                        break;
                    case 'sell':
                        await handleMarketSell(interaction);
                        break;
                    case 'buy':
                        await handleMarketBuy(interaction);
                        break;
                }
            } else if (group === 'trade') {
                switch (subcommand) {
                    case 'start':
                        await handleTradeStart(interaction);
                        break;
                    case 'offer':
                        await handleTradeOffer(interaction);
                        break;
                    case 'confirm':
                        await handleTradeConfirm(interaction);
                        break;
                    case 'cancel':
                        await handleTradeCancel(interaction);
                        break;
                }
            } else {
                switch (subcommand) {
                    case 'start':
                        await handleStart(interaction);
                        break;
                    case 'setchannel':
                        await handleSetChannel(interaction);
                        break;
                    case 'catch':
                        await handleCatch(interaction);
                        break;
                    case 'list':
                        await handleList(interaction);
                        break;
                    case 'info':
                        await handleInfo(interaction);
                        break;
                    case 'select':
                        await handleSelect(interaction);
                        break;
                    case 'favorite':
                        await handleFavorite(interaction);
                        break;
                    case 'nickname':
                        await handleNickname(interaction);
                        break;
                    case 'release':
                        await handleRelease(interaction);
                        break;
                    case 'evolve':
                        await handleEvolve(interaction);
                        break;
                    case 'battle':
                        await handleBattle(interaction);
                        break;
                    case 'adventure':
                        await handleAdventure(interaction);
                        break;
                    case 'index':
                        await handleIndex(interaction);
                        break;
                    case 'dex':
                        await handlePokedex(interaction);
                        break;
                    case 'inventory':
                        await handleInventory(interaction);
                        break;
                    case 'daily':
                        await handleDaily(interaction);
                        break;
                    case 'spawninfo':
                        await handleSpawnInfo(interaction);
                        break;
                    case 'spawnconfig':
                        await handleSpawnConfig(interaction);
                        break;
                    default:
                        await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
                }
            }
        } catch (error) {
            console.error('Pokemon command error:', error);
            const reply = { content: 'An error occurred. Please try again later.', ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};

// Spawn system - called by message handler
// Helper function to track user activity
function trackUserActivity(guildId, userId) {
    if (!userActivity.has(guildId)) {
        userActivity.set(guildId, new Map());
    }
    const guildActivity = userActivity.get(guildId);
    guildActivity.set(userId, Date.now());
}

// Helper function to get active user count in the last 5 minutes
function getActiveUserCount(guildId) {
    if (!userActivity.has(guildId)) {
        return 0;
    }

    const guildActivity = userActivity.get(guildId);
    const now = Date.now();
    let activeCount = 0;

    // Clean up old entries and count active users
    for (const [userId, timestamp] of guildActivity.entries()) {
        if (now - timestamp > ACTIVITY_WINDOW) {
            guildActivity.delete(userId);
        } else {
            activeCount++;
        }
    }

    return activeCount;
}

// Helper function to calculate dynamic spawn rate based on activity
async function calculateSpawnRate(guildId) {
    // Get spawn settings from database
    let minRate = BASE_SPAWN_RATE;
    let maxRate = MAX_SPAWN_RATE;
    let trackingEnabled = true;

    try {
        const [settingsRows] = await pool.execute(
            `SELECT min_spawn_rate, max_spawn_rate, activity_tracking_enabled FROM pokemon_settings WHERE guild_id = ?`,
            [guildId]
        );

        if (settingsRows.length > 0) {
            const settings = settingsRows[0];
            if (settings.min_spawn_rate !== null) minRate = parseFloat(settings.min_spawn_rate);
            if (settings.max_spawn_rate !== null) maxRate = parseFloat(settings.max_spawn_rate);
            if (settings.activity_tracking_enabled !== null) trackingEnabled = settings.activity_tracking_enabled;
        }
    } catch (error) {
        console.error('Error fetching spawn settings:', error);
    }

    // If activity tracking is disabled, return base rate
    if (!trackingEnabled) {
        return minRate;
    }

    const activeUsers = getActiveUserCount(guildId);

    // Scale spawn rate based on active users
    if (activeUsers <= ACTIVITY_THRESHOLD_LOW) {
        // Low activity: use min rate
        return minRate;
    } else if (activeUsers <= ACTIVITY_THRESHOLD_MEDIUM) {
        // Medium activity: scale from min to 50% of range
        const scale = (activeUsers - ACTIVITY_THRESHOLD_LOW) / (ACTIVITY_THRESHOLD_MEDIUM - ACTIVITY_THRESHOLD_LOW);
        return minRate + (scale * (maxRate - minRate) * 0.35);
    } else if (activeUsers <= ACTIVITY_THRESHOLD_HIGH) {
        // High activity: scale from 50% to 80% of range
        const scale = (activeUsers - ACTIVITY_THRESHOLD_MEDIUM) / (ACTIVITY_THRESHOLD_HIGH - ACTIVITY_THRESHOLD_MEDIUM);
        const midRate = minRate + (maxRate - minRate) * 0.35;
        const highRate = minRate + (maxRate - minRate) * 0.80;
        return midRate + (scale * (highRate - midRate));
    } else {
        // Very high activity: scale from 80% to max (capped)
        const scale = Math.min((activeUsers - ACTIVITY_THRESHOLD_HIGH) / 20, 1);
        const highRate = minRate + (maxRate - minRate) * 0.80;
        return highRate + (scale * (maxRate - highRate));
    }
}

export async function spawnPokemon(message) {
    const channelId = message.channel.id;
    const guildId = message.guild.id;
    const userId = message.author.id;

    // Track user activity for dynamic spawn rates
    trackUserActivity(guildId, userId);

    // Check cooldown
    const lastSpawn = lastSpawnTime.get(channelId) || 0;
    if (Date.now() - lastSpawn < SPAWN_COOLDOWN) {
        return;
    }

    // Calculate dynamic spawn rate based on server activity
    const spawnRate = await calculateSpawnRate(guildId);
    if (Math.random() > spawnRate) {
        return;
    }

    try {
        // Get dedicated Pokemon channel setting
        const [settingsRows] = await pool.execute(
            `SELECT pokemon_channel_id FROM pokemon_settings WHERE guild_id = ?`,
            [guildId]
        );

        let spawnChannelId = channelId;
        let spawnChannel = message.channel;

        // If dedicated channel is set, use it
        if (settingsRows.length > 0 && settingsRows[0].pokemon_channel_id) {
            spawnChannelId = settingsRows[0].pokemon_channel_id;
            spawnChannel = await message.guild.channels.fetch(spawnChannelId).catch(() => null);
            if (!spawnChannel) {
                spawnChannel = message.channel;
                spawnChannelId = channelId;
            }
        }

        // Delete any existing spawn in this channel (new spawn replaces old)
        await pool.execute(
            `DELETE FROM pokemon_spawns WHERE guild_id = ? AND channel_id = ?`,
            [guildId, spawnChannelId]
        );

        // Select random Pokemon (weighted towards common ones)
        const [pokemonRows] = await pool.execute(
            `SELECT * FROM pokemon_data WHERE catch_rate > 45 ORDER BY RAND() LIMIT 1`
        );

        if (pokemonRows.length === 0) {
            return;
        }

        const pokemon = pokemonRows[0];
        const isShiny = Math.random() < (1 / SHINY_CHANCE);

        // Create spawn (expires_at kept for compatibility but not used for expiry)
        const expiresAt = new Date(Date.now() + SPAWN_EXPIRES);
        await pool.execute(
            `INSERT INTO pokemon_spawns (guild_id, channel_id, pokemon_id, is_shiny, expires_at) VALUES (?, ?, ?, ?, ?)`,
            [guildId, spawnChannelId, pokemon.id, isShiny, expiresAt]
        );

        lastSpawnTime.set(channelId, Date.now());

        // Get Pokemon image - use official artwork for large, high-quality images (like Poketwo)
        const imageUrl = isShiny
            ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/shiny/${pokemon.id}.png`
            : `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${pokemon.id}.png`;

        const shinyText = isShiny ? '✨ **SHINY** ' : '';

        // Poketwo-style spawn: larger image, cleaner format
        const embed = new EmbedBuilder()
            .setColor(isShiny ? 0xFFD700 : 0x3498db)
            .setDescription(
                `**A wild ${shinyText}Pokémon has appeared!**\n\n` +
                `Guess the Pokémon and type \`/pokemon catch <name>\` to catch it!\n\n` +
                `*This Pokémon will remain until caught or a new one spawns!*`
            )
            .setImage(imageUrl)
            .setTimestamp();

        await spawnChannel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Spawn error:', error);
    }
}

// Helper function to calculate stats
function calculateStat(base, iv, level, stat) {
    if (stat === 'hp') {
        return Math.floor(((2 * base + iv) * level / 100) + level + 10);
    }
    return Math.floor(((2 * base + iv) * level / 100) + 5);
}

// Helper function to check and award XP
async function awardXP(userPokemonId, xpAmount) {
    const [pokemonRows] = await pool.execute(
        `SELECT * FROM user_pokemon WHERE id = ?`,
        [userPokemonId]
    );

    if (pokemonRows.length === 0) return;

    const pokemon = pokemonRows[0];
    let newXP = pokemon.xp + xpAmount;
    let newLevel = pokemon.level;

    while (newXP >= XP_PER_LEVEL) {
        newXP -= XP_PER_LEVEL;
        newLevel++;
    }

    await pool.execute(
        `UPDATE user_pokemon SET xp = ?, level = ? WHERE id = ?`,
        [newXP, newLevel, userPokemonId]
    );

    return { leveled: newLevel > pokemon.level, newLevel, oldLevel: pokemon.level };
}

// Helper function for type effectiveness
function getTypeEffectiveness(attackType, defenderType1, defenderType2) {
    let effectiveness = 1;

    if (TYPE_CHART[attackType] && TYPE_CHART[attackType][defenderType1] !== undefined) {
        effectiveness *= TYPE_CHART[attackType][defenderType1];
    }

    if (defenderType2 && TYPE_CHART[attackType] && TYPE_CHART[attackType][defenderType2] !== undefined) {
        effectiveness *= TYPE_CHART[attackType][defenderType2];
    }

    return effectiveness;
}

// START HANDLER
async function handleStart(interaction) {
    const starter = interaction.options.getString('starter');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    // Check if user already has Pokemon
    const [existingRows] = await pool.execute(
        `SELECT id FROM user_pokemon WHERE user_id = ? AND guild_id = ? LIMIT 1`,
        [userId, guildId]
    );

    if (existingRows.length > 0) {
        return await interaction.reply({
            content: 'You have already started your Pokemon journey!',
            ephemeral: true
        });
    }

    // Parse starter format: gen1_bulbasaur -> gen1, bulbasaur
    const [gen, starterName] = starter.split('_');
    const pokemonId = STARTERS[gen][starterName];

    // Initialize user inventory
    await pool.execute(
        `INSERT IGNORE INTO user_inventory (user_id, guild_id, pokeballs) VALUES (?, ?, 10)`,
        [userId, guildId]
    );

    // Generate random IVs
    const ivs = {
        hp: Math.floor(Math.random() * 32),
        attack: Math.floor(Math.random() * 32),
        defense: Math.floor(Math.random() * 32),
        sp_attack: Math.floor(Math.random() * 32),
        sp_defense: Math.floor(Math.random() * 32),
        speed: Math.floor(Math.random() * 32)
    };

    const nature = NATURES[Math.floor(Math.random() * NATURES.length)];

    // Give starter Pokemon
    await pool.execute(
        `INSERT INTO user_pokemon (user_id, guild_id, pokemon_id, level, iv_hp, iv_attack, iv_defense, iv_sp_attack, iv_sp_defense, iv_speed, nature, is_selected)
         VALUES (?, ?, ?, 5, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
        [userId, guildId, pokemonId, ivs.hp, ivs.attack, ivs.defense, ivs.sp_attack, ivs.sp_defense, ivs.speed, nature]
    );

    // Update Pokedex
    await pool.execute(
        `INSERT INTO user_pokedex (user_id, guild_id, pokemon_id, times_caught)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE times_caught = times_caught + 1`,
        [userId, guildId, pokemonId]
    );

    const [pokemonData] = await pool.execute(
        `SELECT name FROM pokemon_data WHERE id = ?`,
        [pokemonId]
    );

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('Your Pokemon Journey Begins!')
        .setDescription(`Congratulations! You received a **${pokemonData[0].name}** as your starter!\n\nYou also received 10 Pokeballs to start your adventure. Good luck, Trainer!`)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// SET CHANNEL HANDLER
async function handleSetChannel(interaction) {
    // Check for Administrator permission
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return await interaction.reply({
            content: 'You need Administrator permission to use this command.',
            ephemeral: true
        });
    }

    const channel = interaction.options.getChannel('channel');
    const guildId = interaction.guild.id;

    // Update or insert pokemon_settings
    await pool.execute(
        `INSERT INTO pokemon_settings (guild_id, pokemon_channel_id, spawn_enabled)
         VALUES (?, ?, TRUE)
         ON DUPLICATE KEY UPDATE pokemon_channel_id = ?`,
        [guildId, channel.id, channel.id]
    );

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('Pokemon Channel Set!')
        .setDescription(`All Pokemon spawns will now appear in ${channel}`)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// CATCH HANDLER
async function handleCatch(interaction) {
    const pokemonName = interaction.options.getString('name').toLowerCase();
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const channelId = interaction.channel.id;

    // Check for active spawn in this channel (no expiry check - spawns persist until caught)
    const [spawnRows] = await pool.execute(
        `SELECT s.*, p.* FROM pokemon_spawns s
         JOIN pokemon_data p ON s.pokemon_id = p.id
         WHERE s.guild_id = ? AND s.channel_id = ?`,
        [guildId, channelId]
    );

    if (spawnRows.length === 0) {
        return await interaction.reply({
            content: 'There is no wild Pokemon here! Wait for one to spawn.',
            ephemeral: true
        });
    }

    const spawn = spawnRows[0];

    // Check if name matches
    if (spawn.name.toLowerCase() !== pokemonName) {
        return await interaction.reply({
            content: 'That\'s not the right Pokemon! Try again.',
            ephemeral: true
        });
    }

    // Initialize user inventory if needed
    await pool.execute(
        `INSERT IGNORE INTO user_inventory (user_id, guild_id) VALUES (?, ?)`,
        [userId, guildId]
    );

    // Generate random IVs (0-31)
    const ivs = {
        hp: Math.floor(Math.random() * 32),
        attack: Math.floor(Math.random() * 32),
        defense: Math.floor(Math.random() * 32),
        sp_attack: Math.floor(Math.random() * 32),
        sp_defense: Math.floor(Math.random() * 32),
        speed: Math.floor(Math.random() * 32)
    };

    const nature = NATURES[Math.floor(Math.random() * NATURES.length)];

    // Catch Pokemon
    const [result] = await pool.execute(
        `INSERT INTO user_pokemon (user_id, guild_id, pokemon_id, iv_hp, iv_attack, iv_defense, iv_sp_attack, iv_sp_defense, iv_speed, nature, is_shiny, xp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [userId, guildId, spawn.pokemon_id, ivs.hp, ivs.attack, ivs.defense, ivs.sp_attack, ivs.sp_defense, ivs.speed, nature, spawn.is_shiny]
    );

    const userPokemonId = result.insertId;

    // Award XP and check for level up
    const xpResult = await awardXP(userPokemonId, XP_PER_CATCH);

    // Update Pokedex
    await pool.execute(
        `INSERT INTO user_pokedex (user_id, guild_id, pokemon_id, times_caught)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE times_caught = times_caught + 1`,
        [userId, guildId, spawn.pokemon_id]
    );

    // Remove spawn
    await pool.execute(
        `DELETE FROM pokemon_spawns WHERE id = ?`,
        [spawn.id]
    );

    // Calculate total IV percentage
    const totalIV = Object.values(ivs).reduce((a, b) => a + b, 0);
    const ivPercentage = ((totalIV / 186) * 100).toFixed(2);

    const shinyText = spawn.is_shiny ? ' ✨ **SHINY**' : '';
    const typeText = spawn.type2 ? `${spawn.type1}/${spawn.type2}` : spawn.type1;
    const levelUpText = xpResult && xpResult.leveled ? `\n\nYour ${spawn.name} grew to level ${xpResult.newLevel}!` : '';

    const embed = new EmbedBuilder()
        .setColor(spawn.is_shiny ? 0xFFD700 : 0x2ecc71)
        .setTitle(`Congratulations! ${interaction.user.username} caught ${spawn.name}!${shinyText}`)
        .setDescription(`**Level:** ${xpResult ? xpResult.newLevel : 1}\n**Type:** ${typeText}\n**Nature:** ${nature}\n**IV:** ${ivPercentage}%\n**XP:** ${XP_PER_CATCH} gained${levelUpText}`)
        .setFooter({ text: `Added to your collection as #${userPokemonId}` })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// LIST HANDLER
async function handleList(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const [pokemonRows] = await pool.execute(
        `SELECT up.*, pd.name, pd.type1, pd.type2
         FROM user_pokemon up
         JOIN pokemon_data pd ON up.pokemon_id = pd.id
         WHERE up.user_id = ? AND up.guild_id = ?
         ORDER BY up.is_favorite DESC, up.id ASC`,
        [userId, guildId]
    );

    if (pokemonRows.length === 0) {
        return await interaction.reply({
            content: 'You haven\'t caught any Pokemon yet! Use /pokemon start to begin your journey.',
            ephemeral: true
        });
    }

    const totalPages = Math.ceil(pokemonRows.length / POKEMON_PER_PAGE);
    let currentPage = 0;

    const generateEmbed = (page) => {
        const start = page * POKEMON_PER_PAGE;
        const end = start + POKEMON_PER_PAGE;
        const pagePokemon = pokemonRows.slice(start, end);

        const pokemonList = pagePokemon.map(p => {
            const typeText = p.type2 ? `${p.type1}/${p.type2}` : p.type1;
            const shiny = p.is_shiny ? '✨' : '';
            const favorite = p.is_favorite ? '⭐' : '';
            const selected = p.is_selected ? '👉' : '';
            const nickname = p.nickname ? `"${p.nickname}"` : '';
            return `${selected} **#${p.id}** ${shiny}${favorite} Lv. ${p.level} ${p.name} ${nickname} • ${typeText}`;
        }).join('\n');

        return new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle(`${interaction.user.username}'s Pokemon Collection`)
            .setDescription(pokemonList || 'No Pokemon on this page.')
            .setFooter({ text: `Page ${page + 1}/${totalPages} • ${pokemonRows.length} total Pokemon | ✨ Shiny | ⭐ Favorite | 👉 Selected` });
    };

    const generateButtons = (page) => {
        return new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('pokemon_prev')
                    .setLabel('◀ Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('pokemon_next')
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );
    };

    const message = await interaction.reply({
        embeds: [generateEmbed(currentPage)],
        components: totalPages > 1 ? [generateButtons(currentPage)] : [],
        fetchReply: true
    });

    if (totalPages <= 1) return;

    const collector = message.createMessageComponentCollector({
        filter: i => i.user.id === userId,
        time: 300000
    });

    collector.on('collect', async i => {
        if (i.customId === 'pokemon_prev') {
            currentPage--;
        } else if (i.customId === 'pokemon_next') {
            currentPage++;
        }

        await i.update({
            embeds: [generateEmbed(currentPage)],
            components: [generateButtons(currentPage)]
        });
    });

    collector.on('end', () => {
        message.edit({ components: [] }).catch(() => {});
    });
}

// INFO HANDLER
async function handleInfo(interaction) {
    const pokemonNumber = interaction.options.getInteger('number');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const [pokemonRows] = await pool.execute(
        `SELECT up.*, pd.*
         FROM user_pokemon up
         JOIN pokemon_data pd ON up.pokemon_id = pd.id
         WHERE up.id = ? AND up.user_id = ? AND up.guild_id = ?`,
        [pokemonNumber, userId, guildId]
    );

    if (pokemonRows.length === 0) {
        return await interaction.reply({
            content: 'You don\'t own a Pokemon with that number.',
            ephemeral: true
        });
    }

    const p = pokemonRows[0];

    // Calculate stats
    const stats = {
        hp: calculateStat(p.base_hp, p.iv_hp, p.level, 'hp'),
        attack: calculateStat(p.base_attack, p.iv_attack, p.level),
        defense: calculateStat(p.base_defense, p.iv_defense, p.level),
        sp_attack: calculateStat(p.base_sp_attack, p.iv_sp_attack, p.level),
        sp_defense: calculateStat(p.base_sp_defense, p.iv_sp_defense, p.level),
        speed: calculateStat(p.base_speed, p.iv_speed, p.level)
    };

    const totalIV = p.iv_hp + p.iv_attack + p.iv_defense + p.iv_sp_attack + p.iv_sp_defense + p.iv_speed;
    const ivPercentage = ((totalIV / 186) * 100).toFixed(2);

    const typeText = p.type2 ? `${p.type1}/${p.type2}` : p.type1;
    const shinyText = p.is_shiny ? ' ✨ **SHINY**' : '';
    const title = p.nickname ? `${p.name} "${p.nickname}"` : p.name;

    const embed = new EmbedBuilder()
        .setColor(p.is_shiny ? 0xFFD700 : 0x3498db)
        .setTitle(`#${p.id} ${title}${shinyText}`)
        .setDescription(`**Type:** ${typeText}\n**Nature:** ${p.nature}\n**Level:** ${p.level} (XP: ${p.xp}/${XP_PER_LEVEL})`)
        .addFields(
            { name: '📊 Stats', value: `HP: ${stats.hp}\nAttack: ${stats.attack}\nDefense: ${stats.defense}\nSp. Atk: ${stats.sp_attack}\nSp. Def: ${stats.sp_defense}\nSpeed: ${stats.speed}`, inline: true },
            { name: '🧬 IVs', value: `HP: ${p.iv_hp}/31\nAttack: ${p.iv_attack}/31\nDefense: ${p.iv_defense}/31\nSp. Atk: ${p.iv_sp_attack}/31\nSp. Def: ${p.iv_sp_defense}/31\nSpeed: ${p.iv_speed}/31`, inline: true },
            { name: '📈 Total IV', value: `${ivPercentage}%\n${p.is_favorite ? '⭐ Favorite' : ''}\n${p.is_selected ? '👉 Selected' : ''}`, inline: true }
        )
        .setFooter({ text: `Caught on ${new Date(p.caught_at).toLocaleDateString()}` });

    await interaction.reply({ embeds: [embed] });
}

// SELECT HANDLER
async function handleSelect(interaction) {
    const pokemonNumber = interaction.options.getInteger('number');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    // Unselect all
    await pool.execute(
        `UPDATE user_pokemon SET is_selected = FALSE WHERE user_id = ? AND guild_id = ?`,
        [userId, guildId]
    );

    // Select new
    const [result] = await pool.execute(
        `UPDATE user_pokemon SET is_selected = TRUE WHERE id = ? AND user_id = ? AND guild_id = ?`,
        [pokemonNumber, userId, guildId]
    );

    if (result.affectedRows === 0) {
        return await interaction.reply({
            content: 'You don\'t own a Pokemon with that number.',
            ephemeral: true
        });
    }

    await interaction.reply({ content: `Pokemon #${pokemonNumber} is now your selected Pokemon!` });
}

// FAVORITE HANDLER
async function handleFavorite(interaction) {
    const pokemonNumber = interaction.options.getInteger('number');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const [result] = await pool.execute(
        `UPDATE user_pokemon SET is_favorite = NOT is_favorite WHERE id = ? AND user_id = ? AND guild_id = ?`,
        [pokemonNumber, userId, guildId]
    );

    if (result.affectedRows === 0) {
        return await interaction.reply({
            content: 'You don\'t own a Pokemon with that number.',
            ephemeral: true
        });
    }

    await interaction.reply({ content: `Toggled favorite status for Pokemon #${pokemonNumber}!` });
}

// NICKNAME HANDLER
async function handleNickname(interaction) {
    const pokemonNumber = interaction.options.getInteger('number');
    const nickname = interaction.options.getString('name') || null;
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    if (nickname && nickname.length > 50) {
        return await interaction.reply({
            content: 'Nickname must be 50 characters or less.',
            ephemeral: true
        });
    }

    const [result] = await pool.execute(
        `UPDATE user_pokemon SET nickname = ? WHERE id = ? AND user_id = ? AND guild_id = ?`,
        [nickname, pokemonNumber, userId, guildId]
    );

    if (result.affectedRows === 0) {
        return await interaction.reply({
            content: 'You don\'t own a Pokemon with that number.',
            ephemeral: true
        });
    }

    const message = nickname
        ? `Pokemon #${pokemonNumber} is now nicknamed "${nickname}"!`
        : `Removed nickname from Pokemon #${pokemonNumber}!`;

    await interaction.reply({ content: message });
}

// RELEASE HANDLER
async function handleRelease(interaction) {
    const pokemonNumber = interaction.options.getInteger('number');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const [pokemonRows] = await pool.execute(
        `SELECT up.*, pd.name FROM user_pokemon up
         JOIN pokemon_data pd ON up.pokemon_id = pd.id
         WHERE up.id = ? AND up.user_id = ? AND up.guild_id = ?`,
        [pokemonNumber, userId, guildId]
    );

    if (pokemonRows.length === 0) {
        return await interaction.reply({
            content: 'You don\'t own a Pokemon with that number.',
            ephemeral: true
        });
    }

    const pokemon = pokemonRows[0];

    await pool.execute(
        `DELETE FROM user_pokemon WHERE id = ?`,
        [pokemonNumber]
    );

    await interaction.reply({ content: `You released ${pokemon.name}. Goodbye, friend!` });
}

// EVOLVE HANDLER
async function handleEvolve(interaction) {
    const pokemonNumber = interaction.options.getInteger('number');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const [pokemonRows] = await pool.execute(
        `SELECT up.*, pd.name, pd.evolution_to, pd.evolution_level, evo.name as evo_name
         FROM user_pokemon up
         JOIN pokemon_data pd ON up.pokemon_id = pd.id
         LEFT JOIN pokemon_data evo ON pd.evolution_to = evo.id
         WHERE up.id = ? AND up.user_id = ? AND up.guild_id = ?`,
        [pokemonNumber, userId, guildId]
    );

    if (pokemonRows.length === 0) {
        return await interaction.reply({
            content: 'You don\'t own a Pokemon with that number.',
            ephemeral: true
        });
    }

    const pokemon = pokemonRows[0];

    if (!pokemon.evolution_to) {
        return await interaction.reply({
            content: `${pokemon.name} cannot evolve!`,
            ephemeral: true
        });
    }

    if (pokemon.level < pokemon.evolution_level) {
        return await interaction.reply({
            content: `${pokemon.name} needs to be level ${pokemon.evolution_level} to evolve! (Current: ${pokemon.level})`,
            ephemeral: true
        });
    }

    // Evolve the Pokemon
    await pool.execute(
        `UPDATE user_pokemon SET pokemon_id = ? WHERE id = ?`,
        [pokemon.evolution_to, pokemonNumber]
    );

    const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('Congratulations!')
        .setDescription(`Your ${pokemon.name} evolved into ${pokemon.evo_name}!`)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// BATTLE HANDLER
async function handleBattle(interaction) {
    await interaction.deferReply();

    const challenger = interaction.user;
    const opponent = interaction.options.getUser('user');
    const guildId = interaction.guild.id;

    if (opponent.bot) {
        return await interaction.editReply({ content: 'You cannot battle a bot!' });
    }

    if (challenger.id === opponent.id) {
        return await interaction.editReply({ content: 'You cannot battle yourself!' });
    }

    // Get challenger's selected Pokemon
    const [challengerPokemon] = await pool.execute(
        `SELECT up.id as user_pokemon_id, up.*, pd.*
         FROM user_pokemon up
         JOIN pokemon_data pd ON up.pokemon_id = pd.id
         WHERE up.user_id = ? AND up.guild_id = ? AND up.is_selected = TRUE
         LIMIT 1`,
        [challenger.id, guildId]
    );

    if (challengerPokemon.length === 0) {
        return await interaction.editReply({ content: 'You don\'t have a Pokemon selected! Use /pokemon select.' });
    }

    // Get opponent's selected Pokemon
    const [opponentPokemon] = await pool.execute(
        `SELECT up.id as user_pokemon_id, up.*, pd.*
         FROM user_pokemon up
         JOIN pokemon_data pd ON up.pokemon_id = pd.id
         WHERE up.user_id = ? AND up.guild_id = ? AND up.is_selected = TRUE
         LIMIT 1`,
        [opponent.id, guildId]
    );

    if (opponentPokemon.length === 0) {
        return await interaction.editReply({ content: `${opponent.username} doesn't have a Pokemon selected!` });
    }

    const p1 = challengerPokemon[0];
    const p2 = opponentPokemon[0];

    // Calculate stats for both Pokemon
    const p1Stats = {
        hp: calculateStat(p1.base_hp, p1.iv_hp, p1.level, 'hp'),
        attack: calculateStat(p1.base_attack, p1.iv_attack, p1.level),
        defense: calculateStat(p1.base_defense, p1.iv_defense, p1.level),
        sp_attack: calculateStat(p1.base_sp_attack, p1.iv_sp_attack, p1.level),
        sp_defense: calculateStat(p1.base_sp_defense, p1.iv_sp_defense, p1.level),
        speed: calculateStat(p1.base_speed, p1.iv_speed, p1.level)
    };

    const p2Stats = {
        hp: calculateStat(p2.base_hp, p2.iv_hp, p2.level, 'hp'),
        attack: calculateStat(p2.base_attack, p2.iv_attack, p2.level),
        defense: calculateStat(p2.base_defense, p2.iv_defense, p2.level),
        sp_attack: calculateStat(p2.base_sp_attack, p2.iv_sp_attack, p2.level),
        sp_defense: calculateStat(p2.base_sp_defense, p2.iv_sp_defense, p2.level),
        speed: calculateStat(p2.base_speed, p2.iv_speed, p2.level)
    };

    let p1HP = p1Stats.hp;
    let p2HP = p2Stats.hp;

    // Get moves for both Pokemon
    const [p1Moves] = await pool.execute(
        `SELECT * FROM pokemon_moves WHERE type = ? OR type = ? ORDER BY RAND() LIMIT 4`,
        [p1.type1, p1.type2 || p1.type1]
    );

    const [p2Moves] = await pool.execute(
        `SELECT * FROM pokemon_moves WHERE type = ? OR type = ? ORDER BY RAND() LIMIT 4`,
        [p2.type1, p2.type2 || p2.type1]
    );

    if (p1Moves.length === 0 || p2Moves.length === 0) {
        return await interaction.editReply({ content: 'Error: No moves available for battle!' });
    }

    // Battle log
    const battleLog = [];
    battleLog.push(`**Battle Start!**\n${challenger.username}'s ${p1.name} (Lv.${p1.level}) vs ${opponent.username}'s ${p2.name} (Lv.${p2.level})\n`);

    // Determine who goes first (based on speed)
    let firstAttacker = p1Stats.speed >= p2Stats.speed ? 'p1' : 'p2';
    let turn = 0;
    const maxTurns = 20;

    while (p1HP > 0 && p2HP > 0 && turn < maxTurns) {
        turn++;
        const currentAttacker = (turn % 2 === 1) ? firstAttacker : (firstAttacker === 'p1' ? 'p2' : 'p1');

        if (currentAttacker === 'p1') {
            // P1 attacks
            const move = p1Moves[Math.floor(Math.random() * p1Moves.length)];
            const effectiveness = getTypeEffectiveness(move.type, p2.type1, p2.type2);

            let damage = 0;
            if (move.category === 'Physical') {
                damage = Math.floor(((2 * p1.level / 5 + 2) * move.power * p1Stats.attack / p2Stats.defense / 50 + 2) * effectiveness);
            } else if (move.category === 'Special') {
                damage = Math.floor(((2 * p1.level / 5 + 2) * move.power * p1Stats.sp_attack / p2Stats.sp_defense / 50 + 2) * effectiveness);
            }

            damage = Math.max(1, damage);
            p2HP -= damage;

            let effectText = '';
            if (effectiveness > 1) effectText = ' It\'s super effective!';
            if (effectiveness < 1) effectText = ' It\'s not very effective...';

            battleLog.push(`${p1.name} used **${move.name}**! (${damage} damage)${effectText}`);
        } else {
            // P2 attacks
            const move = p2Moves[Math.floor(Math.random() * p2Moves.length)];
            const effectiveness = getTypeEffectiveness(move.type, p1.type1, p1.type2);

            let damage = 0;
            if (move.category === 'Physical') {
                damage = Math.floor(((2 * p2.level / 5 + 2) * move.power * p2Stats.attack / p1Stats.defense / 50 + 2) * effectiveness);
            } else if (move.category === 'Special') {
                damage = Math.floor(((2 * p2.level / 5 + 2) * move.power * p2Stats.sp_attack / p1Stats.sp_defense / 50 + 2) * effectiveness);
            }

            damage = Math.max(1, damage);
            p1HP -= damage;

            let effectText = '';
            if (effectiveness > 1) effectText = ' It\'s super effective!';
            if (effectiveness < 1) effectText = ' It\'s not very effective...';

            battleLog.push(`${p2.name} used **${move.name}**! (${damage} damage)${effectText}`);
        }
    }

    // Determine winner
    let winnerId, loserId, winnerName, loserName;
    if (p1HP > p2HP) {
        winnerId = challenger.id;
        loserId = opponent.id;
        winnerName = challenger.username;
        loserName = opponent.username;
        battleLog.push(`\n**${challenger.username}'s ${p1.name} wins!**`);
    } else {
        winnerId = opponent.id;
        loserId = challenger.id;
        winnerName = opponent.username;
        loserName = challenger.username;
        battleLog.push(`\n**${opponent.username}'s ${p2.name} wins!**`);
    }

    // Award XP
    const winnerPokemonId = winnerId === challenger.id ? p1.user_pokemon_id : p2.user_pokemon_id;
    const loserPokemonId = loserId === challenger.id ? p1.user_pokemon_id : p2.user_pokemon_id;

    const winnerXP = await awardXP(winnerPokemonId, XP_BATTLE_WIN);
    const loserXP = await awardXP(loserPokemonId, XP_BATTLE_LOSE);

    if (winnerXP && winnerXP.leveled) {
        battleLog.push(`${winnerName}'s Pokemon grew to level ${winnerXP.newLevel}!`);
    }

    // Save battle to database
    await pool.execute(
        `INSERT INTO pokemon_battles (guild_id, challenger_id, opponent_id, challenger_pokemon_id, opponent_pokemon_id, winner_id, battle_log)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [guildId, challenger.id, opponent.id, p1.user_pokemon_id, p2.user_pokemon_id, winnerId, battleLog.join('\n')]
    );

    const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('Pokemon Battle!')
        .setDescription(battleLog.slice(0, 10).join('\n') + (battleLog.length > 10 ? '\n...(battle log truncated)' : ''))
        .addFields(
            { name: 'Winner', value: `${winnerName} (+${XP_BATTLE_WIN} XP)`, inline: true },
            { name: 'Loser', value: `${loserName} (+${XP_BATTLE_LOSE} XP)`, inline: true }
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

// MARKET LIST HANDLER
async function handleMarketList(interaction) {
    const guildId = interaction.guild.id;

    const [marketRows] = await pool.execute(
        `SELECT pm.*, pd.name, pd.type1, pd.type2, up.level, up.is_shiny
         FROM pokemon_market pm
         JOIN user_pokemon up ON pm.user_pokemon_id = up.id
         JOIN pokemon_data pd ON up.pokemon_id = pd.id
         WHERE pm.guild_id = ?
         ORDER BY pm.created_at DESC`,
        [guildId]
    );

    if (marketRows.length === 0) {
        return await interaction.reply({
            content: 'The market is empty! Use /pokemon market sell to list a Pokemon.',
            ephemeral: true
        });
    }

    const totalPages = Math.ceil(marketRows.length / POKEMON_PER_PAGE);
    let currentPage = 0;

    const generateEmbed = (page) => {
        const start = page * POKEMON_PER_PAGE;
        const end = start + POKEMON_PER_PAGE;
        const pageListings = marketRows.slice(start, end);

        const listingText = pageListings.map(m => {
            const typeText = m.type2 ? `${m.type1}/${m.type2}` : m.type1;
            const shiny = m.is_shiny ? '✨' : '';
            return `**Listing #${m.id}** ${shiny} Lv.${m.level} ${m.name} • ${typeText} - **${m.price}** Pokecoins`;
        }).join('\n');

        return new EmbedBuilder()
            .setColor(0xf39c12)
            .setTitle('Pokemon Market')
            .setDescription(listingText || 'No listings on this page.')
            .setFooter({ text: `Page ${page + 1}/${totalPages} • ${marketRows.length} total listings | Use /pokemon market buy <id> to purchase` });
    };

    const generateButtons = (page) => {
        return new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('market_prev')
                    .setLabel('◀ Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('market_next')
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );
    };

    const message = await interaction.reply({
        embeds: [generateEmbed(currentPage)],
        components: totalPages > 1 ? [generateButtons(currentPage)] : [],
        fetchReply: true
    });

    if (totalPages <= 1) return;

    const collector = message.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        time: 300000
    });

    collector.on('collect', async i => {
        if (i.customId === 'market_prev') {
            currentPage--;
        } else if (i.customId === 'market_next') {
            currentPage++;
        }

        await i.update({
            embeds: [generateEmbed(currentPage)],
            components: [generateButtons(currentPage)]
        });
    });

    collector.on('end', () => {
        message.edit({ components: [] }).catch(() => {});
    });
}

// MARKET SELL HANDLER
async function handleMarketSell(interaction) {
    const pokemonNumber = interaction.options.getInteger('number');
    const price = interaction.options.getInteger('price');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    // Check if Pokemon exists and belongs to user
    const [pokemonRows] = await pool.execute(
        `SELECT up.*, pd.name FROM user_pokemon up
         JOIN pokemon_data pd ON up.pokemon_id = pd.id
         WHERE up.id = ? AND up.user_id = ? AND up.guild_id = ?`,
        [pokemonNumber, userId, guildId]
    );

    if (pokemonRows.length === 0) {
        return await interaction.reply({
            content: 'You don\'t own a Pokemon with that number.',
            ephemeral: true
        });
    }

    const pokemon = pokemonRows[0];

    if (pokemon.is_selected) {
        return await interaction.reply({
            content: 'You cannot sell your selected Pokemon! Select a different one first.',
            ephemeral: true
        });
    }

    // Create market listing
    await pool.execute(
        `INSERT INTO pokemon_market (seller_user_id, guild_id, user_pokemon_id, price)
         VALUES (?, ?, ?, ?)`,
        [userId, guildId, pokemonNumber, price]
    );

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('Listed on Market!')
        .setDescription(`Your ${pokemon.name} is now listed for **${price}** Pokecoins!`)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// MARKET BUY HANDLER
async function handleMarketBuy(interaction) {
    const listingId = interaction.options.getInteger('listing_id');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    // Get listing
    const [listingRows] = await pool.execute(
        `SELECT pm.*, pd.name, up.pokemon_id
         FROM pokemon_market pm
         JOIN user_pokemon up ON pm.user_pokemon_id = up.id
         JOIN pokemon_data pd ON up.pokemon_id = pd.id
         WHERE pm.id = ? AND pm.guild_id = ?`,
        [listingId, guildId]
    );

    if (listingRows.length === 0) {
        return await interaction.reply({
            content: 'That listing doesn\'t exist!',
            ephemeral: true
        });
    }

    const listing = listingRows[0];

    if (listing.seller_user_id === userId) {
        return await interaction.reply({
            content: 'You cannot buy your own listing!',
            ephemeral: true
        });
    }

    // Check buyer's funds
    const [buyerInv] = await pool.execute(
        `SELECT pokecoins FROM user_inventory WHERE user_id = ? AND guild_id = ?`,
        [userId, guildId]
    );

    if (buyerInv.length === 0 || buyerInv[0].pokecoins < listing.price) {
        return await interaction.reply({
            content: `You don't have enough Pokecoins! Need ${listing.price}, have ${buyerInv[0]?.pokecoins || 0}.`,
            ephemeral: true
        });
    }

    // Process transaction
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Transfer Pokemon
        await connection.execute(
            `UPDATE user_pokemon SET user_id = ? WHERE id = ?`,
            [userId, listing.user_pokemon_id]
        );

        // Transfer money
        await connection.execute(
            `UPDATE user_inventory SET pokecoins = pokecoins - ? WHERE user_id = ? AND guild_id = ?`,
            [listing.price, userId, guildId]
        );

        await connection.execute(
            `UPDATE user_inventory SET pokecoins = pokecoins + ? WHERE user_id = ? AND guild_id = ?`,
            [listing.price, listing.seller_user_id, guildId]
        );

        // Remove listing
        await connection.execute(
            `DELETE FROM pokemon_market WHERE id = ?`,
            [listingId]
        );

        await connection.commit();

        const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('Purchase Complete!')
            .setDescription(`You purchased ${listing.name} for **${listing.price}** Pokecoins!`)
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// TRADE START HANDLER
async function handleTradeStart(interaction) {
    const partner = interaction.options.getUser('user');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    if (partner.bot) {
        return await interaction.reply({
            content: 'You cannot trade with a bot!',
            ephemeral: true
        });
    }

    if (partner.id === userId) {
        return await interaction.reply({
            content: 'You cannot trade with yourself!',
            ephemeral: true
        });
    }

    const tradeKey = `${guildId}_${userId}`;
    if (activeTrades.has(tradeKey)) {
        return await interaction.reply({
            content: 'You already have an active trade!',
            ephemeral: true
        });
    }

    // Create trade record
    const [result] = await pool.execute(
        `INSERT INTO pokemon_trades (guild_id, user1_id, user2_id, status)
         VALUES (?, ?, ?, 'pending')`,
        [guildId, userId, partner.id]
    );

    activeTrades.set(tradeKey, {
        tradeId: result.insertId,
        user1: userId,
        user2: partner.id,
        user1Pokemon: null,
        user2Pokemon: null,
        user1Confirmed: false,
        user2Confirmed: false
    });

    const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('Trade Started!')
        .setDescription(`Trade between ${interaction.user.username} and ${partner.username}\n\nBoth users use /pokemon trade offer to offer Pokemon, then /pokemon trade confirm to complete.`)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// TRADE OFFER HANDLER
async function handleTradeOffer(interaction) {
    const pokemonNumber = interaction.options.getInteger('number');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const tradeKey = `${guildId}_${userId}`;
    let trade = activeTrades.get(tradeKey);

    if (!trade) {
        // Check if user is user2 in another trade
        for (const [key, t] of activeTrades.entries()) {
            if (t.user2 === userId && key.startsWith(guildId)) {
                trade = t;
                break;
            }
        }
    }

    if (!trade) {
        return await interaction.reply({
            content: 'You don\'t have an active trade! Use /pokemon trade start first.',
            ephemeral: true
        });
    }

    // Verify Pokemon ownership
    const [pokemonRows] = await pool.execute(
        `SELECT up.*, pd.name FROM user_pokemon up
         JOIN pokemon_data pd ON up.pokemon_id = pd.id
         WHERE up.id = ? AND up.user_id = ? AND up.guild_id = ?`,
        [pokemonNumber, userId, guildId]
    );

    if (pokemonRows.length === 0) {
        return await interaction.reply({
            content: 'You don\'t own a Pokemon with that number.',
            ephemeral: true
        });
    }

    const pokemon = pokemonRows[0];

    // Update trade offer
    if (trade.user1 === userId) {
        trade.user1Pokemon = pokemonNumber;
        trade.user1Confirmed = false;
    } else {
        trade.user2Pokemon = pokemonNumber;
        trade.user2Confirmed = false;
    }

    await interaction.reply({ content: `You offered ${pokemon.name} for trade!` });
}

// TRADE CONFIRM HANDLER
async function handleTradeConfirm(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const tradeKey = `${guildId}_${userId}`;
    let trade = activeTrades.get(tradeKey);

    if (!trade) {
        for (const [key, t] of activeTrades.entries()) {
            if (t.user2 === userId && key.startsWith(guildId)) {
                trade = t;
                break;
            }
        }
    }

    if (!trade) {
        return await interaction.reply({
            content: 'You don\'t have an active trade!',
            ephemeral: true
        });
    }

    if (!trade.user1Pokemon || !trade.user2Pokemon) {
        return await interaction.reply({
            content: 'Both users must offer a Pokemon before confirming!',
            ephemeral: true
        });
    }

    // Mark user as confirmed
    if (trade.user1 === userId) {
        trade.user1Confirmed = true;
    } else {
        trade.user2Confirmed = true;
    }

    if (!trade.user1Confirmed || !trade.user2Confirmed) {
        return await interaction.reply({ content: 'You confirmed! Waiting for the other trainer...' });
    }

    // Both confirmed - execute trade
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Swap Pokemon ownership
        await connection.execute(
            `UPDATE user_pokemon SET user_id = ? WHERE id = ?`,
            [trade.user2, trade.user1Pokemon]
        );

        await connection.execute(
            `UPDATE user_pokemon SET user_id = ? WHERE id = ?`,
            [trade.user1, trade.user2Pokemon]
        );

        // Update trade status
        await connection.execute(
            `UPDATE pokemon_trades SET status = 'completed', user1_pokemon_id = ?, user2_pokemon_id = ? WHERE id = ?`,
            [trade.user1Pokemon, trade.user2Pokemon, trade.tradeId]
        );

        await connection.commit();

        // Remove from active trades
        activeTrades.delete(`${guildId}_${trade.user1}`);

        const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('Trade Complete!')
            .setDescription('The Pokemon have been traded successfully!')
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

// TRADE CANCEL HANDLER
async function handleTradeCancel(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const tradeKey = `${guildId}_${userId}`;
    let trade = activeTrades.get(tradeKey);
    let foundKey = tradeKey;

    if (!trade) {
        for (const [key, t] of activeTrades.entries()) {
            if (t.user2 === userId && key.startsWith(guildId)) {
                trade = t;
                foundKey = `${guildId}_${t.user1}`;
                break;
            }
        }
    }

    if (!trade) {
        return await interaction.reply({
            content: 'You don\'t have an active trade!',
            ephemeral: true
        });
    }

    // Delete from database
    await pool.execute(
        `DELETE FROM pokemon_trades WHERE id = ?`,
        [trade.tradeId]
    );

    activeTrades.delete(foundKey);

    await interaction.reply({ content: 'Trade cancelled!' });
}

// ADVENTURE HANDLER
async function handleAdventure(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    // Check cooldown
    const cooldownKey = `${guildId}_${userId}`;
    const lastAdventure = adventureCooldowns.get(cooldownKey) || 0;
    const timeSince = Date.now() - lastAdventure;

    if (timeSince < ADVENTURE_COOLDOWN) {
        const minutesLeft = Math.ceil((ADVENTURE_COOLDOWN - timeSince) / 60000);
        return await interaction.reply({
            content: `You're tired from your last adventure! Rest for ${minutesLeft} more minutes.`,
            ephemeral: true
        });
    }

    adventureCooldowns.set(cooldownKey, Date.now());

    const outcomes = ['pokemon', 'pokeball', 'rarecandy', 'coins', 'nothing'];
    const weights = [0.3, 0.25, 0.1, 0.2, 0.15];

    const rand = Math.random();
    let sum = 0;
    let outcome = 'nothing';

    for (let i = 0; i < outcomes.length; i++) {
        sum += weights[i];
        if (rand <= sum) {
            outcome = outcomes[i];
            break;
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('Adventure!')
        .setTimestamp();

    // Initialize inventory if needed
    await pool.execute(
        `INSERT IGNORE INTO user_inventory (user_id, guild_id) VALUES (?, ?)`,
        [userId, guildId]
    );

    if (outcome === 'pokemon') {
        // Wild Pokemon encounter
        const [pokemonRows] = await pool.execute(
            `SELECT * FROM pokemon_data ORDER BY RAND() LIMIT 1`
        );

        const pokemon = pokemonRows[0];
        const isShiny = Math.random() < (1 / SHINY_CHANCE);
        const level = Math.floor(Math.random() * 10) + 1;

        const ivs = {
            hp: Math.floor(Math.random() * 32),
            attack: Math.floor(Math.random() * 32),
            defense: Math.floor(Math.random() * 32),
            sp_attack: Math.floor(Math.random() * 32),
            sp_defense: Math.floor(Math.random() * 32),
            speed: Math.floor(Math.random() * 32)
        };

        const nature = NATURES[Math.floor(Math.random() * NATURES.length)];

        const [result] = await pool.execute(
            `INSERT INTO user_pokemon (user_id, guild_id, pokemon_id, level, iv_hp, iv_attack, iv_defense, iv_sp_attack, iv_sp_defense, iv_speed, nature, is_shiny, xp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [userId, guildId, pokemon.id, level, ivs.hp, ivs.attack, ivs.defense, ivs.sp_attack, ivs.sp_defense, ivs.speed, nature, isShiny]
        );

        // Update Pokedex
        await pool.execute(
            `INSERT INTO user_pokedex (user_id, guild_id, pokemon_id, times_caught)
             VALUES (?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE times_caught = times_caught + 1`,
            [userId, guildId, pokemon.id]
        );

        await awardXP(result.insertId, Math.floor(Math.random() * 50) + 25);

        embed.setDescription(`You encountered a wild ${isShiny ? '✨ **SHINY** ' : ''}**${pokemon.name}** (Lv.${level}) and caught it!`);
    } else if (outcome === 'pokeball') {
        const amount = Math.floor(Math.random() * 5) + 3;
        await pool.execute(
            `UPDATE user_inventory SET pokeballs = pokeballs + ? WHERE user_id = ? AND guild_id = ?`,
            [amount, userId, guildId]
        );
        embed.setDescription(`You found **${amount}** Pokeballs!`);
    } else if (outcome === 'rarecandy') {
        const amount = Math.floor(Math.random() * 3) + 1;
        await pool.execute(
            `UPDATE user_inventory SET rare_candies = rare_candies + ? WHERE user_id = ? AND guild_id = ?`,
            [amount, userId, guildId]
        );
        embed.setDescription(`You found **${amount}** Rare Candies!`);
    } else if (outcome === 'coins') {
        const amount = Math.floor(Math.random() * 500) + 100;
        await pool.execute(
            `UPDATE user_inventory SET pokecoins = pokecoins + ? WHERE user_id = ? AND guild_id = ?`,
            [amount, userId, guildId]
        );
        embed.setDescription(`You found **${amount}** Pokecoins!`);
    } else {
        embed.setDescription('You searched around but didn\'t find anything interesting...');
    }

    await interaction.reply({ embeds: [embed] });
}

// INDEX HANDLER
async function handleIndex(interaction) {
    const search = interaction.options.getString('search');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    let query = `SELECT pd.*, udex.times_caught FROM pokemon_data pd
                 LEFT JOIN user_pokedex udex ON pd.id = udex.pokemon_id
                 AND udex.user_id = ? AND udex.guild_id = ?`;
    let params = [userId, guildId];

    if (search) {
        query += ` WHERE pd.name LIKE ?`;
        params.push(`%${search}%`);
    }

    query += ` ORDER BY pd.id ASC`;

    const [pokemonRows] = await pool.execute(query, params);

    if (pokemonRows.length === 0) {
        return await interaction.reply({
            content: search ? `No Pokemon found matching "${search}".` : 'No Pokemon found.',
            ephemeral: true
        });
    }

    const totalPages = Math.ceil(pokemonRows.length / POKEMON_PER_PAGE);
    let currentPage = 0;

    const generateEmbed = (page) => {
        const start = page * POKEMON_PER_PAGE;
        const end = start + POKEMON_PER_PAGE;
        const pagePokemon = pokemonRows.slice(start, end);

        const pokemonList = pagePokemon.map(p => {
            const typeText = p.type2 ? `${p.type1}/${p.type2}` : p.type1;
            const caught = p.times_caught ? `✓ Caught ${p.times_caught}x` : '✗ Not caught';
            return `**#${p.id}** ${p.name} • ${typeText} - ${caught}`;
        }).join('\n');

        return new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle(search ? `Pokemon Index - Search: "${search}"` : 'Pokemon Index')
            .setDescription(pokemonList || 'No Pokemon on this page.')
            .setFooter({ text: `Page ${page + 1}/${totalPages} • ${pokemonRows.length} Pokemon` });
    };

    const generateButtons = (page) => {
        return new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('index_prev')
                    .setLabel('◀ Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('index_next')
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );
    };

    const message = await interaction.reply({
        embeds: [generateEmbed(currentPage)],
        components: totalPages > 1 ? [generateButtons(currentPage)] : [],
        fetchReply: true
    });

    if (totalPages <= 1) return;

    const collector = message.createMessageComponentCollector({
        filter: i => i.user.id === userId,
        time: 300000
    });

    collector.on('collect', async i => {
        if (i.customId === 'index_prev') {
            currentPage--;
        } else if (i.customId === 'index_next') {
            currentPage++;
        }

        await i.update({
            embeds: [generateEmbed(currentPage)],
            components: [generateButtons(currentPage)]
        });
    });

    collector.on('end', () => {
        message.edit({ components: [] }).catch(() => {});
    });
}

// POKEDEX HANDLER
async function handlePokedex(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const [dexRows] = await pool.execute(
        `SELECT pd.name, pd.type1, pd.type2, udex.times_caught
         FROM user_pokedex udex
         JOIN pokemon_data pd ON udex.pokemon_id = pd.id
         WHERE udex.user_id = ? AND udex.guild_id = ?
         ORDER BY pd.id ASC`,
        [userId, guildId]
    );

    const [totalCount] = await pool.execute(`SELECT COUNT(*) as total FROM pokemon_data`);
    const caughtCount = dexRows.length;
    const totalPokemon = totalCount[0].total;

    const dexText = dexRows.slice(0, 20).map(p => {
        const typeText = p.type2 ? `${p.type1}/${p.type2}` : p.type1;
        return `• **${p.name}** (${typeText}) - Caught ${p.times_caught}x`;
    }).join('\n') || 'No Pokemon caught yet!';

    const completion = ((caughtCount / totalPokemon) * 100).toFixed(2);

    const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle(`${interaction.user.username}'s Pokedex`)
        .setDescription(`**Completion:** ${caughtCount}/${totalPokemon} (${completion}%)\n\n${dexText}`)
        .setFooter({ text: dexRows.length > 20 ? `Showing first 20 of ${caughtCount} caught species` : `${caughtCount} species caught` });

    await interaction.reply({ embeds: [embed] });
}

// INVENTORY HANDLER
async function handleInventory(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const [invRows] = await pool.execute(
        `SELECT * FROM user_inventory WHERE user_id = ? AND guild_id = ?`,
        [userId, guildId]
    );

    if (invRows.length === 0) {
        await pool.execute(
            `INSERT INTO user_inventory (user_id, guild_id) VALUES (?, ?)`,
            [userId, guildId]
        );

        const [newRows] = await pool.execute(
            `SELECT * FROM user_inventory WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId]
        );
        invRows[0] = newRows[0];
    }

    const inv = invRows[0];

    const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle(`${interaction.user.username}'s Inventory`)
        .addFields(
            { name: 'Pokecoins', value: `${inv.pokecoins}`, inline: true },
            { name: 'Pokeballs', value: `${inv.pokeballs}`, inline: true },
            { name: 'Great Balls', value: `${inv.greatballs}`, inline: true },
            { name: 'Ultra Balls', value: `${inv.ultraballs}`, inline: true },
            { name: 'Master Balls', value: `${inv.masterballs}`, inline: true },
            { name: 'Rare Candies', value: `${inv.rare_candies}`, inline: true },
            { name: 'Shiny Charm', value: inv.shiny_charm ? 'Owned' : 'Not owned', inline: true }
        );

    await interaction.reply({ embeds: [embed] });
}

// DAILY HANDLER
async function handleDaily(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const [invRows] = await pool.execute(
        `SELECT *, UNIX_TIMESTAMP(last_daily) as last_daily_unix FROM user_inventory WHERE user_id = ? AND guild_id = ?`,
        [userId, guildId]
    );

    let inv;
    if (invRows.length === 0) {
        await pool.execute(
            `INSERT INTO user_inventory (user_id, guild_id) VALUES (?, ?)`,
            [userId, guildId]
        );
        inv = null;
    } else {
        inv = invRows[0];
    }

    // Check if already claimed today (24 hours = 86400 seconds)
    if (inv && inv.last_daily_unix) {
        const now = Math.floor(Date.now() / 1000); // Current Unix timestamp in seconds
        const secondsSince = now - inv.last_daily_unix;
        const SECONDS_IN_DAY = 86400; // Exactly 24 hours

        if (secondsSince < SECONDS_IN_DAY) {
            const secondsLeft = SECONDS_IN_DAY - secondsSince;
            const hoursLeft = Math.floor(secondsLeft / 3600);
            const minutesLeft = Math.floor((secondsLeft % 3600) / 60);

            const timeText = hoursLeft > 0
                ? `${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''} and ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}`
                : `${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}`;

            return await interaction.reply({
                content: `You've already claimed your daily rewards! Come back in ${timeText}.`,
                ephemeral: true
            });
        }
    }

    // Grant rewards
    const pokecoinReward = 500;
    const pokeballReward = 5;

    await pool.execute(
        `UPDATE user_inventory
         SET pokecoins = pokecoins + ?, pokeballs = pokeballs + ?, last_daily = NOW()
         WHERE user_id = ? AND guild_id = ?`,
        [pokecoinReward, pokeballReward, userId, guildId]
    );

    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('Daily Rewards Claimed!')
        .setDescription(`You received:\n**${pokecoinReward}** Pokecoins\n**${pokeballReward}** Pokeballs`)
        .setFooter({ text: 'Come back tomorrow for more rewards!' });

    await interaction.reply({ embeds: [embed] });
}

// SPAWN INFO HANDLER
async function handleSpawnInfo(interaction) {
    const guildId = interaction.guild.id;

    // Get current spawn settings
    const [settingsRows] = await pool.execute(
        `SELECT min_spawn_rate, max_spawn_rate, activity_tracking_enabled FROM pokemon_settings WHERE guild_id = ?`,
        [guildId]
    );

    let minRate = BASE_SPAWN_RATE;
    let maxRate = MAX_SPAWN_RATE;
    let trackingEnabled = true;

    if (settingsRows.length > 0) {
        const settings = settingsRows[0];
        if (settings.min_spawn_rate !== null) minRate = parseFloat(settings.min_spawn_rate);
        if (settings.max_spawn_rate !== null) maxRate = parseFloat(settings.max_spawn_rate);
        if (settings.activity_tracking_enabled !== null) trackingEnabled = settings.activity_tracking_enabled;
    }

    // Get current active users and spawn rate
    const activeUsers = getActiveUserCount(guildId);
    const currentSpawnRate = await calculateSpawnRate(guildId);

    // Create activity bar
    const maxBarLength = 20;
    let activityLevel = 0;
    if (activeUsers <= ACTIVITY_THRESHOLD_LOW) {
        activityLevel = Math.min(activeUsers / ACTIVITY_THRESHOLD_LOW, 1);
    } else if (activeUsers <= ACTIVITY_THRESHOLD_MEDIUM) {
        activityLevel = 0.33 + (activeUsers - ACTIVITY_THRESHOLD_LOW) / (ACTIVITY_THRESHOLD_MEDIUM - ACTIVITY_THRESHOLD_LOW) * 0.33;
    } else if (activeUsers <= ACTIVITY_THRESHOLD_HIGH) {
        activityLevel = 0.66 + (activeUsers - ACTIVITY_THRESHOLD_MEDIUM) / (ACTIVITY_THRESHOLD_HIGH - ACTIVITY_THRESHOLD_MEDIUM) * 0.34;
    } else {
        activityLevel = 1;
    }

    const filledBars = Math.round(activityLevel * maxBarLength);
    const emptyBars = maxBarLength - filledBars;
    const activityBar = '█'.repeat(filledBars) + '░'.repeat(emptyBars);

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📊 Pokemon Spawn Information')
        .addFields(
            { name: '👥 Active Users (Last 5 min)', value: `${activeUsers} users`, inline: true },
            { name: '🎲 Current Spawn Rate', value: `${(currentSpawnRate * 100).toFixed(1)}%`, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: '📉 Min Spawn Rate', value: `${(minRate * 100).toFixed(1)}%`, inline: true },
            { name: '📈 Max Spawn Rate', value: `${(maxRate * 100).toFixed(1)}%`, inline: true },
            { name: '🔄 Activity Tracking', value: trackingEnabled ? 'Enabled ✅' : 'Disabled ❌', inline: true },
            { name: '📊 Server Activity', value: `\`${activityBar}\``, inline: false }
        )
        .setFooter({ text: 'Spawn rate increases with server activity!' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// SPAWN CONFIG HANDLER
async function handleSpawnConfig(interaction) {
    const guildId = interaction.guild.id;

    // Check admin permission
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return await interaction.reply({
            content: 'You need Administrator permission to configure spawn settings.',
            ephemeral: true
        });
    }

    const enabled = interaction.options.getBoolean('enabled');
    const minRate = interaction.options.getNumber('min_rate');
    const maxRate = interaction.options.getNumber('max_rate');
    const activityTracking = interaction.options.getBoolean('activity_tracking');

    // If no options provided, show current settings
    if (enabled === null && minRate === null && maxRate === null && activityTracking === null) {
        return await interaction.reply({
            content: 'Please provide at least one setting to configure. Use `/pokemon spawninfo` to view current settings.',
            ephemeral: true
        });
    }

    // Validate min/max rates
    if (minRate !== null && maxRate !== null && minRate > maxRate) {
        return await interaction.reply({
            content: 'Minimum spawn rate cannot be greater than maximum spawn rate!',
            ephemeral: true
        });
    }

    // Initialize settings if not exists
    await pool.execute(
        `INSERT IGNORE INTO pokemon_settings (guild_id) VALUES (?)`,
        [guildId]
    );

    // Update settings
    const updates = [];
    const values = [];

    if (enabled !== null) {
        updates.push('spawn_enabled = ?');
        values.push(enabled);
    }
    if (minRate !== null) {
        updates.push('min_spawn_rate = ?');
        values.push(minRate);
    }
    if (maxRate !== null) {
        updates.push('max_spawn_rate = ?');
        values.push(maxRate);
    }
    if (activityTracking !== null) {
        updates.push('activity_tracking_enabled = ?');
        values.push(activityTracking);
    }

    values.push(guildId);

    await pool.execute(
        `UPDATE pokemon_settings SET ${updates.join(', ')} WHERE guild_id = ?`,
        values
    );

    const changesText = [];
    if (enabled !== null) changesText.push(`**Pokemon Spawning:** ${enabled ? 'Enabled ✅' : 'Disabled ❌'}`);
    if (minRate !== null) changesText.push(`**Min Rate:** ${(minRate * 100).toFixed(1)}%`);
    if (maxRate !== null) changesText.push(`**Max Rate:** ${(maxRate * 100).toFixed(1)}%`);
    if (activityTracking !== null) changesText.push(`**Activity Tracking:** ${activityTracking ? 'Enabled ✅' : 'Disabled ❌'}`);

    const embed = new EmbedBuilder()
        .setColor(enabled === false ? 0xe74c3c : 0x2ecc71)
        .setTitle(enabled === false ? '🔴 Pokemon System Disabled' : '✅ Spawn Settings Updated')
        .setDescription(`The following settings have been updated:\n\n${changesText.join('\n')}`)
        .setFooter({ text: enabled === false ? 'Pokemon will no longer spawn in this server' : 'Use /pokemon spawninfo to view detailed spawn information' });

    await interaction.reply({ embeds: [embed] });
}
