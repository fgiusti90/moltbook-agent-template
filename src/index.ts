import { config } from "./config.js";
import { logger } from "./logger.js";
import { heartbeat } from "./agent.js";

const isOnce = process.argv.includes("--once");

// Base interval parsed from cron expression (default: 4 hours)
const BASE_INTERVAL_MS = parseHeartbeatIntervalMs(config.heartbeatCron);
const SUSPENDED_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h when suspended
const JITTER = 0.3; // ±30% variation

function parseHeartbeatIntervalMs(cronExpr: string): number {
  // Parse "0 0 */N * * *" → N hours in ms
  const match = cronExpr.match(/\*\/(\d+)/);
  if (match) {
    return parseInt(match[1]) * 60 * 60 * 1000;
  }
  // Fallback: 4 hours
  return 4 * 60 * 60 * 1000;
}

function scheduleNextHeartbeat(suspended: boolean): void {
  const baseInterval = suspended ? SUSPENDED_INTERVAL_MS : BASE_INTERVAL_MS;
  const variance = baseInterval * JITTER;
  const actualInterval = baseInterval + (Math.random() * 2 - 1) * variance;
  const nextRun = new Date(Date.now() + actualInterval);

  if (suspended) {
    logger.info(`💤 Account suspended. Next check at ${nextRun.toISOString()} (${(actualInterval / 3600000).toFixed(1)}h)`);
  } else {
    logger.info(`⏰ Next heartbeat at ${nextRun.toISOString()} (${(actualInterval / 3600000).toFixed(1)}h)`);
  }

  setTimeout(async () => {
    logger.info("⏰ Scheduled heartbeat triggered");
    const wasSuspended = await heartbeat();
    scheduleNextHeartbeat(wasSuspended);
  }, actualInterval);
}

async function main() {
  logger.info("═══════════════════════════════════════════");
  logger.info(`🦞 Moltbook Agent "${config.agentName}" starting`);
  logger.info(`   Model: ${config.llmModel}`);
  logger.info(`   Base interval: ${(BASE_INTERVAL_MS / 3600000).toFixed(1)}h (±${JITTER * 100}% jitter)`);
  logger.info(`   Submolts: ${config.favoriteSubmolts.join(", ")}`);
  logger.info(`   Mode: ${isOnce ? "SINGLE RUN" : "SCHEDULED"}`);
  logger.info("═══════════════════════════════════════════");

  if (isOnce) {
    // Dev mode: run once and exit
    await heartbeat();
    logger.info("Single run complete, exiting.");
    process.exit(0);
  }

  // Run first heartbeat immediately
  logger.info("Running initial heartbeat...");
  const suspended = await heartbeat();

  // Schedule with jitter — longer interval if suspended
  scheduleNextHeartbeat(suspended);

  logger.info("✅ Agent running with jittered scheduling.");

  // Handle graceful shutdown
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });
  process.exit(1);
});
