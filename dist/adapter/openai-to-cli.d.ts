/**
 * Converts OpenAI chat request format to Claude CLI input
 */
import type { OpenAIChatRequest } from "../types/openai.js";
export type ClaudeModel = "opus" | "sonnet" | "haiku";
export interface CliInput {
    prompt: string;
    systemPrompt: string | null;
    model: ClaudeModel;
    sessionId?: string;
    hasTools: boolean;
    toolSystemPrompt: string | null;
}
/**
 * Extract Claude model alias from request model string
 */
export declare function extractModel(model: string): ClaudeModel;
/**
 * Extract system messages from the messages array.
 * Returns the concatenated system prompt text (or null if none).
 */
export declare function extractSystemPrompt(messages: OpenAIChatRequest["messages"]): string | null;
/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 * System messages are extracted separately via extractSystemPrompt() and
 * passed to the CLI via --system-prompt flag.
 */
export declare function messagesToPrompt(messages: OpenAIChatRequest["messages"]): string;
/**
 * Extract only the latest user message — used when resuming a session,
 * since Claude already has the prior history stored on disk.
 */
export declare function extractLastUserMessage(messages: OpenAIChatRequest["messages"]): string;
/**
 * Convert OpenAI chat request to CLI input format
 */
export declare function openaiToCli(request: OpenAIChatRequest): CliInput;
//# sourceMappingURL=openai-to-cli.d.ts.map