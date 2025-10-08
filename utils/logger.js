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

            if (!targetChannelId || !isCategoryEnabled) {
                return callback();
            }

            const channel = await botClient.channels.fetch(targetChannelId).catch(() => null);
            if (!channel) {
                // Don't log this warning to avoid loops
                console.warn(`[Logger] Log channel ${targetChannelId} not found for guild ${guildId}`);
                return callback();
            }

            const levelColors = {
                error: '#FF0000',
                warn: '#FFA500',
                info: '#00FF00',
                verbose: '#808080',
                debug: '#808080',
                silly: '#808080'
            };

            const embed = new EmbedBuilder()
                .setTitle(`Log: ${category}`)
                .setColor(levelColors[level] || '#FFFFFF')
                .setDescription(message)
                .setTimestamp();

            if (Object.keys(meta).length > 0) {
                let metaString = '';
                for(const [key, value] of Object.entries(meta)) {
                    const valStr = typeof value === 'object' ? JSON.stringify(value) : value;
                    const field = `**${key}**: ${valStr}\n`;
                    if (metaString.length + field.length > 1024) break;
                    metaString += field;
                }
                if(metaString) embed.addFields({ name: 'Details', value: metaString });
            }

            await channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('[Logger] Failed to send log to Discord:', error);
        }

        callback();
    }
}

const baseLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.colorize(),
                winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}` + (info.splat !== undefined ? `${info.splat}`: " "))
            )
        }),
        new winston.transports.File({
            filename: logPath,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        })
    ]
});

const logger = {
    init: (client, database) => {
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