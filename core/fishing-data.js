// Static content for the fishing minigame (VirtualFisher-style).
// Everything here is data-only — the manager (core/fishing-manager.js) consumes it.
// Fish/rods/baits/locations are GLOBAL (per-user, cross-server), like VirtualFisher.

// ── Rarity tiers ───────────────────────────────────────────────────────────
// `weight` is the base relative chance of rolling that tier on a cast at the
// starter location with the starter rod/no bait. Rods + bait shift the curve
// toward the rarer tiers (see fishing-manager rollRarity).
export const RARITIES = {
  junk:      { key: 'junk',      name: 'Junk',      emoji: '🗑️', color: 0x6b7280, weight: 70,    valueMult: 0.2 },
  common:    { key: 'common',    name: 'Common',    emoji: '⚪', color: 0x9ca3af, weight: 1000,  valueMult: 1 },
  uncommon:  { key: 'uncommon',  name: 'Uncommon',  emoji: '🟢', color: 0x22c55e, weight: 380,   valueMult: 1.8 },
  rare:      { key: 'rare',      name: 'Rare',      emoji: '🔵', color: 0x3b82f6, weight: 120,   valueMult: 4 },
  epic:      { key: 'epic',      name: 'Epic',      emoji: '🟣', color: 0xa855f7, weight: 34,    valueMult: 11 },
  legendary: { key: 'legendary', name: 'Legendary', emoji: '🟡', color: 0xf59e0b, weight: 8,     valueMult: 35 },
  mythical:  { key: 'mythical',  name: 'Mythical',  emoji: '🔴', color: 0xef4444, weight: 1.4,   valueMult: 120 },
};
export const RARITY_ORDER = ['junk', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'];

// ── Fishing rods (tackle) ──────────────────────────────────────────────────
// maxCatch  — upper bound of fish reeled in per cast (1 = single).
// luck      — multiplier applied to rare-tier weights (1 = neutral).
// price     — fishcoins to buy. The starter rod is free + pre-owned.
export const RODS = [
  { id: 'wooden',   name: 'Wooden Rod',    emoji: '🪵', price: 0,       maxCatch: 1, luck: 1.0 },
  { id: 'bamboo',   name: 'Bamboo Rod',    emoji: '🎍', price: 800,     maxCatch: 2, luck: 1.15 },
  { id: 'fiber',    name: 'Fiberglass Rod',emoji: '🎣', price: 4500,    maxCatch: 2, luck: 1.35 },
  { id: 'steel',    name: 'Steel Rod',     emoji: '⚙️', price: 22000,   maxCatch: 3, luck: 1.6 },
  { id: 'gold',     name: 'Golden Rod',    emoji: '🥇', price: 95000,   maxCatch: 4, luck: 2.0 },
  { id: 'diamond',  name: 'Diamond Rod',   emoji: '💎', price: 400000,  maxCatch: 5, luck: 2.6 },
  { id: 'celestial',name: 'Celestial Rod', emoji: '🌌', price: 1800000, maxCatch: 6, luck: 3.4 },
];

// ── Bait (consumable; boosts rare odds for a number of casts) ───────────────
// uses — casts the pack lasts. luck stacks (multiplies) with the rod's luck.
export const BAITS = [
  { id: 'worm',    name: 'Worms',        emoji: '🪱', price: 250,    uses: 15,  luck: 1.2 },
  { id: 'cricket', name: 'Crickets',     emoji: '🦗', price: 900,    uses: 20,  luck: 1.5 },
  { id: 'minnow',  name: 'Minnows',      emoji: '🐟', price: 3500,   uses: 25,  luck: 1.9 },
  { id: 'shrimp',  name: 'Glow Shrimp',  emoji: '🦐', price: 14000,  uses: 30,  luck: 2.4 },
  { id: 'magic',   name: 'Magic Bait',   emoji: '✨', price: 75000,  uses: 30,  luck: 3.2 },
];

// ── Locations / biomes ─────────────────────────────────────────────────────
// Each defines its own fish pool. `price` is the unlock cost (one-time). The
// starter pond is free + pre-owned. `rarityShift` nudges the rarity curve for
// higher biomes (e.g. the abyss skews toward rare+).
export const LOCATIONS = [
  {
    id: 'pond', name: 'Tranquil Pond', emoji: '🪴', price: 0, rarityShift: 1.0,
    fish: [
      { id: 'minnow',     name: 'Minnow',        emoji: '🐟', rarity: 'common',    minW: 0.05, maxW: 0.4,  base: 6 },
      { id: 'sunfish',    name: 'Sunfish',       emoji: '🐠', rarity: 'common',    minW: 0.1,  maxW: 0.9,  base: 9 },
      { id: 'perch',      name: 'Perch',         emoji: '🐡', rarity: 'uncommon',  minW: 0.3,  maxW: 1.6,  base: 22 },
      { id: 'bass',       name: 'Largemouth Bass',emoji: '🎣', rarity: 'rare',     minW: 0.8,  maxW: 4.5,  base: 70 },
      { id: 'goldfish',   name: 'Wild Goldfish',  emoji: '🟠', rarity: 'epic',     minW: 0.1,  maxW: 0.6,  base: 240 },
      { id: 'koi',        name: 'Ancient Koi',    emoji: '🎏', rarity: 'legendary',minW: 2,    maxW: 9,    base: 1100 },
      { id: 'pondlord',   name: 'Pond Leviathan', emoji: '🐉', rarity: 'mythical', minW: 12,   maxW: 40,   base: 9000 },
    ],
  },
  {
    id: 'river', name: 'Rushing River', emoji: '🏞️', price: 5000, rarityShift: 1.05,
    fish: [
      { id: 'trout',      name: 'Rainbow Trout',  emoji: '🐟', rarity: 'common',    minW: 0.3,  maxW: 2.5,  base: 14 },
      { id: 'salmon',     name: 'Salmon',         emoji: '🍣', rarity: 'uncommon',  minW: 1,    maxW: 6,    base: 38 },
      { id: 'catfish',    name: 'Catfish',        emoji: '🐈', rarity: 'rare',      minW: 2,    maxW: 18,   base: 95 },
      { id: 'sturgeon',   name: 'Sturgeon',       emoji: '🦈', rarity: 'epic',      minW: 8,    maxW: 60,   base: 330 },
      { id: 'goldtrout',  name: 'Golden Trout',   emoji: '🥇', rarity: 'legendary', minW: 1,    maxW: 4,    base: 1500 },
      { id: 'rivergod',   name: 'River Spirit',   emoji: '🐲', rarity: 'mythical',  minW: 15,   maxW: 55,   base: 12000 },
    ],
  },
  {
    id: 'ocean', name: 'Open Ocean', emoji: '🌊', price: 30000, rarityShift: 1.12,
    fish: [
      { id: 'mackerel',   name: 'Mackerel',       emoji: '🐟', rarity: 'common',    minW: 0.3,  maxW: 2,    base: 20 },
      { id: 'tuna',       name: 'Bluefin Tuna',   emoji: '🐡', rarity: 'uncommon',  minW: 30,   maxW: 250,  base: 65 },
      { id: 'swordfish',  name: 'Swordfish',      emoji: '🗡️', rarity: 'rare',      minW: 50,   maxW: 450,  base: 160 },
      { id: 'marlin',     name: 'Blue Marlin',    emoji: '🔱', rarity: 'epic',      minW: 80,   maxW: 600,  base: 520 },
      { id: 'whaleshark', name: 'Whale Shark',    emoji: '🦈', rarity: 'legendary', minW: 500,  maxW: 9000, base: 2200 },
      { id: 'kraken',     name: 'The Kraken',     emoji: '🐙', rarity: 'mythical',  minW: 800,  maxW: 4000, base: 18000 },
    ],
  },
  {
    id: 'reef', name: 'Coral Reef', emoji: '🪸', price: 120000, rarityShift: 1.18,
    fish: [
      { id: 'clownfish',  name: 'Clownfish',      emoji: '🤡', rarity: 'common',    minW: 0.02, maxW: 0.25, base: 30 },
      { id: 'angelfish',  name: 'Angelfish',      emoji: '😇', rarity: 'uncommon',  minW: 0.1,  maxW: 1.2,  base: 90 },
      { id: 'lionfish',   name: 'Lionfish',       emoji: '🦁', rarity: 'rare',      minW: 0.5,  maxW: 1.8,  base: 230 },
      { id: 'mantaray',   name: 'Manta Ray',      emoji: '🛸', rarity: 'epic',      minW: 200,  maxW: 1500, base: 760 },
      { id: 'seadragon',  name: 'Leafy Seadragon',emoji: '🐉', rarity: 'legendary', minW: 0.1,  maxW: 0.5,  base: 3200 },
      { id: 'reefqueen',  name: 'Reef Queen',     emoji: '👑', rarity: 'mythical',  minW: 5,    maxW: 30,   base: 24000 },
    ],
  },
  {
    id: 'frozen', name: 'Frozen Lake', emoji: '🧊', price: 350000, rarityShift: 1.25,
    fish: [
      { id: 'smelt',      name: 'Ice Smelt',      emoji: '🐟', rarity: 'common',    minW: 0.05, maxW: 0.3,  base: 45 },
      { id: 'pike',       name: 'Northern Pike',  emoji: '🪕', rarity: 'uncommon',  minW: 2,    maxW: 12,   base: 130 },
      { id: 'arcticchar', name: 'Arctic Char',    emoji: '❄️', rarity: 'rare',      minW: 1,    maxW: 7,    base: 340 },
      { id: 'icefish',    name: 'Crystal Icefish',emoji: '🔮', rarity: 'epic',      minW: 0.2,  maxW: 1.5,  base: 1100 },
      { id: 'frostpike',  name: 'Frostfang Pike', emoji: '🧛', rarity: 'legendary', minW: 10,   maxW: 40,   base: 4600 },
      { id: 'permafrost', name: 'Permafrost Wyrm',emoji: '🐍', rarity: 'mythical',  minW: 40,   maxW: 120,  base: 33000 },
    ],
  },
  {
    id: 'abyss', name: 'The Abyss', emoji: '🕳️', price: 1000000, rarityShift: 1.4,
    fish: [
      { id: 'lanternfish',name: 'Lanternfish',    emoji: '🏮', rarity: 'common',    minW: 0.01, maxW: 0.2,  base: 70 },
      { id: 'anglerfish', name: 'Anglerfish',     emoji: '🎣', rarity: 'uncommon',  minW: 0.5,  maxW: 5,    base: 210 },
      { id: 'gulper',     name: 'Gulper Eel',     emoji: '🐍', rarity: 'rare',      minW: 1,    maxW: 9,    base: 540 },
      { id: 'vampiresquid',name:'Vampire Squid',  emoji: '🦑', rarity: 'epic',      minW: 0.1,  maxW: 1,    base: 1800 },
      { id: 'colossal',   name: 'Colossal Squid', emoji: '🦑', rarity: 'legendary', minW: 200,  maxW: 700,  base: 7200 },
      { id: 'leviathan',  name: 'Abyssal Leviathan',emoji:'🌑',rarity: 'mythical',  minW: 1000, maxW: 6000, base: 48000 },
    ],
  },
  {
    id: 'cosmos', name: 'The Cosmic Sea', emoji: '🌌', price: 5000000, rarityShift: 1.6,
    fish: [
      { id: 'stardew',    name: 'Stardust Guppy', emoji: '🌟', rarity: 'common',    minW: 0.01, maxW: 0.5,  base: 120 },
      { id: 'cometfish',  name: 'Comet Fish',     emoji: '☄️', rarity: 'uncommon',  minW: 0.2,  maxW: 3,    base: 380 },
      { id: 'nebulaeel',  name: 'Nebula Eel',     emoji: '🌀', rarity: 'rare',      minW: 1,    maxW: 12,   base: 980 },
      { id: 'voidray',    name: 'Void Ray',       emoji: '🛸', rarity: 'epic',      minW: 50,   maxW: 800,  base: 3400 },
      { id: 'starwhale',  name: 'Star Whale',     emoji: '🐋', rarity: 'legendary', minW: 2000, maxW: 20000,base: 14000 },
      { id: 'galaxydragon',name:'Galaxy Dragon',  emoji: '🐉', rarity: 'mythical',  minW: 5000, maxW: 50000,base: 90000 },
    ],
  },
];

// ── Junk pulls (the "trash" tier) ──────────────────────────────────────────
export const JUNK = [
  { id: 'boot',     name: 'Old Boot',      emoji: '🥾', base: 2 },
  { id: 'can',      name: 'Rusty Can',     emoji: '🥫', base: 1 },
  { id: 'bottle',   name: 'Message Bottle',emoji: '🍾', base: 4 },
  { id: 'seaweed',  name: 'Seaweed',       emoji: '🌿', base: 1 },
  { id: 'tire',     name: 'Soggy Tire',    emoji: '🛞', base: 3 },
];

// ── Daily quest templates (rolled on first cast of the day) ─────────────────
export const DAILY_QUESTS = [
  { id: 'catch10',   desc: 'Catch {n} fish',                    type: 'catch',   targetMin: 8,  targetMax: 15, reward: 600 },
  { id: 'catch25',   desc: 'Catch {n} fish',                    type: 'catch',   targetMin: 20, targetMax: 35, reward: 1500 },
  { id: 'rare3',     desc: 'Catch {n} Rare-or-better fish',     type: 'rare',    targetMin: 2,  targetMax: 5,  reward: 1200 },
  { id: 'earn',      desc: 'Earn {n} fishcoins from selling',   type: 'earn',    targetMin: 500,targetMax: 2000,reward: 800 },
  { id: 'sell',      desc: 'Sell {n} fish at the market',       type: 'sell',    targetMin: 10, targetMax: 25, reward: 700 },
];

export const COOLDOWN_MS = 3000;          // between casts
export const STARTER_COINS = 100;
export const DAILY_REWARD_BASE = 500;     // /fish daily streak base
export const SELL_TAX = 0;                // keep it generous

// ── Pets / companions (passive bonuses; one equipped at a time) ─────────────
// luck      — multiplies catch luck (stacks with rod + bait + weather).
// coinBonus — % bonus on sell value (0.10 = +10%).
// cdReduce  — ms shaved off the cast cooldown.
export const PETS = [
  { id: 'crab',    name: 'Pinchy the Crab', emoji: '🦀', price: 5000,    luck: 1.05, coinBonus: 0.05, cdReduce: 0 },
  { id: 'cat',     name: 'Fishing Cat',     emoji: '🐱', price: 18000,   luck: 1.0,  coinBonus: 0.12, cdReduce: 0 },
  { id: 'otter',   name: 'River Otter',     emoji: '🦦', price: 45000,   luck: 1.15, coinBonus: 0.05, cdReduce: 200 },
  { id: 'parrot',  name: 'Pirate Parrot',   emoji: '🦜', price: 90000,   luck: 1.08, coinBonus: 0.20, cdReduce: 0 },
  { id: 'dolphin', name: 'Lucky Dolphin',   emoji: '🐬', price: 250000,  luck: 1.25, coinBonus: 0.10, cdReduce: 400 },
  { id: 'dragon',  name: 'Baby Sea Dragon', emoji: '🐉', price: 1200000, luck: 1.45, coinBonus: 0.25, cdReduce: 700 },
];
export const PETS_BY_ID = Object.fromEntries(PETS.map(p => [p.id, p]));

// ── Auto-fisher (idle income; upgradeable; claim with /fish collect) ─────────
// perHour — fishcoins generated per hour at that level.
// capHours — how many hours of income it can bank before you must collect.
export const AUTOFISHER = [
  { level: 1, price: 25000,   perHour: 600,   capHours: 8 },
  { level: 2, price: 80000,   perHour: 1600,  capHours: 10 },
  { level: 3, price: 220000,  perHour: 4200,  capHours: 12 },
  { level: 4, price: 600000,  perHour: 11000, capHours: 16 },
  { level: 5, price: 1800000, perHour: 30000, capHours: 24 },
];

// ── Weather (rotates hourly, shared by everyone; shifts the odds) ───────────
// luck — multiplies catch luck. Deterministic from the current hour (no storage).
export const WEATHER = [
  { id: 'sunny',  name: 'Sunny',        emoji: '☀️', luck: 1.0,  blurb: 'Calm and clear.' },
  { id: 'cloudy', name: 'Cloudy',       emoji: '☁️', luck: 1.05, blurb: 'Fish are biting a little more.' },
  { id: 'rainy',  name: 'Rainy',        emoji: '🌧️', luck: 1.15, blurb: 'Rain stirs up the water — better catches!' },
  { id: 'storm',  name: 'Thunderstorm', emoji: '⛈️', luck: 1.30, blurb: 'Wild waters, rare fish surface!' },
  { id: 'foggy',  name: 'Foggy',        emoji: '🌫️', luck: 0.95, blurb: 'Hard to see the bobber.' },
  { id: 'windy',  name: 'Windy',        emoji: '🌬️', luck: 1.08, blurb: 'A good breeze.' },
  { id: 'moon',   name: 'Full Moon',    emoji: '🌕', luck: 1.20, blurb: 'Mystical pull — legends stir.' },
];

// ── Shiny variants (rare recolor of ANY fish; big value) ────────────────────
export const SHINY_CHANCE = 1 / 600;   // per individual fish rolled
export const SHINY_VALUE_MULT = 18;    // shiny sell value multiplier
export const SHINY_SUFFIX = '#s';      // appended to fish_key for shiny storage

// ── Seasonal event fish (appended to a location's pool during their month) ──
// month is 1-12 (UTC). Each is high-rarity flavour content.
export const SEASONAL = {
  2:  { id: 'cupidcarp',  name: 'Cupid Carp',    emoji: '💘', rarity: 'epic',      minW: 1, maxW: 5,  base: 2500 },
  6:  { id: 'sunfishking',name: 'Summer Sunking', emoji: '🌞', rarity: 'legendary', minW: 2, maxW: 9,  base: 4800 },
  10: { id: 'ghosteel',   name: 'Ghost Eel',     emoji: '👻', rarity: 'legendary', minW: 3, maxW: 14, base: 5200 },
  12: { id: 'frostgift',  name: 'Gift-Wrapped Cod', emoji: '🎁', rarity: 'epic',   minW: 1, maxW: 6,  base: 3000 },
};

// ── Angler XP / levels ──────────────────────────────────────────────────────
// XP per catch by rarity; level from total XP via a soft curve.
export const XP_PER_RARITY = { junk: 1, common: 3, uncommon: 7, rare: 18, epic: 50, legendary: 160, mythical: 600 };
export function levelFromXp(xp) { return Math.max(1, Math.floor(Math.sqrt(xp / 80)) + 1); }
export function xpForLevel(level) { return Math.pow(level - 1, 2) * 80; }
export const LEVEL_LUCK_PER = 0.004;   // +0.4% luck per level
export const LEVEL_LUCK_CAP = 0.5;     // capped at +50%

// Lookups -------------------------------------------------------------------
export const RODS_BY_ID = Object.fromEntries(RODS.map(r => [r.id, r]));
export const BAITS_BY_ID = Object.fromEntries(BAITS.map(b => [b.id, b]));
export const LOCATIONS_BY_ID = Object.fromEntries(LOCATIONS.map(l => [l.id, l]));

// Every fish across all locations + junk, keyed by `${locId}:${fishId}` and a
// flat species index by composite id used for inventory storage.
export const FISH_INDEX = (() => {
  const idx = {};
  for (const loc of LOCATIONS) {
    for (const f of loc.fish) idx[`${loc.id}:${f.id}`] = { ...f, location: loc.id };
  }
  for (const j of JUNK) idx[`junk:${j.id}`] = { ...j, rarity: 'junk', location: 'junk', minW: 0, maxW: 0 };
  return idx;
})();

export function fishKey(locationId, fishId) {
  return `${locationId}:${fishId}`;
}
