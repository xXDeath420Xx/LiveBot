const path = require('path');
const CWD = __dirname;

const workerProductionEnv = {
    NODE_ENV: 'production',
    NODE_PATH: path.join(CWD, 'node_modules'),
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD
};

const mainProductionEnv = {
    NODE_ENV: 'production',
    DASHBOARD_PORT: 3001,
    NODE_PATH: path.join(CWD, 'node_modules'),
    IS_MAIN_PROCESS: 'true',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD
};

const mainDevelopmentEnv = {
    NODE_ENV: 'development',
    DASHBOARD_PORT: 3001,
    NODE_PATH: path.join(CWD, 'node_modules'),
    IS_MAIN_PROCESS: 'true',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: 6379,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD
};

module.exports = {
    apps: [
        // Main Bot Process
        {
            name: 'LiveBot-Main',
            script: 'index.js',
            cwd: CWD,
            env_production: mainProductionEnv,
            env_development: mainDevelopmentEnv,
        },

        // Worker Processes (Persistent)
        {
            name: 'LiveBot-Announcer',
            script: 'jobs/announcement-worker.js',
            cwd: CWD,
            env_production: workerProductionEnv,
        },
        {
            name: 'LiveBot-System',
            script: 'jobs/system-worker.js',
            cwd: CWD,
            env_production: workerProductionEnv,
        },
        {
            name: 'LiveBot-Reminder-Worker',
            script: 'jobs/reminder-worker.js',
            cwd: CWD,
            env_production: workerProductionEnv,
        },
        {
            name: 'LiveBot-Ticket-Worker',
            script: 'jobs/ticket-worker.js',
            cwd: CWD,
            env_production: workerProductionEnv,
        },
        {
            name: 'LiveBot-Social-Worker',
            script: 'jobs/social-feed-worker.js',
            cwd: CWD,
            env_production: workerProductionEnv,
        },

        // Scheduler Processes (Run on a cron schedule)
        {
            name: 'Stream-Check-Scheduler',
            script: 'jobs/stream-check-scheduler.js',
            cwd: CWD,
            env_production: workerProductionEnv,
            cron_restart: '*/2 * * * *', // Every 2 minutes
            autorestart: false,
        },
        {
            name: 'Team-Sync-Scheduler',
            script: 'jobs/team-sync-scheduler.js',
            cwd: CWD,
            env_production: workerProductionEnv,
            cron_restart: '0 */6 * * *', // Every 6 hours
            autorestart: false,
        },
        {
            name: 'Reminder-Scheduler',
            script: 'jobs/reminder-scheduler.js',
            cwd: CWD,
            env_production: workerProductionEnv,
            cron_restart: '*/1 * * * *', // Every minute
            autorestart: false,
        },
        {
            name: 'Social-Feed-Scheduler',
            script: 'jobs/social-feed-scheduler.js',
            cwd: CWD,
            env_production: workerProductionEnv,
            cron_restart: '*/5 * * * *', // Every 5 minutes
            autorestart: false,
        },
        {
            name: 'Ticket-Scheduler',
            script: 'jobs/ticket-scheduler.js',
            cwd: CWD,
            env_production: workerProductionEnv,
            cron_restart: '*/5 * * * *', // Every 5 minutes
            autorestart: false,
        },
        {
            name: 'Analytics-Scheduler',
            script: 'jobs/analytics-scheduler.js',
            cwd: CWD,
            env_production: workerProductionEnv,
            cron_restart: '*/15 * * * *', // Every 15 minutes
            autorestart: false,
        }
    ],
};