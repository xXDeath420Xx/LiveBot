import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '877253051994501130';
const BOT_ID = '1473622894138491007';

// MEE6 leaderboard data extracted from screenshots
// Format: [rank, displayName, messages, totalXP, level]
const MEE6_DATA = [
  [1, 'crucicafe', 1300, 25200, 20],
  [2, 'bigbrogamer', 233, 4600, 9],
  [3, 'smurfybizzle', 170, 3400, 8],
  [4, 'mrs.muse', 160, 3100, 8],
  [5, 'cagykarma19', 143, 2800, 7],
  [6, 'madvox98', 137, 2700, 7],
  [7, 'TerrelsIsthegoat', 126, 2500, 7],
  [8, 'sonicthehedgehog135', 123, 2500, 7],
  [9, 'momsonline', 119, 2300, 7],
  [10, 'ftv_goblin', 99, 2000, 6],
  [11, 'bigpapito420', 95, 1900, 6],
  [12, 'nasherthedragongd4u', 84, 1700, 6],
  [13, 'kaagyboy', 78, 1600, 5],
  [14, 'Superman85', 74, 1500, 5],
  [15, 'itswhitebeanss', 57, 1100, 4],
  [16, 'excitee', 47, 978, 4],
  [17, 'alpha_drako_91', 45, 938, 4],
  [18, 'jordanlouisejenkins', 45, 901, 4],
  [19, 'Pali_Mo', 44, 890, 4],
  [20, 'xmuglesx', 41, 812, 4],
  [21, '.inmortalz', 40, 761, 3],
  [22, 'death420', 40, 756, 3],
  [23, '.crazynutz', 36, 703, 3],
  [24, 'TTVgrumpybark39414', 29, 588, 3],
  [25, 'LootxMaMa', 30, 583, 3],
  [26, 'hypersea5639', 28, 580, 3],
  [27, 'tigerscorner', 28, 578, 3],
  [28, 'fireagle', 30, 570, 3],
  [29, 'StuStreamz', 28, 569, 3],
  [30, 'RoseSynn', 27, 556, 3],
  [31, 'revvythefrog', 28, 550, 3],
  [32, 'RachelSpooks', 18, 526, 3],
  [33, 'MrsCoot0251(Huntaz)', 25, 514, 3],
  [34, 'tylerharris00345833', 25, 504, 3],
  [35, 'acszarka', 24, 484, 3],
  [36, 'dorinthian', 24, 476, 3],
  [37, 'patracuf', 24, 473, 2],
  [38, 'jimmy86.', 23, 445, 2],
  [39, 'it_be_colin', 22, 419, 2],
  [40, 'Crowfeet521', 20, 395, 2],
  [41, 'TheeGasMan', 20, 394, 2],
  [42, 'stoneyjak', 19, 384, 2],
  [43, 'osuphoenix', 19, 382, 2],
  [44, 'Exotik_Hatchet23', 19, 379, 2],
  [45, 'ØNI', 19, 375, 2],
  [46, 'one_love0670', 17, 339, 2],
  [47, 'T3KKAD4N', 18, 338, 2],
  [48, 'vertical_8', 16, 333, 2],
  [49, 'bjdevil20', 14, 288, 2],
  [50, 'undeadfather6666', 13, 263, 2],
  [51, 'nineteen27.', 13, 256, 2],
  [52, 'Bigblocklive', 13, 253, 1],
  [53, 'highexposure3', 13, 248, 1],
  [54, 'chris172838374893', 13, 245, 1],
  [55, 'AOFA_FionaRenee86(SGT)', 13, 244, 1],
  [56, 'metrix1809', 12, 241, 1],
  [57, 'Kitality', 13, 235, 1],
  [58, 'legendofdragoons', 11, 232, 1],
  [59, 'orsokuma', 11, 229, 1],
  [60, 'Vintaclectic', 11, 224, 1],
  [61, 'olsonsr', 11, 221, 1],
  [62, 'arty_with_marty', 11, 203, 1],
  [63, 'roxxyroxxy', 10, 202, 1],
  [64, 'mrsbunchesofoats', 9, 191, 1],
  [65, 'Fries', 9, 185, 1],
  [66, 'cozystorm', 9, 181, 1],
  [67, 'shlumpx', 9, 175, 1],
  [68, 'jxmichele', 9, 167, 1],
  [69, 'queerlykai', 8, 160, 1],
  [70, 'beardedgaming420', 7, 159, 1],
  [71, 'SunSunlight2021', 7, 156, 1],
  [72, 'minty', 8, 148, 1],
  [73, 'Rushinkward', 7, 143, 1],
  [74, 'Cptcrippled', 6, 130, 1],
  [75, 'MrBanditTv', 6, 129, 1],
  [76, 'bubbax343', 6, 123, 1],
  [77, 'mksxgaming', 6, 122, 1],
  [78, 'Bubbles', 6, 117, 1],
  [79, 'huckleberry31', 6, 117, 1],
  [80, 'straange719', 6, 115, 1],
  [81, 'sweatydecoybot', 5, 114, 1],
  [82, 'BrownsnatiC', 5, 112, 1],
  [83, 'shrimpyfarts', 6, 108, 1],
  [84, 'MRflix', 5, 106, 1],
  [85, 'Murder0nTheBeat', 5, 106, 1],
  [86, '.paynegaming', 5, 99, 0],
  [87, 'qdawg0542', 5, 94, 0],
  [88, '.nattnatt', 4, 93, 0],
  [89, 'NSchuler007', 5, 91, 0],
  [90, 'devilsangel37', 5, 90, 0],
  [91, 'Kurai Matsu', 4, 89, 0],
  [92, 'nastysmg', 4, 84, 0],
  [93, 'DemonBunny', 5, 84, 0],
  [94, 'realm__vr', 4, 83, 0],
  [95, 'haterhurter2', 4, 83, 0],
  [96, 'BATTLEDON', 4, 78, 0],
  [97, 'bobber1212', 4, 78, 0],
  // [98, '(blank)', 3, 70, 0], // No username visible - skip
  [99, 'Shadow_Wolf', 3, 68, 0],
  [100, 'possumraccoon8038', 3, 63, 0],
  [101, 'johnnytryhard', 3, 62, 0],
  [102, 'kungfukoala06', 3, 62, 0],
  [103, 'Kuscka', 3, 58, 0],
  [104, 'fearless_frfr.alt', 3, 56, 0],
  [105, 'KingKrakeN', 3, 55, 0],
  [106, 'shaggyrogers198', 3, 55, 0],
  [107, 'official_don_gaming', 3, 50, 0],
  [108, 'bomb_on_em.', 2, 49, 0],
  [109, 'Micheal', 2, 47, 0],
  [110, 'Psyko_Sikes', 2, 47, 0],
  [111, 'Johnny the Taco', 2, 46, 0],
  [112, 'BushWah', 2, 45, 0],
  [113, 'Bo-Astharaoth', 2, 44, 0],
  [114, 'xx_goheezzy_xx', 2, 42, 0],
  [115, 'dontquit_iclutch', 2, 42, 0],
  [116, 'crazycroatianguy8415', 2, 42, 0],
];

// MEE6 XP formula: XP to go from level n to n+1 = 5*n² + 50*n + 100
// First level (0→1) costs 100 XP
function mee6XPForLevel(n) {
  return 5 * (n ** 2) + 50 * n + 100;
}

// Our XP formula: XP to go from level (l-1) to l = 5*l² + 50*l + 100
// First level (0→1) costs 155 XP
function ourXPForLevel(l) {
  return 5 * (l ** 2) + 50 * l + 100;
}

// Convert MEE6 total XP + level to our system's total XP
// Preserves the exact level AND proportional progress within the level
function convertMEE6ToOurs(mee6TotalXP, mee6Level) {
  // 1. MEE6 cumulative XP to reach this level
  let mee6Cumulative = 0;
  for (let n = 0; n < mee6Level; n++) mee6Cumulative += mee6XPForLevel(n);

  // 2. Remaining XP within MEE6 level (may be slightly off due to "k" rounding)
  let mee6Remaining = Math.max(0, mee6TotalXP - mee6Cumulative);

  // 3. Fraction of progress through current level in MEE6
  let mee6NextLevelXP = mee6XPForLevel(mee6Level);
  let fraction = Math.min(mee6Remaining / mee6NextLevelXP, 0.99);

  // 4. Our cumulative XP to reach same level
  let ourCumulative = 0;
  for (let l = 1; l <= mee6Level; l++) ourCumulative += ourXPForLevel(l);

  // 5. Proportional progress in our system
  let ourNextLevelXP = ourXPForLevel(mee6Level + 1);
  let ourRemaining = Math.floor(fraction * ourNextLevelXP);

  return ourCumulative + ourRemaining;
}

// Decompose our total XP into level + remaining
function decomposeXP(totalXP) {
  let level = 0;
  let remaining = totalXP;
  while (remaining >= ourXPForLevel(level + 1)) {
    remaining -= ourXPForLevel(level + 1);
    level++;
  }
  return { level, xp: remaining };
}

// Normalize a name for matching (lowercase, strip special chars)
function normalize(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
  try {
    // 1. Get bot token
    console.log('1. Getting bot token...');
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    // 2. Fetch all guild members (paginated)
    console.log('2. Fetching guild members...');
    let allMembers = [];
    let after = '0';
    while (true) {
      const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000&after=${after}`, {
        headers: { Authorization: `Bot ${token}` }
      });
      if (!res.ok) {
        console.error('Failed to fetch members:', res.status, await res.text());
        break;
      }
      const batch = await res.json();
      if (batch.length === 0) break;
      allMembers = allMembers.concat(batch);
      after = batch[batch.length - 1].user.id;
      if (batch.length < 1000) break;
    }
    console.log(`   Found ${allMembers.length} members`);

    // 3. Build lookup maps
    const membersByNorm = new Map(); // normalized name -> member
    const membersByExact = new Map(); // exact username -> member
    const membersByGlobal = new Map(); // global_name -> member
    const membersByNick = new Map(); // nick -> member

    for (const m of allMembers) {
      if (m.user.bot) continue;
      membersByExact.set(m.user.username, m);
      membersByNorm.set(normalize(m.user.username), m);
      if (m.user.global_name) {
        membersByGlobal.set(m.user.global_name, m);
        membersByNorm.set(normalize(m.user.global_name), m);
      }
      if (m.nick) {
        membersByNick.set(m.nick, m);
        membersByNorm.set(normalize(m.nick), m);
      }
    }

    // 4. Match each MEE6 user to a Discord member
    console.log('\n3. Matching MEE6 users to Discord members...');
    const matched = [];
    const unmatched = [];

    for (const [rank, name, msgs, totalXP, mee6Level] of MEE6_DATA) {
      // Try exact username match first
      let member = membersByExact.get(name);
      // Try global name
      if (!member) member = membersByGlobal.get(name);
      // Try nickname
      if (!member) member = membersByNick.get(name);
      // Try normalized match
      if (!member) member = membersByNorm.get(normalize(name));

      if (member) {
        const ourTotalXP = convertMEE6ToOurs(totalXP, mee6Level);
        const { level, xp } = decomposeXP(ourTotalXP);
        matched.push({
          rank,
          mee6Name: name,
          userId: member.user.id,
          username: member.user.username,
          totalXP: ourTotalXP,
          mee6TotalXP: totalXP,
          level,
          xp,
          mee6Level,
          msgs
        });
      } else {
        unmatched.push({ rank, name, msgs, totalXP, mee6Level });
      }
    }

    console.log(`   Matched: ${matched.length}/${MEE6_DATA.length}`);

    if (unmatched.length > 0) {
      console.log(`\n   UNMATCHED (${unmatched.length}):`);
      for (const u of unmatched) {
        console.log(`   #${u.rank} "${u.name}" - ${u.totalXP} XP, level ${u.mee6Level}`);
      }

      // Show available members for manual matching
      console.log('\n   Available non-bot members not yet matched:');
      const matchedIds = new Set(matched.map(m => m.userId));
      const remaining = allMembers.filter(m => !m.user.bot && !matchedIds.has(m.user.id));
      for (const m of remaining) {
        console.log(`   ${m.user.id} | ${m.user.username} | global: ${m.user.global_name || '-'} | nick: ${m.nick || '-'}`);
      }
    }

    // 5. Verify level calculations
    console.log('\n4. Verifying XP decomposition...');
    let levelMismatches = 0;
    for (const m of matched) {
      if (m.level !== m.mee6Level) {
        console.log(`   LEVEL MISMATCH: ${m.mee6Name} - MEE6 level ${m.mee6Level}, calculated level ${m.level} (totalXP: ${m.totalXP})`);
        levelMismatches++;
      }
    }
    if (levelMismatches === 0) {
      console.log('   All levels match!');
    } else {
      console.log(`   ${levelMismatches} mismatches (will use calculated values from total XP)`);
    }

    // 6. Insert into user_levels
    console.log(`\n5. Inserting ${matched.length} records into user_levels...`);
    let inserted = 0;
    let updated = 0;

    for (const m of matched) {
      // Check if record exists
      const [existing] = await pool.execute(
        'SELECT id, level, xp FROM user_levels WHERE guild_id = ? AND user_id = ?',
        [GUILD_ID, m.userId]
      );

      if (existing.length > 0) {
        // Only update if MEE6 data is higher
        const existingTotalXP = (() => {
          let total = existing[0].xp;
          for (let i = 1; i <= existing[0].level; i++) {
            total += getXPForLevel(i);
          }
          return total;
        })();

        if (m.totalXP > existingTotalXP) {
          await pool.execute(
            'UPDATE user_levels SET xp = ?, level = ? WHERE id = ?',
            [m.xp, m.level, existing[0].id]
          );
          console.log(`   Updated: ${m.username} (${m.mee6Name}) - level ${m.level}, ${m.xp} xp remaining`);
          updated++;
        } else {
          console.log(`   Skipped: ${m.username} - existing XP (${existingTotalXP}) >= MEE6 (${m.totalXP})`);
        }
      } else {
        await pool.execute(
          'INSERT INTO user_levels (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?)',
          [GUILD_ID, m.userId, m.xp, m.level]
        );
        console.log(`   Inserted: ${m.username} (${m.mee6Name}) - level ${m.level}, ${m.xp} xp remaining`);
        inserted++;
      }
    }

    console.log(`\n6. Done! Inserted: ${inserted}, Updated: ${updated}, Unmatched: ${unmatched.length}`);

    // 7. Show top 10 verification
    console.log('\n7. Top 10 verification:');
    const [top10] = await pool.execute(
      'SELECT user_id, xp, level FROM user_levels WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT 10',
      [GUILD_ID]
    );
    for (let i = 0; i < top10.length; i++) {
      const u = top10[i];
      const member = allMembers.find(m => m.user.id === u.user_id);
      const name = member?.user.username || member?.user.global_name || u.user_id;
      console.log(`   #${i + 1} ${name} - Level ${u.level}, ${u.xp} XP remaining`);
    }

  } catch (error) {
    console.error('Error:', error);
  }

  await pool.end();
  process.exit(0);
}

main();
