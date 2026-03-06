#!/usr/bin/env node
/**
 * Migrate leveling data from Arcane bot to Steve's leveling system
 *
 * Preserves exact level numbers from Arcane and calculates equivalent
 * XP using Steve's formula (5L² + 50L + 100). Raw XP is NOT transferred
 * because Arcane uses different thresholds — transferring XP would demote users.
 *
 * Usage:
 *   node scripts/migrate-arcane-levels.js              # Dry run (default)
 *   node scripts/migrate-arcane-levels.js --commit      # Actually write to DB
 *   node scripts/migrate-arcane-levels.js --force        # Overwrite existing levels
 */

import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '538201414367707137';
const STEVE_BOT_ID = '1469972857701273716';

/**
 * Get the Steve bot token from custom_bots table (encrypted)
 */
async function getSteveBotToken() {
  // Try bot_id first, then client_id
  let [bots] = await pool.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
    [STEVE_BOT_ID]
  );

  if (bots.length === 0) {
    [bots] = await pool.execute(
      'SELECT bot_token FROM custom_bots WHERE client_id = ?',
      [STEVE_BOT_ID]
    );
  }

  if (bots.length === 0) {
    throw new Error(`Steve bot (${STEVE_BOT_ID}) not found in custom_bots table`);
  }

  return encryption.decrypt(JSON.parse(bots[0].bot_token));
}

// ─── Arcane Leaderboard Data (scraped 2026-02-16) ─────────────────────
const arcaneData = [
  { username: 'krymzynfx', level: 14, arcaneXP: 10400 },
  { username: 'slender21', level: 10, arcaneXP: 6200 },
  { username: 'komabeatzz', level: 10, arcaneXP: 5400 },
  { username: 'greypenguin321', level: 8, arcaneXP: 3900 },
  { username: 'death420', level: 4, arcaneXP: 1300 },
  { username: 'jellybean1818_184', level: 4, arcaneXP: 1200 },
  { username: 'folitentraoada', level: 4, arcaneXP: 1100 },
  { username: 'l1ttle_st0ney', level: 4, arcaneXP: 994 },
  { username: 'QueenOfHearts710', level: 4, arcaneXP: 953 },
  { username: 'oni6yf', level: 3, arcaneXP: 875 },
  { username: 'creamy2day', level: 3, arcaneXP: 841 },
  { username: 'remedy_real', level: 3, arcaneXP: 776 },
  { username: 'nightspeed_fb', level: 3, arcaneXP: 717 },
  { username: 'brocilboy', level: 3, arcaneXP: 557 },
  { username: 'bestboismit', level: 2, arcaneXP: 338 },
  { username: 'wigglesjr', level: 2, arcaneXP: 282 },
  { username: 'nightspeed_fb_alt', level: 1, arcaneXP: 236 },  // duplicate username — likely alt or display name
  { username: 'giraffe_neck987', level: 1, arcaneXP: 202 },
  { username: 'eg6_ang.', level: 1, arcaneXP: 162 },
  { username: 'sleepysnorlax911', level: 1, arcaneXP: 145 },
  { username: 'komavortex5132', level: 1, arcaneXP: 145 },
  { username: 'macjew', level: 1, arcaneXP: 140 },
  { username: 'your_salt_addiction', level: 1, arcaneXP: 140 },
  { username: 'aprilrose1420', level: 1, arcaneXP: 140 },
  { username: 'Dom..', level: 1, arcaneXP: 114 },
  { username: 'juicyplayer957', level: 1, arcaneXP: 114 },
  { username: 'saminsam', level: 1, arcaneXP: 113 },
  { username: 'exodine.', level: 1, arcaneXP: 97 },
  { username: 'ziorax.', level: 1, arcaneXP: 95 },
  { username: 'cypci', level: 1, arcaneXP: 94 },
  { username: 'justkillin4fun', level: 1, arcaneXP: 81 },
  { username: 'frickzy.', level: 1, arcaneXP: 79 },
  { username: 'trunksm', level: 0, arcaneXP: 74 },
  { username: 'pxveilpx', level: 0, arcaneXP: 55 },
  { username: 'diamond2603', level: 0, arcaneXP: 38 },
  { username: 'romey.yy', level: 0, arcaneXP: 34 },
  { username: 'tbtheone14_77109', level: 0, arcaneXP: 33 },
  { username: 'koma_swift', level: 0, arcaneXP: 31 },
  { username: 'k2_geekd', level: 0, arcaneXP: 31 },
  { username: 'seegzygaming', level: 0, arcaneXP: 24 },
  { username: 'superkaioshin', level: 0, arcaneXP: 23 },
  { username: 'igivelightshows_kurbyftw', level: 0, arcaneXP: 22 },
  { username: 'fr.scar', level: 0, arcaneXP: 19 },
  { username: 'skiffback13', level: 0, arcaneXP: 19 },
  { username: 'anonymous041040', level: 0, arcaneXP: 17 },
  { username: '.sonai', level: 0, arcaneXP: 16 },
];

// ─── Steve's XP Formula ───────────────────────────────────────────────

/** XP required to go from level L to level L+1 */
function getXPForLevel(level) {
  return 5 * (level ** 2) + 50 * level + 100;
}

/** Total cumulative XP to reach a given level (with 0 progress) */
function getTotalXPForLevel(level) {
  let total = 0;
  for (let i = 1; i <= level; i++) {
    total += getXPForLevel(i);
  }
  return total;
}

// ─── Username Matching ────────────────────────────────────────────────

/**
 * Normalize a username for fuzzy matching:
 * - Strip leading @/.
 * - Lowercase
 * - Remove trailing discriminator patterns like _184, _77109
 */
function normalize(name) {
  return name
    .replace(/^[@.]/, '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * Attempt to match an Arcane username to a guild member.
 * Tries: exact username, display name, global name, nickname.
 */
function findMember(members, arcaneUsername) {
  const norm = normalize(arcaneUsername);

  // Pass 1: exact username match
  const exactUsername = members.find(m => m.user.username.toLowerCase() === norm);
  if (exactUsername) return exactUsername;

  // Pass 2: global display name
  const globalName = members.find(m => m.user.globalName?.toLowerCase() === norm);
  if (globalName) return globalName;

  // Pass 3: server nickname
  const nickname = members.find(m => m.nickname?.toLowerCase() === norm);
  if (nickname) return nickname;

  // Pass 4: partial/fuzzy — username starts with or contains
  const partial = members.find(m =>
    m.user.username.toLowerCase().includes(norm) ||
    norm.includes(m.user.username.toLowerCase())
  );
  if (partial) return partial;

  // Pass 5: display name contains
  const displayPartial = members.find(m =>
    m.user.globalName?.toLowerCase().includes(norm) ||
    m.nickname?.toLowerCase().includes(norm)
  );
  if (displayPartial) return displayPartial;

  return null;
}

// ─── Main Migration ───────────────────────────────────────────────────

async function migrate() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--commit');
  const force = args.includes('--force');

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Arcane → Steve Leveling Migration           ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Mode:   ${dryRun ? '🔍 DRY RUN (no changes)' : '💾 COMMIT (writing to DB)'}`);
  console.log(`  Force:  ${force ? 'Yes (overwrite existing)' : 'No (skip existing)'}`);
  console.log(`  Guild:  ${GUILD_ID}`);
  console.log(`  Users:  ${arcaneData.length}\n`);

  // ── Step 1: Connect to Discord via Steve bot ────────────────────────
  console.log('1. Fetching Steve bot token from custom_bots...');
  const steveToken = await getSteveBotToken();
  console.log('   Token retrieved successfully');

  console.log('   Connecting to Discord as Steve...');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
  });

  await client.login(steveToken);
  console.log(`   Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  const members = await guild.members.fetch();
  console.log(`   Fetched ${members.size} members from ${guild.name}\n`);

  // ── Step 2: Resolve usernames to user IDs ───────────────────────────
  console.log('2. Matching Arcane usernames to Discord IDs...');
  const matchedMap = new Map(); // userId → best entry (deduplicates, keeps highest level)
  const unmatched = [];
  const skippedLevel0 = [];

  for (const entry of arcaneData) {
    // Skip level 0 users — they'd get 0 XP (same as default)
    if (entry.level === 0) {
      skippedLevel0.push(entry);
      continue;
    }

    const member = findMember(Array.from(members.values()), entry.username);
    if (member) {
      const userId = member.user.id;
      const existing = matchedMap.get(userId);

      // Deduplicate: keep the higher level for the same Discord user
      if (!existing || entry.level > existing.level) {
        matchedMap.set(userId, {
          ...entry,
          userId,
          discordTag: member.user.username,
          displayName: member.displayName,
        });
        if (existing) {
          console.log(`   ⚡ Duplicate "${entry.username}" — keeping level ${entry.level} over ${existing.level}`);
        }
      }
    } else {
      unmatched.push(entry);
    }
  }

  const matched = Array.from(matchedMap.values());

  const eligibleCount = arcaneData.length - skippedLevel0.length;
  console.log(`   Matched:     ${matched.length}/${eligibleCount} eligible users`);
  console.log(`   Skipped L0:  ${skippedLevel0.length} (no XP to transfer)`);
  if (unmatched.length > 0) {
    console.log(`   Unmatched:   ${unmatched.length}`);
    for (const u of unmatched) {
      console.log(`     ⚠  "${u.username}" (Level ${u.level}) — not in server`);
    }
  }
  console.log();

  // ── Step 3: Calculate Steve XP equivalents ──────────────────────────
  console.log('3. Calculating Steve XP for each user...\n');
  console.log('   ┌─────────────────────────┬───────┬────────────┬──────────────┐');
  console.log('   │ User                    │ Level │ Arcane XP  │ Steve XP     │');
  console.log('   ├─────────────────────────┼───────┼────────────┼──────────────┤');

  for (const user of matched) {
    const steveTotal = getTotalXPForLevel(user.level);
    user.steveTotalXP = steveTotal;
    user.steveLevel = user.level;
    user.steveCurrentXP = 0; // Start with 0 progress into current level

    const arcaneStr = user.arcaneXP.toLocaleString().padStart(8);
    const steveStr = steveTotal.toLocaleString().padStart(10);
    const nameStr = user.discordTag.padEnd(23);
    console.log(`   │ ${nameStr} │ ${String(user.level).padStart(5)} │ ${arcaneStr}  │ ${steveStr}  │`);
  }

  console.log('   └─────────────────────────┴───────┴────────────┴──────────────┘\n');

  // ── Step 4: Write to database ───────────────────────────────────────
  if (dryRun) {
    console.log('4. DRY RUN — no database changes made.');
    console.log('   Run with --commit to apply changes.\n');
    client.destroy();
    await pool.end();
    return;
  }

  console.log('4. Writing to user_levels table...');

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const user of matched) {
    try {
      if (!force) {
        // Check if user already has leveling data
        const [existing] = await pool.execute(
          'SELECT level, xp FROM user_levels WHERE guild_id = ? AND user_id = ?',
          [GUILD_ID, user.userId]
        );

        if (existing.length > 0 && existing[0].level > 0) {
          console.log(`   ⏭  ${user.discordTag} — already at level ${existing[0].level}, skipping`);
          skipped++;
          continue;
        }
      }

      const [result] = await pool.execute(
        `INSERT INTO user_levels (guild_id, user_id, xp, level, voice_xp, total_voice_minutes)
         VALUES (?, ?, ?, ?, 0, 0)
         ON DUPLICATE KEY UPDATE xp = VALUES(xp), level = VALUES(level)`,
        [GUILD_ID, user.userId, user.steveCurrentXP, user.steveLevel]
      );

      if (result.affectedRows === 1) {
        inserted++;
        console.log(`   ✅ ${user.discordTag} — inserted at level ${user.steveLevel}`);
      } else if (result.affectedRows === 2) {
        updated++;
        console.log(`   🔄 ${user.discordTag} — updated to level ${user.steveLevel}`);
      }
    } catch (err) {
      console.error(`   ❌ ${user.discordTag} — error: ${err.message}`);
    }
  }

  client.destroy();
  await pool.end();

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Migration Complete                          ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Inserted:  ${String(inserted).padStart(3)}                              ║`);
  console.log(`║  Updated:   ${String(updated).padStart(3)}                              ║`);
  console.log(`║  Skipped:   ${String(skipped).padStart(3)}                              ║`);
  console.log(`║  Unmatched: ${String(unmatched.length).padStart(3)}                              ║`);
  console.log('╚══════════════════════════════════════════════╝');

  if (unmatched.length > 0) {
    console.log('\nUnmatched users need manual resolution:');
    for (const u of unmatched) {
      console.log(`  - "${u.username}" (Level ${u.level})`);
      console.log(`    Use: /level set-xp @user <amount>`);
      console.log(`    XP needed for level ${u.level}: ${getTotalXPForLevel(u.level)}`);
    }
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
