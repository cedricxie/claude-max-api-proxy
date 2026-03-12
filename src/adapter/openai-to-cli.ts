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
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }
  const stripped = model.replace(/^claude-code-cli\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }
  return "opus";
}

/**
 * Escape content that could be confused with our XML-like structural tags.
 * Replaces literal occurrences of tag names used in prompt construction
 * so user/tool content cannot forge role boundaries or tool calls.
 */
function escapeStructuralTags(text: string): string {
  return text
    .replace(/<\/?system>/g, (m) => `&lt;${m.slice(1)}`)
    .replace(/<\/?previous_response>/g, (m) => `&lt;${m.slice(1)}`)
    .replace(/<\/?tool_call>/g, (m) => `&lt;${m.slice(1)}`)
    .replace(/<\/?tool_result[^>]*>/g, (m) => `&lt;${m.slice(1)}`);
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
        const text = escapeStructuralTags(normalizeContent(msg.content));
        parts.push(`<system>\n${text}\n</system>\n`);
        break;
      }

      case "user": {
        const text = escapeStructuralTags(normalizeContent(msg.content));
        parts.push(text);
        break;
      }

      case "assistant": {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const textContent = normalizeContent(msg.content);
          const toolCallParts: string[] = [];
          if (textContent) toolCallParts.push(escapeStructuralTags(textContent));
          for (const tc of msg.tool_calls) {
            const fn = tc.function;
            // Reconstruct tool call as JSON — safe because JSON.stringify
            // handles escaping of the values within the JSON string.
            const callObj = {
              id: tc.id || "",
              name: fn.name,
              arguments:
                typeof fn.arguments === "string"
                  ? JSON.parse(fn.arguments)
                  : fn.arguments,
            };
            toolCallParts.push(
              `<tool_call>\n${JSON.stringify(callObj)}\n</tool_call>`
            );
          }
          parts.push(
            `<previous_response>\n${toolCallParts.join("\n")}\n</previous_response>\n`
          );
        } else {
          const text = escapeStructuralTags(normalizeContent(msg.content));
          parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        }
        break;
      }

      case "tool": {
        const toolContent = escapeStructuralTags(
          normalizeContent(msg.content)
        );
        const toolCallId = (msg.tool_call_id || "").replace(/"/g, "");
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
  // Respect tool_choice: "none" — do not expose tools at all
  const toolChoiceNone = request.tool_choice === "none";
  const tools =
    !toolChoiceNone && request.tools && request.tools.length > 0
      ? request.tools
      : null;
  return {
    prompt: messagesToPrompt(request.messages),
    model: extractModel(request.model),
    sessionId: request.user,
    hasTools: !!tools,
    toolSystemPrompt: tools ? toolsToSystemPrompt(tools) : null,
  };
}
