const winston = require('winston');
const Transport = require('winston-transport');
const path = require('path');
const fs = require('fs');
const { EmbedBuilder } = require('discord.js');

const logDir = path.join(__dirname, '..', 'logs');

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const logPath = path.join(logDir, 'app.log');

let botClient = null;
let db = null;

// This helper function will handle circular references and BigInts
const safeStringify = (obj, indent = 2) => {
    let cache = new Set();
    const retVal = JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
            if (cache.has(value)) return '[Circular]';
            cache.add(value);
        }
        if (typeof value === 'bigint') return value.toString();
        return value;
    }, indent);
    cache.clear();
    return retVal;
};

class DiscordTransport extends Transport {
    constructor(opts) {
        super(opts);
    }

    async log(info, callback) {
        setImmediate(() => this.emit('logged', info));

        if (!botClient || !db || !info.guildId) {
            return callback();
        }

        const { level, message, guildId, category = 'default', ...meta } = info;

        try {
            const [[logConfig]] = await db.execute('SELECT * FROM log_config WHERE guild_id = ?', [guildId]);
            if (!logConfig) return callback();

            const enabledLogs = JSON.parse(logConfig.enabled_logs || '[]');
            const logCategories = JSON.parse(logConfig.log_categories || '{}');
            const targetChannelId = logCategories[category] || logConfig.log_channel_id;
            const isCategoryEnabled = enabledLogs.includes(category) || enabledLogs.includes('all');

            if (!targetChannelId || !isCategoryEnabled) return callback();

            const channel = await botClient.channels.fetch(targetChannelId).catch(() => null);
            if (!channel) return callback();

            const embed = new EmbedBuilder()
                .setTitle(`Log: ${category}`)
                .setColor(level === 'error' ? '#FF0000' : level === 'warn' ? '#FFA500' : '#00FF00')
                .setDescription(message)
                .setTimestamp();

            if (meta && Object.keys(meta).length > 0) {
                const errorStack = meta.error?.stack || (meta.error ? safeStringify(meta.error) : null);
                if (errorStack) {
                    embed.addFields({ name: 'Error Stack', value: `\`\`\`sh\n${errorStack.substring(0, 1020)}\n\`\`\`` });
                    delete meta.error;
                }
                const details = safeStringify(meta);
                if (details !== '{}') {
                    embed.addFields({ name: 'Details', value: `\`\`\`json\n${details.substring(0, 1000)}\n\`\`\`` });
                }
            }

            const webhooks = await channel.fetchWebhooks();
            let webhook = webhooks.find(wh => wh.owner.id === botClient.user.id);

            if (webhook) {
                await webhook.send({ embeds: [embed] });
            } else {
                await channel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('[Logger] CRITICAL: Failed to send log to Discord:', error);
        }

        callback();
    }
}

const baseLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true })
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(info => {
                    const { timestamp, level, message, stack, ...meta } = info;
                    let metaString = '';
                    if (meta && Object.keys(meta).length > 0) {
                        metaString = ` - ${safeStringify(meta, null)}`;
                    }
                    return `${timestamp} ${level}: ${message}${stack ? `\n${stack}` : ''}${metaString}`;
                })
            )
        }),
        new winston.transports.File({
            filename: logPath,
            format: winston.format.printf(info => {
                const { timestamp, level, message, stack, ...meta } = info;
                let metaString = '';
                if (meta && Object.keys(meta).length > 0) {
                    metaString = ` - ${safeStringify(meta, null)}`;
                }
                return `${timestamp} ${level}: ${message}${stack ? `\n${stack}` : ''}${metaString}`;
            })
        })
    ]
});

const logger = {
    init: (client, database) => {
        if (botClient && db) return;
        botClient = client;
        db = database;
        baseLogger.add(new DiscordTransport({}));
        baseLogger.info('[Logger] Discord transport initialized.');
    },
    info: (message, meta) => baseLogger.info(message, meta),
    warn: (message, meta) => baseLogger.warn(message, meta),
    error: (message, meta) => baseLogger.error(message, meta),
    debug: (message, meta) => baseLogger.debug(message, meta)
};

module.exports = logger;