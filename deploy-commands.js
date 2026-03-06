import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const commands = [];

/**
 * Load all command files and build command array
 */
async function loadCommands() {
  const commandsPath = join(__dirname, 'commands');

  if (!fs.existsSync(commandsPath)) {
    logger.warn('[Deploy] Commands directory does not exist');
    return;
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
}

/**
 * Deploy commands to Discord
 */
async function deployCommands() {
  try {
    logger.info(`[Deploy] Started refreshing ${commands.length} application (/) commands.`);

    const rest = new REST().setToken(process.env.DISCORD_TOKEN);

    const data = await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );

    logger.info(`[Deploy] Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    logger.error('[Deploy] Failed to deploy commands', { error: error.message, stack: error.stack });
    throw error;
  }
}

// Execute deployment
(async () => {
  try {
    await loadCommands();
    await deployCommands();
    process.exit(0);
  } catch (error) {
    logger.error('[Deploy] Deployment failed', { error: error.message });
    process.exit(1);
  }
})();
