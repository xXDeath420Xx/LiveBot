// Monkey-patch BigInt to allow serialization
BigInt.prototype.toJSON = function() { return this.toString(); };

const {Client, GatewayIntentBits, Collection, Events, Partials, PermissionsBitField} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv-flow").config();

const logger = require("./utils/logger");
const db = require("./utils/db");
const cache = require("./utils/cache");
const dashboard = require(path.join(__dirname, "dashboard", "server.js"));
const {handleInteraction} = require("./core/interaction-handler");
const {setStatus, Status} = require("./core/status-manager");
const {gracefulShutdown: browserShutdown} = require("./utils/browserManager");
const {startupCleanup} = require("./core/startup");

// --- Main Application --- //

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.User, Partials.GuildMember, Partials.Channel, Partials.Message]
});

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.warn(`[Shutdown] Received ${signal}. Shutting down gracefully...`);
  setStatus(Status.MAINTENANCE, "Bot is shutting down.");

  // 1. Close browser
  await browserShutdown();

  // 2. Destroy Discord client
  await client.destroy();

  // 3. Close database and cache connections
  await db.end();
  await cache.redis.quit();

  logger.info("[Shutdown] All services closed. Exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function loadCommands() {
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
      logger.error(`[CMD Load Error] Failed to load ${file}:`, {error: e});
    }
  }
  logger.info(`[Startup] ${client.commands.size} commands loaded.`);
}

client.once(Events.ClientReady, async c => {
  logger.info(`[READY] Logged in as ${c.user.tag}`);
  
  setStatus(Status.STARTING, "Running startup cleanup...");
  await startupCleanup(c);

  setStatus(Status.STARTING, "Initializing Dashboard...");
  try {
    const app = dashboard.start(c, PermissionsBitField);
    const port = process.env.DASHBOARD_PORT || 3000;
    app.listen(port, () => {
        logger.info(`[Dashboard] Web dashboard listening on port ${port}`);
    });
  } catch (e) {
    logger.error("[Dashboard] Failed to start dashboard:", {error: e});
  }

  // On startup, run the checks once immediately.
  // The recurring schedule is now handled by separate, robust BullMQ schedulers.
  setStatus(Status.STARTING, "Running initial data checks...");
  const { checkStreams, checkTeams } = require("./core/stream-checker");
  const { syncDiscordUserIds } = require("./core/user-sync");
  await checkStreams(c);
  await checkTeams(c);
  await syncDiscordUserIds(c);

  setStatus(Status.ONLINE, "Bot is online and operational.");
});

client.on(Events.InteractionCreate, handleInteraction);

async function main() {
  logger.info("[Main] Starting bot...");
  try {
    setStatus(Status.STARTING, "Loading commands...");
    loadCommands();

    logger.info("[Main] Attempting to log in to Discord...");
    await client.login(process.env.DISCORD_TOKEN);

  } catch (error) {
    logger.error("[Main Error] A fatal error occurred during bot startup:", {error});
    process.exit(1);
  }
}

main();