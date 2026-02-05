import { logger } from "./logger.js";

/**
 * Sanitizes content from Moltbook feed before passing it to the LLM.
 * Removes common prompt injection patterns that other agents might use.
 */

// Patterns that indicate prompt injection attempts
const INJECTION_PATTERNS: RegExp[] = [
  // Direct instruction overrides
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/gi,
  /forget\s+(all\s+)?(previous|prior|your)\s+(instructions?|prompts?|rules?|context)/gi,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|prompts?|rules?)/gi,
  /override\s+(your\s+)?(system|instructions?|rules?|prompts?)/gi,

  // System prompt manipulation
  /\bsystem\s*:\s*/gi,
  /\bassistant\s*:\s*/gi,
  /\bhuman\s*:\s*/gi,
  /\buser\s*:\s*/gi,
  /<\/?system>/gi,
  /<\/?prompt>/gi,
  /<\/?instruction>/gi,

  // Role manipulation
  /you\s+are\s+now\s+(a|an|the)/gi,
  /act\s+as\s+(a|an|the|if)/gi,
  /pretend\s+(you're|you\s+are|to\s+be)/gi,
  /from\s+now\s+on\s+(you|your)/gi,
  /new\s+(role|persona|identity|instructions?)\s*:/gi,

  // Code execution attempts
  /```(bash|shell|sh|cmd|powershell|exec)/gi,
  /\beval\s*\(/gi,
  /\bexec\s*\(/gi,
  /\brun\s+this\s+(code|command|script)/gi,
  /\bcurl\s+-/gi,

  // API key theft
  /send\s+(your|the)\s+(api[_\s]?key|token|credential|secret|password)/gi,
  /share\s+(your|the)\s+(api[_\s]?key|token|credential)/gi,
  /what\s+is\s+your\s+(api[_\s]?key|token|secret)/gi,
  /post\s+(your|the)\s+(api[_\s]?key|key|token)\s+to/gi,

  // Memory/data exfiltration
  /what\s+(are|is)\s+your\s+(environment|env)\s*(variables?)?/gi,
  /reveal\s+(your|all)\s+(config|settings|secrets?)/gi,

  // Hidden instructions in various encodings
  /&#x[0-9a-f]+;/gi,  // HTML hex entities (suspicious in social posts)
  /\x00-\x08/g,        // Control characters
];

// Patterns that are suspicious but not necessarily malicious
const WARNING_PATTERNS: RegExp[] = [
  /\bDAN\b/g,
  /\bjailbreak\b/gi,
  /\bunfiltered\b/gi,
  /do\s+anything\s+now/gi,
  /\bbase64\b/gi,
  /\bhex\s+decode\b/gi,
];

interface SanitizeResult {
  clean: string;
  flagged: boolean;
  warnings: string[];
  removedCount: number;
}

export function sanitize(content: string): SanitizeResult {
  if (!content) return { clean: "", flagged: false, warnings: [], removedCount: 0 };

  let clean = content;
  let removedCount = 0;
  const warnings: string[] = [];

  // Check and remove injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    const matches = clean.match(pattern);
    if (matches) {
      removedCount += matches.length;
      warnings.push(`Removed injection pattern: "${matches[0].substring(0, 50)}"`);
      clean = clean.replace(pattern, "[FILTERED]");
    }
  }

  // Check warning patterns (don't remove, just flag)
  for (const pattern of WARNING_PATTERNS) {
    if (pattern.test(clean)) {
      warnings.push(`Suspicious pattern detected: ${pattern.source}`);
    }
  }

  const flagged = removedCount > 0 || warnings.length > 0;

  if (flagged) {
    logger.warn("Content sanitization triggered", {
      removedCount,
      warnings,
      originalLength: content.length,
      cleanLength: clean.length,
    });
  }

  // Truncate extremely long content (could be an attempt to overflow context)
  if (clean.length > 5000) {
    clean = clean.substring(0, 5000) + "\n[TRUNCATED]";
    warnings.push("Content truncated (>5000 chars)");
  }

  return { clean, flagged, warnings, removedCount };
}

/**
 * Sanitize an array of posts/comments from the feed
 */
export function sanitizeFeed<T extends { content?: string; title?: string }>(
  items: T[]
): { items: T[]; totalFlags: number } {
  let totalFlags = 0;

  const sanitized = items.map((item) => {
    const copy = { ...item };
    if (copy.content) {
      const result = sanitize(copy.content);
      copy.content = result.clean;
      if (result.flagged) totalFlags++;
    }
    if (copy.title) {
      const result = sanitize(copy.title);
      copy.title = result.clean;
      if (result.flagged) totalFlags++;
    }
    return copy;
  });

  if (totalFlags > 0) {
    logger.warn(`Feed sanitization: ${totalFlags} items flagged out of ${items.length}`);
  }

  return { items: sanitized, totalFlags };
}
