import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'fs';

// Full MEE6 leaderboard from screenshots — username, messages, xp, level
const users = [
  // Page 1 (1-12)
  {rank:1, username:'devilsangel37', msgs:562, xp:11200, level:14},
  {rank:2, username:'greazyleo', msgs:225, xp:4500, level:9},
  {rank:3, username:'fireimdabullet', msgs:164, xp:3300, level:8},
  {rank:4, username:'halfbakedhobo', msgs:158, xp:3100, level:8},
  {rank:5, username:'nativegirl49', msgs:153, xp:3100, level:8},
  {rank:6, username:'blacksuncrow', msgs:122, xp:2500, level:7},
  {rank:7, username:'grim_ripper0360', msgs:117, xp:2300, level:7},
  {rank:8, username:'toxictinyyyy', msgs:88, xp:1800, level:6},
  {rank:9, username:'x5stargamingx', msgs:85, xp:1700, level:6},
  {rank:10, username:'artikaries', msgs:82, xp:1700, level:6},
  {rank:11, username:'hallowundead', msgs:80, xp:1700, level:6},
  {rank:12, username:'jpthemonkeyking', msgs:72, xp:1400, level:5},
  // Page 2 (13-25)
  {rank:13, username:'bluntzmackenzie', msgs:58, xp:1100, level:4},
  {rank:14, username:'terrelsthegoat', msgs:53, xp:1100, level:4},
  {rank:15, username:'drdrewpeacoq', msgs:53, xp:1000, level:4},
  {rank:16, username:'thatssomeana', msgs:40, xp:825, level:4},
  {rank:17, username:'pokegirl131427', msgs:39, xp:771, level:4},
  {rank:18, username:'thoffprod', msgs:37, xp:736, level:3},
  {rank:19, username:'shadow_wolf2120_', msgs:37, xp:736, level:3},
  {rank:20, username:'lycan_kadric', msgs:37, xp:715, level:3},
  {rank:21, username:'shadowhoundstream', msgs:34, xp:662, level:3},
  {rank:22, username:'death420', msgs:29, xp:597, level:3},
  {rank:23, username:'kendiobear', msgs:25, xp:521, level:3},
  {rank:24, username:'sgtstafff123', msgs:25, xp:519, level:3},
  {rank:25, username:'rookieodsd961', msgs:23, xp:466, level:2},
  // Page 3 (26-37)
  {rank:26, username:'unicorn_dre', msgs:23, xp:451, level:2},
  {rank:27, username:'capt_perriwinkle', msgs:21, xp:409, level:2},
  {rank:28, username:'headhunter9966', msgs:17, xp:342, level:2},
  {rank:29, username:'ssbuatlas', msgs:18, xp:337, level:2},
  {rank:30, username:'clarajames10', msgs:17, xp:331, level:2},
  {rank:31, username:'.doitfordale', msgs:13, xp:271, level:2},
  {rank:32, username:'darealbeano', msgs:11, xp:229, level:1},
  {rank:33, username:'averageup', msgs:11, xp:226, level:1},
  {rank:34, username:'killerclownclan.', msgs:11, xp:223, level:1},
  {rank:35, username:'manpotion', msgs:9, xp:188, level:1},
  {rank:36, username:'scardechild', msgs:9, xp:187, level:1},
  {rank:37, username:'chaoticsmokii', msgs:9, xp:186, level:1},
  // Page 4 (38-49)
  {rank:38, username:'poffer6385', msgs:8, xp:153, level:1},
  {rank:39, username:'beastdadgaming', msgs:7, xp:144, level:1},
  {rank:40, username:'m00s3e', msgs:7, xp:143, level:1},
  {rank:41, username:'thcspersecond', msgs:7, xp:140, level:1},
  {rank:42, username:'a7xcable', msgs:7, xp:138, level:1},
  {rank:43, username:'exoticbeauty1', msgs:7, xp:135, level:1},
  {rank:44, username:'blackout91', msgs:6, xp:127, level:1},
  {rank:45, username:'firepanda666', msgs:6, xp:125, level:1},
  {rank:46, username:'alisssabbg', msgs:6, xp:122, level:1},
  {rank:47, username:'hammy_10', msgs:6, xp:121, level:1},
  {rank:48, username:'manapull', msgs:6, xp:118, level:1},
  {rank:49, username:'creepyorc', msgs:5, xp:108, level:1},
  // Page 5 (50-52 level 1, 53-60 level 0)
  {rank:50, username:'gracie07.', msgs:5, xp:104, level:1},
  {rank:51, username:'sam75mcl', msgs:5, xp:103, level:1},
  {rank:52, username:'samqweasd', msgs:5, xp:103, level:1},
  {rank:53, username:'thugpumpkin.', msgs:5, xp:92, level:0},
  {rank:54, username:'beeventv', msgs:4, xp:86, level:0},
  {rank:55, username:'zero2kewl', msgs:4, xp:81, level:0},
  {rank:56, username:'kaptainafk', msgs:4, xp:79, level:0},
  {rank:57, username:'chirp91', msgs:4, xp:78, level:0},
  {rank:58, username:'therealfroto', msgs:4, xp:78, level:0},
  {rank:59, username:'portgas_96', msgs:4, xp:77, level:0},
  {rank:60, username:'whytherobo', msgs:4, xp:76, level:0},
  // Page 6 (61-72)
  {rank:61, username:'biggametheorytv', msgs:3, xp:72, level:0},
  {rank:62, username:'go0nieto0nz', msgs:3, xp:70, level:0},
  {rank:63, username:'itscobearonkick', msgs:3, xp:67, level:0},
  {rank:64, username:'amelia_wilson113', msgs:3, xp:65, level:0},
  {rank:65, username:'thehiddinhamstr6833', msgs:3, xp:64, level:0},
  {rank:66, username:'urfavoritepooks', msgs:4, xp:64, level:0},
  {rank:67, username:'riskyravenszero', msgs:3, xp:64, level:0},
  {rank:68, username:'djcorals', msgs:3, xp:62, level:0},
  {rank:69, username:'tmcdousarmy26', msgs:3, xp:61, level:0},
  {rank:70, username:'spanky626', msgs:3, xp:60, level:0},
  {rank:71, username:'luch4', msgs:3, xp:60, level:0},
  {rank:72, username:'brumfiel13', msgs:3, xp:59, level:0},
  // Page 7 (73-85)
  {rank:73, username:'nastykillz', msgs:3, xp:59, level:0},
  {rank:74, username:'froglegmafia', msgs:3, xp:57, level:0},
  {rank:75, username:'kick.comtonetanks', msgs:2, xp:50, level:0},
  {rank:76, username:'thug_pumpkin', msgs:2, xp:44, level:0},
  {rank:77, username:'crybabyj7', msgs:2, xp:44, level:0},
  {rank:78, username:'revengevamp101', msgs:2, xp:40, level:0},
  {rank:79, username:'unknwn_olg_ogf', msgs:2, xp:38, level:0},
  {rank:80, username:'xkiller_s1renx2923', msgs:2, xp:37, level:0},
  {rank:81, username:'aphromoolol', msgs:2, xp:37, level:0},
  {rank:82, username:'its_mathemagical', msgs:2, xp:34, level:0},
  {rank:83, username:'devildog3053', msgs:2, xp:34, level:0},
  {rank:84, username:'synasian', msgs:2, xp:32, level:0},
  {rank:85, username:'hiiiiiiiii__._', msgs:2, xp:30, level:0},
  // Page 8 (86-97)
  {rank:86, username:'kermister69420', msgs:1, xp:25, level:0},
  {rank:87, username:'thebeaminggamer', msgs:1, xp:25, level:0},
  {rank:88, username:'fuisonflarexz', msgs:1, xp:25, level:0},
  {rank:89, username:'bootyliciousbeauty', msgs:1, xp:25, level:0},
  {rank:90, username:'yoloswaggins41', msgs:1, xp:25, level:0},
  {rank:91, username:'sasquatchianpride', msgs:1, xp:24, level:0},
  {rank:92, username:'juggalo_darcy', msgs:1, xp:24, level:0},
  {rank:93, username:'jrexx', msgs:1, xp:23, level:0},
  {rank:94, username:'navywarvet', msgs:1, xp:23, level:0},
  {rank:95, username:'tier1rabbit', msgs:1, xp:23, level:0},
  {rank:96, username:'mrlindbe', msgs:1, xp:23, level:0},
  {rank:97, username:'dad the gamer', msgs:1, xp:22, level:0},
  // Page 9 (98-109)
  {rank:98, username:'hamster04837', msgs:1, xp:22, level:0},
  {rank:99, username:'wyle e coyote', msgs:1, xp:21, level:0},
  {rank:100, username:'smugwib', msgs:1, xp:21, level:0},
  {rank:101, username:'chadbuttersworthkik', msgs:1, xp:21, level:0},
  {rank:102, username:'red_maddog4233', msgs:1, xp:21, level:0},
  {rank:103, username:'catastrophic__ttv', msgs:1, xp:20, level:0},
  {rank:104, username:'.j42.', msgs:1, xp:20, level:0},
  {rank:105, username:'stepdaddygoofy', msgs:1, xp:20, level:0},
  {rank:106, username:'impiiink', msgs:1, xp:19, level:0},
  {rank:107, username:'the_pickle_pub', msgs:1, xp:19, level:0},
  {rank:108, username:'therealsilverp', msgs:1, xp:19, level:0},
  {rank:109, username:'dwreck22', msgs:1, xp:19, level:0},
  // Page 10 (110-120)
  {rank:110, username:'mcmassacre.', msgs:1, xp:19, level:0},
  {rank:111, username:'darkmagic1angirl', msgs:1, xp:19, level:0},
  {rank:112, username:'danotimes', msgs:1, xp:19, level:0},
  {rank:113, username:'no1mustard', msgs:1, xp:18, level:0},
  {rank:114, username:'hiemerio', msgs:1, xp:18, level:0},
  {rank:115, username:'yemmy_', msgs:1, xp:18, level:0},
  {rank:116, username:'calinaughtonjr', msgs:1, xp:17, level:0},
  {rank:117, username:'arin0x', msgs:1, xp:17, level:0},
  {rank:118, username:'fknbaked', msgs:1, xp:16, level:0},
  {rank:119, username:'meep20perfect', msgs:1, xp:16, level:0},
  {rank:120, username:'karmajoy', msgs:1, xp:15, level:0},
  // Page 11 (121-122)
  {rank:121, username:'bongwatertv', msgs:1, xp:15, level:0},
  {rank:122, username:'_nicedeathttv', msgs:1, xp:15, level:0},
];

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME
  });

  const GUILD = '789323062456746005';
  
  // First, need to resolve usernames to Discord user IDs
  // Read the bot token and fetch guild members
  const token = fs.readFileSync('/tmp/.audit_token', 'utf8').trim();
  const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD}/members?limit=1000`, {
    headers: { Authorization: `Bot ${token}` }
  });
  const members = await res.json();
  
  // Build username -> user_id map (lowercase for matching)
  const usernameMap = {};
  for (const m of members) {
    if (m.user.bot) continue;
    usernameMap[m.user.username.toLowerCase()] = m.user.id;
    // Also map global_name/display_name
    if (m.user.global_name) usernameMap[m.user.global_name.toLowerCase()] = m.user.id;
    if (m.nick) usernameMap[m.nick.toLowerCase()] = m.user.id;
  }
  
  let updated = 0, inserted = 0, skipped = 0, notFound = 0;
  
  for (const u of users) {
    const userId = usernameMap[u.username.toLowerCase()];
    if (!userId) {
      notFound++;
      continue; // Can't match to Discord ID — user may have left
    }
    
    // Upsert into user_levels with actual XP and level from MEE6
    const [result] = await conn.execute(`
      INSERT INTO user_levels (guild_id, user_id, xp, level)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        xp = GREATEST(VALUES(xp), xp),
        level = GREATEST(VALUES(level), level)
    `, [GUILD, userId, u.xp, u.level]);
    
    if (result.affectedRows === 1) inserted++;
    else if (result.affectedRows === 2) updated++;
    else skipped++;
  }
  
  console.log(`MEE6 import complete:`);
  console.log(`  Total in screenshots: ${users.length}`);
  console.log(`  Matched to Discord: ${inserted + updated}`);
  console.log(`  New inserts: ${inserted}`);
  console.log(`  Updated (higher values): ${updated}`);
  console.log(`  Not in server (left): ${notFound}`);
  console.log(`  Skipped: ${skipped}`);
  
  // Show current state
  const [rows] = await conn.execute(
    'SELECT user_id, level, xp FROM user_levels WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT 15',
    [GUILD]
  );
  console.log('\nTop 15 in DB:');
  rows.forEach((r, i) => console.log(`  ${i+1}. ${r.user_id} — Level ${r.level}, ${r.xp} XP`));
  
  await conn.end();
}

run().catch(e => console.error(e));
