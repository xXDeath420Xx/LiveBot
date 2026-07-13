// Fishing minigame engine (VirtualFisher-style). GLOBAL per-user economy:
// coins/fish/gear/records follow a player across every server. Persists to
// fishing_players, fishing_inventory (sellable bucket), fishing_records (permanent
// bestiary), fishing_guild_stats and fishing_tournament* (migrations 139 + 140).
// Pure content lives in core/fishing-data.js.
import pool from '../utils/db.js';
import {
  RARITIES, RODS_BY_ID, BAITS_BY_ID, LOCATIONS_BY_ID, FISH_INDEX, JUNK,
  RODS, BAITS, LOCATIONS, DAILY_QUESTS, COOLDOWN_MS, STARTER_COINS,
  DAILY_REWARD_BASE, fishKey,
  PETS, PETS_BY_ID, AUTOFISHER, WEATHER, SEASONAL,
  SHINY_CHANCE, SHINY_VALUE_MULT, SHINY_SUFFIX,
  XP_PER_RARITY, levelFromXp, xpForLevel, LEVEL_LUCK_PER, LEVEL_LUCK_CAP,
} from './fishing-data.js';

function todayStr() { return new Date().toISOString().slice(0, 10); }
function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function jparse(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// ── Shiny-aware key helpers ─────────────────────────────────────────────────
function isShinyKey(k) { return k.endsWith(SHINY_SUFFIX); }
function baseKey(k) { return isShinyKey(k) ? k.slice(0, -SHINY_SUFFIX.length) : k; }
function metaFor(key) {
  return FISH_INDEX[baseKey(key)] || { name: baseKey(key), emoji: '🐟', rarity: 'common', base: 1, minW: 0, maxW: 1 };
}

// ── Weather (rotates hourly, shared, deterministic — no storage) ─────────────
export function getWeather() {
  const hour = Math.floor(Date.now() / 3600000);
  // simple deterministic shuffle so it doesn't march in a fixed order
  const idx = (hour * 2654435761 >>> 0) % WEATHER.length;
  return WEATHER[idx];
}

// ── Player load / create ────────────────────────────────────────────────────
export async function getPlayer(userId) {
  const [rows] = await pool.execute('SELECT * FROM fishing_players WHERE user_id = ?', [userId]);
  if (rows.length) return normalize(rows[0]);
  await pool.execute(
    `INSERT INTO fishing_players (user_id, coins, owned_rods, owned_locations, owned_pets)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, STARTER_COINS, JSON.stringify(['wooden']), JSON.stringify(['pond']), JSON.stringify([])]
  );
  const [again] = await pool.execute('SELECT * FROM fishing_players WHERE user_id = ?', [userId]);
  return normalize(again[0]);
}

function normalize(row) {
  return {
    userId: row.user_id,
    coins: Number(row.coins),
    lifetimeEarned: Number(row.lifetime_earned),
    totalCatches: Number(row.total_catches),
    rod: row.current_rod || 'wooden',
    ownedRods: jparse(row.owned_rods, ['wooden']),
    bait: row.current_bait || null,
    baitUses: Number(row.bait_uses) || 0,
    location: row.current_location || 'pond',
    ownedLocations: jparse(row.owned_locations, ['pond']),
    biggestKey: row.biggest_key,
    biggestWeight: Number(row.biggest_weight) || 0,
    dailyStreak: Number(row.daily_streak) || 0,
    lastDaily: row.last_daily,
    quest: jparse(row.quest_json, null),
    questDate: row.quest_date,
    lastCastAt: Number(row.last_cast_at) || 0,
    xp: Number(row.xp) || 0,
    level: Number(row.level) || 1,
    lockedKeys: jparse(row.locked_keys, []),
    pet: row.current_pet || null,
    ownedPets: jparse(row.owned_pets, []),
    autofisherLevel: Number(row.autofisher_level) || 0,
    autofisherClaimedAt: Number(row.autofisher_claimed_at) || 0,
    shinyCaught: Number(row.shiny_caught) || 0,
  };
}

// ── Rarity rolling ──────────────────────────────────────────────────────────
function rollRarity(luck, locationShift, pool_) {
  const tiers = ['junk', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'];
  const present = new Set(pool_.map(f => f.rarity));
  const weights = [];
  let total = 0;
  for (const key of tiers) {
    const meta = RARITIES[key];
    if (key !== 'junk' && !present.has(key)) continue;
    let w = meta.weight;
    if (key === 'junk') w = w / luck;
    else if (key === 'common') { /* flat */ }
    else {
      const tierIndex = tiers.indexOf(key);
      w = w * Math.pow(luck, tierIndex - 1) * Math.pow(locationShift, tierIndex - 1);
    }
    weights.push([key, w]);
    total += w;
  }
  let r = Math.random() * total;
  for (const [key, w] of weights) { r -= w; if (r <= 0) return key; }
  return 'common';
}

function pickFishOfRarity(locationPool, locationId, rarity) {
  if (rarity === 'junk') {
    const j = JUNK[randInt(0, JUNK.length - 1)];
    return { ...FISH_INDEX[fishKey('junk', j.id)], baseId: fishKey('junk', j.id) };
  }
  const pool_ = locationPool.filter(f => f.rarity === rarity);
  const list = pool_.length ? pool_ : locationPool.filter(f => f.rarity === 'common');
  const f = list[randInt(0, list.length - 1)];
  return { ...f, baseId: fishKey(locationId, f.id) };
}

function valueFor(meta, weight, shiny = false) {
  const rmeta = RARITIES[meta.rarity] || RARITIES.common;
  let val;
  if (meta.rarity === 'junk') val = Math.max(1, Math.round(meta.base * rmeta.valueMult));
  else {
    const mid = (meta.minW + meta.maxW) / 2 || 1;
    const sizeFactor = mid > 0 ? Math.min(2.2, Math.max(0.5, weight / mid)) : 1;
    val = Math.max(1, Math.round(meta.base * rmeta.valueMult * sizeFactor));
  }
  return shiny ? val * SHINY_VALUE_MULT : val;
}

// Build the active fish pool for a location, injecting the current month's
// seasonal fish (if any) so events vary play through the year.
function locationPool(location) {
  const month = new Date().getUTCMonth() + 1;
  const seasonal = SEASONAL[month];
  if (!seasonal) return location.fish;
  // register the seasonal fish in the global index so storage/lookups resolve it
  const key = fishKey(location.id, seasonal.id);
  if (!FISH_INDEX[key]) FISH_INDEX[key] = { ...seasonal, location: location.id };
  return [...location.fish, { ...seasonal }];
}

// ── Casting ─────────────────────────────────────────────────────────────────
export async function cast(userId, guildId = null) {
  const p = await getPlayer(userId);
  const now = Date.now();
  const pet = p.pet ? PETS_BY_ID[p.pet] : null;
  const cooldown = Math.max(800, COOLDOWN_MS - (pet?.cdReduce || 0));
  const remaining = p.lastCastAt + cooldown - now;
  if (remaining > 0) return { cooldown: true, remainingMs: remaining };

  const location = LOCATIONS_BY_ID[p.location] || LOCATIONS_BY_ID.pond;
  const rod = RODS_BY_ID[p.rod] || RODS_BY_ID.wooden;
  const weather = getWeather();
  let luck = rod.luck * weather.luck;
  luck *= 1 + Math.min(p.level * LEVEL_LUCK_PER, LEVEL_LUCK_CAP);
  if (pet) luck *= pet.luck;
  let baitConsumed = false;
  if (p.bait && p.baitUses > 0) {
    const bait = BAITS_BY_ID[p.bait];
    if (bait) { luck *= bait.luck; baitConsumed = true; }
  }

  const fishPool = locationPool(location);
  const count = randInt(1, rod.maxCatch);
  const caught = [];
  for (let i = 0; i < count; i++) {
    const rarity = rollRarity(luck, location.rarityShift || 1, fishPool);
    const fish = pickFishOfRarity(fishPool, location.id, rarity);
    const shiny = rarity !== 'junk' && Math.random() < SHINY_CHANCE;
    const weight = rarity === 'junk' ? 0 : Number(rand(fish.minW, fish.maxW).toFixed(3));
    const key = rarity === 'junk' ? fish.baseId : (shiny ? fish.baseId + SHINY_SUFFIX : fish.baseId);
    const value = valueFor(fish, weight, shiny);
    caught.push({ key, baseKey: fish.baseId, name: fish.name, emoji: fish.emoji, rarity, weight, value, shiny });
  }

  const xpGain = caught.reduce((s, c) => s + (XP_PER_RARITY[c.rarity] || 1), 0);
  const before = p;
  await persistCatch(p, caught, baitConsumed, xpGain);

  const newXp = p.xp + xpGain;
  const newLevel = levelFromXp(newXp);
  const leveledUp = newLevel > before.level ? newLevel : null;

  // Quests (catch / rare), guild tally, tournament entry.
  const quest = await applyQuest(p, {
    catch: caught.filter(c => c.rarity !== 'junk').length,
    rare: caught.filter(c => ['rare', 'epic', 'legendary', 'mythical'].includes(c.rarity)).length,
  });
  if (guildId) {
    await bumpGuildStats(guildId, userId, caught.filter(c => c.rarity !== 'junk').length, 0);
    await updateTournamentEntry(guildId, userId, caught.filter(c => c.rarity !== 'junk'));
  }

  return {
    cooldown: false, caught, location, rod, weather,
    bait: baitConsumed ? BAITS_BY_ID[p.bait] : null,
    baitLeft: baitConsumed ? Math.max(0, p.baitUses - 1) : p.baitUses,
    quest, xpGain, level: newLevel, leveledUp,
    shinyHit: caught.some(c => c.shiny),
    player: { ...p, coins: p.coins, xp: newXp, level: newLevel },
  };
}

async function persistCatch(p, caught, baitConsumed, xpGain) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let biggestKey = p.biggestKey, biggestWeight = p.biggestWeight, newCatches = 0, shinyCount = 0;
    for (const c of caught) {
      if (c.rarity === 'junk') continue;
      newCatches++;
      if (c.shiny) shinyCount++;
      // sellable bucket
      await conn.execute(
        `INSERT INTO fishing_inventory (user_id, fish_key, quantity, biggest_weight)
         VALUES (?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + 1,
           biggest_weight = GREATEST(biggest_weight, VALUES(biggest_weight))`,
        [p.userId, c.key, c.weight]
      );
      // permanent bestiary record (survives selling)
      await conn.execute(
        `INSERT INTO fishing_records (user_id, fish_key, times_caught, best_weight, last_caught)
         VALUES (?, ?, 1, ?, NOW())
         ON DUPLICATE KEY UPDATE times_caught = times_caught + 1,
           best_weight = GREATEST(best_weight, VALUES(best_weight)), last_caught = NOW()`,
        [p.userId, c.key, c.weight]
      );
      if (c.weight > biggestWeight) { biggestWeight = c.weight; biggestKey = c.key; }
    }
    await conn.execute(
      `UPDATE fishing_players
         SET total_catches = total_catches + ?,
             bait_uses = GREATEST(0, bait_uses - ?),
             current_bait = CASE WHEN bait_uses - ? <= 0 THEN NULL ELSE current_bait END,
             biggest_key = ?, biggest_weight = ?, last_cast_at = ?,
             xp = xp + ?, level = ?, shiny_caught = shiny_caught + ?
       WHERE user_id = ?`,
      [newCatches, baitConsumed ? 1 : 0, baitConsumed ? 1 : 0, biggestKey, biggestWeight, Date.now(),
       xpGain, levelFromXp(p.xp + xpGain), shinyCount, p.userId]
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

// ── Inventory + selling ─────────────────────────────────────────────────────
export async function getInventory(userId) {
  const [rows] = await pool.execute(
    'SELECT fish_key, quantity, biggest_weight FROM fishing_inventory WHERE user_id = ? AND quantity > 0',
    [userId]
  );
  return rows.map(r => {
    const shiny = isShinyKey(r.fish_key);
    const meta = metaFor(r.fish_key);
    const unit = valueFor(meta, Number(r.biggest_weight) || ((meta.minW + meta.maxW) / 2 || 1), shiny);
    return {
      key: r.fish_key, baseKey: baseKey(r.fish_key), name: meta.name, emoji: meta.emoji,
      rarity: meta.rarity, shiny, quantity: Number(r.quantity), biggestWeight: Number(r.biggest_weight),
      unitValue: unit, totalValue: unit * Number(r.quantity),
    };
  }).sort((a, b) => b.totalValue - a.totalValue);
}

// Sell everything (or one species). Locked species are skipped on a bulk sell.
// Pet coin bonus is applied here. Returns { sold, coins, balance, quest }.
export async function sell(userId, fishKeyOrAll = 'all', guildId = null) {
  const p = await getPlayer(userId);
  const inv = await getInventory(userId);
  const locked = new Set(p.lockedKeys || []);
  let targets;
  if (fishKeyOrAll === 'all') targets = inv.filter(i => !locked.has(i.key) && !locked.has(i.baseKey));
  else targets = inv.filter(i => i.key === fishKeyOrAll || i.baseKey === fishKeyOrAll);
  if (!targets.length) return { sold: 0, coins: 0, balance: p.coins, skippedLocked: fishKeyOrAll === 'all' && inv.length > 0 };

  const pet = p.pet ? PETS_BY_ID[p.pet] : null;
  const bonus = pet ? (1 + pet.coinBonus) : 1;
  let coins = 0, sold = 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const t of targets) {
      coins += Math.round(t.totalValue * bonus);
      sold += t.quantity;
      await conn.execute('DELETE FROM fishing_inventory WHERE user_id = ? AND fish_key = ?', [userId, t.key]);
    }
    await conn.execute(
      'UPDATE fishing_players SET coins = coins + ?, lifetime_earned = lifetime_earned + ? WHERE user_id = ?',
      [coins, coins, userId]
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    conn.release();
    throw e;
  }
  conn.release();

  if (guildId) await bumpGuildStats(guildId, userId, 0, coins);
  const quest = await applyQuest(p, { sell: sold, earn: coins });
  return { sold, coins, balance: p.coins + coins, quest };
}

// ── Trophy lock / unlock ─────────────────────────────────────────────────────
export async function toggleLock(userId, query, lock) {
  const p = await getPlayer(userId);
  const match = await resolveFishKey(userId, query);
  if (!match) return { ok: false, reason: 'No fish matching that name in your collection.' };
  const set = new Set(p.lockedKeys || []);
  if (lock) set.add(match.key); else set.delete(match.key);
  await pool.execute('UPDATE fishing_players SET locked_keys = ? WHERE user_id = ?', [JSON.stringify([...set]), userId]);
  return { ok: true, fish: match, locked: lock };
}

// Resolve a free-text fish name to a stored key (prefers the player's records).
async function resolveFishKey(userId, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return null;
  const [rows] = await pool.execute('SELECT fish_key FROM fishing_records WHERE user_id = ?', [userId]);
  const cands = rows.map(r => ({ key: r.fish_key, meta: metaFor(r.fish_key), shiny: isShinyKey(r.fish_key) }));
  // exact, then startsWith, then includes
  return cands.find(c => c.meta.name.toLowerCase() === q)
    || cands.find(c => c.meta.name.toLowerCase().startsWith(q))
    || cands.find(c => c.meta.name.toLowerCase().includes(q))
    || null;
}

// ── Bestiary (permanent records) ─────────────────────────────────────────────
export async function getRecords(userId) {
  const [rows] = await pool.execute(
    'SELECT fish_key, times_caught, best_weight FROM fishing_records WHERE user_id = ?',
    [userId]
  );
  const list = rows.map(r => ({
    key: r.fish_key, baseKey: baseKey(r.fish_key), shiny: isShinyKey(r.fish_key),
    meta: metaFor(r.fish_key), timesCaught: Number(r.times_caught), bestWeight: Number(r.best_weight),
  }));
  // total catchable species = all non-junk fish across locations (shiny not counted toward base completion)
  const totalSpecies = Object.values(FISH_INDEX).filter(f => f.rarity !== 'junk' && f.location !== 'junk').length;
  const caughtSpecies = new Set(list.filter(l => l.meta.rarity !== 'junk').map(l => l.baseKey)).size;
  return { list, totalSpecies, caughtSpecies };
}

// ── Shop: rods / baits / locations / pets ────────────────────────────────────
export async function buyRod(userId, rodId) {
  const p = await getPlayer(userId);
  const rod = RODS_BY_ID[rodId];
  if (!rod) return { ok: false, reason: 'No such rod.' };
  if (p.ownedRods.includes(rodId)) return { ok: false, reason: 'You already own that rod.' };
  if (p.coins < rod.price) return { ok: false, reason: `Not enough fishcoins (need ${rod.price.toLocaleString()}).` };
  const owned = [...p.ownedRods, rodId];
  await pool.execute('UPDATE fishing_players SET coins = coins - ?, owned_rods = ?, current_rod = ? WHERE user_id = ?',
    [rod.price, JSON.stringify(owned), rodId, userId]);
  return { ok: true, rod, balance: p.coins - rod.price };
}
export async function equipRod(userId, rodId) {
  const p = await getPlayer(userId);
  if (!p.ownedRods.includes(rodId)) return { ok: false, reason: "You don't own that rod." };
  await pool.execute('UPDATE fishing_players SET current_rod = ? WHERE user_id = ?', [rodId, userId]);
  return { ok: true, rod: RODS_BY_ID[rodId] };
}
export async function buyBait(userId, baitId) {
  const p = await getPlayer(userId);
  const bait = BAITS_BY_ID[baitId];
  if (!bait) return { ok: false, reason: 'No such bait.' };
  if (p.coins < bait.price) return { ok: false, reason: `Not enough fishcoins (need ${bait.price.toLocaleString()}).` };
  const newUses = (p.bait === baitId ? p.baitUses : 0) + bait.uses;
  await pool.execute('UPDATE fishing_players SET coins = coins - ?, current_bait = ?, bait_uses = ? WHERE user_id = ?',
    [bait.price, baitId, newUses, userId]);
  return { ok: true, bait, uses: newUses, balance: p.coins - bait.price };
}
export async function buyLocation(userId, locationId) {
  const p = await getPlayer(userId);
  const loc = LOCATIONS_BY_ID[locationId];
  if (!loc) return { ok: false, reason: 'No such location.' };
  if (p.ownedLocations.includes(locationId)) return { ok: false, reason: 'You already unlocked that spot.' };
  if (p.coins < loc.price) return { ok: false, reason: `Not enough fishcoins (need ${loc.price.toLocaleString()}).` };
  const owned = [...p.ownedLocations, locationId];
  await pool.execute('UPDATE fishing_players SET coins = coins - ?, owned_locations = ?, current_location = ? WHERE user_id = ?',
    [loc.price, JSON.stringify(owned), locationId, userId]);
  return { ok: true, location: loc, balance: p.coins - loc.price };
}
export async function travel(userId, locationId) {
  const p = await getPlayer(userId);
  if (!p.ownedLocations.includes(locationId)) return { ok: false, reason: "You haven't unlocked that spot — buy it in `/fish shop`." };
  await pool.execute('UPDATE fishing_players SET current_location = ? WHERE user_id = ?', [locationId, userId]);
  return { ok: true, location: LOCATIONS_BY_ID[locationId] };
}
export async function buyPet(userId, petId) {
  const p = await getPlayer(userId);
  const pet = PETS_BY_ID[petId];
  if (!pet) return { ok: false, reason: 'No such pet.' };
  if (p.ownedPets.includes(petId)) return { ok: false, reason: 'You already own that pet.' };
  if (p.coins < pet.price) return { ok: false, reason: `Not enough fishcoins (need ${pet.price.toLocaleString()}).` };
  const owned = [...p.ownedPets, petId];
  await pool.execute('UPDATE fishing_players SET coins = coins - ?, owned_pets = ?, current_pet = ? WHERE user_id = ?',
    [pet.price, JSON.stringify(owned), petId, userId]);
  return { ok: true, pet, balance: p.coins - pet.price };
}
export async function equipPet(userId, petId) {
  const p = await getPlayer(userId);
  if (petId && !p.ownedPets.includes(petId)) return { ok: false, reason: "You don't own that pet." };
  await pool.execute('UPDATE fishing_players SET current_pet = ? WHERE user_id = ?', [petId || null, userId]);
  return { ok: true, pet: petId ? PETS_BY_ID[petId] : null };
}

// ── Auto-fisher (idle income) ────────────────────────────────────────────────
function autofisherPending(p) {
  if (!p.autofisherLevel) return { coins: 0, hours: 0, capped: false };
  const tier = AUTOFISHER[p.autofisherLevel - 1];
  const start = p.autofisherClaimedAt || Date.now();
  const elapsedH = Math.max(0, (Date.now() - start) / 3600000);
  const hours = Math.min(elapsedH, tier.capHours);
  return { coins: Math.floor(hours * tier.perHour), hours, capped: elapsedH >= tier.capHours, tier };
}
export function getAutofisher(p) { return { level: p.autofisherLevel, pending: autofisherPending(p) }; }
export async function buyAutofisher(userId) {
  const p = await getPlayer(userId);
  const next = AUTOFISHER[p.autofisherLevel]; // level N → index N is the (N+1)th tier
  if (!next) return { ok: false, reason: 'Your auto-fisher is already max level.' };
  if (p.coins < next.price) return { ok: false, reason: `Not enough fishcoins (need ${next.price.toLocaleString()}).` };
  // collect any pending before upgrading so the timer resets cleanly
  const pend = autofisherPending(p);
  await pool.execute(
    'UPDATE fishing_players SET coins = coins - ? + ?, lifetime_earned = lifetime_earned + ?, autofisher_level = ?, autofisher_claimed_at = ? WHERE user_id = ?',
    [next.price, pend.coins, pend.coins, next.level, Date.now(), userId]
  );
  return { ok: true, tier: next, collected: pend.coins, balance: p.coins - next.price + pend.coins };
}
export async function collectAutofisher(userId) {
  const p = await getPlayer(userId);
  if (!p.autofisherLevel) return { ok: false, reason: 'You don\'t own an auto-fisher yet. Buy one in `/fish shop`.' };
  const pend = autofisherPending(p);
  if (pend.coins <= 0) return { ok: false, reason: 'Nothing banked yet — check back later.' };
  await pool.execute(
    'UPDATE fishing_players SET coins = coins + ?, lifetime_earned = lifetime_earned + ?, autofisher_claimed_at = ? WHERE user_id = ?',
    [pend.coins, pend.coins, Date.now(), userId]
  );
  return { ok: true, coins: pend.coins, capped: pend.capped, balance: p.coins + pend.coins };
}

// ── Gifting / trading ────────────────────────────────────────────────────────
export async function giftCoins(fromId, toId, amount) {
  if (fromId === toId) return { ok: false, reason: "You can't gift yourself." };
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'Enter a positive amount.' };
  const from = await getPlayer(fromId);
  if (from.coins < amount) return { ok: false, reason: `You only have ${from.coins.toLocaleString()} fishcoins.` };
  await getPlayer(toId); // ensure recipient row exists
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('UPDATE fishing_players SET coins = coins - ? WHERE user_id = ?', [amount, fromId]);
    await conn.execute('UPDATE fishing_players SET coins = coins + ? WHERE user_id = ?', [amount, toId]);
    await conn.commit();
  } catch (e) { await conn.rollback().catch(() => {}); conn.release(); throw e; }
  conn.release();
  return { ok: true, amount, balance: from.coins - amount };
}
export async function giftFish(fromId, toId, query, qty = 1) {
  if (fromId === toId) return { ok: false, reason: "You can't gift yourself." };
  qty = Math.max(1, Math.floor(Number(qty) || 1));
  const match = await resolveInventoryFish(fromId, query);
  if (!match) return { ok: false, reason: 'You don\'t have that fish in your bucket.' };
  if (match.quantity < qty) return { ok: false, reason: `You only have ${match.quantity} of those.` };
  await getPlayer(toId);
  const meta = metaFor(match.key);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('UPDATE fishing_inventory SET quantity = quantity - ? WHERE user_id = ? AND fish_key = ?', [qty, fromId, match.key]);
    await conn.execute('DELETE FROM fishing_inventory WHERE user_id = ? AND fish_key = ? AND quantity <= 0', [fromId, match.key]);
    await conn.execute(
      `INSERT INTO fishing_inventory (user_id, fish_key, quantity, biggest_weight) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), biggest_weight = GREATEST(biggest_weight, VALUES(biggest_weight))`,
      [toId, match.key, qty, match.biggestWeight]
    );
    // recipient also earns the bestiary record
    await conn.execute(
      `INSERT INTO fishing_records (user_id, fish_key, times_caught, best_weight, last_caught) VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE times_caught = times_caught + VALUES(times_caught), best_weight = GREATEST(best_weight, VALUES(best_weight)), last_caught = NOW()`,
      [toId, match.key, qty, match.biggestWeight]
    );
    await conn.commit();
  } catch (e) { await conn.rollback().catch(() => {}); conn.release(); throw e; }
  conn.release();
  return { ok: true, qty, name: (match.shiny ? '✨ ' : '') + meta.name, emoji: meta.emoji };
}
async function resolveInventoryFish(userId, query) {
  const inv = await getInventory(userId);
  const q = String(query || '').toLowerCase().trim();
  return inv.find(i => i.name.toLowerCase() === q)
    || inv.find(i => i.name.toLowerCase().startsWith(q))
    || inv.find(i => i.name.toLowerCase().includes(q)) || null;
}

// ── Daily reward (streak) ────────────────────────────────────────────────────
export async function claimDaily(userId) {
  const p = await getPlayer(userId);
  const today = todayStr();
  const last = dateOnly(p.lastDaily);
  if (last === today) return { ok: false, reason: 'You already claimed your daily today.' };
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const streak = last === yesterday ? p.dailyStreak + 1 : 1;
  const reward = DAILY_REWARD_BASE + Math.min(streak - 1, 30) * 100;
  await pool.execute(
    'UPDATE fishing_players SET coins = coins + ?, lifetime_earned = lifetime_earned + ?, daily_streak = ?, last_daily = ? WHERE user_id = ?',
    [reward, reward, streak, today, userId]
  );
  return { ok: true, reward, streak, balance: p.coins + reward };
}

// ── Daily quest ──────────────────────────────────────────────────────────────
function rollQuest() {
  const t = DAILY_QUESTS[randInt(0, DAILY_QUESTS.length - 1)];
  const target = randInt(t.targetMin, t.targetMax);
  return { id: t.id, type: t.type, desc: t.desc.replace('{n}', target.toLocaleString()), target, progress: 0, reward: t.reward, claimed: false };
}
export async function getQuest(userId) {
  const p = await getPlayer(userId);
  const today = todayStr();
  if (!p.quest || dateOnly(p.questDate) !== today) {
    const q = rollQuest();
    await pool.execute('UPDATE fishing_players SET quest_json = ?, quest_date = ? WHERE user_id = ?', [JSON.stringify(q), today, userId]);
    return q;
  }
  return p.quest;
}
async function applyQuest(p, deltas) {
  const today = todayStr();
  let q = (p.quest && dateOnly(p.questDate) === today) ? p.quest : rollQuest();
  if (q.claimed) return q;
  const d = deltas[q.type] || 0;
  if (d <= 0) {
    if (!p.quest || dateOnly(p.questDate) !== today) {
      await pool.execute('UPDATE fishing_players SET quest_json = ?, quest_date = ? WHERE user_id = ?', [JSON.stringify(q), today, p.userId]);
    }
    return q;
  }
  q.progress = Math.min(q.target, q.progress + d);
  let paid = 0;
  if (q.progress >= q.target && !q.claimed) { q.claimed = true; paid = q.reward; }
  await pool.execute(
    'UPDATE fishing_players SET quest_json = ?, quest_date = ?, coins = coins + ?, lifetime_earned = lifetime_earned + ? WHERE user_id = ?',
    [JSON.stringify(q), today, paid, paid, p.userId]
  );
  if (paid) q.justRewarded = paid;
  return q;
}

// ── Leaderboards ─────────────────────────────────────────────────────────────
export async function getLeaderboard(by = 'coins', limit = 10) {
  const col = by === 'catches' ? 'total_catches' : 'coins';
  const [rows] = await pool.execute(
    `SELECT user_id, coins, total_catches, lifetime_earned FROM fishing_players ORDER BY ${col} DESC LIMIT ?`, [limit]);
  return rows.map(r => ({ userId: r.user_id, coins: Number(r.coins), catches: Number(r.total_catches), lifetimeEarned: Number(r.lifetime_earned) }));
}
export async function getGuildLeaderboard(guildId, by = 'earned', limit = 10) {
  const col = by === 'catches' ? 'catches' : 'earned';
  const [rows] = await pool.execute(
    `SELECT user_id, catches, earned FROM fishing_guild_stats WHERE guild_id = ? ORDER BY ${col} DESC LIMIT ?`, [guildId, limit]);
  return rows.map(r => ({ userId: r.user_id, catches: Number(r.catches), earned: Number(r.earned) }));
}
async function bumpGuildStats(guildId, userId, catches, earned) {
  await pool.execute(
    `INSERT INTO fishing_guild_stats (guild_id, user_id, catches, earned) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE catches = catches + VALUES(catches), earned = earned + VALUES(earned)`,
    [guildId, userId, catches, earned]
  );
}

// ── Tournaments ──────────────────────────────────────────────────────────────
export async function getActiveTournament(guildId) {
  const [rows] = await pool.execute(
    "SELECT * FROM fishing_tournaments WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [guildId]);
  return rows[0] || null;
}
export async function startTournament(guildId, channelId, startedBy, { type = 'biggest', minutes = 60, prize = 10000 } = {}) {
  const existing = await getActiveTournament(guildId);
  if (existing) return { ok: false, reason: 'A tournament is already running in this server.' };
  minutes = Math.min(1440, Math.max(5, Math.floor(minutes)));
  prize = Math.min(5000000, Math.max(0, Math.floor(prize)));
  const ends = new Date(Date.now() + minutes * 60000);
  const [res] = await pool.execute(
    `INSERT INTO fishing_tournaments (guild_id, channel_id, type, prize, started_by, ends_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [guildId, channelId, type, prize, startedBy, ends.toISOString().slice(0, 19).replace('T', ' ')]
  );
  return { ok: true, id: res.insertId, type, minutes, prize, endsAt: ends };
}
async function updateTournamentEntry(guildId, userId, caughtNonJunk) {
  if (!caughtNonJunk.length) return;
  const t = await getActiveTournament(guildId);
  if (!t) return;
  const addCatches = caughtNonJunk.length;
  let maxW = 0, bestKey = null;
  for (const c of caughtNonJunk) if (c.weight > maxW) { maxW = c.weight; bestKey = c.key; }
  if (t.type === 'most') {
    await pool.execute(
      `INSERT INTO fishing_tournament_entries (tournament_id, user_id, score, catches, best_key) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE catches = catches + VALUES(catches), score = catches + VALUES(catches)`,
      [t.id, userId, addCatches, addCatches, bestKey]
    );
  } else {
    await pool.execute(
      `INSERT INTO fishing_tournament_entries (tournament_id, user_id, score, catches, best_key) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE catches = catches + VALUES(catches),
         best_key = IF(VALUES(score) > score, VALUES(best_key), best_key),
         score = GREATEST(score, VALUES(score))`,
      [t.id, userId, maxW, addCatches, bestKey]
    );
  }
}
export async function getTournamentStandings(tournamentId, limit = 10) {
  const [rows] = await pool.execute(
    'SELECT user_id, score, catches, best_key FROM fishing_tournament_entries WHERE tournament_id = ? ORDER BY score DESC LIMIT ?',
    [tournamentId, limit]);
  return rows.map(r => ({ userId: r.user_id, score: Number(r.score), catches: Number(r.catches), bestKey: r.best_key, bestMeta: r.best_key ? metaFor(r.best_key) : null }));
}
// Called by the scheduler: finalize tournaments past ends_at, pay the winner.
export async function endDueTournaments() {
  const [due] = await pool.execute(
    "SELECT * FROM fishing_tournaments WHERE status = 'active' AND ends_at <= NOW()");
  const results = [];
  for (const t of due) {
    const standings = await getTournamentStandings(t.id, 3);
    const winner = standings[0] || null;
    if (winner && t.prize > 0) {
      await getPlayer(winner.userId);
      await pool.execute('UPDATE fishing_players SET coins = coins + ?, lifetime_earned = lifetime_earned + ? WHERE user_id = ?',
        [t.prize, t.prize, winner.userId]);
    }
    await pool.execute("UPDATE fishing_tournaments SET status = 'ended', winner_id = ? WHERE id = ?",
      [winner?.userId || null, t.id]);
    results.push({ tournament: t, standings, winner });
  }
  return results;
}

// helpers exposed for autocomplete (fish-name suggestions from records/bucket)
export async function suggestFishNames(userId, prefix, fromBucket = false) {
  const q = String(prefix || '').toLowerCase();
  const table = fromBucket ? 'fishing_inventory' : 'fishing_records';
  const [rows] = await pool.execute(`SELECT DISTINCT fish_key FROM ${table} WHERE user_id = ?${fromBucket ? ' AND quantity > 0' : ''} LIMIT 60`, [userId]);
  const names = rows.map(r => ({ key: r.fish_key, name: (isShinyKey(r.fish_key) ? '✨ ' : '') + metaFor(r.fish_key).name }));
  return names.filter(x => x.name.toLowerCase().includes(q)).slice(0, 25);
}

export {
  RARITIES, RODS, BAITS, LOCATIONS, PETS, AUTOFISHER, WEATHER, SEASONAL,
  RODS_BY_ID, BAITS_BY_ID, LOCATIONS_BY_ID, PETS_BY_ID, FISH_INDEX,
  COOLDOWN_MS, fishKey, levelFromXp, xpForLevel,
} from './fishing-data.js';
