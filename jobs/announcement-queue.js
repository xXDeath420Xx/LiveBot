const { Queue } = require("bullmq");
const { redis } = require("../utils/cache");
const logger = require("../utils/logger");

// Create a new queue and reuse the existing ioredis client.
const announcementQueue = new Queue("announcements", {
  connection: redis
});

announcementQueue.on("error", err => {
  logger.error("[BullMQ] Queue Error:", { error: err });
});

module.exports = { announcementQueue };