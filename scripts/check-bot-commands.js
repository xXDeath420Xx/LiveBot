// Check what commands are actually registered with Discord API for a bot
import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
dotenv.config();

const botId = process.argv[2] || '1438889625388060723';

const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [botId]);
if (!bots.length) { console.error('Bot not found'); process.exit(1); }
const tokenObj = JSON.parse(bots[0].bot_token);
const token = encryption.decrypt(tokenObj);
const rest = new REST().setToken(token);

// Get guild mappings
const [mappings] = await pool.execute('SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?', [botId]);
const guildIds = mappings.map(m => m.guild_id);

// Check guild commands
for (const guildId of guildIds) {
  try {
    const guildCmds = await rest.get(Routes.applicationGuildCommands(botId, guildId));
    console.log(`\n=== GUILD ${guildId} COMMANDS (${guildCmds.length}) ===`);
    for (const cmd of guildCmds) {
      let detail = `  /${cmd.name}`;
      if (cmd.options) {
        const subs = cmd.options.filter(o => o.type === 1 || o.type === 2);
        if (subs.length > 0) {
          detail += ` [${subs.map(s => {
            if (s.type === 2 && s.options) {
              return `${s.name}: ${s.options.map(ss => ss.name).join(',')}`;
            }
            return s.name;
          }).join(' | ')}]`;
        }
      }
      console.log(detail);
    }
  } catch (e) {
    console.error(`Guild ${guildId} error:`, e.message);
  }
}

// Check global commands
try {
  const globalCmds = await rest.get(Routes.applicationCommands(botId));
  console.log(`\n=== GLOBAL COMMANDS (${globalCmds.length}) ===`);
  for (const cmd of globalCmds) {
    console.log(`  /${cmd.name}`);
  }
} catch (e) {
  console.error('Global commands error:', e.message);
}

await pool.end();
process.exit(0);
