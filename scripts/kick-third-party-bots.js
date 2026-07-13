// Sequenced removal of all 9 third-party bots from guild 1469931133981687873.
// Runs setup-forsaken-warriors-features.js's deferred JTC handover immediately after VoiceMaster.
// CertiFried Utility (Admin role pos 29) sits above every bot being kicked, so this can't fail on hierarchy.
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import pool from '../utils/db.js';

const GUILD_ID = '1469931133981687873';
const TOKEN = process.env.DISCORD_TOKEN;
const rest = new REST({ version: '10' }).setToken(TOKEN);

// Order: lowest-risk first, VoiceMaster last so we can immediately seed temp_channel_config.
const BOTS = [
  { name: 'ProBot ✨',         user_id: '282859044593598464' },
  { name: 'Reaction Roles',    user_id: '550613223733329920' },
  { name: 'PatchBot',          user_id: '402528814548254720' },
  { name: 'NotifyMe',          user_id: '1044050359586394192' },
  { name: 'Streamcord',        user_id: '375805687529209857' },
  { name: 'MEE6',              user_id: '159985415099514880' },
  { name: 'Welcomer',          user_id: '330416853971107840' },
  { name: 'YAGPDB.xyz',        user_id: '204255083083333633' },
  { name: 'VoiceMaster',       user_id: '472911936951156740' },
];

// VoiceMaster JTC handover values
const JTC_TRIGGER  = '1471385969398775822';  // existing #𝒥𝑜𝒾𝓃 𝓉𝑜 𝒞𝓇𝑒𝒶𝓉𝑒
const JTC_CATEGORY = '1469931134845456534';  // 🎀 𝐻𝑒𝓁𝓁🏵 voice category

const log = (...a) => console.log('[kick]', ...a);
const REASON = 'Bot consolidation: replaced by CertiFried Utility';

async function memberExists(userId) {
  try {
    await rest.get(Routes.guildMember(GUILD_ID, userId));
    return true;
  } catch (e) {
    if (e.code === 10007 || e.status === 404) return false;
    throw e;
  }
}

async function kick(bot) {
  const present = await memberExists(bot.user_id);
  if (!present) {
    log(`SKIP   ${bot.name.padEnd(20)} — already not in guild`);
    return 'skipped';
  }
  await rest.delete(Routes.guildMember(GUILD_ID, bot.user_id), { reason: REASON });
  log(`KICKED ${bot.name.padEnd(20)} (${bot.user_id})`);
  return 'kicked';
}

async function seedJtcConfig() {
  await pool.execute(
    `INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       creator_channel_id = VALUES(creator_channel_id),
       category_id        = VALUES(category_id),
       naming_template    = VALUES(naming_template)`,
    [GUILD_ID, JTC_TRIGGER, JTC_CATEGORY, "{user}'s Room"]
  );
  log(`JTC takeover seeded: trigger=${JTC_TRIGGER} category=${JTC_CATEGORY}`);
}

async function postKickIntegrationAudit() {
  try {
    const integrations = await rest.get(Routes.guildIntegrations(GUILD_ID));
    const remaining = (integrations || []).filter(i => i.application?.bot || i.type === 'twitch' || i.type === 'youtube');
    console.log('\n=== INTEGRATIONS REMAINING ===');
    for (const i of remaining) {
      console.log(`  ${i.type.padEnd(10)} ${(i.name || i.application?.name || '?').padEnd(28)} ${i.user?.username ? '(by ' + i.user.username + ')' : ''}`);
    }
  } catch (e) {
    log('integration audit failed:', e.message);
  }
}

(async () => {
  if (!TOKEN) { console.error('DISCORD_TOKEN missing'); process.exit(1); }
  log(`starting cutover for guild ${GUILD_ID}`);

  const results = { kicked: 0, skipped: 0, failed: 0 };
  for (const bot of BOTS) {
    try {
      const r = await kick(bot);
      results[r]++;
      if (bot.name === 'VoiceMaster' && r === 'kicked') {
        await seedJtcConfig();
      }
    } catch (e) {
      results.failed++;
      log(`FAIL   ${bot.name.padEnd(20)} ${e.message} (status=${e.status})`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n=== summary ===');
  console.log('  kicked: ', results.kicked);
  console.log('  skipped:', results.skipped);
  console.log('  failed: ', results.failed);

  await postKickIntegrationAudit();
  console.log('\n--- post-cutover sanity ---');
  console.log('  • Have any member join the JTC trigger VC; CertiFried should create their temp room.');
  console.log('  • Next live stream from any subscribed streamer should ping the matching opt-in role (no @everyone).');
  console.log('  • All 4 reaction-role panels remain in #self-role / #code-of-conduct.');
  await pool.end();
})().catch(async e => {
  console.error('FAIL', e.stack || e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
