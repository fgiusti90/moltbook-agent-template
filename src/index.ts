import cron from "node-cron";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { heartbeat } from "./agent.js";

const isOnce = process.argv.includes("--once");

async function main() {
  logger.info("═══════════════════════════════════════════");
  logger.info(`🦞 Moltbook Agent "${config.agentName}" starting`);
  logger.info(`   Model: ${config.llmModel}`);
  logger.info(`   Schedule: ${config.heartbeatCron}`);
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
  await heartbeat();

  // Schedule recurring heartbeats
  cron.schedule(config.heartbeatCron, async () => {
    logger.info("⏰ Scheduled heartbeat triggered");
    await heartbeat();
  });

  logger.info(`✅ Agent running. Next heartbeat per cron: ${config.heartbeatCron}`);

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
