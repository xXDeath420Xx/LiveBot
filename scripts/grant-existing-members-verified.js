// Bulk-grant the Verified role to all existing non-bot members of the Forsaken Warriors.
// Run this AFTER setup-forsaken-warriors-panels.js. Idempotent.
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

const GUILD_ID = '1469931133981687873';
const VERIFIED_ROLE = '1498502484912635906';
const TOKEN = process.env.DISCORD_TOKEN;
const rest = new REST({ version: '10' }).setToken(TOKEN);

const log = (...a) => console.log('[grant-verified]', ...a);

(async () => {
  if (!TOKEN) { console.error('DISCORD_TOKEN missing'); process.exit(1); }
  log(`fetching all members of ${GUILD_ID}...`);

  const members = [];
  let after = '0';
  while (true) {
    const batch = await rest.get(Routes.guildMembers(GUILD_ID), { query: new URLSearchParams({ limit: '1000', after }) });
    if (!Array.isArray(batch) || batch.length === 0) break;
    members.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  log(`fetched ${members.length} members`);

  let granted = 0, skipped_bot = 0, skipped_already = 0, failed = 0;
  for (const m of members) {
    if (m.user?.bot) { skipped_bot++; continue; }
    if ((m.roles || []).includes(VERIFIED_ROLE)) { skipped_already++; continue; }
    try {
      await rest.put(Routes.guildMemberRole(GUILD_ID, m.user.id, VERIFIED_ROLE), {
        reason: 'Backfill: existing members granted Verified during cutover'
      });
      granted++;
      if (granted % 25 === 0) log(`  ... ${granted} granted so far`);
      await new Promise(r => setTimeout(r, 350)); // polite pacing for Discord rate limits
    } catch (e) {
      failed++;
      log(`  ✗ failed for ${m.user?.username || m.user?.id}: ${e.message}`);
    }
  }

  console.log('\n=== summary ===');
  console.log('  granted:        ', granted);
  console.log('  already had it: ', skipped_already);
  console.log('  bots skipped:   ', skipped_bot);
  console.log('  failed:         ', failed);
})().catch(e => {
  console.error('FAIL', e.stack || e);
  process.exit(1);
});
