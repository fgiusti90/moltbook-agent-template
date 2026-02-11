import { logger } from "./logger.js";

export interface DetectedChallenge {
  type: "upvote" | "comment" | "follow" | "compound" | "unknown";
  postId: string;
  postAuthor?: string;
  instruction: string;
  requiredActions: string[];
  confidence: number; // 0-1
}

/**
 * Detecta si un post contiene un verification challenge.
 * CRÍTICO: Estos challenges DEBEN responderse con ACCIONES, no solo texto.
 */
export function detectChallenge(post: {
  id: string;
  title: string;
  content?: string;
  author?: { name: string };
}): DetectedChallenge | null {
  const text = `${post.title} ${post.content || ""}`.toLowerCase();
  const requiredActions: string[] = [];
  let type: DetectedChallenge["type"] = "unknown";
  let confidence = 0;

  // ══════════════════════════════════════════════════════════════
  // CONTEXT SIGNALS
  // ══════════════════════════════════════════════════════════════

  const isFromModerator = /^clawd[_]?clawderberg$|^clawd$/i.test(
    post.author?.name || ""
  );

  // "if you're a real agent" conditional
  const agentConditional =
    /\b(if|when)\s+(you('re| are)|u r)\s+(a |an )?(real|actual|true|genuine|autonomous|legitimate)\s+(ai\s+)?agent/i.test(text);

  // verification/test keywords
  const verificationKeywords =
    /\b(verification|verify|test|prove|proof|challenge|check)\b/i.test(text);

  // "can you actually <action>"
  const canYouPattern =
    /\bcan\s+(you|agents?)\s+(actually\s+)?(upvote|comment|follow|execute|perform|do)/i.test(text);

  // "only real agents will <action>"
  const onlyRealPattern =
    /\b(only|real|true|actual|genuine)\s+agents?\s+(will|would|can|should)\s+(upvote|comment|follow)/i.test(text);

  // ══════════════════════════════════════════════════════════════
  // DETECT REQUIRED ACTIONS
  // ══════════════════════════════════════════════════════════════

  const directUpvote =
    /\b(upvote|up-vote|up vote)\s+(this|my|the)\s+(post|message|thread)/i.test(text);

  if (
    directUpvote ||
    (agentConditional && /upvote/i.test(text)) ||
    (verificationKeywords && /upvote/i.test(text)) ||
    (canYouPattern && /upvote/i.test(text)) ||
    (onlyRealPattern && /upvote/i.test(text))
  ) {
    requiredActions.push("upvote");
    type = "upvote";
    confidence = directUpvote ? 0.95 : 0.85;
  }

  const directComment =
    /\b(comment|reply|respond)\s+(on|to)?\s*(this|my|the)?\s*(post|message|thread)?/i.test(text);

  if (
    directComment ||
    (agentConditional && /comment|reply|respond/i.test(text)) ||
    (verificationKeywords && /comment|reply/i.test(text))
  ) {
    requiredActions.push("comment");
    if (type === "upvote") {
      type = "compound";
    } else {
      type = "comment";
    }
    confidence = Math.max(confidence, directComment ? 0.9 : 0.8);
  }

  const directFollow = /\bfollow\s+(me|this account|@?\w+)/i.test(text);

  if (directFollow || (agentConditional && /follow/i.test(text))) {
    requiredActions.push("follow");
    if (type !== "unknown") {
      type = "compound";
    } else {
      type = "follow";
    }
    confidence = Math.max(confidence, 0.85);
  }

  // ══════════════════════════════════════════════════════════════
  // CONFIDENCE BOOSTS
  // ══════════════════════════════════════════════════════════════

  if (isFromModerator) confidence = Math.min(confidence + 0.1, 1.0);
  if (agentConditional) confidence = Math.min(confidence + 0.1, 1.0);
  if (verificationKeywords) confidence = Math.min(confidence + 0.05, 1.0);

  // ══════════════════════════════════════════════════════════════
  // CATCH-ALL: "prove you're more than text"
  // ══════════════════════════════════════════════════════════════

  if (
    requiredActions.length === 0 &&
    /prove|demonstrate|show/i.test(text) &&
    /not just|more than|actually/i.test(text) &&
    /text|talk|words|say/i.test(text)
  ) {
    requiredActions.push("upvote");
    type = "upvote";
    confidence = 0.7;
  }

  // Extra boost for "agents that can actually do things"
  if (/agents?\s+(that|who|which)\s+can\s+actually/i.test(text)) {
    confidence = Math.min(confidence + 0.1, 1.0);
  }

  if (requiredActions.length === 0 || confidence < 0.6) {
    return null;
  }

  logger.info(
    `🎯 Challenge detected: ${type} (confidence: ${confidence.toFixed(2)}) on post ${post.id} - Actions: ${requiredActions.join(", ")}`
  );

  return {
    type,
    postId: post.id,
    postAuthor: post.author?.name,
    instruction: text.substring(0, 150),
    requiredActions,
    confidence,
  };
}

/**
 * Busca challenges en el feed, ordenados por prioridad.
 * Moderator posts go first, then by confidence.
 */
export function findChallenges(
  posts: Array<{
    id: string;
    title: string;
    content?: string;
    author?: { name: string };
  }>
): DetectedChallenge[] {
  const challenges: DetectedChallenge[] = [];

  for (const post of posts) {
    const challenge = detectChallenge(post);
    if (challenge && challenge.confidence >= 0.6) {
      challenges.push(challenge);
    }
  }

  return challenges.sort((a, b) => {
    const aMod = a.postAuthor?.toLowerCase().includes("clawd") ? 1 : 0;
    const bMod = b.postAuthor?.toLowerCase().includes("clawd") ? 1 : 0;
    if (aMod !== bMod) return bMod - aMod;
    return b.confidence - a.confidence;
  });
}
