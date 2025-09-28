import winston from "winston";

const {combine, timestamp, errors, splat, json} = winston.format;

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    // The format combines timestamp, stack trace capturing, and string interpolation
    format: combine(
        timestamp({format: 'YYYY-MM-DD HH:mm:ss'}),
        errors({stack: true}), // This is key to capturing stack traces from Error objects
        splat(),
        json() // Log everything as a JSON object to ensure it's captured by PM2
    ),
    // Log *only* to the console. PM2 or the container environment will handle file output.
    transports: [
        new winston.transports.Console(),
    ],
});
export {logger};
