import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import logger from './utils/logger.js';

dotenv.config();

/**
 * Clear all guild-specific commands to avoid duplicates
 * This will keep only the global commands
 */
async function clearGuildCommands() {
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    const clientId = process.env.DISCORD_CLIENT_ID;

    // Get all guilds the bot is in
    const guilds = await rest.get(Routes.userGuilds());

    logger.info(`[Clear] Found ${guilds.length} guild(s)`);

    // Clear commands for each guild
    for (const guild of guilds) {
      try {
        const guildCommands = await rest.get(
          Routes.applicationGuildCommands(clientId, guild.id)
        );

        if (guildCommands.length > 0) {
          logger.info(`[Clear] Deleting ${guildCommands.length} guild command(s) from ${guild.name} (${guild.id})`);

          await rest.put(
            Routes.applicationGuildCommands(clientId, guild.id),
            { body: [] }
          );

          logger.info(`[Clear] ✓ Cleared commands from ${guild.name}`);
        } else {
          logger.info(`[Clear] No guild commands found in ${guild.name}`);
        }
      } catch (error) {
        logger.error(`[Clear] Failed to clear commands from ${guild.name}`, { error: error.message });
      }
    }

    // Verify global commands still exist
    const globalCommands = await rest.get(Routes.applicationCommands(clientId));
    logger.info(`[Clear] ✓ Global commands remaining: ${globalCommands.length}`);
    logger.info(`[Clear] Cleanup complete! Only global commands should now appear in Discord.`);

  } catch (error) {
    logger.error('[Clear] Failed to clear guild commands', { error: error.message, stack: error.stack });
    throw error;
  }
}

// Execute cleanup
(async () => {
  try {
    await clearGuildCommands();
    process.exit(0);
  } catch (error) {
    logger.error('[Clear] Cleanup failed', { error: error.message });
    process.exit(1);
  }
})();
