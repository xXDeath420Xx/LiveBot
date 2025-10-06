module.exports = {
  apps: [
    {
      name: 'LiveBot-Main',
      script: 'index.js',
      env_production: { NODE_ENV: 'production' },
      env_development: { NODE_ENV: 'development' },
    },
    {
      name: 'LiveBot-Announcer',
      script: 'jobs/announcement-worker.js',
      env_production: { NODE_ENV: 'production' },
      env_development: { NODE_ENV: 'development' },
    },
    {
      name: 'LiveBot-System',
      script: 'jobs/system-worker.js',
      env_production: { NODE_ENV: 'production' },
      env_development: { NODE_ENV: 'development' },
    },
    {
      name: 'LiveBot-Reminder-Worker',
      script: 'jobs/reminder-worker.js',
      env_production: { NODE_ENV: 'production' },
      env_development: { NODE_ENV: 'development' },
    },
    {
      name: 'Stream-Check-Scheduler',
      script: 'jobs/stream-check-scheduler.js',
      cron_restart: '*/2 * * * *',
      autorestart: false,
    },
    {
      name: 'Team-Sync-Scheduler',
      script: 'jobs/team-sync-scheduler.js',
      cron_restart: '0 */6 * * *',
      autorestart: false,
    },
    {
      name: 'Reminder-Scheduler',
      script: 'jobs/reminder-scheduler.js',
      cron_restart: '*/1 * * * *',
      autorestart: false,
    },
    {
      name: 'Stats-Scheduler',
      script: 'jobs/stats-scheduler.js',
      cron_restart: '0 0 * * *', // Run once a day at midnight
      autorestart: false,
    },
    {
      name: 'Poll-Scheduler',
      script: 'jobs/poll-scheduler.js',
      cron_restart: '*/1 * * * *',
      autorestart: false,
    }
  ],
};