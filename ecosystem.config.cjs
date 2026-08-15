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

// SECRET-LEAK FIX (2026-08-16). PM2 captures the FULL environment of whatever shell
// started an app, and `pm2 save` writes that capture into ~/.pm2/dump.pm2 as
// PLAINTEXT. This process had been started from a shell with secrets exported, so
// the dump held SOLANA_PRIVATE_KEY and SOVA_API_KEY in the clear — neither of which
// is declared in this file, and SOLANA_PRIVATE_KEY is not even read by this app
// (src/config.ts wants WALLET_PRIVATE_KEY_BASE58). `pm2 resurrect` then replayed
// those stale values on every boot. Audited across the whole dump, all 13 PM2 apps
// on this box carried the same two keys.
//
// filter_env drops these prefixes at spawn so they never enter the snapshot.
// Safe here because src/config.ts:1 does `import "dotenv/config"`, which loads .env
// from cwd at startup — the app supplies its own secrets and never needed the
// inherited copies. .env stays the single source of truth.
//
// NOTE: this only cleans the dump once the app is re-registered from this file
// (`pm2 delete trader && pm2 start ecosystem.config.cjs && pm2 save`). Editing
// dump.pm2 by hand is pointless: PM2 rewrites it from live daemon state on save.
const SECRET_ENV_PREFIXES = [
  "SOLANA_", "SOVA_", "WALLET_", "HELIUS_", "JUPITER_", "JITO_", "WEBHOOK_",
  "TOKENS_INGEST_SERVICE_SECRET", "WORKER_", "MESH_", "CONTROLLER_", "DASHBOARD_",
  "VAPID_", "CLAUDE_", "CLAUDECODE", "ANTHROPIC_", "OPENAI_", "TELEGRAM_",
  "GITHUB_", "GH_", "AWS_", "VSCODE_", "WT_", "TERM_PROGRAM",
];

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
      filter_env: SECRET_ENV_PREFIXES,
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
