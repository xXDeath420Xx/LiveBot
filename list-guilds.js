import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import pool from './utils/db.js';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
  console.log('\n=== MAIN BOT GUILDS ===');
  console.log(`Bot: ${client.user.tag} (${client.user.id})`);
  console.log(`Total Guilds: ${client.guilds.cache.size}\n`);

  client.guilds.cache.forEach(guild => {
    console.log(`- ${guild.name} (${guild.id}) - ${guild.memberCount} members`);
  });

  // Get custom bots from database
  console.log('\n=== CUSTOM BOTS ===');
  try {
    const [customBots] = await pool.execute(`
      SELECT cb.bot_id, cb.bot_name, gbm.guild_id
      FROM custom_bots cb
      LEFT JOIN guild_bot_mapping gbm ON cb.bot_id = gbm.bot_id
      WHERE cb.enabled = 1
      ORDER BY cb.bot_name, gbm.guild_id
    `);

    if (customBots.length === 0) {
      console.log('No custom bots found');
    } else {
      let currentBotId = null;
      for (const bot of customBots) {
        if (bot.bot_id !== currentBotId) {
          console.log(`\nBot: ${bot.bot_name} (${bot.bot_id})`);
          currentBotId = bot.bot_id;
        }
        if (bot.guild_id) {
          console.log(`  - Guild ID: ${bot.guild_id}`);
        }
      }
    }
  } catch (error) {
    console.error('Error fetching custom bots:', error);
  }

  // Get unique guild count
  console.log('\n=== SUMMARY ===');
  const allGuildIds = new Set();
  client.guilds.cache.forEach(guild => allGuildIds.add(guild.id));

  try {
    const [mappings] = await pool.execute('SELECT DISTINCT guild_id FROM guild_bot_mapping');
    mappings.forEach(m => allGuildIds.add(m.guild_id));
  } catch (error) {
    console.error('Error getting guild mappings:', error);
  }

  console.log(`Total Unique Guilds: ${allGuildIds.size}`);

  await pool.end();
  process.exit(0);
});

client.login(process.env.DISCORD_BOT_TOKEN);
