"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.announcementQueue = void 0;
var bullmq_1 = require("bullmq");
var cache_1 = require("../utils/cache");
var logger_1 = __importDefault(require("../utils/logger"));
// Create a new queue and reuse the existing ioredis client.
var announcementQueue = new bullmq_1.Queue('announcements', {
    connection: cache_1.connection
});
exports.announcementQueue = announcementQueue;
announcementQueue.on('error', function (err) {
    logger_1.default.error('[BullMQ] Queue Error:', { error: err });
});
