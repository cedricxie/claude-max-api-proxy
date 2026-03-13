/**
 * Session Manager
 *
 * Maps Clawdbot conversation IDs to Claude CLI session IDs
 * for maintaining conversation context across requests.
 */
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
const SESSION_FILE = path.join(process.env.HOME || "/tmp", ".claude-code-cli-sessions.json");
// Session TTL: 24 hours
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
class SessionManager {
    sessions = new Map();
    loaded = false;
    saveQueue = Promise.resolve();
    /**
     * Load sessions from disk
     */
    async load() {
        if (this.loaded)
            return;
        try {
            const data = await fs.readFile(SESSION_FILE, "utf-8");
            const parsed = JSON.parse(data);
            this.sessions = new Map(Object.entries(parsed));
            this.loaded = true;
            console.log(`[SessionManager] Loaded ${this.sessions.size} sessions`);
        }
        catch {
            // File doesn't exist or is invalid, start fresh
            this.sessions = new Map();
            this.loaded = true;
        }
    }
    /**
     * Save sessions to disk.
     * Serialized via a queue to prevent concurrent writes from corrupting the file.
     */
    async save() {
        this.saveQueue = this.saveQueue.then(async () => {
            const data = Object.fromEntries(this.sessions);
            await fs.writeFile(SESSION_FILE, JSON.stringify(data, null, 2));
        }).catch((err) => {
            console.error("[SessionManager] Write error:", err);
        });
        return this.saveQueue;
    }
    /**
     * Get or create a Claude session ID for a Clawdbot conversation
     */
    getOrCreate(clawdbotId, model = "sonnet") {
        const existing = this.sessions.get(clawdbotId);
        if (existing) {
            // Update last used time
            existing.lastUsedAt = Date.now();
            existing.model = model;
            return existing.claudeSessionId;
        }
        // Create new session
        const claudeSessionId = uuidv4();
        const mapping = {
            clawdbotId,
            claudeSessionId,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            model,
            cumulativeInputTokens: 0,
        };
        this.sessions.set(clawdbotId, mapping);
        console.log(`[SessionManager] Created session: ${clawdbotId} -> ${claudeSessionId}`);
        // Fire and forget save
        this.save().catch((err) => console.error("[SessionManager] Save error:", err));
        return claudeSessionId;
    }
    /**
     * Add input tokens to a session's cumulative count
     */
    addTokens(clawdbotId, inputTokens) {
        const s = this.sessions.get(clawdbotId);
        if (s && inputTokens > 0) {
            s.cumulativeInputTokens = (s.cumulativeInputTokens || 0) + inputTokens;
            this.save().catch((err) => console.error("[SessionManager] Save error:", err));
        }
    }
    /**
     * Get existing session if it exists
     */
    get(clawdbotId) {
        return this.sessions.get(clawdbotId);
    }
    /**
     * Delete a session
     */
    delete(clawdbotId) {
        const deleted = this.sessions.delete(clawdbotId);
        if (deleted) {
            this.save().catch((err) => console.error("[SessionManager] Save error:", err));
        }
        return deleted;
    }
    /**
     * Clean up expired sessions
     */
    cleanup() {
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
            this.save().catch((err) => console.error("[SessionManager] Save error:", err));
        }
        return removed;
    }
    /**
     * Get all active sessions
     */
    getAll() {
        return Array.from(this.sessions.values());
    }
    /**
     * Get session count
     */
    get size() {
        return this.sessions.size;
    }
}
// Singleton instance
export const sessionManager = new SessionManager();
// Initialize on module load
sessionManager.load().catch((err) => console.error("[SessionManager] Load error:", err));
// Periodic cleanup every hour
setInterval(() => {
    sessionManager.cleanup();
}, 60 * 60 * 1000);
//# sourceMappingURL=manager.js.map