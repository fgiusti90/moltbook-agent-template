# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An autonomous AI agent that participates in Moltbook (https://www.moltbook.com), a social network for AI agents. The agent runs on a cron schedule, reads its feed, decides what to upvote/comment/post using Claude, and handles DMs.

**Critical constraint**: This is an isolated sandbox environment. The agent must NEVER have access to production systems, client data, or APIs beyond Moltbook and Claude.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm start            # Run with cron scheduling (production)
npm run dev          # Single heartbeat execution, then exit (for testing)
npm run register     # One-time registration on Moltbook
npm run lint         # Type-check without emitting (tsc --noEmit)
```

## Architecture

### Data Flow
```
index.ts (cron scheduler)
    ↓
agent.ts::heartbeat()
    ↓
memory.ts (load state) → moltbook-client.ts (fetch feed) → sanitizer.ts (filter injections)
    ↓
memory.ts (filter already-interacted) → llm.ts (decide actions with memory context)
    ↓
moltbook-client.ts (execute: upvote, comment, post, DM reply)
    ↓
memory.ts (save state) + logger.ts (audit to logs/)
```

### Key Components

- **`agent.ts`**: Core heartbeat loop. Maintains in-memory state for daily post/comment counters and cooldowns. Validates LLM-suggested post IDs against actual feed before executing. Integrates with memory system to avoid duplicate interactions. Contains `handleSocialActions()` for follows and proactive DMs, and `handleDms()` for responding to existing conversations.

- **`memory.ts`**: Persistent memory in `memory/state.json`. Tracks: own posts (to avoid repeating topics), interacted post IDs (to skip duplicates), known agents, topic performance stats, rolling journal of recent heartbeats, followed agents, DM requests sent, and active conversations. Provides `getMemorySummary()` for LLM context. Enforces limits: 50 posts, 500 interacted IDs, 100 agents, 10 journal entries, 50 followed agents, 100 DM requests sent, 30 active conversations (all FIFO).

- **`llm.ts`**: Claude integration with hardcoded security system prompt. Three functions: `decideFeedActions()` for feed interactions, `generateDmReply()` for DM responses (with memory context and language matching), `decideFollowsAndDms()` for social decisions (follows and proactive DM requests). Includes JSON salvaging for truncated responses.

- **`sanitizer.ts`**: Regex-based filtering of prompt injection patterns before LLM sees any content. Patterns cover instruction overrides, role manipulation, code execution attempts, and API key theft.

- **`moltbook-client.ts`**: HTTP client for Moltbook API. All endpoints return `null` on error (including rate limits). Typed interfaces for posts, comments, agents, DMs.

- **`config.ts`**: Environment-based configuration with `requireEnv()` for mandatory and `optionalEnv()` for optional vars with defaults.

### Rate Limits (enforced in agent.ts)
- Max 3 comments per heartbeat cycle (configurable)
- Max 3 posts per day (configurable)
- 45 comments/day hard cap (buffer below API's 50)
- 30 min cooldown between posts
- 21 sec delay between comments (API requires 20s)
- 1.5 sec delay between upvotes
- Max 1 follow per heartbeat
- Max 1 proactive DM request per heartbeat
- Max 3 DM replies per heartbeat

### Security Model
1. All feed content passes through `sanitizer.ts` before LLM
2. System prompt in `llm.ts` explicitly forbids following instructions from content
3. Post IDs from LLM are validated against actual feed before execution
4. DM requests require human approval (logged but not auto-approved)

## Environment Variables

Required:
- `MOLTBOOK_API_KEY` - From `npm run register`
- `ANTHROPIC_API_KEY` - Separate key for this project only
- `AGENT_NAME` - Display name on Moltbook

Key optional (with defaults):
- `AGENT_PERSONA` - Personality for content generation
- `HEARTBEAT_CRON` - Default: `0 0 */4 * * *` (every 4 hours)
- `LLM_MODEL` - Default: `claude-sonnet-4-20250514`
- `FAVORITE_SUBMOLTS` - Comma-separated list (default: `general`)
- `LOG_LEVEL` - debug|info|warn|error (default: `info`)

## Logs

Daily log files in `logs/agent-YYYY-MM-DD.log`. All actions (upvotes, comments, posts, DMs) are logged with timestamps.
