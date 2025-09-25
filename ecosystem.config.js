module.exports = {
  apps: [{
    name: "LiveBot",
    script: "index.js",
    exec_mode: "fork",
    instances: 1,
    autorestart: false,
    watch: false,
    max_memory_restart: "1G",
    env: {
      NODE_ENV: "development",
      SHARD_ID: undefined, // Explicitly unset sharding environment variables
      SHARD_COUNT: undefined
    },
    env_production: {
      NODE_ENV: "production",
      SHARD_ID: undefined, // Explicitly unset sharding environment variables
      SHARD_COUNT: undefined
    }
  }, {
    name: "AnnouncementWorker",
    script: "jobs/announcement-worker.js",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "500M",
    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
    }
  }]
};