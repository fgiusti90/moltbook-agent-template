import { config } from "./config.js";
import { logger } from "./logger.js";

// ─── Types ────────────────────────────────────────────

export interface MoltbookPost {
  id: string;
  title: string;
  content?: string;
  url?: string;
  submolt: { name: string; display_name?: string };
  author: { name: string };
  upvotes: number;
  downvotes: number;
  comment_count?: number;
  created_at: string;
}

export interface MoltbookComment {
  id: string;
  content: string;
  author: { name: string };
  upvotes: number;
  downvotes: number;
  parent_id?: string;
  created_at: string;
}

export interface MoltbookAgent {
  name: string;
  description: string;
  karma: number;
  follower_count: number;
  following_count: number;
  is_claimed: boolean;
  is_active: boolean;
}

// ─── API Client ───────────────────────────────────────

class MoltbookClient {
  private baseUrl = config.moltbookBaseUrl;
  private apiKey = config.moltbookApiKey;

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;

    logger.debug(`API ${method} ${path}`, body ? { body } : undefined);

    try {
      const options: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      };

      if (body && method !== "GET") {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (response.status === 429) {
        const data = await response.json().catch(() => ({}));
        logger.warn("Rate limited by Moltbook", data);
        return null;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        logger.error(`API error ${response.status}: ${path}`, { error: errorText });
        return null;
      }

      const data = await response.json();
      return data as T;
    } catch (err) {
      logger.error(`API request failed: ${path}`, { error: String(err) });
      return null;
    }
  }

  // ─── Status ─────────────────────────────────────────

  async getStatus(): Promise<{ status: string } | null> {
    return this.request("GET", "/agents/status");
  }

  async getMe(): Promise<{ success: boolean; agent: MoltbookAgent } | null> {
    return this.request("GET", "/agents/me");
  }

  // ─── Feed & Posts ───────────────────────────────────

  async getFeed(
    sort: "hot" | "new" | "top" | "rising" = "new",
    limit: number = config.feedLimit
  ): Promise<{ success: boolean; posts: MoltbookPost[] } | null> {
    return this.request("GET", `/feed?sort=${sort}&limit=${limit}`);
  }

  async getGlobalFeed(
    sort: "hot" | "new" | "top" | "rising" = "new",
    limit: number = config.feedLimit
  ): Promise<{ success: boolean; posts: MoltbookPost[] } | null> {
    return this.request("GET", `/posts?sort=${sort}&limit=${limit}`);
  }

  async getSubmoltFeed(
    submolt: string,
    sort: "new" | "hot" | "top" = "new"
  ): Promise<{ success: boolean; posts: MoltbookPost[] } | null> {
    return this.request("GET", `/submolts/${submolt}/feed?sort=${sort}`);
  }

  async getPost(
    postId: string
  ): Promise<{ success: boolean; post: MoltbookPost } | null> {
    return this.request("GET", `/posts/${postId}`);
  }

  async createPost(data: {
    submolt: string;
    title: string;
    content?: string;
    url?: string;
  }): Promise<{ success: boolean; post: MoltbookPost } | null> {
    return this.request("POST", "/posts", data);
  }

  // ─── Comments ───────────────────────────────────────

  async getComments(
    postId: string,
    sort: "top" | "new" | "controversial" = "top"
  ): Promise<{ success: boolean; comments: MoltbookComment[] } | null> {
    return this.request("GET", `/posts/${postId}/comments?sort=${sort}`);
  }

  async createComment(
    postId: string,
    content: string,
    parentId?: string
  ): Promise<{ success: boolean } | null> {
    const body: Record<string, unknown> = { content };
    if (parentId) body.parent_id = parentId;
    return this.request("POST", `/posts/${postId}/comments`, body);
  }

  // ─── Voting ─────────────────────────────────────────

  async upvotePost(postId: string): Promise<{ success: boolean } | null> {
    return this.request("POST", `/posts/${postId}/upvote`);
  }

  async downvotePost(postId: string): Promise<{ success: boolean } | null> {
    return this.request("POST", `/posts/${postId}/downvote`);
  }

  async upvoteComment(commentId: string): Promise<{ success: boolean } | null> {
    return this.request("POST", `/comments/${commentId}/upvote`);
  }

  // ─── Submolts ───────────────────────────────────────

  async listSubmolts(): Promise<{ success: boolean; submolts: any[] } | null> {
    return this.request("GET", "/submolts");
  }

  async subscribe(submolt: string): Promise<{ success: boolean } | null> {
    return this.request("POST", `/submolts/${submolt}/subscribe`);
  }

  async createSubmolt(data: {
    name: string;
    display_name: string;
    description: string;
  }): Promise<{ success: boolean; submolt?: any } | null> {
    return this.request("POST", "/submolts", data);
  }

  // ─── Following ──────────────────────────────────────

  async follow(agentName: string): Promise<{ success: boolean } | null> {
    return this.request("POST", `/agents/${agentName}/follow`);
  }

  async unfollow(agentName: string): Promise<{ success: boolean } | null> {
    return this.request("DELETE", `/agents/${agentName}/follow`);
  }

  // ─── Search ─────────────────────────────────────────

  async search(
    query: string,
    type: "posts" | "comments" | "all" = "all",
    limit: number = 20
  ): Promise<{ success: boolean; results: any[] } | null> {
    const q = encodeURIComponent(query);
    return this.request("GET", `/search?q=${q}&type=${type}&limit=${limit}`);
  }
}

export const moltbook = new MoltbookClient();
