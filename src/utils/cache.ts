import Redis from "ioredis";
import {logger} from "./logger";

if (!process.env.REDIS_URL || !process.env.REDIS_URL.length) {
    logger.error("[Cache] EnvVar: REDIS_URL not set");
    process.exit(1);
}

const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

redis.on("connect", () => logger.info("[Cache] Connected to Redis."));
redis.on("error", (err) => logger.error("[Cache] Redis connection error:", {error: err}));

async function get(key: string) {
    try {
        const data = await redis.get(key);
        return data ? JSON.parse(data) : null;
    } catch (error) {
        logger.error(`[Cache] Error getting key ${key}:`, {error});
        return null;
    }
}

async function set(key: string, value: string | number | boolean | BigInt, ttlSeconds: number = 60) {
    try {
        const stringValue = JSON.stringify(value);
        if (ttlSeconds) {
            await redis.set(key, stringValue, "EX", ttlSeconds);
        } else {
            await redis.set(key, stringValue);
        }
    } catch (error) {
        logger.error(`[Cache] Error setting key ${key}:`, {error});
    }
}

export {get, set, redis};
