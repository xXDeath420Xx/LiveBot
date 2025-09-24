const {Queue} = require("bullmq");
const logger = require("../utils/logger");

const youtubeQueue = new Queue("youtube-uploads", {
  connection: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: process.env.REDIS_PORT || 6379
  }
});

youtubeQueue.on("error", err => {
  logger.error("[BullMQ] YouTube Queue Error:", {error: err});
});

module.exports = {youtubeQueue};