/**
 * Game Constants
 * All tuning numbers in one place for easy balancing
 */

export const GAME = {
    // Starting resources
    STARTING_CASH: 1000,
    STARTING_GROW_SLOTS: 2,
    STARTING_PLOTS: 2, // Alias for bot bridge compatibility
    MAX_GROW_SLOTS: 20,

    // XP and leveling
    XP_PER_LEVEL_BASE: 100,
    BASE_XP_PER_LEVEL: 100, // Alias for bot bridge compatibility
    XP_PER_LEVEL_MULTIPLIER: 1.15, // Each level needs 15% more XP
    XP_SCALING_FACTOR: 1.15, // Alias for bot bridge compatibility
    MAX_LEVEL: 100,

    // Daily rewards (for bot !cfxdaily command)
    DAILY_REWARD_BASE: 100, // Base currency reward
    DAILY_REWARD_PER_LEVEL: 10, // Extra per player level

    // Quality system (0-100)
    QUALITY_MIN: 0,
    QUALITY_MAX: 100,
    QUALITY_VARIANCE_PLANT: 15, // +/- when planting
    QUALITY_VARIANCE_HARVEST: 10, // +/- when harvesting

    // Yield variance
    YIELD_VARIANCE_PERCENT: 0.10, // +/- 10%

    // Grow time variance
    GROW_TIME_VARIANCE_PERCENT: 0.10, // +/- 10%

    // Withering
    WITHER_TIME_MULTIPLIER: 2.0, // Time after ready before withering
    WITHER_PENALTY_YIELD: 0.5, // 50% yield if harvested while withering
    WITHER_PENALTY_QUALITY: 0.5, // 50% quality if harvested while withering
};

export const MARKET = {
    // NPC quick-sell formula: base_price * (0.5 + quality/100 * 1.5)
    NPC_PRICE_FLOOR_MULTIPLIER: 0.5,
    NPC_PRICE_QUALITY_MULTIPLIER: 1.5,

    // Price engine
    DEMAND_BASE: 100,
    DEMAND_MIN: 50, // 50% of base price minimum
    DEMAND_MAX: 300, // 300% of base price maximum
    DEMAND_SUPPLY_FACTOR: 100, // Divide supply by this
    DEMAND_VELOCITY_FACTOR: 5, // Multiply purchase velocity by this

    // Listings
    LISTING_DURATION_HOURS: 24,
    LISTING_FEE_PERCENT: 0.05, // 5% fee
    MAX_LISTINGS_BASE: 3,

    // Price tick interval (ms)
    PRICE_TICK_INTERVAL: 300000, // 5 minutes
};

export const BREEDING = {
    // Genetics (each gene 0-100)
    GENE_KEYS: ['thc', 'cbd', 'yield', 'speed', 'quality', 'resilience'],

    // Crossover
    PARENT_WEIGHT_MIN: 0.4, // 40-60% weight per parent
    PARENT_WEIGHT_MAX: 0.6,
    CROSSOVER_NOISE_SIGMA: 5, // Gaussian noise sigma

    // Mutations
    MUTATION_CHANCE_BASE: 0.05, // 5% base
    MUTATION_SHIFT_MIN: 10,
    MUTATION_SHIFT_MAX: 20,

    // Strain matching (to determine if it's a new or existing strain)
    MATCH_THRESHOLD: 10, // Within 10 points per gene = match

    // Legendary breeding
    LEGENDARY_CHANCE_BASE: 0.05, // 5% base chance with epic+ parents
    LEGENDARY_PARENT_REQUIRED_RARITY: 'epic',

    // Breeding time (ms)
    BASE_BREED_TIME_MS: 900000, // 15 minutes base
    MAX_BREED_TIME_MS: 1800000, // 30 minutes max
};

export const SKILLS = {
    // Categories
    CATEGORIES: ['cultivation', 'business', 'genetics', 'efficiency'],

    // Skill point cost scaling
    COST_PER_RANK_MULTIPLIER: 1.5,
};

export const PRESTIGE = {
    // Requirements
    MIN_LEVEL: 50,
    MIN_CASH: 1000000, // $1M

    // Token calculation
    TOKENS_PER_10_LEVELS: 1, // floor(level/10)
    TOKENS_LOG_CASH: true, // floor(log10(cash))

    // Permanent bonuses per prestige level
    XP_BONUS_PER_PRESTIGE: 0.02, // +2%
    YIELD_BONUS_PER_PRESTIGE: 0.01, // +1%
    CASH_BONUS_PER_PRESTIGE: 0.01, // +1%

    // What resets
    RESETS: ['cash', 'slots', 'inventory', 'facility', 'listings', 'level', 'xp'],

    // What persists
    KEEPS: ['prestige_level', 'prestige_tokens', 'skills', 'bred_strains', 'achievements', 'bits_purchases'],

    // Exclusive strain unlocks
    EXCLUSIVE_STRAINS: {
        3: 'prestige-strain-1',
        5: 'prestige-strain-2',
        10: 'prestige-strain-3'
    }
};

export const BOT_BONUSES = {
    // Sync interval (ms)
    SYNC_INTERVAL: 900000, // 15 minutes

    // Bot level bonuses
    GROW_SPEED_PER_LEVEL: 0.005, // -0.5% grow time per level
    GROW_SPEED_CAP: 0.25, // Max -25%
    XP_PER_LEVEL: 0.01, // +1% XP per level
    XP_CAP: 0.50, // Max +50%

    // Bot streak bonuses
    YIELD_PER_STREAK_DAY: 0.002, // +0.2% per day
    YIELD_STREAK_CAP: 0.10, // Max +10%
    PRICE_PER_STREAK_DAY: 0.001, // +0.1% per day
    PRICE_STREAK_CAP: 0.05, // Max +5%

    // Tokes milestones
    MILESTONES: {
        100: { type: 'unlock_strain', rarity: 'rare' },
        500: { type: 'quality_bonus', value: 0.05 },
        1000: { type: 'cash_bonus', value: 0.10 },
        5000: { type: 'unlock_legendary_parent' }
    }
};

export const WEBSOCKET = {
    // Heartbeat
    PING_INTERVAL: 30000, // 30 seconds
    PONG_TIMEOUT: 90000, // 90 seconds before disconnect

    // Reconnect
    RECONNECT_BASE_DELAY: 1000, // 1 second
    RECONNECT_MAX_DELAY: 30000, // 30 seconds
    RECONNECT_MULTIPLIER: 2, // Exponential backoff
};

export const RATE_LIMITS = {
    // Per player per window
    REQUESTS_PER_MINUTE: 60,
    REQUESTS_PER_SECOND: 10,

    // Specific endpoint cooldowns
    PLANT_COOLDOWN_MS: 1000,
    HARVEST_COOLDOWN_MS: 500,
    SELL_COOLDOWN_MS: 500,
    BREED_COOLDOWN_MS: 5000,
    TRADE_COOLDOWN_MS: 2000,
};

export const QUESTS = {
    // Reset times (UTC)
    DAILY_RESET_HOUR: 0, // Midnight UTC
    WEEKLY_RESET_DAY: 1, // Monday

    // Quest slots
    DAILY_QUEST_COUNT: 3,
    WEEKLY_QUEST_COUNT: 2,
};

export const SEASONS = {
    // Duration
    SEASON_DURATION_DAYS: 30,

    // Leaderboard rewards (top N)
    REWARD_TIERS: [1, 3, 10, 25, 50, 100],
};

// Export all as default object too
export default {
    GAME,
    MARKET,
    BREEDING,
    SKILLS,
    PRESTIGE,
    BOT_BONUSES,
    WEBSOCKET,
    RATE_LIMITS,
    QUESTS,
    SEASONS
};
