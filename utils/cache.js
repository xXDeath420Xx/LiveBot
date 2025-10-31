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
exports.queueOptions = exports.redis = exports.connection = exports.redisOptions = void 0;
exports.getCache = getCache;
exports.setCache = setCache;
exports.deleteCache = deleteCache;
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = require("./logger");
const dotenv = __importStar(require("dotenv-flow"));
dotenv.config(); // Ensure dotenv-flow is loaded in this process
// Debugging: Log Redis environment variables
console.log('[DEBUG] REDIS_HOST from process.env in cache.ts:', process.env.REDIS_HOST || 'NOT SET');
console.log('[DEBUG] REDIS_PORT from process.env in cache.ts:', process.env.REDIS_PORT || 'NOT SET');
console.log('[DEBUG] REDIS_PASSWORD from process.env in cache.ts:', process.env.REDIS_PASSWORD ? '********' + process.env.REDIS_PASSWORD.slice(-5) : 'NOT SET');
const redisOptions = {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
};
exports.redisOptions = redisOptions;
const connection = new ioredis_1.default(redisOptions);
exports.connection = connection;
exports.redis = connection;
connection.on('error', (err) => {
    logger_1.logger.error('[Cache] Redis connection error:', { category: 'system', error: err.message });
});
connection.on('connect', () => {
    logger_1.logger.info('[Cache] Connected to Redis.', { category: 'system' });
});
const queueOptions = {
    connection: connection,
};
exports.queueOptions = queueOptions;
// Helper functions for cache operations
async function getCache(key) {
    try {
        return await connection.get(key);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.error(`[Cache] Failed to get key "${key}":`, { category: 'system', error: errorMessage });
        return null;
    }
}
async function setCache(key, value, ttlSeconds) {
    try {
        if (ttlSeconds) {
            await connection.setex(key, ttlSeconds, value);
        }
        else {
            await connection.set(key, value);
        }
        return true;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.error(`[Cache] Failed to set key "${key}":`, { category: 'system', error: errorMessage });
        return false;
    }
}
async function deleteCache(key) {
    try {
        await connection.del(key);
        return true;
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger_1.logger.error(`[Cache] Failed to delete key "${key}":`, { category: 'system', error: errorMessage });
        return false;
    }
}
