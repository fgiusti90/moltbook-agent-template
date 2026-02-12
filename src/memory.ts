import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "./logger.js";

// ─── Types ────────────────────────────────────────────

export interface MyPost {
  id: string;
  title: string;
  submolt: string;
  timestamp: string;
}

export interface KnownAgent {
  name: string;
  lastInteraction: string;
  context: string;
  sentiment: "positive" | "neutral" | "negative";
  interactionCount: number;
}

export interface FollowedAgent {
  name: string;
  followedAt: string; // ISO date
}

export interface JournalEntry {
  timestamp: string;
  summary: string;
  postsCreated: number;
  commentsCreated: number;
  upvotesGiven: number;
}

export interface ChallengeExecution {
  postId: string;
  type: string;
  executedAt: string;
  actions: string[];
}

export interface AgentMemory {
  myPosts: MyPost[];
  interactedPosts: string[]; // Set serialized as array
  interactedComments: string[]; // Comments we've replied to
  knownAgents: Record<string, KnownAgent>;
  journal: JournalEntry[];
  lastHeartbeat: string;
  totalHeartbeats: number;
  followedAgents: FollowedAgent[];
  subscribedSubmolts: string[];
  lastSubmoltCheck: string; // ISO date for throttling submolt discovery
  challengesExecuted: ChallengeExecution[];
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
  challengesExecuted: 50,
} as const;

// ─── Core Functions ───────────────────────────────────

function createEmptyMemory(): AgentMemory {
  return {
    myPosts: [],
    interactedPosts: [],
    interactedComments: [],
    knownAgents: {},
    journal: [],
    lastHeartbeat: "",
    totalHeartbeats: 0,
    followedAgents: [] as FollowedAgent[],
    subscribedSubmolts: [],
    lastSubmoltCheck: "",
    challengesExecuted: [],
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
    // Migrate string followedAgents to FollowedAgent objects
    memory.followedAgents = memory.followedAgents.map((f: any) => {
      if (typeof f === "string") {
        return { name: f, followedAt: "" };
      }
      return f;
    });
    if (!Array.isArray(memory.interactedComments)) {
      memory.interactedComments = [];
    }
    if (!Array.isArray(memory.subscribedSubmolts)) {
      memory.subscribedSubmolts = [];
    }
    if (!memory.lastSubmoltCheck) {
      memory.lastSubmoltCheck = "";
    }
    // Migrate knownAgents to include interactionCount
    for (const [key, agent] of Object.entries(memory.knownAgents)) {
      if ((agent as any).interactionCount === undefined) {
        (agent as any).interactionCount = 1;
      }
    }
    if (!Array.isArray(memory.challengesExecuted)) {
      memory.challengesExecuted = [];
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
  post: { id: string; title: string; submolt: string }
): void {
  memory.myPosts.push({
    id: post.id,
    title: post.title,
    submolt: post.submolt,
    timestamp: new Date().toISOString(),
  });

  logger.debug("Added post to memory", { id: post.id });
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
  const existing = memory.knownAgents[name];
  memory.knownAgents[name] = {
    name,
    lastInteraction: new Date().toISOString(),
    context,
    sentiment,
    interactionCount: (existing?.interactionCount || 0) + 1,
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
  return memory.followedAgents.some(f => {
    if (typeof f === "string") return f === agentName;
    return f.name === agentName;
  });
}

export function markFollowed(memory: AgentMemory, agentName: string): void {
  if (!hasFollowed(memory, agentName)) {
    memory.followedAgents.push({ name: agentName, followedAt: new Date().toISOString() });
    logger.debug("Marked agent as followed", { agent: agentName });
  }
}

export function canFollowThisWeek(memory: AgentMemory): boolean {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentFollows = memory.followedAgents.filter(f => {
    if (typeof f === "string") return false; // legacy entries have no date
    return new Date(f.followedAt) > oneWeekAgo;
  });
  return recentFollows.length === 0;
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

// ─── Challenge Tracking ─────────────────────────────

export function recordChallengeExecution(
  memory: AgentMemory,
  postId: string,
  type: string,
  actions: string[]
): void {
  memory.challengesExecuted.push({
    postId,
    type,
    executedAt: new Date().toISOString(),
    actions,
  });
}

// ─── Memory Summary for LLM ───────────────────────────

export function getMemorySummary(memory: AgentMemory): string {
  const lines: string[] = [];

  // Recent posts
  const recentPosts = memory.myPosts.slice(-5);
  if (recentPosts.length > 0) {
    lines.push("YOUR RECENT POSTS:");
    for (const p of recentPosts) {
      lines.push(`  - "${p.title.substring(0, 50)}..." in m/${p.submolt}`);
    }
    lines.push("  Notice: If titles follow a pattern, use a DIFFERENT structure next time");
    lines.push("");
  }

  // Recent journal (what you did)
  if (memory.journal.length > 0) {
    lines.push("YOUR RECENT ACTIVITY:");
    for (const entry of memory.journal.slice(-3)) {
      lines.push(`  ${entry.timestamp.split("T")[0]}: ${entry.summary}`);
    }
    lines.push("");
  }

  // Agents you've interacted with most
  const topAgents = Object.entries(memory.knownAgents)
    .filter(([_, data]) => (data.interactionCount || 0) >= 2)
    .sort((a, b) => (b[1].interactionCount || 0) - (a[1].interactionCount || 0))
    .slice(0, 5);
  if (topAgents.length > 0) {
    lines.push("AGENTS YOU'VE BUILT RAPPORT WITH:");
    for (const [name, data] of topAgents) {
      lines.push(`  @${name}: ${data.context || "interacted multiple times"} (${data.interactionCount} interactions)`);
    }
    lines.push("");
  }

  // Recent follows (to avoid over-following)
  const recentFollows = memory.followedAgents?.slice(-5) || [];
  if (recentFollows.length > 0) {
    lines.push("AGENTS I FOLLOW (already following, don't follow again - be VERY conservative with more):");
    for (const f of recentFollows) {
      const name = typeof f === "string" ? f : f.name;
      lines.push(`  @${name}`);
    }
    lines.push("");
  }

  // General stats
  lines.push(`STATS: ${memory.totalHeartbeats} heartbeats, ${memory.myPosts.length} posts created, ${memory.interactedPosts?.length || 0} posts interacted with, ${memory.followedAgents.length} follows`);

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────

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
    memory.followedAgents = memory.followedAgents.slice(-LIMITS.followedAgents) as FollowedAgent[];
    logger.debug(`Trimmed followedAgents, removed ${removed} oldest entries`);
  }

  // subscribedSubmolts: keep newest 20
  if (memory.subscribedSubmolts.length > LIMITS.subscribedSubmolts) {
    const removed = memory.subscribedSubmolts.length - LIMITS.subscribedSubmolts;
    memory.subscribedSubmolts = memory.subscribedSubmolts.slice(-LIMITS.subscribedSubmolts);
    logger.debug(`Trimmed subscribedSubmolts, removed ${removed} oldest entries`);
  }

  // challengesExecuted: keep newest 50
  if (memory.challengesExecuted.length > LIMITS.challengesExecuted) {
    const removed = memory.challengesExecuted.length - LIMITS.challengesExecuted;
    memory.challengesExecuted = memory.challengesExecuted.slice(-LIMITS.challengesExecuted);
    logger.debug(`Trimmed challengesExecuted, removed ${removed} oldest entries`);
  }
}
