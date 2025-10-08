const Redis = require('ioredis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

console.log('[DEBUG] REDIS_PASSWORD from process.env in cache.js:', process.env.REDIS_PASSWORD);

const redisOptions = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    db: process.env.REDIS_DB || 0,
    maxRetriesPerRequest: null, // Required for BullMQ
};

// Conditionally add password if it exists in environment variables and is not an empty string
if (process.env.REDIS_PASSWORD && process.env.REDIS_PASSWORD !== '') {
    redisOptions.password = process.env.REDIS_PASSWORD;
}

const redis = new Redis(redisOptions);

redis.on('error', (err) => {
    // Do not exit the process, just log the error.
    // BullMQ and other components have their own retry logic.
    console.error('[Cache] Redis connection error:', err.message);
});

redis.on('connect', () => {
    console.log('[Cache] Successfully connected to Redis.');
});

module.exports = { redis, redisOptions };