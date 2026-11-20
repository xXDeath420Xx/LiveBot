import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { localizeCommands } from './utils/command-localization.js';
// Same payload builder as the automatic deploy (core/bot-manager.js runCommandDeploy): moved commands
// folded into their parents (core/command-mounts.js) and only slash-registered commands
// (core/command-registration.js). Pushing raw module JSON skipped both and went over Discord's 100 cap.
import { buildDeployJson } from './core/command-mounts.js';
import { fitSlashLimit } from './core/custom-bot-commands.js';
import { withEntryPoint } from './utils/entry-point-command.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let commands = [];
const modules = [];
const skipped = [];

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
          // guildScoped commands are deliberately kept out of the GLOBAL payload -- see
          // scripts/deploy-guild-scoped-commands.js, which registers them per-guild to the
          // servers that opted in. Custom bots use their own loaders and still get everything.
          if (command.default.guildScoped) {
            skipped.push(command.default.data.name);
            continue;
          }
          modules.push(command.default);
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
    commands = fitSlashLimit(buildDeployJson(modules)).commands;
    logger.info(`[Deploy] Started refreshing ${commands.length} application (/) commands.`);
    if (skipped.length) {
      logger.info(`[Deploy] Held back ${skipped.length} guild-scoped command(s) from the global payload: ${skipped.join(', ')}`);
    }

    const rest = new REST().setToken(process.env.DISCORD_TOKEN);

    const data = await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      // Native Discord localization: names/descriptions render in each user's
      // own client language at no runtime cost. Applied at the payload level so
      // no command file has to know it exists.
      // already mounted and filtered above; keeps the Discord Activity's Entry Point command (utils/entry-point-command.js)
      { body: await withEntryPoint(rest, process.env.DISCORD_CLIENT_ID, localizeCommands(commands)) }
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
