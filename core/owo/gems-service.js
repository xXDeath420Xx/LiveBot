/*
 * OwO gems — CC-BY-NC-SA-4.0 derivative. See /LICENSE-OWO-NOTICE.md.
 *
 * Ownership, activation and per-hunt consumption.
 *
 * `owo_user_gem` carries both numbers:
 *   gcount      how many of this gem you own, unused, in your inventory
 *   activecount how many USES are left on the active one — this is the `[left/length]` counter.
 *               Activating a gem moves one from gcount into activecount = gem.length.
 *
 * Only one gem per TYPE may be active at a time, which is what makes the hunt line show at most
 * one Hunting + one Empowering + one Lucky gem.
 */
import pool from '../../utils/db.js';
import { GEMS, HUNT_SLOTS, byId, byName, gemName, rollGem } from './gems.js';

/** Gems you own but have not activated. */
export async function listOwned(guildId, userId) {
  const [rows] = await pool.execute(
    'SELECT gname, gcount FROM owo_user_gem WHERE guild_id = ? AND uid = ? AND gcount > 0',
    [guildId, userId]);
  return rows
    .map(r => ({ ...byName(r.gname), count: Number(r.gcount) }))
    .filter(g => g.gname)
    .sort((a, b) => a.id - b.id);
}

/** Gems currently active, keyed by type — at most one per type. */
export async function getActive(guildId, userId) {
  const [rows] = await pool.execute(
    'SELECT gname, activecount FROM owo_user_gem WHERE guild_id = ? AND uid = ? AND activecount > 0',
    [guildId, userId]);

  const active = {};
  for (const r of rows) {
    const gem = byName(r.gname);
    if (gem) active[gem.type] = { ...gem, activecount: Number(r.activecount) };
  }
  return active;
}

/** Grant gems (from a lootbox). `gems` is a list of catalog entries. */
export async function grant(guildId, userId, gems) {
  const tally = new Map();
  for (const g of gems) tally.set(g.gname, (tally.get(g.gname) ?? 0) + 1);

  for (const [gname, n] of tally) {
    await pool.execute(
      `INSERT INTO owo_user_gem (guild_id, uid, gname, gcount) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE gcount = gcount + VALUES(gcount)`,
      [guildId, userId, gname, n]);
  }
}

/** Roll `n` gems out of lootboxes and bank them. Returns them grouped for display. */
export async function grantRolled(guildId, userId, n) {
  const rolled = Array.from({ length: n }, () => rollGem());
  await grant(guildId, userId, rolled);

  const grouped = new Map();
  for (const g of rolled) {
    const e = grouped.get(g.gname) ?? { gem: g, count: 0 };
    e.count++;
    grouped.set(g.gname, e);
  }
  return [...grouped.values()].sort((a, b) => a.gem.id - b.gem.id);
}

/**
 * Activate gems by catalog id. Refuses two of the same type, mirroring upstream — you cannot
 * stack two Hunting gems, and silently ignoring the second would be worse than saying so.
 */
export async function use(guildId, userId, ids) {
  if (!ids.length) return { error: 'Give me a gem id — `owo gems` lists yours.' };
  if (ids.length > 4) return { error: 'You can only use up to four gems at one time!' };

  const wanted = [];
  const seenTypes = new Set();
  for (const id of ids) {
    const gem = byId(id);
    if (!gem) return { error: `\`${id}\` is not a gem id.` };
    if (seenTypes.has(gem.type)) {
      return { error: `You can not use multiple **${gem.type} Gems** at the same time!` };
    }
    seenTypes.add(gem.type);
    wanted.push(gem);
  }

  const activated = [];
  for (const gem of wanted) {
    // One statement, guarded on gcount > 0, so two concurrent `owo use` cannot both spend the
    // last gem. activecount is overwritten, not added to: re-activating restarts the counter.
    const [r] = await pool.execute(
      `UPDATE owo_user_gem SET gcount = gcount - 1, activecount = ?
       WHERE guild_id = ? AND uid = ? AND gname = ? AND gcount > 0`,
      [gem.length, guildId, userId, gem.gname]);
    if (r.affectedRows === 1) activated.push(gem);
  }

  if (!activated.length) return { error: "You don't have any of those gems!" };
  return { activated };
}

/**
 * How many uses a hunt burns off each active gem. Straight from upstream, and deliberately
 * uneven: Hunting always costs 1, while Empowering costs half the animals it just gave you, so a
 * bigger hunt burns the Empowering gem faster. Lucky normally costs one use PER ANIMAL — unless
 * you are running Hunting AND Empowering too, in which case it is halved, which is upstream's way
 * of making a full three-gem loadout last.
 */
export function huntCost(type, animalCount, active) {
  const full = !!active.Hunting && !!active.Empowering;
  switch (type) {
    case 'Hunting':
    case 'Patreon':
      return 1;
    case 'Empowering':
      return Math.trunc(animalCount / 2);
    case 'Lucky':
    case 'Special':
      return full ? Math.trunc(animalCount / 2) : animalCount;
    default:
      return 1;
  }
}

/** Burn this hunt's uses off every active gem. Never goes below zero. */
export async function consumeForHunt(guildId, userId, animalCount, active) {
  for (const gem of Object.values(active)) {
    const cost = huntCost(gem.type, animalCount, active);
    if (cost <= 0) continue;
    await pool.execute(
      `UPDATE owo_user_gem SET activecount = GREATEST(activecount - ?, 0)
       WHERE guild_id = ? AND uid = ? AND gname = ?`,
      [cost, guildId, userId, gem.gname]);
  }
}

/**
 * The "hunt is empowered by 🔮`[24/25]` …" line. Shows what will be LEFT after this hunt, which
 * is why it takes the cost off here rather than reading the row back.
 */
export function empoweredBy(active, animalCount) {
  const parts = [];
  for (const type of HUNT_SLOTS) {
    const gem = active[type];
    if (!gem) continue;
    const left = Math.max(0, gem.activecount - huntCost(type, animalCount, active));
    parts.push(`${gem.emoji}\`[${left}/${gem.length}]\``);
  }
  return parts.join(' ');
}

export { GEMS, gemName, byId, byName };
