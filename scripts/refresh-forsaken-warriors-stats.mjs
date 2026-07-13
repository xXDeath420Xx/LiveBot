/**
 * One-shot: re-render the 4 stat-counter VC names in "the Forsaken Warriors"
 * using the freshly-fixed templates ({value} + emojis). Avoids waiting for
 * the next 10-min scheduler tick.
 */
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1469931133981687873';
const KITSUNE_BOT_ID = '1498486251576229958';

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [KITSUNE_BOT_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));
const rest = new REST({ version: '10' }).setToken(token);

// Pull approximate member/online counts (single API call with ?with_counts=true).
const guild = await rest.get(Routes.guild(GUILD_ID) + '?with_counts=true');
const allChannels = await rest.get(Routes.guildChannels(GUILD_ID));
// approximate_member_count includes bots; bots count via member listing is expensive,
// so use a per-guild approximation: pull /preview for live numbers, or fall back to fetch all.
// Discord does not give bots-only count; the runtime manager iterates members. For this
// one-shot refresh, fetch /members?limit=1000 to count bots accurately for a sub-1000 guild.
const allMembers = await rest.get(`/guilds/${GUILD_ID}/members?limit=1000`);
const bots = allMembers.filter(m => m.user?.bot).length;
const humans = allMembers.length - bots;

const stats = {
  members:  guild.approximate_member_count ?? allMembers.length,
  online:   guild.approximate_presence_count ?? 0,
  bots,
  channels: allChannels.filter(c => c.type !== 4 /* exclude categories */).length,
};

console.log('Computed stats:', stats);

const [statRows] = await pool.execute(
  'SELECT channel_id, stat_type, template FROM stat_display_channels WHERE guild_id = ?',
  [GUILD_ID]
);

for (const r of statRows) {
  const value = stats[r.stat_type];
  if (value === undefined) {
    console.log(`skip ${r.stat_type} — no computed value`);
    continue;
  }
  const newName = r.template.replace('{value}', value).slice(0, 100);
  try {
    await rest.patch(Routes.channel(r.channel_id), {
      body: { name: newName },
      reason: 'CertiFried: refresh stat-counter VC name after template fix'
    });
    console.log(`renamed  ${r.channel_id}  →  "${newName}"`);
  } catch (e) {
    console.log(`FAILED   ${r.channel_id}  ${r.stat_type}  →  ${e.message}`);
  }
}

await pool.end();
