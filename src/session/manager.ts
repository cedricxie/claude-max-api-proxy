/**
 * Session Manager
 *
 * Maps Clawdbot conversation IDs to Claude CLI session IDs
 * for maintaining conversation context across requests.
 */

import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";

export interface SessionMapping {
  clawdbotId: string;
  claudeSessionId: string;
  createdAt: number;
  lastUsedAt: number;
  model: string;
  cumulativeInputTokens: number;
  lastTotalContext?: number;
}

const SESSION_FILE = path.join(
  process.env.HOME || "/tmp",
  ".claude-code-cli-sessions.json"
);

// Session TTL: 24 hours
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Maximum number of sessions before forced eviction of oldest
const MAX_SESSIONS = 1000;

class SessionManager {
  private sessions: Map<string, SessionMapping> = new Map();
  private loaded: boolean = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private locks: Map<string, Promise<void>> = new Map();

  /**
   * Load sessions from disk
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      const data = await fs.readFile(SESSION_FILE, "utf-8");
      const parsed = JSON.parse(data) as Record<string, SessionMapping>;
      this.sessions = new Map(Object.entries(parsed));
      this.loaded = true;
      console.log(`[SessionManager] Loaded ${this.sessions.size} sessions`);
    } catch {
      // File doesn't exist or is invalid, start fresh
      this.sessions = new Map();
      this.loaded = true;
    }
  }

  /**
   * Save sessions to disk.
   * Serialized via a queue to prevent concurrent writes from corrupting the file.
   */
  async save(): Promise<void> {
    this.saveQueue = this.saveQueue.then(async () => {
      const data = Object.fromEntries(this.sessions);
      await fs.writeFile(SESSION_FILE, JSON.stringify(data, null, 2), {
        mode: 0o600,
      });
    }).catch((err) => {
      console.error("[SessionManager] Write error:", err);
    });
    return this.saveQueue;
  }

  /**
   * Get or create a Claude session ID for a Clawdbot conversation
   */
  getOrCreate(clawdbotId: string, model: string = "sonnet"): string {
    const existing = this.sessions.get(clawdbotId);

    if (existing) {
      // Update last used time
      existing.lastUsedAt = Date.now();
      existing.model = model;
      return existing.claudeSessionId;
    }

    // Create new session
    const claudeSessionId = uuidv4();
    const mapping: SessionMapping = {
      clawdbotId,
      claudeSessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      model,
      cumulativeInputTokens: 0,
    };

    this.sessions.set(clawdbotId, mapping);
    this.evictIfNeeded();
    console.log(
      `[SessionManager] Created session: ${clawdbotId} -> ${claudeSessionId}`
    );

    // Fire and forget save
    this.save().catch((err) =>
      console.error("[SessionManager] Save error:", err)
    );

    return claudeSessionId;
  }

  /**
   * Add input tokens to a session's cumulative count
   */
  addTokens(clawdbotId: string, inputTokens: number): void {
    const s = this.sessions.get(clawdbotId);
    if (s && inputTokens > 0) {
      s.cumulativeInputTokens = (s.cumulativeInputTokens || 0) + inputTokens;
      this.save().catch((err) =>
        console.error("[SessionManager] Save error:", err)
      );
    }
  }

  /**
   * Get existing session if it exists
   */
  get(clawdbotId: string): SessionMapping | undefined {
    return this.sessions.get(clawdbotId);
  }

  /**
   * Delete a session
   */
  delete(clawdbotId: string): boolean {
    const deleted = this.sessions.delete(clawdbotId);
    if (deleted) {
      this.save().catch((err) =>
        console.error("[SessionManager] Save error:", err)
      );
    }
    return deleted;
  }

  /**
   * Clean up expired sessions
   */
  cleanup(): number {
    const cutoff = Date.now() - SESSION_TTL_MS;
    let removed = 0;

    for (const [key, session] of this.sessions) {
      if (session.lastUsedAt < cutoff) {
        this.sessions.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[SessionManager] Cleaned up ${removed} expired sessions`);
      this.save().catch((err) =>
        console.error("[SessionManager] Save error:", err)
      );
    }

    return removed;
  }

  /**
   * Get all active sessions
   */
  getAll(): SessionMapping[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session count
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Acquire a per-session lock so concurrent requests for the same
   * session are serialized. Returns a release function.
   *
   * Includes a safety timeout (10 min) to prevent permanent hangs
   * if a lock holder crashes without releasing.
   */
  async acquireLock(key: string): Promise<() => void> {
    const LOCK_TIMEOUT_MS = 600000; // 10 minutes

    // Wait for any existing lock on this key, with timeout
    if (this.locks.has(key)) {
      await Promise.race([
        this.locks.get(key),
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            console.error(`[SessionManager] Lock timeout for key "${key}" — forcing release`);
            this.locks.delete(key);
            resolve();
          }, LOCK_TIMEOUT_MS);
          timer.unref();
          // Also resolve if the lock clears normally
          this.locks.get(key)?.then(resolve);
        }),
      ]);
    }

    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, promise);

    // Auto-release after timeout as a safety net
    const autoRelease = setTimeout(() => {
      if (this.locks.get(key) === promise) {
        console.error(`[SessionManager] Auto-releasing stale lock for key "${key}"`);
        this.locks.delete(key);
        release();
      }
    }, LOCK_TIMEOUT_MS);
    autoRelease.unref();

    return () => {
      clearTimeout(autoRelease);
      this.locks.delete(key);
      release();
    };
  }

  /**
   * Evict oldest sessions if we exceed MAX_SESSIONS
   */
  private evictIfNeeded(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;

    const entries = Array.from(this.sessions.entries())
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    const toRemove = this.sessions.size - MAX_SESSIONS;
    for (let i = 0; i < toRemove; i++) {
      this.sessions.delete(entries[i][0]);
    }
    console.log(`[SessionManager] Evicted ${toRemove} oldest sessions (cap: ${MAX_SESSIONS})`);
  }
}

// Singleton instance
export const sessionManager = new SessionManager();

// Initialize on module load
sessionManager.load().catch((err) =>
  console.error("[SessionManager] Load error:", err)
);

// Periodic cleanup every hour
setInterval(() => {
  sessionManager.cleanup();
}, 60 * 60 * 1000);
