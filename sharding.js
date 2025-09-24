const {ShardingManager} = require("discord.js");
const path = require("path");
require("dotenv-flow").config();
const logger = require("./utils/logger");

const manager = new ShardingManager(path.join(__dirname, "index.js"), {
  token: process.env.DISCORD_TOKEN,
  totalShards: "auto",
  respawn: true,
});

manager.on("shardCreate", shard => {
  logger.info(`[ShardingManager] Launched shard #${shard.id}`);
  shard.on("death", () => logger.error(`[Shard #${shard.id}] Died`));
  shard.on("disconnect", () => logger.warn(`[Shard #${shard.id}] Disconnected`));
  shard.on("reconnecting", () => logger.info(`[Shard #${shard.id}] Reconnecting...`));
});

manager.spawn().catch(error => {
  logger.error("[ShardingManager] Error spawning shards:", {error});
});