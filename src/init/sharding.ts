import {ShardingManager} from "discord.js";
import path from "path";
import dotenv from "dotenv";
import {logger} from "../utils/logger";

dotenv.config();

// --- ASCII Art Startup Banner ---
// True Color (RGB) escape code for #1591fd and the reset code
const COLOR = "\u001b[38;2;21;145;253m";
const NC = "\u001b[0m"; // From your colours.json

// Backticks are used for this multi-line string
const asciiArt = `
    _____          _   _ ______   _          _
   / ____|        | | (_)  ____| (_)        | |
  | |     ___ _ __| |_ _| |__ _ __ _  ___  __| |
  | |    / _ \ '__| __| |  __| '__| |/ _ \/ _\` |
  | |___|  __/ |  | |_| | |  | |  | |  __/ (_| |
   \\_____\\___|_|   \\__|_|_|  |_|  |_|\\___|\\__,_|
     /  \\   _ __  _ __   ___  _   _ _ __   ___ ___ _ __
    / /\\ \\ | '_ \\| '_ \\ / _ \\| | | | '_ \\ / __/ _ \\ '__|
   / ____ \\| | | | | | | (_) | |_| | | | | (_|  __/ |
  /_/    \\_\\_| |_|_| |_|\\___/ \\__,_|_| |_|\\___\\___|_|

`;

// Log the colored ASCII art. A newline is added before and after for clean spacing.
console.log(`\n${COLOR}${asciiArt}${NC}`);
// --- End Banner ---

const manager = new ShardingManager(path.join(__dirname, "index.js"), {
    token: process.env.DISCORD_TOKEN,
    totalShards: "auto",
    respawn: true,
});

manager.on("shardCreate", shard => {
    logger.info(`[ShardingManager] Launched shard #${shard.id}`);
    shard.on("message", (msg) => logger.info(msg));
    shard.on("death", () => logger.error(`[Shard #${shard.id}] Died`));
    shard.on("disconnect", () => logger.warn(`[Shard #${shard.id}] Disconnected`));
    shard.on("reconnecting", () => logger.info(`[Shard #${shard.id}] Reconnecting...`));
});

manager.spawn().catch(error => {
    logger.error("[ShardingManager] Error spawning shards:", {error});
});
