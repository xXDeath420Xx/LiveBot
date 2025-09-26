// Monkey-patch BigInt to allow serialization
BigInt.prototype.toJSON = function() { return this.toString(); };

const {Client, GatewayIntentBits, Collection, Events, Partials, PermissionsBitField} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv-flow").config();
const logger = require("./utils/logger");
const dashboard = require(path.join(__dirname, "dashboard", "server.js"));
const {handleInteraction} = require("./core/interaction-handler");
const {setStatus} = require("./core/status-manager");
const db = require("./utils/db");
const cache = require("./utils/cache");
const { cacheAllTwitchAvatars } = require("./core/avatar-cache");
const fetch = require('node-fetch'); // Add node-fetch for HTTP requests

async function main() {
  logger.info("[Main] Entered main function.");
  try {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.User, Partials.GuildMember, Partials.Channel, Partials.Message]
    });

    let isShuttingDown = false;
    const intervals = [];

    async function shutdown(signal) {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.warn(`[Shutdown] Received ${signal}. Shutting down gracefully...`);
      setStatus("MAINTENANCE", "Bot is shutting down.");
      intervals.forEach(clearInterval);
      await client.destroy();
      await db.end();
      await cache.redis.quit();
      process.exit(0);
    }

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    client.commands = new Collection();
    const commandsPath = path.join(__dirname, "commands");
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"));
    for (const file of commandFiles) {
      try {
        const command = require(path.join(commandsPath, file));
        if (command.data && command.execute) {
          client.commands.set(command.data.name, command);
        }
      } catch (e) {
        logger.error(`[CMD Load Error] Failed to load ${file}: ${e.message}`, {error: e});
      }
    }
    logger.info(`[Startup] ${client.commands.size} commands loaded.`);

    // Interaction handlers loading (buttons, modals, etc.)
    // ... (code for loading interactions remains the same)

    client.on(Events.InteractionCreate, handleInteraction);

    // New button interaction handler for global commands
    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.isButton()) return;

        const BOT_OWNER_ID = "365905620060340224";
        if (interaction.user.id !== BOT_OWNER_ID) {
            return interaction.reply({ content: "You do not have permission to use this button.", ephemeral: true });
        }

        const dashboardPort = process.env.DASHBOARD_PORT || 3000;

        switch (interaction.customId) {
            case 'confirm_global_reinit':
                await interaction.deferReply({ ephemeral: true });
                try {
                    const response = await fetch(`http://localhost:${dashboardPort}/api/reinit`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                    });
                    const result = await response.json();
                    if (response.ok && result.success) {
                        await interaction.editReply({ content: `Bot re-initialization initiated: ${result.message}` });
                    } else {
                        await interaction.editReply({ content: `Failed to re-initialize bot: ${result.message || 'Unknown error'}` });
                    }
                } catch (error) {
                    logger.error("[Discord Button] Global Reinit API call failed:", { error });
                    await interaction.editReply({ content: `An error occurred while trying to re-initialize the bot: ${error.message}` });
                }
                break;
            case 'cancel_global_reinit':
                await interaction.reply({ content: "Global bot re-initialization cancelled.", ephemeral: true });
                break;
            case 'confirm_reset_database':
                await interaction.deferReply({ ephemeral: true });
                try {
                    const response = await fetch(`http://localhost:${dashboardPort}/api/admin/reset-database`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                    });
                    const result = await response.json();
                    if (response.ok && result.success) {
                        await interaction.editReply({ content: `Database reset initiated: ${result.message}` });
                    } else {
                        await interaction.editReply({ content: `Failed to reset database: ${result.message || 'Unknown error'}` });
                    }
                } catch (error) {
                    logger.error("[Discord Button] Database Reset API call failed:", { error });
                    await interaction.editReply({ content: `An error occurred while trying to reset the database: ${error.message}` });
                }
                break;
            case 'cancel_reset_database':
                await interaction.reply({ content: "Database reset cancelled.", ephemeral: true });
                break;
            default:
                // Handle other buttons or ignore
                break;
        }
    });

    client.once(Events.ClientReady, async c => {
      logger.info(`[READY] Logged in as ${c.user.tag}`);
      
      setStatus("STARTING", "Initializing Dashboard...");
      const app = dashboard.start(c, PermissionsBitField);
      const port = process.env.DASHBOARD_PORT || 3000;
      app.listen(port, () => {
          logger.info(`[Dashboard] Web dashboard listening on port ${port}`);
      });

      // Initial data caching
      await cacheAllTwitchAvatars();

      setStatus("ONLINE", "Bot is online and operational.");

      const { checkStreams, checkTeams } = require("./core/stream-checker");
      const { syncDiscordUserIds } = require("./core/user-sync");
      
      // Initial checks on startup
      await checkStreams(c);
      await checkTeams(c);
      await syncDiscordUserIds(c);

      // Set intervals for recurring checks
      intervals.push(setInterval(() => checkStreams(c), 180 * 1000)); // Every 3 minutes
      intervals.push(setInterval(() => checkTeams(c), 3600 * 1000)); // Every 1 hour
      intervals.push(setInterval(() => syncDiscordUserIds(c), 6 * 3600 * 1000)); // Every 6 hours
    });

    logger.info("[Main] Attempting to log in to Discord...");
    await client.login(process.env.DISCORD_TOKEN);

  } 
  catch (error) {
    logger.error("[Main Error] A fatal error occurred during bot startup:", {error});
    process.exit(1);
  }
}

main();

module.exports = { main };
