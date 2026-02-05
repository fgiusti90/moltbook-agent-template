import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

// Ensure logs directory exists
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {}

function getLogFile(): string {
  const date = new Date().toISOString().split("T")[0];
  return join(LOG_DIR, `agent-${date}.log`);
}

function formatMessage(level: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (data !== undefined) {
    return `${base} | ${JSON.stringify(data)}`;
  }
  return base;
}

function shouldLog(level: keyof typeof LOG_LEVELS): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel];
}

function write(level: keyof typeof LOG_LEVELS, message: string, data?: unknown) {
  if (!shouldLog(level)) return;

  const formatted = formatMessage(level, message, data);

  // Console output
  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(formatted);

  // File output
  try {
    appendFileSync(getLogFile(), formatted + "\n");
  } catch (err) {
    console.error("Failed to write log:", err);
  }
}

export const logger = {
  debug: (msg: string, data?: unknown) => write("debug", msg, data),
  info: (msg: string, data?: unknown) => write("info", msg, data),
  warn: (msg: string, data?: unknown) => write("warn", msg, data),
  error: (msg: string, data?: unknown) => write("error", msg, data),
};
