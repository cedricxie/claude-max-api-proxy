/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest, OpenAITool } from "../types/openai.js";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  sessionId?: string;
  hasTools: boolean;
  toolSystemPrompt: string | null;
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names
  "claude-opus-4": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-haiku-4": "haiku",
  // With provider prefix
  "claude-code-cli/claude-opus-4": "opus",
  "claude-code-cli/claude-sonnet-4": "sonnet",
  "claude-code-cli/claude-haiku-4": "haiku",
  // Aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  // Try direct lookup
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Try stripping provider prefix
  const stripped = model.replace(/^claude-code-cli\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Default to opus (Claude Max subscription)
  return "opus";
}

/**
 * Normalize message content to string.
 *
 * OpenAI messages can have string content, array of content parts, or null.
 */
function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((p: unknown) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const obj = p as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          if (obj.type === "text" && typeof obj.content === "string")
            return obj.content;
          if (typeof obj.content === "string") return obj.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"]
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system": {
        const text = normalizeContent(msg.content);
        parts.push(`<system>\n${text}\n</system>\n`);
        break;
      }

      case "user": {
        const text = normalizeContent(msg.content);
        parts.push(text);
        break;
      }

      case "assistant": {
        // Handle assistant messages with tool_calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const textContent = normalizeContent(msg.content);
          const toolCallParts: string[] = [];
          if (textContent) toolCallParts.push(textContent);
          for (const tc of msg.tool_calls) {
            const fn = tc.function;
            const args =
              typeof fn.arguments === "string"
                ? fn.arguments
                : JSON.stringify(fn.arguments);
            toolCallParts.push(
              `<tool_call>\n{"id": "${tc.id || ""}", "name": "${fn.name}", "arguments": ${args}}\n</tool_call>`
            );
          }
          parts.push(
            `<previous_response>\n${toolCallParts.join("\n")}\n</previous_response>\n`
          );
        } else {
          const text = normalizeContent(msg.content);
          parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        }
        break;
      }

      case "tool": {
        // Tool result message
        const toolContent = normalizeContent(msg.content);
        const toolCallId = msg.tool_call_id || "";
        parts.push(
          `<tool_result tool_call_id="${toolCallId}">\n${toolContent}\n</tool_result>\n`
        );
        break;
      }
    }
  }

  return parts.join("\n").trim();
}

/**
 * Convert OpenAI tools array to a system prompt section for Claude.
 *
 * This is injected via --append-system-prompt so Claude treats it as
 * authoritative system-level instructions rather than user text.
 */
function toolsToSystemPrompt(tools: OpenAITool[]): string {
  const toolDefs = tools
    .map((t) => {
      const fn = t.function;
      const paramStr = fn.parameters ? JSON.stringify(fn.parameters) : "{}";
      return `- ${fn.name}: ${fn.description || "(no description)"}\n  Parameters: ${paramStr}`;
    })
    .join("\n\n");

  return `You have access to external tools provided by the caller. To invoke a tool, you MUST output a <tool_call> block with valid JSON inside. This is NOT a suggestion — it is the mechanism by which tools are executed. The proxy will parse these blocks and execute the tools on your behalf.

Format (output this exactly):
<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

You may include text before or after tool_call blocks. You may call multiple tools using multiple <tool_call> blocks.

Available tools:
${toolDefs}

IMPORTANT: When the user's request requires using one of these tools, you MUST output the <tool_call> block. Do NOT say you cannot access the tool — the proxy handles execution.`;
}

/**
 * Extract only the latest user message — used when resuming a session,
 * since Claude already has the prior history stored on disk.
 */
export function extractLastUserMessage(
  messages: OpenAIChatRequest["messages"]
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return normalizeContent(messages[i].content);
    }
  }
  return "";
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const tools =
    request.tools && request.tools.length > 0 ? request.tools : null;
  return {
    prompt: messagesToPrompt(request.messages),
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
    hasTools: !!tools,
    toolSystemPrompt: tools ? toolsToSystemPrompt(tools) : null,
  };
}
