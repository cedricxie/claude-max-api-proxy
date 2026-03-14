/**
 * Session Manager
 *
 * Maps Clawdbot conversation IDs to Claude CLI session IDs
 * for maintaining conversation context across requests.
 */
export interface SessionMapping {
    clawdbotId: string;
    claudeSessionId: string;
    createdAt: number;
    lastUsedAt: number;
    model: string;
    cumulativeInputTokens: number;
    lastTotalContext?: number;
}
declare class SessionManager {
    private sessions;
    private loaded;
    private saveQueue;
    private locks;
    /**
     * Load sessions from disk
     */
    load(): Promise<void>;
    /**
     * Save sessions to disk.
     * Serialized via a queue to prevent concurrent writes from corrupting the file.
     */
    save(): Promise<void>;
    /**
     * Get or create a Claude session ID for a Clawdbot conversation
     */
    getOrCreate(clawdbotId: string, model?: string): string;
    /**
     * Add input tokens to a session's cumulative count
     */
    addTokens(clawdbotId: string, inputTokens: number): void;
    /**
     * Get existing session if it exists
     */
    get(clawdbotId: string): SessionMapping | undefined;
    /**
     * Delete a session
     */
    delete(clawdbotId: string): boolean;
    /**
     * Clean up expired sessions
     */
    cleanup(): number;
    /**
     * Get all active sessions
     */
    getAll(): SessionMapping[];
    /**
     * Get session count
     */
    get size(): number;
    /**
     * Acquire a per-session lock so concurrent requests for the same
     * session are serialized. Returns a release function.
     *
     * Includes a safety timeout (10 min) to prevent permanent hangs
     * if a lock holder crashes without releasing.
     */
    acquireLock(key: string): Promise<() => void>;
    /**
     * Evict oldest sessions if we exceed MAX_SESSIONS
     */
    private evictIfNeeded;
}
export declare const sessionManager: SessionManager;
export declare const sessionReady: Promise<void>;
export {};
//# sourceMappingURL=manager.d.ts.map