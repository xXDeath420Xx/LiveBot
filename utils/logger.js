const winston = require('winston');
require('dotenv-flow').config();

const { combine, timestamp, printf, colorize, json, errors, splat } = winston.format;

// Determine log level from environment variable, default to 'info' for production, 'debug' otherwise.
const logLevel = process.env.NODE_ENV === 'production' ? (process.env.LOG_LEVEL || 'info') : 'debug';

// Custom format for console logging
const consoleFormat = combine(
    colorize({ all: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }), // Ensure stack traces are printed
    splat(),
    printf(info => {
        const { timestamp, level, message, stack, ...rest } = info;
        const restString = JSON.stringify(rest, null, 2);
        const log = `${timestamp} ${level}: ${message}`;
        // Print stack trace if it exists
        if (stack) {
            return `${log}\n${stack}`;
        }
        // Print remaining metadata if it exists
        if (restString !== '{}') {
            return `${log} ${restString}`;
        }
        return log;
    })
);

// Format for file logging (JSON)
const fileFormat = combine(
    timestamp(),
    errors({ stack: true }),
    splat(),
    json()
);

const logger = winston.createLogger({
    level: logLevel,
    format: fileFormat, // Default format for transports is JSON
    transports: [
        // - Write all logs with level `error` or less to `logs/error.log`
        // - Write all logs with level `info` or less to `logs/combined.log`
        // Note: Winston will create the 'logs' directory if it doesn't exist.
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
    ],
    // Catch and log unhandled exceptions
    exceptionHandlers: [
        new winston.transports.File({ filename: 'logs/exceptions.log' })
    ],
    // Catch and log unhandled promise rejections
    rejectionHandlers: [
        new winston.transports.File({ filename: 'logs/rejections.log' })
    ]
});

// In a non-production environment, add a colorized console logger.
// In production, console logs will use the structured JSON format,
// which is preferred by container environments and log collection services.
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: consoleFormat,
    }));
} else {
    logger.add(new winston.transports.Console());
}

module.exports = logger;