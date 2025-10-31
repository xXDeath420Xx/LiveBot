"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.summaryQueue = void 0;
const bullmq_1 = require("bullmq");
const logger_1 = __importDefault(require("../utils/logger"));
const summaryQueue = new bullmq_1.Queue('stream-summary', {
    connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379
    }
});
exports.summaryQueue = summaryQueue;
summaryQueue.on('error', (err) => {
    logger_1.default.error('[BullMQ] Summary Queue Error:', { error: err });
});
