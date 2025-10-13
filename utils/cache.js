const Redis = require('ioredis');
const logger = require('./logger');
require('dotenv').config(); // Ensure dotenv is loaded in this process

// Debugging: Log Redis environment variables
console.log('[DEBUG] REDIS_HOST from process.env in cache.js:', process.env.REDIS_HOST || 'NOT SET');
console.log('[DEBUG] REDIS_PORT from process.env in cache.js:', process.env.REDIS_PORT || 'NOT SET');
console.log('[DEBUG] REDIS_PASSWORD from process.env in cache.js:', process.env.REDIS_PASSWORD ? '********' + process.env.REDIS_PASSWORD.slice(-5) : 'NOT SET');

const redisOptions = {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
};

const connection = new Redis(redisOptions);

connection.on('error', (err) => {
    logger.error('[Cache] Redis connection error:', { category: 'system', error: err.message });
});

connection.on('connect', () => {
    logger.info('[Cache] Connected to Redis.', { category: 'system' });
});

const queueOptions = {
    connection: connection,
};

module.exports = {
    redisOptions,
    connection,
    queueOptions,
};