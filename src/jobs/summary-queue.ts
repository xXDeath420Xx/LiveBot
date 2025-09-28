import {Queue} from "bullmq";
import {logger} from "../utils/logger";

const summaryQueue = new Queue("stream-summary", {
  connection: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: process.env.REDIS_PORT || 6379
  }
});

summaryQueue.on("error", err => {
  logger.error("[BullMQ] Summary Queue Error:", {error: err});
});

export {summaryQueue};
