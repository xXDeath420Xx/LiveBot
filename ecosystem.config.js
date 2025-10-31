require('dotenv').config();

module.exports = {
  apps: [
    {
      name: 'LiveBot-Main',
      script: 'index.js',
      env: {
        NODE_ENV: 'development',
        IS_MAIN_PROCESS: 'true',
      },
    },
    {
        name: 'LiveBot-System',
        script: 'jobs/system-worker.js',
        instances: 1,
        exec_mode: 'fork',
    },
    {
        name: 'LiveBot-Reminder-Worker',
        script: 'jobs/reminder-worker.js',
        instances: 1,
        exec_mode: 'fork',
    },
    {
        name: 'LiveBot-Ticket-Worker',
        script: 'jobs/ticket-worker.js',
        instances: 1,
        exec_mode: 'fork',
    },
    {
        name: 'LiveBot-Social-Worker',
        script: 'jobs/social-feed-worker.js',
        instances: 1,
        exec_mode: 'fork',
    },
    {
        name: 'LiveBot-Announcer',
        script: 'jobs/announcement-worker.js',
        instances: 1,
        exec_mode: 'fork',
    },
    {
        name: 'LiveBot-Offline-Worker',
        script: 'jobs/offline-worker.js',
        instances: 1,
        exec_mode: 'fork',
    },
    {
        name: 'Stream-Check-Scheduler',
        script: 'jobs/stream-check-scheduler.js',
        instances: 1,
        exec_mode: 'fork',
        cron_restart: '*/1 * * * *',
        autorestart: true,
    },
    {
        name: 'Team-Sync-Scheduler',
        script: 'jobs/team-sync-scheduler.js',
        instances: 1,
        exec_mode: 'fork',
        cron_restart: '0 */6 * * *',
        autorestart: false,
    },
    {
        name: 'Reminder-Scheduler',
        script: 'jobs/reminder-scheduler.js',
        instances: 1,
        exec_mode: 'fork',
        cron_restart: '*/1 * * * *',
        autorestart: false,
    },
    {
        name: 'Social-Feed-Scheduler',
        script: 'jobs/social-feed-scheduler.js',
        instances: 1,
        exec_mode: 'fork',
        cron_restart: '*/5 * * * *',
        autorestart: false,
    },
    {
        name: 'Ticket-Scheduler',
        script: 'jobs/ticket-scheduler.js',
        instances: 1,
        exec_mode: 'fork',
        cron_restart: '*/5 * * * *',
        autorestart: false,
    },
    {
        name: 'Analytics-Scheduler',
        script: 'jobs/analytics-scheduler.js',
        instances: 1,
        exec_mode: 'fork',
        cron_restart: '*/15 * * * *',
        autorestart: false,
    },
  ],
};