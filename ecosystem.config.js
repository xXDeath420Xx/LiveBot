module.exports = {
  apps: [{
    name: "LiveBot",
    script: "index.js",
    exec_mode: "fork",
    instances: 1,
    autorestart: false,
    watch: false,
    max_memory_restart: "1G",
    out_file: "./logs/LiveBot-out.log",
    error_file: "./logs/LiveBot-error.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    env: {
      NODE_ENV: "development",
      SHARD_ID: undefined, // Explicitly unset sharding environment variables
      SHARD_COUNT: undefined,
      DISCORD_SHARDING_MANAGER: false // Explicitly disable Discord.js sharding
    },
    env_production: {
      NODE_ENV: "production",
      SHARD_ID: undefined, // Explicitly unset sharding environment variables
      SHARD_COUNT: undefined,
      DISCORD_SHARDING_MANAGER: false // Explicitly disable Discord.js sharding
    }
  }, {
    name: "AnnouncementWorker",
    script: "jobs/announcement-worker.js",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "500M",
    out_file: "./logs/AnnouncementWorker-out.log",
    error_file: "./logs/AnnouncementWorker-error.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
    }
  }]
};