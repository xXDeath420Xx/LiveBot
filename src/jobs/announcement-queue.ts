import {Queue} from "bullmq";
import {logger} from "../utils/logger";

const announcementQueue = new Queue("announcements", {
  connection: {
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: process.env.REDIS_PORT ?? 6379
  }
});

announcementQueue.on("error", err => {
  logger.error("[BullMQ] Queue Error:", {error: err});
});

export {announcementQueue};
