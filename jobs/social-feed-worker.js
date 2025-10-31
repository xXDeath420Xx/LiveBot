"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const bullmq_1 = require("bullmq");
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
const cache_1 = require("../utils/cache");
const logger_1 = __importDefault(require("../utils/logger"));
const reddit_feed_1 = require("../core/reddit-feed");
const twitter_feed_1 = require("../core/twitter-feed");
module.exports = function startSocialFeedWorker(client) {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger_1.default.info('[Social Feed Worker] Initializing BullMQ Worker.');
    const socialFeedWorker = new bullmq_1.Worker('social-feeds', async (job) => {
        if (!client.isReady()) {
            logger_1.default.warn(`[SocialFeedWorker] Discord client not ready. Retrying job ${job.id}...`);
            throw new Error('Discord client not ready');
        }
        if (job.name === 'check-social-feeds') {
            logger_1.default.info('[SocialFeedWorker] Checking for new posts from Reddit and Twitter.');
            try {
                await (0, reddit_feed_1.checkRedditFeeds)(client);
                await (0, twitter_feed_1.checkTwitterFeeds)(client);
            }
            catch (error) {
                logger_1.default.error('[SocialFeedWorker] Error during social feed check:', { error });
                throw error;
            }
        }
    }, { connection: cache_1.redisOptions });
    socialFeedWorker.on('completed', (job) => logger_1.default.info(`[SocialFeedWorker] Job ${job.id} has completed.`));
    socialFeedWorker.on('failed', (job, err) => logger_1.default.error(`[SocialFeedWorker] Job ${job?.id} has failed.`, { error: err }));
    // Graceful shutdown is handled by the main process.
    return socialFeedWorker;
};
