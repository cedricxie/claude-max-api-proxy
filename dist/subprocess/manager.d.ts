/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */
import { EventEmitter } from "events";
import type { ClaudeCliMessage, ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
export interface SubprocessOptions {
    model: ClaudeModel;
    sessionId?: string;
    useResume?: boolean;
    cwd?: string;
    timeout?: number;
    systemPrompt?: string | null;
    toolSystemPrompt?: string | null;
    hasTools?: boolean;
}
export interface SubprocessEvents {
    message: (msg: ClaudeCliMessage) => void;
    assistant: (msg: ClaudeCliAssistant) => void;
    result: (result: ClaudeCliResult) => void;
    error: (error: Error) => void;
    close: (code: number | null) => void;
    raw: (line: string) => void;
}
export declare class ClaudeSubprocess extends EventEmitter {
    private process;
    private buffer;
    private timeoutId;
    private isKilled;
    /**
     * Start the Claude CLI subprocess with the given prompt
     */
    start(prompt: string, options: SubprocessOptions): Promise<void>;
    /**
     * Build CLI arguments array
     */
    private buildArgs;
    /**
     * Process the buffer and emit parsed messages
     */
    private processBuffer;
    /**
     * Clear the timeout timer
     */
    private clearTimeout;
    /**
     * Kill the subprocess
     */
    kill(signal?: NodeJS.Signals): void;
    /**
     * Check if the process is still running
     */
    isRunning(): boolean;
}
/**
 * Verify that Claude CLI is installed and accessible
 */
export declare function verifyClaude(): Promise<{
    ok: boolean;
    error?: string;
    version?: string;
}>;
/**
 * Check if Claude CLI is authenticated by running `claude auth status`.
 */
export declare function verifyAuth(): Promise<{
    ok: boolean;
    error?: string;
}>;
//# sourceMappingURL=manager.d.ts.map