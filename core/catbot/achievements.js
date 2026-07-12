/*
 * Cat Bot achievements. Clean-room — these titles, descriptions and thresholds are our
 * own; none are copied from upstream. See /LICENSE-CATBOT-NOTICE.md.
 *
 * Each definition is a pure predicate over a snapshot of the player's state, so the whole
 * set can be evaluated after any event with a single DB read.
 */
import pool from '../../utils/db.js';
import { CAT_TYPES, valueOf } from './constants.js';

/**
 * ctx = {
 *   totalCatches, distinctTypes, fastestMs, slowestMs,
 *   counts: Map<type, n>, value, prisms, packsOpened, boostedCatches, belatedCatches,
 *   justCaught: string|null, wasBoosted: boolean
 * }
 */
export const ACHIEVEMENTS = Object.freeze([
  // ── Getting started ──
  { id: 'first-cat', name: 'First cat!', category: 'Cat Hunt', emoji: '🐾',
    description: 'the journey begins...', test: c => c.totalCatches >= 1 },
  // Earned by pinging the bot, not by catching anything — see `checkPing` below.
  { id: 'who-ping', name: 'Who Ping', category: 'Social', emoji: '❓',
    description: 'ping cat bot', test: c => c.pinged === true },
  { id: 'ten-cats', name: 'Cat Person', category: 'Cat Hunt', emoji: '🐈',
    description: 'Catch 10 cats.', test: c => c.totalCatches >= 10 },
  { id: 'hundred-cats', name: 'Crazy Cat Person', category: 'Cat Hunt', emoji: '🐈‍⬛',
    description: 'Catch 100 cats.', test: c => c.totalCatches >= 100 },
  { id: 'thousand-cats', name: 'Colony', category: 'Cat Hunt', emoji: '🏠',
    description: 'Catch 1,000 cats.', test: c => c.totalCatches >= 1000 },

  // ── Collection ──
  { id: 'five-types', name: 'Variety Pack', category: 'Collection', emoji: '🎨',
    description: 'Own 5 different cat types.', test: c => c.distinctTypes >= 5 },
  { id: 'half-types', name: 'Halfway There', category: 'Collection', emoji: '📖',
    description: `Own ${Math.ceil(CAT_TYPES.length / 2)} different cat types.`,
    test: c => c.distinctTypes >= Math.ceil(CAT_TYPES.length / 2) },
  { id: 'all-types', name: 'Completionist', category: 'Collection', emoji: '🏅',
    description: 'Own at least one of every cat type.', test: c => c.distinctTypes >= CAT_TYPES.length },
  { id: 'value-1000', name: 'Worth It', category: 'Collection', emoji: '💰',
    description: 'Reach a collection value of 1,000.', test: c => c.value >= 1000 },
  { id: 'value-10000', name: 'Priceless', category: 'Collection', emoji: '💎',
    description: 'Reach a collection value of 10,000.', test: c => c.value >= 10000 },

  // ── Rarity ──
  { id: 'first-rare', name: 'Uncommon Company', category: 'Rarity', emoji: '✨',
    description: 'Catch a Rare cat or better.',
    test: c => rarityIndexOwned(c) >= CAT_TYPES.indexOf('Rare') },
  { id: 'legendary', name: 'The Stuff of Legend', category: 'Rarity', emoji: '🌟',
    description: 'Catch a Legendary cat.', test: c => (c.counts.get('Legendary') || 0) >= 1 },
  { id: 'divine', name: 'Touched by Cat', category: 'Rarity', emoji: '😇',
    description: 'Catch a Divine cat.', test: c => (c.counts.get('Divine') || 0) >= 1 },
  { id: 'egirl', name: 'One in Two Thousand', category: 'Rarity', emoji: '💅',
    description: 'Catch an eGirl cat — the rarest there is.', test: c => (c.counts.get('eGirl') || 0) >= 1 },
  { id: 'corrupt', name: 'Something Is Wrong', category: 'Rarity', emoji: '💀',
    description: 'Catch a Corrupt cat.', test: c => (c.counts.get('Corrupt') || 0) >= 1 },

  // ── Speed ──
  { id: 'fast-1s', name: 'Quick Paws', category: 'Speed', emoji: '⚡',
    description: 'Catch a cat within one second.', test: c => c.fastestMs != null && c.fastestMs <= 1000 },
  { id: 'fast-500', name: 'Reflexes', category: 'Speed', emoji: '🏃',
    description: 'Catch a cat within half a second.', test: c => c.fastestMs != null && c.fastestMs <= 500 },
  { id: 'slow-1h', name: 'Eventually', category: 'Speed', emoji: '🐌',
    description: 'Catch a cat that has been waiting over an hour.',
    test: c => c.slowestMs != null && c.slowestMs >= 3_600_000 },

  // ── Prisms & packs ──
  { id: 'first-prism', name: 'Refracted', category: 'Prestige', emoji: '🔮',
    description: 'Craft your first prism.', test: c => c.prisms >= 1 },
  { id: 'five-prisms', name: 'Spectrum', category: 'Prestige', emoji: '🌈',
    description: 'Craft 5 prisms.', test: c => c.prisms >= 5 },
  { id: 'first-boost', name: 'Upgraded', category: 'Prestige', emoji: '⬆️',
    description: 'Have a prism upgrade one of your catches.', test: c => c.boostedCatches >= 1 },
  { id: 'first-pack', name: 'Unboxed', category: 'Packs', emoji: '📦',
    description: 'Open your first pack.', test: c => c.packsOpened >= 1 },
  { id: 'ten-packs', name: 'Hoarder', category: 'Packs', emoji: '🎁',
    description: 'Open 10 packs.', test: c => c.packsOpened >= 10 },

  // ── Social ──
  { id: 'belated', name: 'Close Enough', category: 'Social', emoji: '🥈',
    description: 'Catch a cat in the window after someone beat you to it.', test: c => c.belatedCatches >= 1 },
  { id: 'ten-belated', name: 'Always Second', category: 'Social', emoji: '🤝',
    description: 'Get 10 late catches.', test: c => c.belatedCatches >= 10 },
]);

function rarityIndexOwned(ctx) {
  let best = -1;
  for (const [type, n] of ctx.counts) if (n > 0) best = Math.max(best, CAT_TYPES.indexOf(type));
  return best;
}

export function getAchievement(id) { return ACHIEVEMENTS.find(a => a.id === id) || null; }
export function achievementCategories() { return [...new Set(ACHIEVEMENTS.map(a => a.category))]; }

/** Build the snapshot the predicates read. One profile + one catches query. */
export async function buildContext(guildId, userId, extra = {}) {
  const [[profile]] = await pool.execute(
    `SELECT total_catches, fastest_ms, slowest_ms, packs_opened, boosted_catches, belated_catches
       FROM catbot_profiles WHERE guild_id = ? AND user_id = ?`, [guildId, userId]);
  const [catchRows] = await pool.execute(
    'SELECT cat_type, count FROM catbot_catches WHERE guild_id = ? AND user_id = ? AND count > 0',
    [guildId, userId]);
  const [[prisms]] = await pool.execute(
    'SELECT COUNT(*) AS n FROM catbot_prisms WHERE guild_id = ? AND creator_id = ?', [guildId, userId]);

  const counts = new Map(catchRows.map(r => [r.cat_type, Number(r.count)]));
  let value = 0;
  for (const [type, n] of counts) value += n * valueOf(type);

  return {
    totalCatches: Number(profile?.total_catches || 0),
    distinctTypes: counts.size,
    fastestMs: profile?.fastest_ms ?? null,
    slowestMs: profile?.slowest_ms ?? null,
    packsOpened: Number(profile?.packs_opened || 0),
    boostedCatches: Number(profile?.boosted_catches || 0),
    belatedCatches: Number(profile?.belated_catches || 0),
    prisms: Number(prisms?.n || 0),
    counts, value,
    ...extra,
  };
}

export async function earnedIds(guildId, userId) {
  const [rows] = await pool.execute(
    'SELECT ach_id FROM catbot_achievements WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return new Set(rows.map(r => r.ach_id));
}

/**
 * Evaluate every achievement and persist the newly earned ones.
 * @returns {Promise<Array>} the definitions that were just unlocked (for announcing).
 */
export async function checkAndAward(guildId, userId, extra = {}) {
  const [ctx, already] = await Promise.all([
    buildContext(guildId, userId, extra),
    earnedIds(guildId, userId),
  ]);

  const fresh = ACHIEVEMENTS.filter(a => !already.has(a.id) && safeTest(a, ctx));
  if (!fresh.length) return [];

  const now = Date.now();
  // INSERT IGNORE decides the winner: affectedRows 0 means a concurrent catch already
  // awarded it, so only one of them announces. Never mutate the shared definitions.
  const awarded = [];
  for (const a of fresh) {
    const [r] = await pool.execute(
      'INSERT IGNORE INTO catbot_achievements (guild_id, user_id, ach_id, earned_at) VALUES (?, ?, ?, ?)',
      [guildId, userId, a.id, now]);
    if (r.affectedRows === 1) awarded.push(a);
  }
  return awarded;
}

function safeTest(achievement, ctx) {
  try { return !!achievement.test(ctx); } catch { return false; }
}

export async function progressFor(guildId, userId) {
  const earned = await earnedIds(guildId, userId);
  return ACHIEVEMENTS.map(a => ({ ...a, earned: earned.has(a.id) }));
}
