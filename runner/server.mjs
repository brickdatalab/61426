// Runner entrypoint (systemd ExecStart). Binds the control-API to 127.0.0.1 ONLY —
// never 0.0.0.0. External access is a later concern (TLS front at the Vercel hookup).
// Gates on NTP sync before resuming sessions (wrong clock => wrong bar boundaries).
import { execFileSync } from 'node:child_process';
import { createOrchestrator } from './orchestrator.mjs';
import { createApp } from './control-api.mjs';

export function readConfig(env = process.env) {
  const secret = env.VM_CONTROL_SECRET;
  if (!secret) throw new Error('VM_CONTROL_SECRET is required');
  return {
    secret,
    port: Number(env.CONTROL_PORT || 8790),
    host: env.CONTROL_HOST || '127.0.0.1', // localhost-only by default
    stateDir: env.RUNNER_STATE_DIR || '/home/vincent/61426-runner/state',
    logDir: env.RUNNER_LOG_DIR || '/home/vincent/61426-runner/logs', // scratch by default; prod dir set explicitly
  };
}

// NTP gate: `timedatectl show -p NTPSynchronized --value` must be "yes".
export function ntpSynced(execFn = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })) {
  try {
    return execFn('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']).trim() === 'yes';
  } catch {
    return false;
  }
}

async function main() {
  const cfg = readConfig();
  if (!ntpSynced()) {
    console.error('[runner] NTP not synchronized — refusing to start (bar boundaries need a correct clock)');
    process.exit(1);
  }
  const orchestrator = createOrchestrator({ stateDir: cfg.stateDir, logDir: cfg.logDir });
  const resumedCount = await orchestrator.resumeAll(); // returns the number of sessions resumed
  console.error(`[runner] resumed ${resumedCount} session(s); OWS_BASE=${process.env.OWS_BASE || '(default)'}`);
  const app = createApp({ secret: cfg.secret, orchestrator });
  app.listen(cfg.port, cfg.host, () => console.error(`[runner] control-API on ${cfg.host}:${cfg.port}`));

  const shutdown = () => { try { app.close(); } catch {} process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[runner] fatal:', e); process.exit(1); });
}
