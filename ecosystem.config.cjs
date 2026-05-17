module.exports = {
  apps: [
    {
      name: "trader",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/index.ts",
      cwd: __dirname,

      // Environment
      env: {
        NODE_ENV: "production",
        LOG_FILE: "logs/bot.log",
      },

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,

      // Log management
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,

      // Graceful shutdown — matches SIGTERM handler in src/index.ts
      kill_timeout: 10000,
      listen_timeout: 15000,

      instances: 1,
      exec_mode: "fork",
    },
  ],
};
