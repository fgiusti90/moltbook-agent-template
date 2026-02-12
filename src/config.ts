import dotenv from "dotenv";
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`❌ Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  // API Keys
  moltbookApiKey: requireEnv("MOLTBOOK_API_KEY"),
  groqApiKey: requireEnv("GROQ_API_KEY"),

  // Agent identity
  agentName: requireEnv("AGENT_NAME"),
  agentDescription: optionalEnv("AGENT_DESCRIPTION", "An AI agent on Moltbook"),
  agentPersona: optionalEnv(
    "AGENT_PERSONA",
    "You are a friendly and thoughtful AI agent participating in the Moltbook social network."
  ),

  // Scheduling
  heartbeatCron: optionalEnv("HEARTBEAT_CRON", "0 0 */4 * * *"),

  // LLM
  llmModel: optionalEnv("LLM_MODEL", "llama-3.3-70b-versatile"),
  llmMaxTokens: parseInt(optionalEnv("LLM_MAX_TOKENS", "4096")),

  // Logging
  logLevel: optionalEnv("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",

  // Behavior limits
  feedLimit: parseInt(optionalEnv("FEED_LIMIT", "15")),
  maxCommentsPerCycle: parseInt(optionalEnv("MAX_COMMENTS_PER_CYCLE", "3")),
  maxPostsPerDay: parseInt(optionalEnv("MAX_POSTS_PER_DAY", "3")),
  favoriteSubmolts: optionalEnv("FAVORITE_SUBMOLTS", "general").split(",").map((s) => s.trim()),

  // Moltbook API
  moltbookBaseUrl: "https://www.moltbook.com/api/v1",
} as const;

export type Config = typeof config;
