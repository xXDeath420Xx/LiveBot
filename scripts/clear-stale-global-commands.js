// Clear stale global commands from custom bots
// Custom bots should ONLY have guild-specific commands, not global ones
import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
dotenv.config();

const targetBotId = process.argv[2]; // optional: only clear a specific bot

async function clearGlobalCommands() {
  const query = targetBotId
    ? 'SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE bot_id = ?'
    : 'SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE enabled = 1';
  const params = targetBotId ? [targetBotId] : [];

  const [bots] = await pool.execute(query, params);
  console.log(`Found ${bots.length} custom bot(s) to clean\n`);

  for (const bot of bots) {
    try {
      const tokenObj = JSON.parse(bot.bot_token);
      const token = encryption.decrypt(tokenObj);
      const rest = new REST().setToken(token);

      // Check current global commands
      const globalCmds = await rest.get(Routes.applicationCommands(bot.bot_id));

      if (globalCmds.length === 0) {
        console.log(`[${bot.bot_name}] No global commands to clear`);
        continue;
      }

      console.log(`[${bot.bot_name}] Found ${globalCmds.length} stale global commands - clearing...`);

      // Clear all global commands by deploying empty array
      await rest.put(Routes.applicationCommands(bot.bot_id), { body: [] });

      console.log(`[${bot.bot_name}] Cleared ${globalCmds.length} global commands`);
    } catch (error) {
      console.error(`[${bot.bot_name}] Error: ${error.message}`);
    }

    // Small delay between bots
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\nDone! Custom bots now only have guild-specific commands.');
  await pool.end();
  process.exit(0);
}

clearGlobalCommands().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
