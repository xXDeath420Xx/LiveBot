/*
 * Rebuild a user's OwO state from an #owo-game channel.
 *
 *   node scripts/owo-import-from-channel.mjs <guildId> <channelId> [--apply]
 *
 * OwO stores its data on OwO's servers and exposes no API, so the only evidence of what anyone
 * owns is what OwO *said* in the channel. That turns out to be enough, because OwO is chatty:
 *
 *   • `owo inv` prints an exact inventory — every gem, lootbox, crate and weapon, with counts.
 *     That is the baseline.
 *   • every hunt, lootbox opening and battle after it is a delta we can replay forward.
 *   • the hunt line carries the active gems' remaining uses in `[left/length]`.
 *
 * What this CANNOT recover, and does not pretend to:
 *   • cowoncy — never printed in the channel.
 *   • the zoo as it stood BEFORE the channel existed. OwO's economy is global, so animals caught
 *     in other servers are invisible here. We only replay the hunts we can see, so the imported
 *     zoo is a floor, not the true total.
 *   • weapon QUALITIES. We know she owns 15 GreatSwords; we do not know each one's rolled stats,
 *     so those are re-rolled. The type and the count are exact.
 *
 * REST-GET only against Discord. Writes nothing unless --apply.
 */
import 'dotenv/config';
import { REST } from 'discord.js';
import mysql from 'mysql2/promise';
import encryption from '../utils/encryption.js';
import pool from '../utils/db.js';
import { GEMS, byId as gemById } from '../core/owo/gems.js';
import { generateWeapon, saveWeapon } from '../core/owo/weapons-service.js';
import { createTeam, setActiveTeam, addAnimalToTeam } from '../core/owo/teams-service.js';
import { xpForLevel } from '../core/owo/pet-levels.js';
import { getCatalog, RANK_META } from '../core/owo/catalog.js';

const [, , GUILD, CHANNEL, ...flags] = process.argv;
const APPLY = flags.includes('--apply');
if (!GUILD || !CHANNEL) {
  console.error('usage: owo-import-from-channel.mjs <guildId> <channelId> [--apply]');
  process.exit(1);
}

// ── parsing ──────────────────────────────────────────────────────────────────

const SUPER = { '⁰': 0, '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9 };
const unSuper = (s) => Number([...s].map(c => SUPER[c] ?? '').join('')) || 0;

/** `<a:lgem1:4925…>` -> "lgem1" */
const emojiName = (tag) => /^<a?:(\w+):\d+>$/.exec(tag)?.[1] ?? null;

/**
 * The `owo inv` dump: rows of "`050`<:box:…>⁰⁰³". The leading number is the item id —
 * gems use their catalog id, 50 is a lootbox, 100 a weapon crate, and 101+ are weapons
 * (weapon id = item id - 100).
 */
function parseInventory(content) {
  const inv = { gems: {}, lootboxes: 0, crates: 0, weapons: {} };
  for (const m of content.matchAll(/`(\d+)`<a?:(\w+):\d+>([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g)) {
    const id = Number(m[1]);
    const count = unSuper(m[3]);
    if (id === 50) inv.lootboxes = count;
    else if (id === 100) inv.crates = count;
    else if (id >= 101) inv.weapons[id - 100] = count;
    else if (gemById(id)) inv.gems[gemById(id).gname] = count;
  }
  return inv;
}

const isHunt = (c) => /\*\*🌱 \| .+\*\*/.test(c) && /You found:/.test(c);

/** Animals are literal `:shortcode:` tokens after "You found:". */
function parseHunt(content) {
  const found = /You found:([^\n]*)/.exec(content)?.[1] ?? '';
  const animals = [...found.matchAll(/:(\w+):/g)].map(m => `:${m[1]}:`);

  // Active gems, as `<gem>`[left/length]`` — the value shown is what remains AFTER this hunt.
  const gems = {};
  for (const m of content.matchAll(/<a?:(\w+):\d+>`\[(\d+)\/(\d+)\]`/g)) {
    gems[m[1]] = { left: Number(m[2]), length: Number(m[3]) };
  }
  return { animals, gems, lootbox: /You found a \*\*lootbox\*\*/.test(content) };
}

const isCrateDrop = (c) => /You found a \*\*weapon crate\*\*/.test(c);

/** Single open: "…finds an **Uncommon Empowering Gem**!"  Multi: "…finds: <gem>¹ <gem>²" */
function parseLootboxOpen(content) {
  const single = /opens a lootbox/.test(content);
  const multi = /opens (\d+) lootboxes/.exec(content);
  if (!single && !multi) return null;

  const gems = {};
  if (single) {
    const named = /finds an? \*\*(\w+) (\w+) Gem\*\*/.exec(content);
    if (!named) return null;
    const gem = Object.values(GEMS).find(g => g.tier === named[1] && g.type === named[2]);
    if (gem) gems[gem.gname] = 1;
    return { spent: 1, gems };
  }

  for (const m of content.matchAll(/<a?:(\w+):\d+>([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g)) {
    if (GEMS[m[1]]) gems[m[1]] = (gems[m[1]] ?? 0) + unSuper(m[2]);
  }
  return { spent: Number(multi[1]), gems };
}

/** Battle embed: pets and their levels from the player's team field. */
function parseBattle(msg) {
  const e = msg.embeds?.[0];
  const who = /^(.+) goes into battle!$/.exec(e?.author?.name ?? '');
  if (!who) return null;
  const teamField = e.fields?.[0];
  if (!teamField) return null;

  const pets = [...String(teamField.value).matchAll(/L\.\s*(\d+)\s+(<a?:\w+:\d+>|:\w+:)/g)]
    .map(m => ({ level: Number(m[1]), animal: emojiName(m[2]) ? `:${emojiName(m[2])}:` : m[2] }));

  return { user: who[1], teamName: teamField.name, pets };
}

// ── fetch ────────────────────────────────────────────────────────────────────

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[bot]] = await db.execute(
  'SELECT bot_token FROM custom_bots WHERE bot_id = (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1)',
  [GUILD]);
await db.end();
if (!bot) { console.error('No custom bot mapped to that guild.'); process.exit(1); }

const rest = new REST({ version: '10' }).setToken(encryption.decrypt(JSON.parse(bot.bot_token)));

let before = null; const messages = [];
for (;;) {
  const q = new URLSearchParams({ limit: '100' });
  if (before) q.set('before', before);
  const page = await rest.get(`/channels/${CHANNEL}/messages?${q}`);
  messages.push(...page);
  if (page.length < 100) break;
  before = page[page.length - 1].id;
}
messages.reverse(); // oldest first — we replay forward
console.log(`read ${messages.length} messages\n`);

// ── replay ───────────────────────────────────────────────────────────────────

/**
 * OwO addresses people by DISPLAY name ("Kabs"), which is not their username and changes over
 * time. The reliable link is the human message immediately before OwO's reply — OwO answers the
 * person who ran the command. So we track the last human author and attribute to them.
 */
const state = new Map(); // userId -> { name, gems, active, lootboxes, crates, weapons, zoo, team }
const blank = (name) => ({
  name, gems: {}, active: {}, lootboxes: 0, crates: 0, weapons: {},
  zoo: {}, team: null, sawInventory: false, hunts: 0, battles: 0,
});

let lastHuman = null;
for (const msg of messages) {
  if (!msg.author.bot) { lastHuman = msg.author; continue; }
  if (!lastHuman) continue;

  const s = state.get(lastHuman.id) ?? blank(lastHuman.username);
  state.set(lastHuman.id, s);
  const c = msg.content ?? '';

  if (/=+ .+'s Inventory =+/.test(c) || (s.sawInventory && /^`\d+`/.test(c.trim()))) {
    const inv = parseInventory(c);
    // The dump spills over two messages; merge rather than overwrite.
    for (const [g, n] of Object.entries(inv.gems)) s.gems[g] = n;
    for (const [w, n] of Object.entries(inv.weapons)) s.weapons[w] = n;
    if (inv.lootboxes) s.lootboxes = inv.lootboxes;
    if (inv.crates) s.crates = inv.crates;
    s.sawInventory = true;
    continue;
  }

  if (isHunt(c)) {
    const h = parseHunt(c);
    s.hunts++;
    for (const a of h.animals) s.zoo[a] = (s.zoo[a] ?? 0) + 1;
    for (const [g, v] of Object.entries(h.gems)) s.active[g] = v.left; // latest wins
    if (h.lootbox) s.lootboxes++;
    continue;
  }

  if (isCrateDrop(c)) { s.crates++; continue; }

  const open = parseLootboxOpen(c);
  if (open) {
    s.lootboxes = Math.max(0, s.lootboxes - open.spent);
    for (const [g, n] of Object.entries(open.gems)) s.gems[g] = (s.gems[g] ?? 0) + n;
    continue;
  }

  const b = parseBattle(msg);
  if (b) { s.battles++; s.team = { name: b.teamName, pets: b.pets }; }
}

// ── report ───────────────────────────────────────────────────────────────────

const catalog = await getCatalog();
const rankOf = (name) => catalog.byName?.[name]?.rank ?? null;

for (const [uid, s] of state) {
  if (!s.hunts && !s.sawInventory) continue;
  const totalAnimals = Object.values(s.zoo).reduce((a, b) => a + b, 0);
  const totalWeapons = Object.values(s.weapons).reduce((a, b) => a + b, 0);

  console.log(`══ ${s.name} (${uid}) ══`);
  console.log(`  inventory snapshot found : ${s.sawInventory ? 'yes' : 'NO — gems/crates/weapons cannot be recovered'}`);
  console.log(`  hunts replayed           : ${s.hunts}   battles: ${s.battles}`);
  console.log(`  lootboxes                : ${s.lootboxes}`);
  console.log(`  weapon crates            : ${s.crates}`);
  console.log(`  weapons                  : ${totalWeapons} across ${Object.keys(s.weapons).length} types`);
  console.log(`  gems owned               : ${Object.values(s.gems).reduce((a, b) => a + b, 0)} across ${Object.keys(s.gems).length} kinds`);
  const act = Object.entries(s.active).map(([g, left]) => `${g} [${left}/${GEMS[g]?.length ?? '?'}]`);
  console.log(`  gems active              : ${act.join(', ') || 'none'}`);
  console.log(`  zoo (from visible hunts) : ${totalAnimals} animals, ${Object.keys(s.zoo).length} species`);
  if (s.team) console.log(`  team "${s.team.name}"      : ${s.team.pets.map(p => `${p.animal} L${p.level}`).join(', ')}`);
  console.log();
}

if (!APPLY) {
  console.log('DRY RUN — nothing written. Re-run with --apply to import.');
  await pool.end();
  process.exit(0);
}

// ── apply ────────────────────────────────────────────────────────────────────

for (const [uid, s] of state) {
  if (!s.hunts && !s.sawInventory) continue;
  console.log(`importing ${s.name}…`);

  for (const [gname, gcount] of Object.entries(s.gems)) {
    await pool.execute(
      `INSERT INTO owo_user_gem (guild_id, uid, gname, gcount, activecount) VALUES (?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE gcount = VALUES(gcount)`,
      [GUILD, uid, gname, gcount]);
  }
  // Active gems keep their remaining uses, so a half-spent Legendary stays half-spent.
  for (const [gname, left] of Object.entries(s.active)) {
    await pool.execute(
      `INSERT INTO owo_user_gem (guild_id, uid, gname, gcount, activecount) VALUES (?, ?, ?, 0, ?)
       ON DUPLICATE KEY UPDATE activecount = VALUES(activecount)`,
      [GUILD, uid, gname, left]);
  }

  await pool.execute(
    `INSERT INTO owo_lootbox (guild_id, id, boxcount) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE boxcount = VALUES(boxcount)`,
    [GUILD, uid, s.lootboxes]);

  await pool.execute(
    `INSERT INTO owo_crate (guild_id, uid, cratetype, boxcount) VALUES (?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE boxcount = VALUES(boxcount)`,
    [GUILD, uid, s.crates]);

  // Weapons: the type and the count are known, the rolled qualities are not — those re-roll.
  const [[have]] = await pool.execute(
    'SELECT COUNT(*) AS n FROM owo_user_weapon WHERE guild_id = ? AND uid = ?', [GUILD, uid]);
  if (Number(have.n) === 0) {
    for (const [wid, n] of Object.entries(s.weapons)) {
      for (let i = 0; i < n; i++) await saveWeapon(GUILD, uid, generateWeapon(Number(wid)));
    }
  } else {
    console.log(`  (skipping weapons — ${have.n} already present, refusing to duplicate)`);
  }

  // The zoo needs the team's pets in it even if they were never caught on camera, or the team
  // cannot be rebuilt below.
  const zoo = { ...s.zoo };
  for (const p of s.team?.pets ?? []) if (!zoo[p.animal]) zoo[p.animal] = 1;

  for (const [name, count] of Object.entries(zoo)) {
    const rank = rankOf(name);
    if (!rank) continue;
    await pool.execute(
      `INSERT INTO owo_animal (guild_id, id, name, count, totalcount) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE count = VALUES(count), totalcount = VALUES(totalcount)`,
      [GUILD, uid, name, count, count]);
    if (RANK_META[rank]) {
      await pool.execute(
        `INSERT INTO owo_animal_count (guild_id, id, \`${rank}\`) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE \`${rank}\` = VALUES(\`${rank}\`)`,
        [GUILD, uid, count]);
    }
  }

  // Rebuild the battle team, pets at the level the battle embeds showed. Without this `owob`
  // simply refuses to run, which would be the most visible possible regression.
  if (s.team?.pets?.length) {
    const [[existing]] = await pool.execute(
      'SELECT pgid FROM owo_pet_team WHERE guild_id = ? AND uid = ? LIMIT 1', [GUILD, uid]);

    let pgid = existing?.pgid;
    if (!pgid) {
      const made = await createTeam(GUILD, uid, s.team.name);
      pgid = made.pgid;
      await setActiveTeam(GUILD, uid, pgid);
    }

    for (const pet of s.team.pets) {
      const xp = xpForLevel(pet.level);
      await pool.execute(
        'UPDATE owo_animal SET xp = ?, ispet = 1 WHERE guild_id = ? AND id = ? AND name = ?',
        [xp, GUILD, uid, pet.animal]);
      await addAnimalToTeam(GUILD, uid, pgid, pet.animal).catch(() => { /* already on the team */ });
    }
    console.log(`  team "${s.team.name}" rebuilt: ${s.team.pets.map(p => `${p.animal} L${p.level}`).join(', ')}`);
  }

  console.log(`  done: ${Object.keys(s.gems).length} gem kinds, ${s.lootboxes} lootboxes, ${s.crates} crates, ${Object.keys(zoo).length} species`);
}

console.log('\nimport complete.');
await pool.end();
