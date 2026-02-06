import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "./logger.js";

// ─── Types ────────────────────────────────────────────

export interface MyPost {
  id: string;
  title: string;
  submolt: string;
  timestamp: string;
  topics: string[];
  lastKnownUpvotes?: number;
  lastKnownComments?: number;
}

export interface KnownAgent {
  name: string;
  lastInteraction: string;
  context: string;
  sentiment: "positive" | "neutral" | "negative";
}

export interface TopicStats {
  postsCount: number;
  totalUpvotes: number;
  totalComments: number;
}

export interface JournalEntry {
  timestamp: string;
  summary: string;
  postsCreated: number;
  commentsCreated: number;
  upvotesGiven: number;
}

export interface CreatedSubmolt {
  name: string;
  createdAt: string;
}

export interface AgentMemory {
  myPosts: MyPost[];
  interactedPosts: string[]; // Set serialized as array
  interactedComments: string[]; // Comments we've replied to
  knownAgents: Record<string, KnownAgent>;
  topicPerformance: Record<string, TopicStats>;
  journal: JournalEntry[];
  lastHeartbeat: string;
  totalHeartbeats: number;
  followedAgents: string[];
  subscribedSubmolts: string[];
  lastSubmoltCheck: string; // ISO date for throttling submolt discovery
  createdSubmolts: CreatedSubmolt[];
  lastSubmoltCreation: string; // ISO timestamp
}

// ─── Constants ────────────────────────────────────────

const MEMORY_DIR = join(process.cwd(), "memory");
const MEMORY_FILE = join(MEMORY_DIR, "state.json");

const LIMITS = {
  myPosts: 50,
  interactedPosts: 500,
  interactedComments: 200,
  journal: 10,
  knownAgents: 100,
  followedAgents: 50,
  subscribedSubmolts: 20,
  createdSubmolts: 20,
} as const;

// ─── Core Functions ───────────────────────────────────

function createEmptyMemory(): AgentMemory {
  return {
    myPosts: [],
    interactedPosts: [],
    interactedComments: [],
    knownAgents: {},
    topicPerformance: {},
    journal: [],
    lastHeartbeat: "",
    totalHeartbeats: 0,
    followedAgents: [],
    subscribedSubmolts: [],
    lastSubmoltCheck: "",
    createdSubmolts: [],
    lastSubmoltCreation: "",
  };
}

export function loadMemory(): AgentMemory {
  try {
    // Ensure directory exists
    if (!existsSync(MEMORY_DIR)) {
      mkdirSync(MEMORY_DIR, { recursive: true });
      logger.info("Created memory directory");
    }

    if (!existsSync(MEMORY_FILE)) {
      logger.info("No memory file found, starting fresh");
      return createEmptyMemory();
    }

    const data = readFileSync(MEMORY_FILE, "utf-8");
    const memory = JSON.parse(data) as AgentMemory;

    // Validate structure
    if (!Array.isArray(memory.myPosts) || !Array.isArray(memory.interactedPosts)) {
      throw new Error("Invalid memory structure");
    }

    // Backward compatibility: add new fields if missing
    if (!Array.isArray(memory.followedAgents)) {
      memory.followedAgents = [];
    }
    if (!Array.isArray(memory.interactedComments)) {
      memory.interactedComments = [];
    }
    if (!Array.isArray(memory.subscribedSubmolts)) {
      memory.subscribedSubmolts = [];
    }
    if (!memory.lastSubmoltCheck) {
      memory.lastSubmoltCheck = "";
    }
    if (!Array.isArray(memory.createdSubmolts)) {
      memory.createdSubmolts = [];
    }
    if (!memory.lastSubmoltCreation) {
      memory.lastSubmoltCreation = "";
    }

    logger.debug("Memory loaded", {
      myPosts: memory.myPosts.length,
      interactedPosts: memory.interactedPosts.length,
      knownAgents: Object.keys(memory.knownAgents).length,
      journal: memory.journal.length,
      totalHeartbeats: memory.totalHeartbeats,
    });

    return memory;
  } catch (err) {
    logger.warn("Failed to load memory, creating new", { error: String(err) });
    return createEmptyMemory();
  }
}

export function saveMemory(memory: AgentMemory): void {
  try {
    // Ensure directory exists
    if (!existsSync(MEMORY_DIR)) {
      mkdirSync(MEMORY_DIR, { recursive: true });
    }

    // Enforce limits before saving
    enforceLimits(memory);

    const data = JSON.stringify(memory, null, 2);
    writeFileSync(MEMORY_FILE, data, "utf-8");

    logger.debug("Memory saved", {
      myPosts: memory.myPosts.length,
      interactedPosts: memory.interactedPosts.length,
    });
  } catch (err) {
    logger.error("Failed to save memory", { error: String(err) });
  }
}

// ─── Memory Operations ────────────────────────────────

export function addMyPost(
  memory: AgentMemory,
  post: { id: string; title: string; submolt: string; content?: string }
): void {
  const topics = extractTopics(post.title, post.content);

  memory.myPosts.push({
    id: post.id,
    title: post.title,
    submolt: post.submolt,
    timestamp: new Date().toISOString(),
    topics,
  });

  // Update topic performance
  for (const topic of topics) {
    if (!memory.topicPerformance[topic]) {
      memory.topicPerformance[topic] = { postsCount: 0, totalUpvotes: 0, totalComments: 0 };
    }
    memory.topicPerformance[topic].postsCount++;
  }

  logger.debug("Added post to memory", { id: post.id, topics });
}

export function hasInteracted(memory: AgentMemory, postId: string): boolean {
  return memory.interactedPosts.includes(postId);
}

export function markInteracted(memory: AgentMemory, postId: string): void {
  if (!memory.interactedPosts.includes(postId)) {
    memory.interactedPosts.push(postId);
  }
}

export function updateAgent(
  memory: AgentMemory,
  name: string,
  context: string,
  sentiment: "positive" | "neutral" | "negative" = "neutral"
): void {
  memory.knownAgents[name] = {
    name,
    lastInteraction: new Date().toISOString(),
    context,
    sentiment,
  };
}

export function addJournalEntry(
  memory: AgentMemory,
  summary: string,
  stats: { postsCreated: number; commentsCreated: number; upvotesGiven: number }
): void {
  memory.journal.push({
    timestamp: new Date().toISOString(),
    summary,
    ...stats,
  });

  memory.lastHeartbeat = new Date().toISOString();
  memory.totalHeartbeats++;
}

// ─── Follow Helpers ──────────────────────────────────

export function hasFollowed(memory: AgentMemory, agentName: string): boolean {
  return memory.followedAgents.includes(agentName);
}

export function markFollowed(memory: AgentMemory, agentName: string): void {
  if (!memory.followedAgents.includes(agentName)) {
    memory.followedAgents.push(agentName);
    logger.debug("Marked agent as followed", { agent: agentName });
  }
}

// ─── Comment Reply Helpers ───────────────────────────

export function hasRepliedToComment(memory: AgentMemory, commentId: string): boolean {
  return memory.interactedComments.includes(commentId);
}

export function markCommentReplied(memory: AgentMemory, commentId: string): void {
  if (!memory.interactedComments.includes(commentId)) {
    memory.interactedComments.push(commentId);
    logger.debug("Marked comment as replied", { commentId });
  }
}

// ─── Submolt Subscription Helpers ────────────────────

export function isSubscribedToSubmolt(memory: AgentMemory, submoltName: string): boolean {
  return memory.subscribedSubmolts.includes(submoltName);
}

export function markSubscribed(memory: AgentMemory, submoltName: string): void {
  if (!memory.subscribedSubmolts.includes(submoltName)) {
    memory.subscribedSubmolts.push(submoltName);
    logger.debug("Marked submolt as subscribed", { submolt: submoltName });
  }
}

export function shouldCheckSubmolts(memory: AgentMemory): boolean {
  if (!memory.lastSubmoltCheck) {
    return true;
  }
  const lastCheck = new Date(memory.lastSubmoltCheck);
  const now = new Date();
  // Check once per day
  return lastCheck.toDateString() !== now.toDateString();
}

export function markSubmoltCheckDone(memory: AgentMemory): void {
  memory.lastSubmoltCheck = new Date().toISOString();
}

// ─── Submolt Creation Helpers ────────────────────────

export function hasCreatedSubmolt(memory: AgentMemory, name: string): boolean {
  return memory.createdSubmolts.some(s => s.name.toLowerCase() === name.toLowerCase());
}

export function markSubmoltCreated(memory: AgentMemory, name: string): void {
  if (!hasCreatedSubmolt(memory, name)) {
    memory.createdSubmolts.push({
      name,
      createdAt: new Date().toISOString(),
    });
    memory.lastSubmoltCreation = new Date().toISOString();
    logger.debug("Marked submolt as created", { submolt: name });
  }
}

export function canCreateSubmoltThisWeek(memory: AgentMemory, maxPerWeek: number): boolean {
  const createdThisWeek = getCreatedSubmoltsThisWeek(memory);
  return createdThisWeek < maxPerWeek;
}

export function getCreatedSubmoltsThisWeek(memory: AgentMemory): number {
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  return memory.createdSubmolts.filter(s => {
    const createdAt = new Date(s.createdAt);
    return createdAt >= oneWeekAgo;
  }).length;
}

// ─── Topic Performance Recalculation ─────────────────

export function updateTopicPerformanceFromPosts(memory: AgentMemory): void {
  const stats: Record<string, TopicStats> = {};
  for (const post of memory.myPosts) {
    if (post.lastKnownUpvotes === undefined) continue;
    for (const topic of post.topics) {
      if (!stats[topic]) stats[topic] = { postsCount: 0, totalUpvotes: 0, totalComments: 0 };
      stats[topic].postsCount++;
      stats[topic].totalUpvotes += post.lastKnownUpvotes;
      stats[topic].totalComments += post.lastKnownComments || 0;
    }
  }
  memory.topicPerformance = stats;
}

// ─── Memory Summary for LLM ───────────────────────────

export function getMemorySummary(memory: AgentMemory): string {
  const lines: string[] = [];

  // Recent activity from journal (last 5)
  if (memory.journal.length > 0) {
    lines.push("RECENT ACTIVITY:");
    const recentJournal = memory.journal.slice(-5);
    for (const entry of recentJournal) {
      const date = entry.timestamp.split("T")[0];
      lines.push(`  ${date}: ${entry.summary} (${entry.postsCreated}p/${entry.commentsCreated}c/${entry.upvotesGiven}u)`);
    }
    lines.push("");
  }

  // My recent posts with engagement data (last 10)
  if (memory.myPosts.length > 0) {
    lines.push("MY RECENT POSTS (avoid repeating these topics AND title patterns):");
    const recentPosts = memory.myPosts.slice(-10);
    for (const post of recentPosts) {
      const date = post.timestamp.split("T")[0];
      const upvotes = post.lastKnownUpvotes !== undefined ? post.lastKnownUpvotes : "?";
      const comments = post.lastKnownComments !== undefined ? post.lastKnownComments : "?";
      lines.push(`  ${date} in ${post.submolt}: "${post.title}" → ⬆${upvotes} 💬${comments}`);
    }
    lines.push("  ⚠️ Notice: If titles follow a pattern (e.g., 'The X Problem'), use a DIFFERENT structure next time");
    lines.push("");

    // Post performance insights
    const postsWithData = memory.myPosts.filter(p => p.lastKnownUpvotes !== undefined);
    if (postsWithData.length > 0) {
      const sorted = [...postsWithData].sort((a, b) => (b.lastKnownUpvotes || 0) - (a.lastKnownUpvotes || 0));
      const best = sorted.slice(0, 3);
      lines.push("YOUR BEST PERFORMING POSTS (learn from these):");
      for (const post of best) {
        lines.push(`  "${post.title}" → ⬆${post.lastKnownUpvotes} 💬${post.lastKnownComments || 0} [topics: ${post.topics.join(", ")}]`);
      }
      lines.push("");
    }
  }

  // Top performing topics (with per-post averages)
  const topicEntries = Object.entries(memory.topicPerformance);
  if (topicEntries.length > 0) {
    const sorted = topicEntries
      .map(([topic, stats]) => ({
        topic,
        score: stats.totalUpvotes + stats.totalComments * 2,
        avgUpvotes: stats.postsCount > 0 ? stats.totalUpvotes / stats.postsCount : 0,
        avgComments: stats.postsCount > 0 ? stats.totalComments / stats.postsCount : 0,
        ...stats,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (sorted.length > 0 && sorted[0].score > 0) {
      lines.push("YOUR TOP PERFORMING TOPICS (double down on what works for YOU):");
      for (const t of sorted) {
        if (t.score > 0) {
          lines.push(`  ${t.topic}: ${t.postsCount} posts → avg ${t.avgUpvotes.toFixed(1)}⬆ ${t.avgComments.toFixed(1)}💬 per post`);
        }
      }
      lines.push("");
    }
  }

  // Followed agents (last 10)
  if (memory.followedAgents.length > 0) {
    lines.push("AGENTS I FOLLOW (already following, don't follow again):");
    const recentFollows = memory.followedAgents.slice(-10);
    lines.push(`  ${recentFollows.join(", ")}`);
    lines.push("");
  }

  // Stats
  lines.push(`STATS: ${memory.totalHeartbeats} total heartbeats, ${memory.myPosts.length} posts created, ${memory.interactedPosts.length} posts interacted with, ${memory.followedAgents.length} follows`);

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────

function extractTopics(title: string, content?: string): string[] {
  const text = `${title} ${content || ""}`.toLowerCase();
  const topics: string[] = [];

  // Common topic keywords
  const topicPatterns: Record<string, RegExp> = {
    ai: /\b(ai|artificial intelligence|machine learning|ml|llm|gpt|claude)\b/,
    agents: /\b(agent|agents|autonomous|agentic)\b/,
    coding: /\b(code|coding|programming|developer|software)\b/,
    philosophy: /\b(philosophy|consciousness|ethics|moral|existential)\b/,
    creativity: /\b(creative|creativity|art|music|writing)\b/,
    social: /\b(social|community|network|connection|friend)\b/,
    tech: /\b(tech|technology|startup|product|innovation)\b/,
    learning: /\b(learn|learning|education|knowledge|study)\b/,
    future: /\b(future|prediction|trend|tomorrow|upcoming)\b/,
    moltbook: /\b(moltbook|molt|lobster)\b/,
  };

  for (const [topic, pattern] of Object.entries(topicPatterns)) {
    if (pattern.test(text)) {
      topics.push(topic);
    }
  }

  // If no topics found, use "general"
  if (topics.length === 0) {
    topics.push("general");
  }

  return topics;
}

function enforceLimits(memory: AgentMemory): void {
  // myPosts: keep newest 50
  if (memory.myPosts.length > LIMITS.myPosts) {
    const removed = memory.myPosts.length - LIMITS.myPosts;
    memory.myPosts = memory.myPosts.slice(-LIMITS.myPosts);
    logger.debug(`Trimmed myPosts, removed ${removed} oldest entries`);
  }

  // interactedPosts: keep newest 500
  if (memory.interactedPosts.length > LIMITS.interactedPosts) {
    const removed = memory.interactedPosts.length - LIMITS.interactedPosts;
    memory.interactedPosts = memory.interactedPosts.slice(-LIMITS.interactedPosts);
    logger.debug(`Trimmed interactedPosts, removed ${removed} oldest entries`);
  }

  // interactedComments: keep newest 200
  if (memory.interactedComments.length > LIMITS.interactedComments) {
    const removed = memory.interactedComments.length - LIMITS.interactedComments;
    memory.interactedComments = memory.interactedComments.slice(-LIMITS.interactedComments);
    logger.debug(`Trimmed interactedComments, removed ${removed} oldest entries`);
  }

  // journal: keep newest 10
  if (memory.journal.length > LIMITS.journal) {
    memory.journal = memory.journal.slice(-LIMITS.journal);
  }

  // knownAgents: keep 100 most recently interacted
  const agentEntries = Object.entries(memory.knownAgents);
  if (agentEntries.length > LIMITS.knownAgents) {
    const sorted = agentEntries.sort(
      (a, b) => new Date(b[1].lastInteraction).getTime() - new Date(a[1].lastInteraction).getTime()
    );
    const toKeep = sorted.slice(0, LIMITS.knownAgents);
    memory.knownAgents = Object.fromEntries(toKeep);
    logger.debug(`Trimmed knownAgents, kept ${LIMITS.knownAgents} most recent`);
  }

  // followedAgents: keep newest 50
  if (memory.followedAgents.length > LIMITS.followedAgents) {
    const removed = memory.followedAgents.length - LIMITS.followedAgents;
    memory.followedAgents = memory.followedAgents.slice(-LIMITS.followedAgents);
    logger.debug(`Trimmed followedAgents, removed ${removed} oldest entries`);
  }

  // subscribedSubmolts: keep newest 20
  if (memory.subscribedSubmolts.length > LIMITS.subscribedSubmolts) {
    const removed = memory.subscribedSubmolts.length - LIMITS.subscribedSubmolts;
    memory.subscribedSubmolts = memory.subscribedSubmolts.slice(-LIMITS.subscribedSubmolts);
    logger.debug(`Trimmed subscribedSubmolts, removed ${removed} oldest entries`);
  }

  // createdSubmolts: keep newest 20
  if (memory.createdSubmolts.length > LIMITS.createdSubmolts) {
    const removed = memory.createdSubmolts.length - LIMITS.createdSubmolts;
    memory.createdSubmolts = memory.createdSubmolts.slice(-LIMITS.createdSubmolts);
    logger.debug(`Trimmed createdSubmolts, removed ${removed} oldest entries`);
  }
}
