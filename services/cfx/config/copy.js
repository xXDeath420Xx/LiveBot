// Greenhouse Tycoon (cfx v2): every display name and player-facing sentence lives here, so the owner can
// rename things in one file (audit B12: "keep display names in one copy/config module").
//
// Theme rule (owner, 2026-11-18): a greenhouse and plant-breeding business. Plants are fictional or
// ornamental hybrids. tests/cfx/v2/domain.test.js scans this service for words that break the rule.

export const BRAND = 'CertiFried';
export const GAME_TITLE = 'Greenhouse Tycoon';
export const BYLINE = `by ${BRAND}`;

// Base varieties, keyed by the code in catalog.js.
export const VARIETY_NAMES = Object.freeze({
    sunmoss: 'Sunmoss',
    velvet_fern: 'Velvet Fern',
    ember_coleus: 'Ember Coleus',
    frostbell: 'Frostbell',
    copper_calathea: 'Copper Calathea',
    moonpetal: 'Moonpetal',
    glasswing_orchid: 'Glasswing Orchid',
    tiger_begonia: 'Tiger Begonia',
    starlace_fern: 'Starlace Fern',
    ruby_peperomia: 'Ruby Peperomia',
    cloudleaf_ivy: 'Cloudleaf Ivy',
    aurora_bromeliad: 'Aurora Bromeliad'
});

// Hybrids follow the botanical convention "Parent A × Parent B", so players never name anything and
// there is nothing to moderate.
export function hybridName(nameA, nameB) {
    return `${nameA} × ${nameB}`;
}

export const QUALITY_NAMES = Object.freeze(['Standard', 'Fine', 'Premium', 'Show grade']);

export const STAFF_NAMES = Object.freeze({
    gardener: 'Gardener',
    propagator: 'Propagator',
    shop_assistant: 'Shop assistant'
});

export const UPGRADE_NAMES = Object.freeze({
    grow_lights: 'Grow lights',
    irrigation: 'Drip irrigation',
    soil_mix: 'Better soil mix',
    extra_bench: 'Extra bench',
    market_stall: 'Market stall',
    packaging: 'Gift packaging',
    staff_training: 'Staff training',
    staff_quarters: 'Staff room'
});

export const BOOST_NAMES = Object.freeze({
    plant_food: 'Plant food',
    growth_tonic: 'Growth tonic'
});

// NPC buyers who place orders. Chosen per order from its id, so the name never changes.
export const BUYER_NAMES = Object.freeze([
    'Corner florist', 'Garden centre', 'Hotel lobby', 'Wedding planner', 'Botanical society',
    'Office plant service', 'Cafe on the square', 'Museum conservatory', 'Market hall stall', 'Seed library'
]);

export const PLATFORM_NAMES = Object.freeze({
    twitch: 'Twitch',
    twitch_opaque: 'Twitch (panel)',
    kick: 'Kick',
    discord: 'Discord',
    dev: 'Test'
});

export const DEFAULT_DISPLAY_NAME = 'Grower';

// ------------------------------------------------------------------ phase 4: quests, achievements, seasons

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const usd = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;

// One sentence per quest metric; n is the target.
export const QUEST_TEXT = Object.freeze({
    harvest: (n) => `Harvest ${plural(n, 'plant', 'plants')}`,
    plant: (n) => `Plant ${plural(n, 'seed', 'seeds')}`,
    water: (n) => `Water ${plural(n, 'plant', 'plants')}`,
    sell_units: (n) => `Sell ${plural(n, 'item', 'items')} of produce`,
    earn_cash: (n) => `Earn ${usd(n)} from sales and orders`,
    fill_order: (n) => `Fill ${plural(n, 'order', 'orders')}`,
    cross: (n) => `Collect ${plural(n, 'cross', 'crosses')} from the breeding bench`,
    staff_claim: (n) => (n === 1 ? 'Collect what your staff made' : `Collect from your staff ${n} times`),
    upgrade: (n) => `Buy ${plural(n, 'upgrade level', 'upgrade levels')}`,
    daily: (n) => `Collect the daily reward on ${plural(n, 'day', 'days')}`,
    boost: (n) => `Use ${plural(n, 'boost', 'boosts')}`
});

export const ACHIEVEMENT_TEXT = Object.freeze({
    first_harvest: ['First harvest', 'Harvest your first plant.'],
    harvests_100: ['Green thumb', 'Harvest 100 plants.'],
    harvests_1000: ['Busy benches', 'Harvest 1,000 plants.'],
    harvests_10000: ['Master grower', 'Harvest 10,000 plants.'],
    sold_1000: ['Market regular', 'Sell 1,000 items of produce.'],
    sold_100000: ['Wholesaler', 'Sell 100,000 items of produce.'],
    earned_100k: ['Paying its way', 'Earn $100,000 from sales and orders.'],
    earned_10m: ['Greenhouse empire', 'Earn $10,000,000 from sales and orders.'],
    orders_1: ['First order', 'Fill an order for a buyer.'],
    orders_50: ['Reliable supplier', 'Fill 50 orders.'],
    orders_500: ['Trusted supplier', 'Fill 500 orders.'],
    hybrid_1: ['New in the catalogue', 'Breed your first hybrid.'],
    hybrid_10: ['Plant breeder', 'Breed 10 different hybrids.'],
    hybrid_all: ['Botanist', 'Breed all 66 hybrids.'],
    collection_base: ['Full set', 'Grow all 12 base plants.'],
    level_10: ['Level 10', 'Reach level 10.'],
    level_25: ['Level 25', 'Reach level 25.'],
    level_50: ['Veteran', 'Reach level 50.'],
    staff_first: ['Extra hands', 'Collect what your staff made for the first time.'],
    quests_25: ['Goal setter', 'Finish 25 quests.'],
    quests_250: ['Never idle', 'Finish 250 quests.'],
    streak_7: ['Every day', 'Collect the daily reward 7 days in a row.'],
    challenge_1: ['Up for a challenge', 'Finish a weekly challenge.'],
    replant_1: ['Fresh start', 'Replant your greenhouse once.'],
    replant_5: ['Evergreen', 'Replant your greenhouse five times.'],
    decor_1: ['Homely touch', 'Buy a decoration.'],
    decor_all: ['Curator', 'Own every decoration sold in the shop.']
});

export const DECORATION_NAMES = Object.freeze({
    potted_fern: 'Hanging fern basket',
    stone_path: 'Stone path',
    bird_bath: 'Bird bath',
    wind_chime: 'Wind chime',
    trellis_arch: 'Rose trellis arch',
    koi_pond: 'Koi pond',
    glass_cupola: 'Glass cupola',
    sundial: 'Sundial',
    fountain: 'Tiered fountain',
    orangery_wing: 'Orangery wing',
    golden_can: 'Golden watering can',
    laurel_arch: 'Laurel arch'
});

export const SEASON_TIER_NAMES = Object.freeze({
    champion: 'Season champion',
    podium: 'Top 3',
    top10: 'Top 10',
    top_quarter: 'Top quarter',
    grower: 'Season grower',
    challenge_podium: 'Challenge podium'
});

// Badges that are not tied to a season. Season badges are named by badgeName().
export const BADGE_NAMES = Object.freeze({
    master_grower: 'Master grower',
    trusted_supplier: 'Trusted supplier',
    botanist: 'Botanist',
    veteran: 'Veteran',
    replanted: 'Replanted',
    evergreen: 'Evergreen',
    curator: 'Curator'
});

const SEASON_BADGE = /^s(\d{1,6})_([a-z0-9_]+)$/;

/** "Season 3: Top 10" for a badge code s3_top10; the plain name for other badges; null if unknown. */
export function badgeName(code) {
    const m = String(code).match(SEASON_BADGE);
    if (m && SEASON_TIER_NAMES[m[2]]) return `Season ${m[1]}: ${SEASON_TIER_NAMES[m[2]]}`;
    return BADGE_NAMES[code] || null;
}

export const REVIEW_NOTE = 'This is a shared example save for reviewers. It resets every night and is not ranked.';

// Phase 5: what the old game's addresses and commands (/arcade cfx, !cfx) say once this game is live.
export function oldGameMoved(url) {
    return `CertiFried Tycoon has closed. ${GAME_TITLE} replaces it: ${url}`;
}

// Notification lines (store/meta.js). `p` is the stored payload.
export const NOTIFICATION_TEXT = Object.freeze({
    quest: (p) => `Quest done: ${p.title}. Collect the reward on the Grow tab.`,
    achievement: (p) => `Achievement unlocked: ${p.name}. Collect the reward on the Profile tab.`,
    challenge: (p) => `Weekly challenge finished: ${p.title}. ${usd(p.cash)} paid.`,
    challenge_podium: (p) => `You finished the week ${p.week} challenge in place ${p.place}. Bonus ${usd(p.cash)} paid.`,
    season_reward: (p) => `Season ${p.number} ended. You placed ${p.rank} of ${p.of}: ${p.tierName}, ${usd(p.cash)}.`,
    replant: (p) => `Greenhouse replanted (${p.count}). Sale prices +${p.pricePct}%, XP +${p.xpPct}% for good.`
});

export function notificationText(kind, payload) {
    const fn = NOTIFICATION_TEXT[kind];
    try { return fn ? fn(payload || {}) : ''; } catch { return ''; }
}

// Messages for error codes (lib/errors.js). Plain wording, shown as-is to players.
export const ERROR_MESSAGES = Object.freeze({
    VALIDATION: 'Some of the details sent were not valid.',
    BAD_JSON: 'The request body is not valid JSON.',
    PAYLOAD_TOO_LARGE: 'The request is too large.',
    IDEMPOTENCY_KEY_REQUIRED: 'This action needs an Idempotency-Key header.',
    IDEMPOTENCY_MISMATCH: 'That request id was already used for a different action.',
    UNAUTHORIZED: 'Please sign in again.',
    SESSION_STALE: 'Your accounts changed. Please sign in again.',
    FORBIDDEN: 'You cannot do that.',
    ACCOUNT_INACTIVE: 'This game account is not active.',
    NOT_FOUND: 'Not found.',
    INSUFFICIENT_FUNDS: 'You do not have enough money for that.',
    INSUFFICIENT_ITEMS: 'You do not have enough of that item.',
    BALANCE_LIMIT: 'That would go over the maximum balance.',
    ITEM_LIMIT: 'That would go over the maximum you can hold.',
    PLATFORM_NOT_ALLOWED: 'Sign-in from that platform is not available.',
    LINK_CODE_INVALID: 'That link code is wrong or has expired.',
    LINK_CODE_LIMIT: 'You already have several link codes waiting. Use one or wait for them to expire.',
    LINK_TOO_MANY_ATTEMPTS: 'Too many wrong link codes. Try again in an hour.',
    LINK_COOLDOWN: 'This sign-in was moved recently. You can move it again after the cooldown.',
    PLATFORM_ALREADY_LINKED: 'That game account already has a sign-in from this platform.',
    SOURCE_HAS_PROGRESS: 'This sign-in already has its own progress, so it cannot be moved onto another account.',
    CANNOT_UNLINK_CURRENT: 'You cannot unlink the sign-in you are using right now.',
    IDENTITY_NOT_ON_ACCOUNT: 'That sign-in is not linked to your account.',
    RATE_LIMITED: 'Slow down a little and try again.',
    CORS_ORIGIN: 'This site is not allowed to use the game.',
    SIGNIN_UNAVAILABLE: 'That sign-in option is not set up yet.',
    SIGNIN_FAILED: 'Sign-in did not work. Please try again.',
    TWITCH_SIGNED_OUT: 'Log in to Twitch to play.',
    TICKET_INVALID: 'That sign-in link has expired. Please sign in again.',
    REFRESH_RACE: 'Your session was just renewed in another tab. Try again.',
    PLOT_LOCKED: 'You do not own that plot yet.',
    PLOT_OCCUPIED: 'Something is already growing there.',
    PLOT_EMPTY: 'Nothing is growing there.',
    PLOT_CHANGED: 'That plot changed. Refresh and try again.',
    PLOT_NOT_GROWING: 'That plant is not growing any more.',
    NOT_READY: 'That plant is not ready yet.',
    NOTHING_READY: 'Nothing is ready to harvest.',
    ALREADY_WATERED: 'This plant has already been watered.',
    WATER_TOO_EARLY: 'Plants can be watered once they are half grown.',
    BREEDING_PARENTS: 'Only two different base plants can be crossed.',
    BOOST_ALREADY_USED: 'That has already been used on this plant.',
    UNKNOWN_VARIETY: 'That plant does not exist.',
    VARIETY_LOCKED: 'You have not unlocked that plant yet.',
    LEVEL_TOO_LOW: 'You need a higher level for that.',
    MAX_LEVEL: 'That is already at its highest level.',
    LEVEL_MISMATCH: 'That was already bought. Refresh to see the new price.',
    REQUIREMENT_MISSING: 'You need another upgrade first.',
    STAFF_FULL: 'You cannot hire more of these yet.',
    STAFF_NONE: 'You have none of these to let go.',
    COUNT_MISMATCH: 'Your staff changed. Refresh and try again.',
    BREEDING_BUSY: 'Your breeding bench is in use.',
    BREEDING_NOT_READY: 'The cross is not ready yet.',
    BREEDING_NOT_ACTIVE: 'That cross was already collected.',
    NOT_DISCOVERED: 'You have not discovered that plant yet.',
    ORDER_NOT_OPEN: 'That order is no longer open.',
    ORDER_EXPIRED: 'That order has expired.',
    DAILY_ALREADY_CLAIMED: 'You already collected the daily reward today. Come back tomorrow.',
    NAME_NOT_ALLOWED: 'That name is not allowed. Please choose another one.',
    NAME_COOLDOWN: 'You changed your name recently. You can change it again later.',
    QUEST_NOT_DONE: 'That quest is not finished yet.',
    ALREADY_CLAIMED: 'That reward was already collected.',
    ACHIEVEMENT_LOCKED: 'That achievement is not unlocked yet.',
    REPLANT_LOCKED: 'You can replant from level 25.',
    PRESTIGE_MISMATCH: 'Your greenhouse was already replanted. Refresh and look again.',
    DECORATION_OWNED: 'You already own that decoration.',
    DECORATION_NOT_OWNED: 'You do not own that decoration.',
    DECORATION_NOT_SOLD: 'That decoration is not sold in the shop.',
    DECORATION_LIMIT: 'You can show at most 6 decorations. Put one away first.',
    REVIEW_ACCOUNT: 'This is the shared review save, so that is turned off here.',
    DELETE_CONFIRM_REQUIRED: 'Type DELETE to confirm.',
    REVIEW_UNAVAILABLE: 'The review save is not available right now.',
    SERVICE_DISABLED: 'The game is paused for maintenance.',
    INTERNAL: 'Something went wrong on our side.'
});

export function errorMessage(code) {
    return ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL;
}
