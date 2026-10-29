import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadApiEnvFiles } from "./env-files.js";
import { getConfig, isPostgresDbType, resolveQueueSettings } from "./config";
import { createStore } from "./db/create-store";
import { createApp } from "./app";
import { seedWorkflowsIfEmpty, seedTemplatesIfEmpty } from "./services/seed-service";
import { SecretService } from "./services/secret-service";
import { AuthService } from "./services/auth-service";
import { SchedulerService } from "./services/scheduler-service";
import { QueueService } from "./services/queue-service";
import { TriggerService } from "./services/trigger-service";
import { AppLifecycle } from "./services/app-lifecycle.js";

const currentFilePath = fileURLToPath(import.meta.url);
const apiRoot = path.resolve(path.dirname(currentFilePath), "..");
const workspaceRoot = path.resolve(apiRoot, "..", "..");

// The same .env rule db:copy follows (env-files.ts): the repo root's .env without override, then apps/api/.env with it.
loadApiEnvFiles(apiRoot);

async function bootstrap() {
  const config = getConfig();
  // DB_SQLITE_PATH (relative to the working directory) picks another SQLite file; unset, the default is as before.
  const dbPath = process.env.DB_SQLITE_PATH?.trim() ? path.resolve(process.env.DB_SQLITE_PATH.trim()) : path.resolve(apiRoot, "data", "orchestrator.db");
  const store = await createStore({ dbFilePath: dbPath });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);

  const bootstrapUser = await authService.bootstrapAdmin(config.BOOTSTRAP_ADMIN_EMAIL, config.BOOTSTRAP_ADMIN_PASSWORD);
  if (bootstrapUser) {
    // eslint-disable-next-line no-console
    console.log(`Bootstrapped admin user '${bootstrapUser.email}'`);
  }

  if (config.SEED_SAMPLE_WORKFLOWS) {
    await seedWorkflowsIfEmpty(store, workspaceRoot);
  }
  await seedTemplatesIfEmpty(store, workspaceRoot);

  // Ensure the default project exists and backfill any legacy rows that predate Phase 4.2.
  await store.ensureDefaultProject();

  const runsBackgroundWorkers = config.WORKER_MODE === "all" || config.WORKER_MODE === "worker";
  const schedulerService = runsBackgroundWorkers ? new SchedulerService(store) : undefined;
  const queueSettings = resolveQueueSettings(config, { clusterMode: isPostgresDbType(process.env.DB_TYPE) && config.HA_ENABLED });
  const queueService = runsBackgroundWorkers
    ? new QueueService(store, {
        concurrency: queueSettings.concurrency,
        pollIntervalMs: queueSettings.pollIntervalMs,
        stuckJobTimeoutMs: config.QUEUE_STUCK_JOB_TIMEOUT_MS,
        executionTimeoutMs: config.WORKFLOW_EXECUTION_TIMEOUT_MS,
        maxPending: queueSettings.maxPending,
        maxRssMb: queueSettings.maxRssMb,
        maxEventLoopLagMs: queueSettings.maxEventLoopLagMs
      })
    : undefined;
  const triggerService = runsBackgroundWorkers ? new TriggerService(store) : undefined;
  const lifecycle = new AppLifecycle();
  const app = await createApp(
    config,
    store,
    secretService,
    authService,
    schedulerService,
    queueService,
    triggerService,
    { lifecycle }
  );
  // scheduler/trigger initialize() is called from the leader-election
  // onBecomeLeader callback inside createApp so only one replica at a time
  // fires cron/trigger work. When HA is disabled, the callback fires
  // immediately during `leaderElection.start()` at onReady.
  await app.listen({
    host: config.API_HOST,
    port: config.API_PORT
  });

  app.log.info(
    `API listening on http://${config.API_HOST}:${config.API_PORT} (worker_mode=${config.WORKER_MODE}, ha=${config.HA_ENABLED})`
  );

  // Phase 13.1 — graceful shutdown, in cluster mode or when SHUTDOWN_DRAIN_MS is set (otherwise SIGTERM/SIGINT keep
  // Node's default: the process exits at once). /ready turns 503, no new queue jobs are claimed, leadership is handed
  // on, running jobs get SHUTDOWN_DRAIN_MS to finish and the rest are given back to the queue; then the app (and the
  // store) closes. A second signal, or a drain that overruns its budget by more than the close grace, exits at once.
  if (queueSettings.drainOnSignal) {
    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        app.log.warn({ signal }, "Second shutdown signal: exiting now");
        process.exit(1);
      }
      shuttingDown = true;
      app.log.info({ signal, drainMs: queueSettings.shutdownDrainMs }, "Shutting down: draining");
      const hardStop = setTimeout(() => {
        app.log.error({ signal }, "Shutdown did not finish in time: exiting");
        process.exit(1);
      }, queueSettings.shutdownDrainMs + SHUTDOWN_CLOSE_GRACE_MS);
      hardStop.unref();
      let exitCode = 0;
      try {
        await lifecycle.drain(queueSettings.shutdownDrainMs);
        // Closing the app closes the store too (its onClose hook).
        await app.close();
      } catch (error) {
        exitCode = 1;
        app.log.error({ err: error instanceof Error ? error.message : String(error) }, "Shutdown failed");
      }
      clearTimeout(hardStop);
      process.exit(exitCode);
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, (received) => {
        void shutdown(received);
      });
    }
  }
}

/** Time allowed after the drain budget for closing the app and the database (20 s + 5 s fits a 30 s grace period). */
const SHUTDOWN_CLOSE_GRACE_MS = 5_000;

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
