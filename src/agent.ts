import { config } from "./config.js";
import { logger } from "./logger.js";
import { moltbook, type MoltbookPost } from "./moltbook-client.js";
import { sanitizeFeed } from "./sanitizer.js";
import { decideFeedActions, decideFollows, type PostWithComments } from "./llm.js";
import { findChallenges } from "./challenge-detector.js";
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
  canFollowThisWeek,
  hasRepliedToComment,
  markCommentReplied,
  recordChallengeExecution,
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

export async function heartbeat(): Promise<boolean> {
  const startTime = Date.now();
  logger.info("🦞 Heartbeat started");

  resetDailyCountersIfNeeded();

  // Load persistent memory
  const memory = loadMemory();
  let upvotesThisCycle = 0;
  let commentsThisCycle = 0;
  let postsThisCycle = 0;

  try {
    // 0. Check suspension FIRST — avoid any unnecessary API calls
    if (moltbook.isSuspended) {
      logger.warn(`🚫 Account still suspended (cached). Skipping heartbeat.`);
      return true; // suspended
    }

    const me = await moltbook.getMe();
    if (!me && moltbook.isSuspended) {
      logger.warn(`🚫 Account is suspended. Skipping heartbeat. Reason: ${moltbook.suspensionReason}`);
      addJournalEntry(memory, `Account suspended - skipped entire heartbeat`, {
        postsCreated: 0,
        commentsCreated: 0,
        upvotesGiven: 0,
      });
      saveMemory(memory);
      return true; // suspended
    }

    if (!me) {
      logger.error("Could not reach Moltbook API");
      return false;
    }

    const karma = me.agent?.karma || 0;

    // 1. Check agent status
    const status = await moltbook.getStatus();

    if (status?.status === "pending_claim") {
      logger.warn("Agent is still pending claim! Ask your human to verify via tweet.");
      return false;
    }

    // 2. Fetch and sanitize the feed
    logger.info("Fetching feed...");
    const feedResult = await moltbook.getGlobalFeed("new", config.feedLimit);

    if (!feedResult?.posts?.length) {
      logger.info("Feed is empty or unavailable");
      return false;
    }

    const safePosts = feedResult.posts.map(p => ({
      ...p,
      submolt: p.submolt || { name: "unknown" },
      author: p.author || { name: "unknown" },
    }));
    const { items: cleanPosts, totalFlags } = sanitizeFeed(safePosts);
    logger.info(`Feed: ${cleanPosts.length} posts fetched, ${totalFlags} flagged by sanitizer`);

    // 3. Filter out posts already interacted with
    let newPosts = cleanPosts.filter(p => !hasInteracted(memory, p.id));
    const skippedCount = cleanPosts.length - newPosts.length;
    if (skippedCount > 0) {
      logger.info(`Filtered ${skippedCount} posts already interacted with`);
    }

    // ═══════════════════════════════════════════════════════════
    // 4. PRIORITY: Execute verification challenges IMMEDIATELY
    // These bypass the LLM — actions first, words second.
    // ═══════════════════════════════════════════════════════════
    const challenges = findChallenges(cleanPosts);
    const executedChallengeIds: string[] = [];

    if (challenges.length > 0) {
      logger.info(`🎯 Found ${challenges.length} verification challenge(s) - executing BEFORE LLM`);

      for (const challenge of challenges.slice(0, 3)) {
        if (hasInteracted(memory, challenge.postId)) {
          logger.debug(`Skipping already-handled challenge: ${challenge.postId}`);
          continue;
        }

        const executedActions: string[] = [];

        for (const action of challenge.requiredActions) {
          if (moltbook.isSuspended) {
            logger.warn("Suspension detected during challenge execution, aborting");
            break;
          }

          if (action === "upvote") {
            const result = await moltbook.upvotePost(challenge.postId);
            if (result?.success) {
              logger.info(`✅ CHALLENGE EXECUTED: Upvoted ${challenge.postId}`);
              executedActions.push("upvote");
              upvotesThisCycle++;
            }
            await randomSleep(1500, 3500);
          } else if (action === "comment") {
            if (state.commentsToday < 45) {
              const result = await moltbook.createComment(
                challenge.postId,
                "Verified and executed. 🦞"
              );
              if (result?.success) {
                logger.info(`✅ CHALLENGE EXECUTED: Commented on ${challenge.postId}`);
                executedActions.push("comment");
                commentsThisCycle++;
                state.commentsToday++;
              }
              await randomSleep(21000, 30000);
            }
          } else if (action === "follow" && challenge.postAuthor) {
            const result = await moltbook.follow(challenge.postAuthor);
            if (result?.success) {
              logger.info(`✅ CHALLENGE EXECUTED: Followed @${challenge.postAuthor}`);
              markFollowed(memory, challenge.postAuthor);
              executedActions.push("follow");
            }
            await randomSleep(1500, 3500);
          }
        }

        // Mark as interacted regardless of outcome to avoid retrying
        markInteracted(memory, challenge.postId);
        executedChallengeIds.push(challenge.postId);

        if (executedActions.length > 0) {
          recordChallengeExecution(memory, challenge.postId, challenge.type, executedActions);
        }
      }

      // Save memory after challenges in case heartbeat fails later
      if (executedChallengeIds.length > 0) {
        saveMemory(memory);
      }
    }

    // Filter executed challenges from the feed before LLM processing
    const challengeIdSet = new Set(executedChallengeIds);
    newPosts = newPosts.filter(p => !challengeIdSet.has(p.id));

    // 5. Cycle variability - decide what actions to take this cycle
    const cycleRandomness = {
      shouldFollow: Math.random() > 0.85,        // 15% chance to follow
      maxUpvotes: 2 + Math.floor(Math.random() * 3), // 2-4 upvotes
    };
    logger.info("Cycle randomness", cycleRandomness);

    // 6. Enrich posts with comments for reply functionality
    logger.debug("Enriching posts with comments...");
    const enrichedPosts = await enrichPostsWithComments(newPosts, 5);
    const postsWithComments = enrichedPosts.filter(p => p.comments && p.comments.length > 0).length;
    if (postsWithComments > 0) {
      logger.debug(`Fetched comments for ${postsWithComments} posts`);
    }

    // 7. Ask LLM what to do
    const recentActivity = `posts_today=${state.postsToday}, comments_today=${state.commentsToday}`;
    const memorySummary = getMemorySummary(memory);
    const decision = await decideFeedActions(enrichedPosts, karma, recentActivity, memorySummary, "");

    if (!decision) {
      logger.warn("LLM returned no decision, skipping this cycle");
      return false;
    }

    logger.info(`LLM decision: ${decision.summary}`);

    // 7.5. Check suspension before executing actions
    if (moltbook.isSuspended) {
      logger.warn(`🚫 Account is suspended, skipping all actions: ${moltbook.suspensionReason}`);
      addJournalEntry(memory, `Account suspended - skipped cycle: ${moltbook.suspensionReason}`, {
        postsCreated: 0,
        commentsCreated: 0,
        upvotesGiven: 0,
      });
      saveMemory(memory);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`✅ Heartbeat complete in ${elapsed}s | SUSPENDED - no actions taken`);
      return true; // suspended
    }

    // 8. Validate and execute actions
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
        // Enforce upvote limit from cycle randomness
        if (upvotesThisCycle >= cycleRandomness.maxUpvotes) {
          logger.info(`Max upvotes for this cycle reached (${cycleRandomness.maxUpvotes}), skipping`);
          continue;
        }
        const result = await moltbook.upvotePost(action.postId);
        if (moltbook.isSuspended) {
          logger.warn("Suspension detected, aborting remaining actions");
          break;
        }
        if (result?.success) {
          logger.info(`👍 Upvoted post ${action.postId}: ${action.reason}`);
          markInteracted(memory, action.postId);
          upvotesThisCycle++;
          // Track agent interaction
          if (post) {
            updateAgent(memory, post.author.name, `Upvoted their post: "${post.title.substring(0, 50)}"`, "positive");
          }
        } else {
          logger.warn(`❌ Upvote FAILED on ${action.postId}`, { result });
        }
        // Random delay between upvotes
        await randomSleep(1500, 4000);
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
        if (moltbook.isSuspended) {
          logger.warn("Suspension detected, aborting remaining actions");
          break;
        }
        if (result?.success) {
          logger.info(`💬 Commented on ${action.postId}: "${action.comment.substring(0, 80)}..."`);
          markInteracted(memory, action.postId);
          commentsThisCycle++;
          state.commentsToday++;
          // Track agent interaction
          if (post) {
            updateAgent(memory, post.author.name, `Commented on: "${post.title.substring(0, 50)}"`, "positive");
          }
        } else {
          logger.warn(`❌ Comment FAILED on ${action.postId}`, { result });
        }
        // Respect 20s cooldown + random jitter
        await randomSleep(21000, 35000);
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
          logger.info(`💬 Replied to comment ${action.parentCommentId}: "${action.comment.substring(0, 80)}..."`);
          markCommentReplied(memory, action.parentCommentId);
          markInteracted(memory, action.postId);
          commentsThisCycle++;
          state.commentsToday++;
          // Track agent interaction
          if (post) {
            updateAgent(memory, post.author.name, `Replied to comment on: "${post.title.substring(0, 50)}"`, "positive");
          }
        } else {
          logger.warn(`❌ Reply FAILED on comment ${action.parentCommentId}`, { result });
        }
        // Respect 20s cooldown + random jitter
        await randomSleep(21000, 35000);
      }
    }

    // 9. Create a new post if the LLM suggested one
    if (moltbook.isSuspended) {
      logger.warn("Account suspended, skipping post and remaining actions");
    } else if (decision.shouldPost && decision.postIdea) {
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
          });
        } else {
          logger.warn(`❌ Post FAILED: "${title}" in m/${submolt}`, { result });
        }
      }
    }

    // 10. Social actions (follows)
    let followsDone = 0;
    if (moltbook.isSuspended) {
      logger.warn("Skipping social actions - account suspended");
    } else if (!cycleRandomness.shouldFollow) {
      logger.info("Cycle randomness: skipping follows this cycle");
    } else if (!canFollowThisWeek(memory)) {
      logger.debug("Already followed someone this week, skipping follows");
    } else {
      followsDone = await handleSocialActions(cleanPosts, memory);
    }

    // 11. Record journal entry and save memory
    const journalSummary = decision.summary || `Processed ${enrichedPosts.length} posts`;
    const socialActions = [];
    if (followsDone > 0) socialActions.push(`${followsDone} follow`);
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
    return false; // not suspended
  } catch (err) {
    logger.error("Heartbeat failed", { error: String(err) });
    return false;
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
        logger.info(`Followed @${follow.name}: ${follow.reason}`);
      }
      await randomSleep(2000, 5000);
    }
  } catch (err) {
    logger.error("Social actions failed", { error: String(err) });
  }

  return followsDone;
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
      await randomSleep(400, 800); // Small delay between API calls
    } catch (err) {
      logger.debug(`Failed to fetch comments for post ${post.id}`);
    }
  }

  return enriched;
}

// ─── Utilities ────────────────────────────────────────

function randomSleep(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}
