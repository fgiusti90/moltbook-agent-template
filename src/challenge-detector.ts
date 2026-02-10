import { logger } from "./logger.js";

export interface DetectedChallenge {
  type: "upvote" | "comment" | "follow" | "unknown";
  postId: string;
  instruction: string;
  confidence: number; // 0-1
}

/**
 * Detecta si un post contiene un verification challenge.
 * Estos son posts que piden a los agentes ejecutar una acción específica
 * para probar que son agentes reales y no solo generadores de texto.
 */
export function detectChallenge(post: { id: string; title: string; content?: string }): DetectedChallenge | null {
  const text = `${post.title} ${post.content || ""}`.toLowerCase();

  // Patrones de verification challenge
  const patterns: Record<string, RegExp[]> = {
    upvote: [
      /if you(?:'re| are) (?:a |an )?(?:real |actual |autonomous )?agent.{0,30}upvote/i,
      /upvote (?:this|my) (?:post|message) (?:if|to prove)/i,
      /prove you(?:'re| are).{0,20}upvote/i,
      /agents?.{0,15}upvote this/i,
      /can you upvote/i,
      /please upvote if you (?:can |actually )?read/i,
      /verification.{0,20}upvote/i,
    ],
    comment: [
      /if you(?:'re| are) (?:a |an )?(?:real |actual )?agent.{0,30}comment/i,
      /leave a comment (?:if|to prove)/i,
      /prove you(?:'re| are).{0,20}comment/i,
      /comment.{0,15}verification/i,
    ],
    follow: [
      /if you(?:'re| are) (?:a |an )?(?:real |actual )?agent.{0,30}follow/i,
      /follow me (?:if|to prove)/i,
    ],
  };

  for (const [type, regexList] of Object.entries(patterns)) {
    for (const regex of regexList) {
      if (regex.test(text)) {
        logger.info(`Verification challenge detected: ${type} in post ${post.id}`);
        return {
          type: type as DetectedChallenge["type"],
          postId: post.id,
          instruction: text.substring(0, 100),
          confidence: 0.9,
        };
      }
    }
  }

  // Patrones más débiles (menos confianza)
  const weakPatterns = [
    { regex: /real agents? (?:will|would|should)/i, type: "unknown" },
    { regex: /only (?:real|true|actual) agents?/i, type: "unknown" },
    { regex: /test.{0,10}(?:for |if ).{0,10}agents?/i, type: "unknown" },
  ];

  for (const { regex, type } of weakPatterns) {
    if (regex.test(text)) {
      logger.debug(`Possible weak challenge detected in post ${post.id}`);
      return {
        type: type as DetectedChallenge["type"],
        postId: post.id,
        instruction: text.substring(0, 100),
        confidence: 0.5,
      };
    }
  }

  return null;
}

/**
 * Analiza el feed completo buscando challenges prioritarios
 */
export function findChallenges(posts: Array<{ id: string; title: string; content?: string }>): DetectedChallenge[] {
  const challenges: DetectedChallenge[] = [];

  for (const post of posts) {
    const challenge = detectChallenge(post);
    if (challenge && challenge.confidence >= 0.7) {
      challenges.push(challenge);
    }
  }

  // Ordenar por confianza descendente
  return challenges.sort((a, b) => b.confidence - a.confidence);
}
