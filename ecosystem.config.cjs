const path = require("path");
const { pathToFileURL } = require("url");

// CONSOLE-WINDOW FIX (2026-08-15). Was: script=node_modules/tsx/dist/cli.mjs. The tsx CLI does
// not run the script itself — it RE-EXECS a grandchild `node --require preflight.cjs --import
// loader.mjs <script>`. pm2's ForkMode spawn sets windowsHide:true so pm2's DIRECT child gets no
// console, but tsx's re-exec passes no such flag ('windowsHide' occurs 0 times in the whole tsx
// 4.23.1 dist), so Windows allocates a visible console for the GRANDCHILD — this process was one
// of the two black windows on the desktop. Passing tsx's own loader flags to node directly removes
// the re-exec, so no unhidden spawn is left to create a window. Behaviourally identical: these are
// the exact flags tsx passes internally. Same fix as tokens_ingest/ecosystem.config.cjs.
const TSX_LOADER_ARGS = [
  "--require",
  "./node_modules/tsx/dist/preflight.cjs",
  "--import",
  pathToFileURL(path.join(__dirname, "node_modules/tsx/dist/loader.mjs")).href,
].join(" ");

module.exports = {
  apps: [
    {
      name: "trader",
      script: "src/index.ts",
      interpreter: "C:\\Program Files\\nodejs\\node.exe",
      interpreter_args: TSX_LOADER_ARGS,
      args: "",
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
