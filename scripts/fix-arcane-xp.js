#!/usr/bin/env node
/**
 * Fix Arcane XP migration — adds XP progress within each level.
 *
 * Now that we know Arcane's actual formula (from arcane.bot/calculator):
 *   Arcane XP per level = 100L - 25  (linear curve, multiplier 1)
 *   Arcane cumulative    = 50L² + 25L
 *
 * For each user, calculates their progress fraction within their Arcane level,
 * then maps that same fraction onto Steve's XP requirement for the same level.
 * This preserves relative progress while keeping levels intact.
 *
 * Uses Discord API (Steve bot) for reliable username→userId matching,
 * same approach as the original migration script.
 *
 * Usage:
 *   node scripts/fix-arcane-xp.js              # Dry run
 *   node scripts/fix-arcane-xp.js --commit      # Write to DB
 */

import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '538201414367707137';
const STEVE_BOT_ID = '1469972857701273716';

// Arcane data with corrected XP values from screenshots
const arcaneData = [
  { username: 'krymzynfx', level: 14, arcaneXP: 10400 },
  { username: 'slender21', level: 10, arcaneXP: 6200 },
  { username: 'komabeatzz', level: 10, arcaneXP: 5400 },
  { username: 'greypenguin321', level: 8, arcaneXP: 3900 },
  { username: 'death420', level: 4, arcaneXP: 1400 },
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
  { username: 'nightspeed_fb_alt', level: 1, arcaneXP: 236 },
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

// ─── Arcane XP Formula (from arcane.bot/calculator, Linear curve, multiplier 1) ───

/** Arcane XP required to go from level L-1 to level L */
function arcaneXPForLevel(level) {
    return 100 * level - 25;
}

/** Arcane cumulative XP to reach a given level (with 0 progress) */
function arcaneCumulativeXP(level) {
    return 50 * (level ** 2) + 25 * level;
}

// ─── Steve's XP Formula ───────────────────────────────────────────────

/** Steve XP required to go from level L to level L+1 */
function steveXPForLevel(level) {
    return 5 * (level ** 2) + 50 * level + 100;
}

// ─── Username Matching (same as migration script) ─────────────────────

function normalize(name) {
    return name
        .replace(/^[@.]/, '')
        .toLowerCase()
        .replace(/\s+/g, '');
}

function findMember(members, arcaneUsername) {
    const norm = normalize(arcaneUsername);
    const exactUsername = members.find(m => m.user.username.toLowerCase() === norm);
    if (exactUsername) return exactUsername;
    const globalName = members.find(m => m.user.globalName?.toLowerCase() === norm);
    if (globalName) return globalName;
    const nickname = members.find(m => m.nickname?.toLowerCase() === norm);
    if (nickname) return nickname;
    const partial = members.find(m =>
        m.user.username.toLowerCase().includes(norm) ||
        norm.includes(m.user.username.toLowerCase())
    );
    if (partial) return partial;
    const displayPartial = members.find(m =>
        m.user.globalName?.toLowerCase().includes(norm) ||
        m.nickname?.toLowerCase().includes(norm)
    );
    if (displayPartial) return displayPartial;
    return null;
}

// ─── XP Conversion ───────────────────────────────────────────────────

/**
 * Convert Arcane level + total XP into Steve level + progress XP.
 *
 * Strategy: preserve the user's progress fraction within their current level.
 * - Calculate how far into their Arcane level they are (as a fraction)
 * - Apply that fraction to Steve's XP requirement for the same level transition
 */
function convertToSteveXP(arcaneLevel, arcaneTotalXP) {
    const arcaneCumulative = arcaneCumulativeXP(arcaneLevel);
    const arcaneRemaining = Math.max(0, arcaneTotalXP - arcaneCumulative);
    const arcaneForNext = arcaneXPForLevel(arcaneLevel + 1);
    const fraction = Math.min(1, arcaneRemaining / arcaneForNext);

    const steveForNext = steveXPForLevel(arcaneLevel + 1);
    const steveXP = Math.floor(fraction * steveForNext);

    return {
        level: arcaneLevel,
        xp: steveXP,
        fraction: Math.round(fraction * 100),
        arcaneRemaining,
        arcaneForNext,
        steveForNext
    };
}

// ─── Get Steve Bot Token ──────────────────────────────────────────────

async function getSteveBotToken() {
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

// ─── Main Fix ─────────────────────────────────────────────────────────

async function fix() {
    const args = process.argv.slice(2);
    const dryRun = !args.includes('--commit');

    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  Fix Arcane XP — Proportional Progress Conversion    ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`  Mode: ${dryRun ? '🔍 DRY RUN' : '💾 COMMIT'}`);
    console.log(`  Arcane formula: 100L - 25 per level (linear)`);
    console.log(`  Steve formula:  5L² + 50L + 100 per level\n`);

    // Step 1: Connect to Discord as Steve for reliable username matching
    console.log('1. Connecting to Discord as Steve...');
    const steveToken = await getSteveBotToken();
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
    });
    await client.login(steveToken);
    console.log(`   Logged in as ${client.user.tag}`);

    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch();
    console.log(`   Fetched ${members.size} members\n`);

    // Step 2: Match Arcane usernames to Discord IDs (same as migration)
    console.log('2. Matching Arcane usernames to Discord IDs...');
    const matchedMap = new Map();
    const unmatched = [];

    for (const entry of arcaneData) {
        const member = findMember(Array.from(members.values()), entry.username);
        if (member) {
            const userId = member.user.id;
            const existing = matchedMap.get(userId);
            if (!existing || entry.level > existing.level) {
                matchedMap.set(userId, {
                    ...entry,
                    userId,
                    discordTag: member.user.username,
                });
            }
        } else {
            unmatched.push(entry);
        }
    }

    const matched = Array.from(matchedMap.values());
    console.log(`   Matched: ${matched.length}, Unmatched: ${unmatched.length}\n`);

    // Step 3: Check which matched users exist in DB
    console.log('3. Converting XP and updating...\n');
    console.log('   ┌──────────────────────┬───────┬──────────┬──────────┬─────────┬────────┐');
    console.log('   │ Username             │ Level │ Arcane   │ Progress │ New XP  │ Of     │');
    console.log('   ├──────────────────────┼───────┼──────────┼──────────┼─────────┼────────┤');

    let updated = 0;
    let skippedNotInDB = 0;

    for (const entry of matched) {
        // Check if user exists in DB
        const [dbRows] = await pool.execute(
            'SELECT level, xp FROM user_levels WHERE guild_id = ? AND user_id = ?',
            [GUILD_ID, entry.userId]
        );

        if (dbRows.length === 0) {
            skippedNotInDB++;
            continue;
        }

        const result = convertToSteveXP(entry.level, entry.arcaneXP);

        const nameStr = entry.discordTag.padEnd(20);
        const lvStr = String(result.level).padStart(5);
        const arcStr = String(entry.arcaneXP).toLocaleString().padStart(8);
        const pctStr = (result.fraction + '%').padStart(8);
        const xpStr = String(result.xp).padStart(7);
        const ofStr = String(result.steveForNext).padStart(6);
        console.log(`   │ ${nameStr} │ ${lvStr} │ ${arcStr} │ ${pctStr} │ ${xpStr} │ ${ofStr} │`);

        if (!dryRun) {
            await pool.execute(
                'UPDATE user_levels SET level = ?, xp = ? WHERE guild_id = ? AND user_id = ?',
                [result.level, result.xp, GUILD_ID, entry.userId]
            );
            updated++;
        }
    }

    console.log('   └──────────────────────┴───────┴──────────┴──────────┴─────────┴────────┘\n');

    if (unmatched.length > 0) {
        console.log('   Unmatched (not in server):');
        for (const u of unmatched) {
            console.log(`     - "${u.username}" (Level ${u.level})`);
        }
        console.log();
    }

    if (dryRun) {
        console.log('DRY RUN — no changes. Run with --commit to apply.');
    } else {
        console.log(`Updated ${updated} users. ${skippedNotInDB} not in DB (skipped).`);
    }

    client.destroy();
    await pool.end();
}

fix().catch(err => {
    console.error('Fix failed:', err);
    process.exit(1);
});
