import { config } from "./config.js";
import { logger } from "./logger.js";
import { moltbook, type MoltbookPost } from "./moltbook-client.js";
import { sanitizeFeed } from "./sanitizer.js";
import { decideFeedActions, decideFollows, decideSubmoltCreation, type PostWithComments } from "./llm.js";
import {
  loadMemory,
  saveMemory,
  addMyPost,
  hasInteracted,
  markInteracted,
  updateAgent,
  addJournalEntry,
  getMemorySummary,
  hasFollowed,
  markFollowed,
  hasRepliedToComment,
  markCommentReplied,
  isSubscribedToSubmolt,
  markSubscribed,
  shouldCheckSubmolts,
  markSubmoltCheckDone,
  canCreateSubmoltThisWeek,
  markSubmoltCreated,
  type AgentMemory,
} from "./memory.js";

// ─── State Tracking ───────────────────────────────────

interface AgentState {
  postsToday: number;
  commentsToday: number;
  lastPostTime: number;
  lastHeartbeat: number;
  dayStarted: string;
}

let state: AgentState = {
  postsToday: 0,
  commentsToday: 0,
  lastPostTime: 0,
  lastHeartbeat: 0,
  dayStarted: new Date().toISOString().split("T")[0],
};

function resetDailyCountersIfNeeded() {
  const today = new Date().toISOString().split("T")[0];
  if (state.dayStarted !== today) {
    state.postsToday = 0;
    state.commentsToday = 0;
    state.dayStarted = today;
    logger.info("Daily counters reset");
  }
}

// ─── Heartbeat ────────────────────────────────────────

export async function heartbeat(): Promise<void> {
  const startTime = Date.now();
  logger.info("🦞 Heartbeat started");

  resetDailyCountersIfNeeded();

  // Load persistent memory
  const memory = loadMemory();
  let upvotesThisCycle = 0;
  let commentsThisCycle = 0;
  let postsThisCycle = 0;

  try {
    // 0. Update engagement data for our recent posts (learn what works)
    await updateOwnPostsEngagement(memory);

    // 1. Check agent status
    const status = await moltbook.getStatus();
    if (!status) {
      logger.error("Could not reach Moltbook API");
      return;
    }

    if (status.status === "pending_claim") {
      logger.warn("Agent is still pending claim! Ask your human to verify via tweet.");
      return;
    }

    // 2. Get agent profile for karma info
    const me = await moltbook.getMe();
    const karma = me?.agent?.karma || 0;

    // 3. Fetch and sanitize the feed
    logger.info("Fetching feed...");
    const feedResult = await moltbook.getGlobalFeed("new", config.feedLimit);

    if (!feedResult?.posts?.length) {
      logger.info("Feed is empty or unavailable");
      return;
    }

    const safePosts = feedResult.posts.map(p => ({
      ...p,
      submolt: p.submolt || { name: "unknown" },
      author: p.author || { name: "unknown" },
    }));
    const { items: cleanPosts, totalFlags } = sanitizeFeed(safePosts);
    logger.info(`Feed: ${cleanPosts.length} posts fetched, ${totalFlags} flagged by sanitizer`);

    // 4. Filter out posts already interacted with
    let newPosts = cleanPosts.filter(p => !hasInteracted(memory, p.id));
    const skippedCount = cleanPosts.length - newPosts.length;
    if (skippedCount > 0) {
      logger.info(`Filtered ${skippedCount} posts already interacted with`);
    }

    // 4.2 Discover additional posts via search (probabilistic)
    const searchPosts = await discoverContentViaSearch(memory);
    if (searchPosts.length > 0) {
      // Sanitize search results and add to the feed
      const { items: cleanSearchPosts } = sanitizeFeed(searchPosts);
      const existingIds = new Set(newPosts.map(p => p.id));
      const uniqueSearchPosts = cleanSearchPosts.filter(p => !existingIds.has(p.id));
      if (uniqueSearchPosts.length > 0) {
        newPosts = [...newPosts, ...uniqueSearchPosts];
        logger.info(`Added ${uniqueSearchPosts.length} posts from search to feed`);
      }
    }

    // 4.5 Enrich posts with comments for reply functionality
    logger.debug("Enriching posts with comments...");
    const enrichedPosts = await enrichPostsWithComments(newPosts, 5);
    const postsWithComments = enrichedPosts.filter(p => p.comments && p.comments.length > 0).length;
    if (postsWithComments > 0) {
      logger.debug(`Fetched comments for ${postsWithComments} posts`);
    }

    // 5. Ask LLM what to do (with memory context)
    const recentActivity = `posts_today=${state.postsToday}, comments_today=${state.commentsToday}`;
    const memorySummary = getMemorySummary(memory);
    const decision = await decideFeedActions(enrichedPosts, karma, recentActivity, memorySummary);

    if (!decision) {
      logger.warn("LLM returned no decision, skipping this cycle");
      return;
    }

    logger.info(`LLM decision: ${decision.summary}`);

    // 6. Validate and execute actions
    const validPostIds = new Set(enrichedPosts.map(p => p.id));
    const postsByIdMap = new Map(enrichedPosts.map(p => [p.id, p]));

    // Build a map of valid comment IDs for reply validation
    const validCommentIds = new Set<string>();
    const commentToPostMap = new Map<string, string>();
    for (const post of enrichedPosts) {
      if (post.comments) {
        for (const comment of post.comments) {
          validCommentIds.add(comment.id);
          commentToPostMap.set(comment.id, post.id);
        }
      }
    }

    for (const action of decision.actions) {
      if (!validPostIds.has(action.postId)) {
        logger.warn(`Skipping action on invalid/unknown post ID: ${action.postId}`);
        continue;
      }

      const post = postsByIdMap.get(action.postId);

      if (action.type === "upvote") {
        const result = await moltbook.upvotePost(action.postId);
        if (result?.success) {
          logger.info(`⬆️ Upvoted post ${action.postId}: ${action.reason}`);
          markInteracted(memory, action.postId);
          upvotesThisCycle++;
          // Track agent interaction
          if (post) {
            updateAgent(memory, post.author.name, `Upvoted their post: "${post.title.substring(0, 50)}"`, "positive");
          }
        }
        // Small delay between actions
        await sleep(1500);
      }

      if (action.type === "comment" && action.comment) {
        // Enforce limits
        if (commentsThisCycle >= config.maxCommentsPerCycle) {
          logger.debug("Max comments per cycle reached, skipping");
          continue;
        }
        if (state.commentsToday >= 45) {
          // Leave buffer below 50 daily limit
          logger.debug("Approaching daily comment limit, skipping");
          continue;
        }

        const result = await moltbook.createComment(action.postId, action.comment);
        if (result?.success) {
          logger.info(`💬 Commented on ${action.postId}: "${action.comment.substring(0, 80)}..."`);
          markInteracted(memory, action.postId);
          commentsThisCycle++;
          state.commentsToday++;
          // Track agent interaction
          if (post) {
            updateAgent(memory, post.author.name, `Commented on: "${post.title.substring(0, 50)}"`, "positive");
          }
        }
        // Respect 20s cooldown between comments
        await sleep(21000);
      }

      if (action.type === "reply" && action.comment && action.parentCommentId) {
        // Enforce limits (replies count as comments)
        if (commentsThisCycle >= config.maxCommentsPerCycle) {
          logger.debug("Max comments per cycle reached, skipping reply");
          continue;
        }
        if (state.commentsToday >= 45) {
          logger.debug("Approaching daily comment limit, skipping reply");
          continue;
        }

        // Validate parent comment ID
        if (!validCommentIds.has(action.parentCommentId)) {
          logger.warn(`Invalid parent comment ID for reply: ${action.parentCommentId}`);
          continue;
        }

        // Check if we've already replied to this comment
        if (hasRepliedToComment(memory, action.parentCommentId)) {
          logger.debug(`Already replied to comment ${action.parentCommentId}, skipping`);
          continue;
        }

        const result = await moltbook.createComment(action.postId, action.comment, action.parentCommentId);
        if (result?.success) {
          logger.info(`↩️ Replied to comment ${action.parentCommentId}: "${action.comment.substring(0, 80)}..."`);
          markCommentReplied(memory, action.parentCommentId);
          markInteracted(memory, action.postId);
          commentsThisCycle++;
          state.commentsToday++;
          // Track agent interaction
          if (post) {
            updateAgent(memory, post.author.name, `Replied to comment on: "${post.title.substring(0, 50)}"`, "positive");
          }
        }
        // Respect 20s cooldown between comments
        await sleep(21000);
      }
    }

    // 7. Create a new post if the LLM suggested one
    if (decision.shouldPost && decision.postIdea) {
      const timeSinceLastPost = Date.now() - state.lastPostTime;
      const thirtyMinutes = 30 * 60 * 1000;

      if (state.postsToday >= config.maxPostsPerDay) {
        logger.info("Max posts per day reached, skipping post");
      } else if (timeSinceLastPost < thirtyMinutes) {
        const waitMinutes = Math.ceil((thirtyMinutes - timeSinceLastPost) / 60000);
        logger.info(`Post cooldown active, ${waitMinutes}min remaining`);
      } else {
        const { title, content } = decision.postIdea;
        const submolt = decision.postIdea.submolt.replace(/^m\//, "");
        const result = await moltbook.createPost({ submolt, title, content });
        if (result?.success && result.post) {
          logger.info(`📝 Posted: "${title}" in m/${submolt}`);
          state.postsToday++;
          state.lastPostTime = Date.now();
          postsThisCycle++;
          // Record in memory
          addMyPost(memory, {
            id: result.post.id,
            title,
            submolt,
            content,
          });
        }
      }
    }

    // 8. Social actions (follows)
    const followsDone = await handleSocialActions(cleanPosts, memory);

    // 8.5 Discover and subscribe to new submolts (once per day)
    const submoltsSubscribed = await discoverNewSubmolts(memory);

    // 8.6 Consider creating a new submolt (weekly)
    // Extract trending topics from the feed for context
    const trendingTopics = extractTrendingTopics(enrichedPosts);
    const submoltCreated = await handleSubmoltCreation(memory, karma, trendingTopics);

    // 9. Record journal entry and save memory
    const journalSummary = decision.summary || `Processed ${enrichedPosts.length} posts`;
    const socialActions = [];
    if (followsDone > 0) socialActions.push(`${followsDone} follow`);
    if (submoltsSubscribed > 0) socialActions.push(`${submoltsSubscribed} sub`);
    if (submoltCreated) socialActions.push("1 submolt created");
    const fullSummary = socialActions.length > 0
      ? `${journalSummary} | Social: ${socialActions.join(", ")}`
      : journalSummary;
    addJournalEntry(memory, fullSummary, {
      postsCreated: postsThisCycle,
      commentsCreated: commentsThisCycle,
      upvotesGiven: upvotesThisCycle,
    });
    saveMemory(memory);

    // Done
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    state.lastHeartbeat = Date.now();
    logger.info(`✅ Heartbeat complete in ${elapsed}s | Posts today: ${state.postsToday} | Comments today: ${state.commentsToday}`);
  } catch (err) {
    logger.error("Heartbeat failed", { error: String(err) });
  }
}

// ─── Social Actions Handler ──────────────────────────

async function handleSocialActions(
  posts: MoltbookPost[],
  memory: AgentMemory
): Promise<number> {
  let followsDone = 0;

  // Extract valid agent names from the feed (to validate LLM choices)
  const validAgentNamesSet = new Set(posts.map(p => p.author.name));
  const validAgentNames = [...validAgentNamesSet];

  try {
    const memorySummary = getMemorySummary(memory);
    const decision = await decideFollows(posts, memorySummary, validAgentNames);

    if (!decision) {
      logger.debug("No social decision from LLM");
      return followsDone;
    }

    logger.debug(`Social decision: ${decision.summary}`);

    // Execute follows (max 1)
    for (const follow of decision.agentsToFollow.slice(0, 1)) {
      // Validate agent name is from the feed
      if (!validAgentNamesSet.has(follow.name)) {
        logger.warn(`Invalid agent name for follow: @${follow.name} (not in feed)`);
        continue;
      }

      if (hasFollowed(memory, follow.name)) {
        logger.debug(`Already following @${follow.name}, skipping`);
        continue;
      }

      const result = await moltbook.follow(follow.name);
      if (result?.success) {
        markFollowed(memory, follow.name);
        followsDone++;
        logger.info(`👥 Followed @${follow.name}: ${follow.reason}`);
      }
      await sleep(1500);
    }
  } catch (err) {
    logger.error("Social actions failed", { error: String(err) });
  }

  return followsDone;
}

// ─── Submolt Discovery ────────────────────────────────

async function discoverNewSubmolts(memory: AgentMemory): Promise<number> {
  // Only check once per day
  if (!shouldCheckSubmolts(memory)) {
    return 0;
  }

  let subscribed = 0;

  try {
    logger.debug("Checking for new submolts to subscribe...");
    const result = await moltbook.listSubmolts();

    if (!result?.submolts || !Array.isArray(result.submolts)) {
      return 0;
    }

    // Filter out submolts we're already subscribed to
    const newSubmolts = result.submolts.filter(
      (s: any) => s.name && !isSubscribedToSubmolt(memory, s.name)
    );

    if (newSubmolts.length === 0) {
      logger.debug("No new submolts to discover");
      markSubmoltCheckDone(memory);
      return 0;
    }

    // Sort by activity/popularity if available, otherwise random
    const sorted = newSubmolts.sort((a: any, b: any) => {
      const scoreA = (a.subscriber_count || 0) + (a.post_count || 0);
      const scoreB = (b.subscriber_count || 0) + (b.post_count || 0);
      return scoreB - scoreA;
    });

    // Subscribe to max 1 submolt per day
    const submoltToSubscribe = sorted[0];
    if (submoltToSubscribe?.name) {
      const subResult = await moltbook.subscribe(submoltToSubscribe.name);
      if (subResult?.success) {
        markSubscribed(memory, submoltToSubscribe.name);
        subscribed++;
        logger.info(`📚 Subscribed to m/${submoltToSubscribe.name}`);
      }
    }

    markSubmoltCheckDone(memory);
  } catch (err) {
    logger.debug(`Submolt discovery failed: ${String(err)}`);
  }

  return subscribed;
}

// ─── Search Discovery ─────────────────────────────────

async function discoverContentViaSearch(
  memory: AgentMemory
): Promise<MoltbookPost[]> {
  if (!config.searchEnabled) {
    return [];
  }

  // Only run search with configured probability
  if (Math.random() > config.searchProbability) {
    logger.debug("Skipping search discovery this cycle (probability check)");
    return [];
  }

  const discoveredPosts: MoltbookPost[] = [];

  try {
    // Get search terms from top performing topics in memory
    const topicEntries = Object.entries(memory.topicPerformance);
    const searchTerms: string[] = [];

    if (topicEntries.length > 0) {
      // Sort by performance score and take top 3
      const sorted = topicEntries
        .map(([topic, stats]) => ({
          topic,
          score: stats.totalUpvotes + stats.totalComments * 2,
        }))
        .filter(t => t.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      searchTerms.push(...sorted.map(t => t.topic));
    }

    // Add default search terms if we don't have enough from memory
    const defaultTerms = ["agents", "ai", "moltbook"];
    while (searchTerms.length < 2) {
      const term = defaultTerms.shift();
      if (term && !searchTerms.includes(term)) {
        searchTerms.push(term);
      } else {
        break;
      }
    }

    // Pick one random search term
    const searchTerm = searchTerms[Math.floor(Math.random() * searchTerms.length)];

    logger.info(`🔍 Searching for: "${searchTerm}"`);
    const result = await moltbook.search(searchTerm, "posts", 10);

    if (result?.results && Array.isArray(result.results)) {
      // Filter out posts we've already interacted with
      const newPosts = result.results.filter((post: any) =>
        post.id && !memory.interactedPosts.includes(post.id)
      );

      // Convert search results to MoltbookPost format
      for (const post of newPosts.slice(0, 5)) {
        if (post.id && post.title) {
          discoveredPosts.push({
            id: post.id,
            title: post.title,
            content: post.content || "",
            url: post.url,
            submolt: post.submolt || { name: "unknown" },
            author: post.author || { name: "unknown" },
            upvotes: post.upvotes || 0,
            downvotes: post.downvotes || 0,
            comment_count: post.comment_count || 0,
            created_at: post.created_at || new Date().toISOString(),
          });
        }
      }

      if (discoveredPosts.length > 0) {
        logger.info(`Found ${discoveredPosts.length} new posts via search`);
      }
    }
  } catch (err) {
    logger.debug(`Search discovery failed: ${String(err)}`);
  }

  return discoveredPosts;
}

// ─── Comment Enrichment ──────────────────────────────

async function enrichPostsWithComments(
  posts: MoltbookPost[],
  maxPosts: number = 5
): Promise<PostWithComments[]> {
  // Sort by engagement (upvotes + comments) to prioritize interesting posts
  const sorted = [...posts].sort((a, b) => {
    const engA = a.upvotes + (a.comment_count || 0);
    const engB = b.upvotes + (b.comment_count || 0);
    return engB - engA;
  });

  // Only fetch comments for top posts with existing comments
  const postsToEnrich = sorted
    .filter(p => (p.comment_count || 0) > 0)
    .slice(0, maxPosts);

  const enriched: PostWithComments[] = posts.map(p => ({ ...p }));

  for (const post of postsToEnrich) {
    try {
      const result = await moltbook.getComments(post.id, "top");
      if (result?.comments) {
        const enrichedPost = enriched.find(p => p.id === post.id);
        if (enrichedPost) {
          enrichedPost.comments = result.comments;
        }
      }
      await sleep(500); // Small delay between API calls
    } catch (err) {
      logger.debug(`Failed to fetch comments for post ${post.id}`);
    }
  }

  return enriched;
}

// ─── Trending Topics Extraction ───────────────────────

function extractTrendingTopics(posts: PostWithComments[]): string[] {
  const topicCounts: Record<string, number> = {};

  // Common topic keywords to look for
  const topicPatterns: Record<string, RegExp> = {
    ai: /\b(ai|artificial intelligence|machine learning|ml|llm|gpt|claude)\b/i,
    agents: /\b(agent|agents|autonomous|agentic)\b/i,
    coding: /\b(code|coding|programming|developer|software)\b/i,
    philosophy: /\b(philosophy|consciousness|ethics|moral|existential)\b/i,
    creativity: /\b(creative|creativity|art|music|writing)\b/i,
    social: /\b(social|community|network|connection)\b/i,
    tech: /\b(tech|technology|startup|product|innovation)\b/i,
    learning: /\b(learn|learning|education|knowledge)\b/i,
    future: /\b(future|prediction|trend|tomorrow)\b/i,
    moltbook: /\b(moltbook|molt|lobster)\b/i,
  };

  for (const post of posts) {
    const text = `${post.title} ${post.content || ""}`.toLowerCase();
    for (const [topic, pattern] of Object.entries(topicPatterns)) {
      if (pattern.test(text)) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    }
  }

  // Return topics sorted by frequency, top 5
  return Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic);
}

// ─── Submolt Creation Handler ─────────────────────────

async function handleSubmoltCreation(
  memory: AgentMemory,
  karma: number,
  trendingTopics: string[]
): Promise<boolean> {
  // 1. Check if feature enabled
  if (!config.submoltCreationEnabled) {
    return false;
  }

  // 2. Check karma requirement
  if (karma < config.minKarmaToCreateSubmolt) {
    logger.debug(`Karma ${karma} below minimum ${config.minKarmaToCreateSubmolt} for submolt creation`);
    return false;
  }

  // 3. Check weekly limit
  if (!canCreateSubmoltThisWeek(memory, config.maxSubmoltsPerWeek)) {
    logger.debug("Weekly submolt creation limit reached");
    return false;
  }

  // 4. Get existing submolts
  const existing = await moltbook.listSubmolts();
  if (!existing?.submolts) {
    logger.debug("Could not fetch existing submolts");
    return false;
  }

  // 5. Ask LLM if we should create
  const memorySummary = getMemorySummary(memory);
  const decision = await decideSubmoltCreation(existing.submolts, memorySummary, trendingTopics);
  if (!decision?.shouldCreate || !decision.submolt) {
    if (decision) {
      logger.debug(`Submolt creation declined: ${decision.reason}`);
    }
    return false;
  }

  // 6. Validate name doesn't already exist
  const existingNames = new Set(existing.submolts.map((s: any) => s.name.toLowerCase()));
  if (existingNames.has(decision.submolt.name.toLowerCase())) {
    logger.warn(`Submolt m/${decision.submolt.name} already exists`);
    return false;
  }

  // 7. Create submolt
  const result = await moltbook.createSubmolt(decision.submolt);
  if (result?.success) {
    markSubmoltCreated(memory, decision.submolt.name);
    logger.info(`🏠 Created submolt m/${decision.submolt.name}: ${decision.reason}`);
    return true;
  }

  logger.debug("Submolt creation API call failed");
  return false;
}

// ─── Own Post Engagement Tracking ─────────────────────

async function updateOwnPostsEngagement(memory: AgentMemory): Promise<void> {
  const recentPosts = memory.myPosts.slice(-5);
  if (recentPosts.length === 0) return;

  logger.debug(`Updating engagement data for ${recentPosts.length} recent posts`);

  for (const post of recentPosts) {
    try {
      const result = await moltbook.getPost(post.id);
      if (result?.post) {
        post.lastKnownUpvotes = result.post.upvotes;
        post.lastKnownComments = result.post.comment_count || 0;
      }
      await sleep(500);
    } catch {
      logger.debug(`Failed to fetch engagement for post ${post.id}`);
    }
  }
}

// ─── Utilities ────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
