/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
const DEFAULT_TIMEOUT = 600000; // 10 minutes
/**
 * Sanitize session ID to prevent CLI argument injection.
 * Only allows alphanumeric characters, hyphens, and underscores.
 */
function sanitizeSessionId(id) {
    return id.replace(/[^a-zA-Z0-9\-_]/g, "");
}
export class ClaudeSubprocess extends EventEmitter {
    process = null;
    buffer = "";
    timeoutId = null;
    isKilled = false;
    /**
     * Start the Claude CLI subprocess with the given prompt
     */
    async start(prompt, options) {
        const args = this.buildArgs(options);
        const timeout = options.timeout || DEFAULT_TIMEOUT;
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn) => {
                if (!settled) {
                    settled = true;
                    fn();
                }
            };
            try {
                // Use spawn() for security - no shell interpretation
                // Unset CLAUDECODE so nested Claude sessions are allowed
                const spawnEnv = { ...process.env };
                delete spawnEnv.CLAUDECODE;
                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    env: spawnEnv,
                    stdio: ["pipe", "pipe", "pipe"],
                });
                // Set timeout
                this.timeoutId = setTimeout(() => {
                    if (!this.isKilled) {
                        this.isKilled = true;
                        this.process?.kill("SIGTERM");
                        // Follow up with SIGKILL if process doesn't exit within 5 seconds
                        const killTimer = setTimeout(() => {
                            try {
                                this.process?.kill("SIGKILL");
                            }
                            catch { /* already dead */ }
                        }, 5000);
                        killTimer.unref();
                        this.emit("error", new Error(`Request timed out after ${timeout}ms`));
                    }
                }, timeout);
                // Handle spawn errors (e.g., claude not found)
                this.process.on("error", (err) => {
                    this.clearTimeout();
                    if (err.message.includes("ENOENT")) {
                        settle(() => reject(new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code")));
                    }
                    else {
                        settle(() => reject(err));
                    }
                });
                // Pass prompt via stdin to avoid ARG_MAX limits on large conversations
                this.process.stdin?.write(prompt);
                this.process.stdin?.end();
                console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);
                // Parse JSON stream from stdout
                this.process.stdout?.on("data", (chunk) => {
                    const data = chunk.toString();
                    console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
                    this.buffer += data;
                    this.processBuffer();
                });
                // Capture stderr for debugging
                this.process.stderr?.on("data", (chunk) => {
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        // Don't emit as error unless it's actually an error
                        // Claude CLI may write debug info to stderr
                        console.error("[Subprocess stderr]:", errorText.slice(0, 200));
                    }
                });
                // Handle process close
                this.process.on("close", (code) => {
                    console.error(`[Subprocess] Process closed with code: ${code}`);
                    this.clearTimeout();
                    // Process any remaining buffer
                    if (this.buffer.trim()) {
                        this.processBuffer();
                    }
                    this.emit("close", code);
                });
                // Resolve immediately since we're streaming
                settle(() => resolve());
            }
            catch (err) {
                this.clearTimeout();
                settle(() => reject(err));
            }
        });
    }
    /**
     * Build CLI arguments array
     */
    buildArgs(options) {
        const args = [
            "--print", // Non-interactive mode
            "--output-format",
            "stream-json", // JSON streaming output
            "--verbose", // Required for stream-json
            "--include-partial-messages", // Enable streaming chunks
        ];
        if (options.useResume && options.sessionId) {
            // Resume existing session — Claude loads history from disk
            args.push("--resume", sanitizeSessionId(options.sessionId));
        }
        else {
            args.push("--model", options.model);
            if (options.sessionId) {
                args.push("--session-id", sanitizeSessionId(options.sessionId));
            }
        }
        // Pass system prompt via --system-prompt flag so Claude CLI treats it as
        // authoritative system instructions, not user text that could be ignored.
        //
        // Skip on resume: the CLI session already has the system prompt baked in
        // from the first turn. Re-sending could override saved session state.
        //
        // When both systemPrompt and toolSystemPrompt are present, consolidate
        // into a single --system-prompt to avoid undefined interaction between
        // --system-prompt (replaces built-in) and --append-system-prompt (appends to built-in).
        const isResume = options.useResume && options.sessionId;
        const sysPrompt = isResume ? null : options.systemPrompt;
        if (sysPrompt && options.toolSystemPrompt) {
            args.push("--system-prompt", sysPrompt + "\n\n" + options.toolSystemPrompt);
            args.push("--tools", "", "--");
        }
        else if (sysPrompt) {
            args.push("--system-prompt", sysPrompt);
        }
        else if (options.toolSystemPrompt) {
            // No caller system prompt — append tool defs to CLI's built-in system prompt.
            args.push("--append-system-prompt", options.toolSystemPrompt);
            args.push("--tools", "", "--");
        }
        // Prompt is passed via stdin (not argv) to avoid OS ARG_MAX limits
        return args;
    }
    /**
     * Process the buffer and emit parsed messages
     */
    processBuffer() {
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || ""; // Keep incomplete line
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const message = JSON.parse(trimmed);
                this.emit("message", message);
                if (isContentDelta(message)) {
                    // Emit content delta for streaming
                    this.emit("content_delta", message);
                }
                else if (isAssistantMessage(message)) {
                    this.emit("assistant", message);
                }
                else if (isResultMessage(message)) {
                    this.emit("result", message);
                }
            }
            catch {
                // Non-JSON output, emit as raw
                this.emit("raw", trimmed);
            }
        }
    }
    /**
     * Clear the timeout timer
     */
    clearTimeout() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }
    /**
     * Kill the subprocess
     */
    kill(signal = "SIGTERM") {
        if (!this.isKilled && this.process) {
            this.isKilled = true;
            this.clearTimeout();
            this.process.kill(signal);
        }
    }
    /**
     * Check if the process is still running
     */
    isRunning() {
        return this.process !== null && !this.isKilled && this.process.exitCode === null;
    }
}
/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude() {
    return new Promise((resolve) => {
        const proc = spawn("claude", ["--version"], { stdio: "pipe" });
        let output = "";
        proc.stdout?.on("data", (chunk) => {
            output += chunk.toString();
        });
        proc.on("error", () => {
            resolve({
                ok: false,
                error: "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
            });
        });
        proc.on("close", (code) => {
            if (code === 0) {
                resolve({ ok: true, version: output.trim() });
            }
            else {
                resolve({
                    ok: false,
                    error: "Claude CLI returned non-zero exit code",
                });
            }
        });
    });
}
/**
 * Check if Claude CLI is authenticated by running `claude auth status`.
 */
export async function verifyAuth() {
    return new Promise((resolve) => {
        const proc = spawn("claude", ["auth", "status"], { stdio: "pipe" });
        let output = "";
        proc.stdout?.on("data", (chunk) => {
            output += chunk.toString();
        });
        proc.stderr?.on("data", (chunk) => {
            output += chunk.toString();
        });
        proc.on("error", () => {
            resolve({ ok: false, error: "Claude CLI not found" });
        });
        proc.on("close", (code) => {
            if (code === 0) {
                resolve({ ok: true });
            }
            else {
                resolve({
                    ok: false,
                    error: `Claude CLI auth check failed: ${output.trim().slice(0, 200)}`,
                });
            }
        });
    });
}
//# sourceMappingURL=manager.js.map