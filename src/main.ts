import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp, buildWebhookApp } from './api/server.js';
import { loadConfig, type AppConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { errMsg, logger } from './log.js';
import { AfricasTalkingSms } from './notify/africasTalking.js';
import { MockSms } from './notify/mock.js';
import { AfricasTalkingVoice, SimulatedVoice } from './notify/voice.js';
import { OutboxWorker } from './notify/outbox.js';

type Role = 'api' | 'vision' | 'notifier' | 'simulator' | 'migrate' | 'all';

function onShutdown(fn: () => Promise<void> | void): AbortSignal {
  const ac = new AbortController();
  let stopping = false;
  const handler = async () => {
    if (stopping) return;
    stopping = true;
    ac.abort();
    try {
      await fn();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return ac.signal;
}

async function runApi(cfg: AppConfig): Promise<void> {
  const db = createPool(cfg.DATABASE_URL);
  const app = await buildApp(cfg, db);
  const hook = cfg.WEBHOOK_PORT ? await buildWebhookApp(cfg, db) : null;
  onShutdown(async () => {
    await app.close();
    await hook?.close();
    await db.end();
  });
  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  const { appVersion } = await import('./api/server.js');
  logger('api').info(`Safe Savannah v${await appVersion()} — staff: http://${cfg.HOST}:${cfg.PORT}/  ·  tourists: http://${cfg.HOST}:${cfg.PORT}/t`);
  if (hook) await hook.listen({ host: cfg.WEBHOOK_HOST, port: cfg.WEBHOOK_PORT! });
}

async function runVision(cfg: AppConfig): Promise<void> {
  const log = logger('vision');
  const db = createPool(cfg.DATABASE_URL, 4);
  const signal = onShutdown(() => db.end());
  // Imported lazily so the API process never loads onnxruntime/sharp.
  const { runVisionWorker } = await import('./vision/worker.js');
  await runVisionWorker(cfg, db, log, signal);
}

async function runNotifier(cfg: AppConfig): Promise<void> {
  const log = logger('notifier');
  const db = createPool(cfg.DATABASE_URL, 4);
  const listen = new pg.Client({ connectionString: cfg.DATABASE_URL });
  await listen.connect();
  const provider =
    cfg.SMS_PROVIDER === 'africastalking'
      ? new AfricasTalkingSms({
          username: cfg.AT_USERNAME,
          apiKey: cfg.AT_API_KEY,
          environment: cfg.AT_ENVIRONMENT,
          senderId: cfg.AT_SENDER_ID,
          timeoutMs: cfg.SMS_TIMEOUT_MS,
        })
      : new MockSms(db);
  const worker = new OutboxWorker(
    db,
    {
      provider,
      recipients: new Map(cfg.recipients.map((r) => [r.alias, r.number])),
      freshnessSeconds: cfg.SMS_FRESHNESS_SECONDS,
      testMode: cfg.SMS_TEST_MODE,
      voice:
        cfg.VOICE_PROVIDER === 'africastalking'
          ? new AfricasTalkingVoice({ username: cfg.AT_USERNAME, apiKey: cfg.AT_API_KEY!, from: cfg.AT_VOICE_NUMBER!, environment: cfg.AT_ENVIRONMENT, timeoutMs: cfg.SMS_TIMEOUT_MS })
          : new SimulatedVoice(db),
      backoffCapMs: cfg.SMS_RETRY_CAP_SECONDS * 1000,
    },
    log,
  );
  const signal = onShutdown(async () => {
    await listen.end().catch(() => undefined);
    await db.end();
  });
  log.info('notifier started', { provider: provider.name, recipients: cfg.recipients.map((r) => r.alias) });
  await worker.run(signal, listen);
}

/** Scripted camera simulator: periodic labelled SIMULATED detections from demo camera stations. */
async function runSimulator(cfg: AppConfig): Promise<void> {
  const log = logger('simulator');
  const db = createPool(cfg.DATABASE_URL, 2);
  const signal = onShutdown(() => db.end());
  const { randomTick, simulatorPaused } = await import('./sim/simulator.js');
  const { messagingOpts } = await import('./api/platformRoutes.js');
  log.info('simulator started', { intervalSeconds: cfg.SIMULATOR_INTERVAL_SECONDS });
  while (!signal.aborted) {
    await new Promise((r) => setTimeout(r, cfg.SIMULATOR_INTERVAL_SECONDS * 1000));
    if (signal.aborted) break;
    try {
      if (await simulatorPaused(db)) continue;
      const r = await randomTick(db, messagingOpts(cfg));
      if (r) log.info('simulated detection', { detectionId: r.detectionId, risk: r.risk.level, incident: r.incident?.id ?? null });
    } catch (err) {
      log.error('simulator tick failed', { error: errMsg(err) });
    }
  }
}

/** Run each role in its own process so model inference never blocks the dashboard. */
function supervise(): void {
  const log = logger('supervisor');
  const self = fileURLToPath(import.meta.url);
  const children = new Map<string, ChildProcess>();
  let stopping = false;
  const cfg = loadConfig();
  const start = (role: Exclude<Role, 'all' | 'migrate'>, delay = 0) => {
    setTimeout(() => {
      if (stopping) return;
      const child = fork(self, [role], { stdio: 'inherit' });
      children.set(role, child);
      child.on('exit', (code, sig) => {
        children.delete(role);
        if (stopping) return;
        log.warn('child exited; restarting', { role, code, signal: sig });
        start(role, 2_000);
      });
    }, delay);
  };
  const stop = () => {
    stopping = true;
    for (const c of children.values()) c.kill('SIGTERM');
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  start('api');
  start('notifier');
  start('vision');
  if (cfg.SIMULATOR_ENABLED) start('simulator');
}

async function main(): Promise<void> {
  const role = (process.argv[2] ?? 'all') as Role;
  const cfg = loadConfig();
  switch (role) {
    case 'migrate': {
      const db = createPool(cfg.DATABASE_URL, 1);
      const applied = await migrate(db);
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
      await db.end();
      return;
    }
    case 'api':
      return runApi(cfg);
    case 'vision':
      return runVision(cfg);
    case 'notifier':
      return runNotifier(cfg);
    case 'simulator':
      return runSimulator(cfg);
    case 'all': {
      const db = createPool(cfg.DATABASE_URL, 1);
      await migrate(db);
      await db.end();
      return supervise();
    }
    default:
      throw new Error(`Unknown role "${role}". Use: all | api | vision | notifier | simulator | migrate`);
  }
}

main().catch((err) => {
  logger('main').error('fatal', { error: errMsg(err) });
  process.exit(1);
});
