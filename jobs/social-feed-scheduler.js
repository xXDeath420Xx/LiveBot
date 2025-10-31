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
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleSocialFeedChecks = scheduleSocialFeedChecks;
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
const bullmq_1 = require("bullmq");
const cache_1 = require("../utils/cache");
const logger_1 = __importDefault(require("../utils/logger"));
const socialQueue = new bullmq_1.Queue('social-feeds', { connection: cache_1.redisOptions });
async function scheduleSocialFeedChecks() {
    const repeatableJobs = await socialQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        await socialQueue.removeRepeatableByKey(job.key);
    }
    await socialQueue.add('check-social-feeds', {}, {
        repeat: {
            every: 5 * 60 * 1000, // Every 5 minutes
        },
        removeOnComplete: true,
        removeOnFail: true,
    });
    logger_1.default.info('[SocialFeedScheduler] Social feed check job scheduled to run every 5 minutes.');
}
