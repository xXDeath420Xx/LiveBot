// Deploy slash commands to a specific bot by ID
// Uses guild-specific deployment for custom bots (instant availability)
import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load all command files
 */
async function loadCommands() {
  const commands = [];
  const commandsPath = join(__dirname, '../commands');

  if (!fs.existsSync(commandsPath)) {
    logger.warn('[Deploy] Commands directory does not exist');
    return commands;
  }

  const commandFolders = fs.readdirSync(commandsPath).filter(item => {
    return fs.statSync(join(commandsPath, item)).isDirectory();
  });

  for (const folder of commandFolders) {
    const folderPath = join(commandsPath, folder);
    const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
      try {
        const filePath = join(folderPath, file);
        const command = await import(`file://${filePath}`);

        if (command.default && command.default.data) {
          commands.push(command.default.data.toJSON());
          logger.debug(`[Deploy] Added ${folder}/${file}`);
        }
      } catch (error) {
        logger.error(`[Deploy] Failed to load ${folder}/${file}`, { error: error.message });
      }
    }
  }

  return commands;
}

/**
 * Deploy commands to a specific bot's assigned guilds (guild-specific deployment)
 * Falls back to global deployment only if no guild mappings exist
 */
async function deployCommandsToBot(botId, botToken, guildIds) {
  try {
    const commands = await loadCommands();
    console.log(`Loaded ${commands.length} commands`);

    const rest = new REST().setToken(botToken);

    if (guildIds && guildIds.length > 0) {
      // Guild-specific deployment (instant, matches bot-manager.js behavior)
      console.log(`Deploying to ${guildIds.length} guild(s)...`);
      let successCount = 0;

      for (const guildId of guildIds) {
        try {
          const data = await rest.put(
            Routes.applicationGuildCommands(botId, guildId),
            { body: commands }
          );
          console.log(`  Guild ${guildId}: ${data.length} commands deployed`);
          successCount++;
        } catch (guildError) {
          console.error(`  Guild ${guildId}: FAILED - ${guildError.message}`);
        }
      }

      console.log(`Deployed to ${successCount}/${guildIds.length} guild(s)`);

      // Also hide the main bot's global commands in these guilds
      await hideDefaultBotCommands(guildIds);
    } else {
      // No guild mappings - fall back to global deployment
      console.log('No guild mappings found, deploying globally...');
      const data = await rest.put(
        Routes.applicationCommands(botId),
        { body: commands }
      );
      console.log(`Deployed ${data.length} commands globally`);
    }

    return true;
  } catch (error) {
    logger.error(`[Deploy] Failed to deploy commands to bot ${botId}`, { error: error.message });
    throw error;
  }
}

/**
 * Hide the default bot's global commands in guilds with custom bots
 */
async function hideDefaultBotCommands(guildIds) {
  const mainToken = process.env.DISCORD_TOKEN;
  const mainClientId = process.env.DISCORD_CLIENT_ID;

  if (!mainToken || !mainClientId) {
    console.log('  (Skipping default bot command hiding - no main bot credentials)');
    return;
  }

  const rest = new REST().setToken(mainToken);

  for (const guildId of guildIds) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(mainClientId, guildId),
        { body: [] }
      );
      console.log(`  Hidden main bot commands in guild ${guildId}`);
    } catch (error) {
      console.error(`  Failed to hide main bot commands in guild ${guildId}: ${error.message}`);
    }
  }
}

// Main execution
(async () => {
  try {
    const botId = process.argv[2];

    if (!botId) {
      console.error('Usage: node deploy-commands-to-bot.js <bot_id>');
      console.error('Example: node deploy-commands-to-bot.js 1438889625388060723');
      process.exit(1);
    }

    // Get bot from database
    const [bots] = await pool.execute(
      'SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE bot_id = ?',
      [botId]
    );

    if (bots.length === 0) {
      console.error(`Bot ${botId} not found in database`);
      process.exit(1);
    }

    const bot = bots[0];
    const encryptedToken = JSON.parse(bot.bot_token);
    const decryptedToken = encryption.decrypt(encryptedToken);

    // Get guild mappings for this bot
    const [mappings] = await pool.execute(
      'SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?',
      [botId]
    );
    const guildIds = mappings.map(m => m.guild_id);

    console.log(`Deploying commands to: ${bot.bot_name} (${bot.bot_id})`);
    if (guildIds.length > 0) {
      console.log(`Assigned guilds: ${guildIds.join(', ')}`);
    }

    await deployCommandsToBot(bot.bot_id, decryptedToken, guildIds);

    console.log('Commands deployed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('Deployment failed:', error.message);
    process.exit(1);
  }
})();
