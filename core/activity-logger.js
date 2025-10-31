"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logMessageActivity = logMessageActivity;
exports.logVoiceStateUpdate = logVoiceStateUpdate;
exports.flushVoiceActivity = flushVoiceActivity;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
// In-memory cache to batch database writes
const messageActivityCache = new Map(); // key: `${guildId}:${userId}:${channelId}`, value: count
const voiceActivityCache = new Map(); // key: userId, value: { guildId, channelId, joinTimestamp }
// Periodically flush caches to the database
setInterval(flushMessageActivity, 5 * 60 * 1000); // every 5 minutes
function logMessageActivity(message) {
    if (!message.guild)
        return;
    const key = `${message.guild.id}:${message.author.id}:${message.channel.id}`;
    const currentCount = messageActivityCache.get(key) || 0;
    messageActivityCache.set(key, currentCount + 1);
}
async function flushMessageActivity() {
    if (messageActivityCache.size === 0)
        return;
    const entries = Array.from(messageActivityCache.entries());
    messageActivityCache.clear();
    const query = 'INSERT INTO activity_logs (guild_id, user_id, channel_id, type, count, log_date) VALUES ? ON DUPLICATE KEY UPDATE count = count + VALUES(count)';
    const values = entries.map(([key, count]) => {
        const [guildId, userId, channelId] = key.split(':');
        const logDate = new Date().toISOString().slice(0, 10); // Get YYYY-MM-DD
        return [guildId, userId, channelId, 'message', count, logDate];
    });
    try {
        await db_1.default.query(query, [values]);
        logger_1.default.info(`Flushed ${entries.length} message activity records to the database.`, { category: 'activity-log' });
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code !== 'ER_NO_SUCH_TABLE') {
            logger_1.default.error('Error flushing message activity:', { error: error instanceof Error ? error.stack : error });
        }
    }
}
function logVoiceStateUpdate(oldState, newState) {
    const userId = newState.id;
    const guildId = newState.guild.id;
    // User joins a voice channel or moves between channels
    if (newState.channelId && newState.channelId !== oldState.channelId) {
        if (voiceActivityCache.has(userId)) {
            const oldData = voiceActivityCache.get(userId);
            const durationSeconds = Math.floor((Date.now() - oldData.joinTimestamp) / 1000);
            if (durationSeconds > 0) {
                const logDate = new Date().toISOString().slice(0, 10);
                db_1.default.execute('INSERT INTO activity_logs (guild_id, user_id, channel_id, type, count, log_date) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE count = count + VALUES(count)', [oldData.guildId, userId, oldData.channelId, 'voice', durationSeconds, logDate]).catch((e) => logger_1.default.error('Error logging voice activity:', { error: e instanceof Error ? e.stack : e }));
            }
        }
        voiceActivityCache.set(userId, { guildId, channelId: newState.channelId, joinTimestamp: Date.now() });
    }
    // User leaves a voice channel
    else if (!newState.channelId && oldState.channelId) {
        if (voiceActivityCache.has(userId)) {
            const oldData = voiceActivityCache.get(userId);
            const durationSeconds = Math.floor((Date.now() - oldData.joinTimestamp) / 1000);
            if (durationSeconds > 0) {
                const logDate = new Date().toISOString().slice(0, 10);
                db_1.default.execute('INSERT INTO activity_logs (guild_id, user_id, channel_id, type, count, log_date) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE count = count + VALUES(count)', [oldData.guildId, userId, oldData.channelId, 'voice', durationSeconds, logDate]).catch((e) => logger_1.default.error('Error logging voice activity:', { error: e instanceof Error ? e.stack : e }));
            }
            voiceActivityCache.delete(userId);
        }
    }
}
async function flushVoiceActivity() {
    if (voiceActivityCache.size === 0)
        return;
    const entries = Array.from(voiceActivityCache.entries());
    voiceActivityCache.clear();
    const values = entries.map(([userId, data]) => {
        const durationSeconds = Math.floor((Date.now() - data.joinTimestamp) / 1000);
        if (durationSeconds <= 0)
            return null;
        const logDate = new Date().toISOString().slice(0, 10);
        return [data.guildId, userId, data.channelId, 'voice', durationSeconds, logDate];
    }).filter(Boolean);
    if (values.length === 0)
        return;
    const query = 'INSERT INTO activity_logs (guild_id, user_id, channel_id, type, count, log_date) VALUES ? ON DUPLICATE KEY UPDATE count = count + VALUES(count)';
    try {
        await db_1.default.query(query, [values]);
        logger_1.default.info(`Flushed ${values.length} voice activity records to the database during shutdown.`, { category: 'activity-log' });
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code !== 'ER_NO_SUCH_TABLE') {
            logger_1.default.error('Error flushing voice activity:', { error: error instanceof Error ? error.stack : error });
        }
    }
}
