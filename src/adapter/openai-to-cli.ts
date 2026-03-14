/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest, OpenAITool } from "../types/openai.js";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliInput {
  prompt: string;
  systemPrompt: string | null;
  model: ClaudeModel;
  sessionId?: string;
  hasTools: boolean;
  toolSystemPrompt: string | null;
  toolNames: string[];
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
  // Unified regex: escape all structural tags, with or without attributes
  return text
    .replace(/<\/?(system|previous_response|tool_call|tool_result)[\s>\/][^>]*>|<\/?(system|previous_response|tool_call|tool_result)>/g,
      (m) => `&lt;${m.slice(1)}`);
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
 * Extract system messages from the messages array.
 * Returns the concatenated system prompt text (or null if none).
 * Multiple system messages are joined in original order with double newlines.
 *
 * Note: escapeStructuralTags is intentionally NOT applied here — system content
 * is passed via --system-prompt flag (authoritative channel) and is never embedded
 * in the user prompt string where structural tags could cause parsing confusion.
 */
export function extractSystemPrompt(
  messages: OpenAIChatRequest["messages"]
): string | null {
  const systemParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const text = normalizeContent(msg.content);
      if (text) systemParts.push(text);
    }
  }
  return systemParts.length > 0 ? systemParts.join("\n\n") : null;
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 * System messages are extracted separately via extractSystemPrompt() and
 * passed to the CLI via --system-prompt flag.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"]
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        // Handled by extractSystemPrompt() — skip here
        break;

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
            let argsObj: unknown;
            if (typeof fn.arguments === "string") {
              try {
                argsObj = JSON.parse(fn.arguments);
              } catch {
                // Malformed arguments string — pass through as-is
                argsObj = fn.arguments;
              }
            } else {
              argsObj = fn.arguments;
            }
            // Sanitize id and name to prevent structural injection
            const safeId = (tc.id || "").replace(/[^a-zA-Z0-9_\-]/g, "");
            const safeName = (fn.name || "").replace(/[^a-zA-Z0-9_\-]/g, "");
            const callObj = { id: safeId, name: safeName, arguments: argsObj };
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
        // Sanitize tool_call_id: strip anything that could break XML attribute context
        const toolCallId = (msg.tool_call_id || "").replace(/[^a-zA-Z0-9_\-]/g, "");
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
function toolsToSystemPrompt(tools: OpenAITool[], required: boolean = false): string {
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
{"id": "call_1", "name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

IMPORTANT: Always include a unique "id" field in each tool call (e.g. "call_1", "call_2"). This ID is used to match tool results back to the corresponding tool call.

You may include text before or after tool_call blocks. You may call multiple tools using multiple <tool_call> blocks.

Available tools:
${toolDefs}

IMPORTANT: When the user's request requires using one of these tools, you MUST output the <tool_call> block. Do NOT say you cannot access the tool — the proxy handles execution.${required ? "\n\nYou MUST call at least one tool in your response. Do NOT respond with only text — a tool call is REQUIRED." : ""}`;

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
      return escapeStructuralTags(normalizeContent(messages[i].content));
    }
  }
  return "";
}

/**
 * Extract new turn content for session resume — includes tool results
 * and the latest user message.
 *
 * When resuming a Claude CLI session, the CLI already has conversation
 * history up to its last assistant response. We need to send everything
 * that happened AFTER that last assistant response:
 *   - tool result messages (from tool calls Claude made)
 *   - new user messages
 *
 * Without this, tool results are silently dropped on resume and Claude
 * reports "tools didn't return results".
 */
export function extractNewTurnContent(
  messages: OpenAIChatRequest["messages"]
): string {
  // Find the last assistant message — everything after it is new
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  // No assistant message found — fall back to last user message
  if (lastAssistantIdx === -1) {
    return extractLastUserMessage(messages);
  }

  // Collect all messages after the last assistant message
  const newMessages = messages.slice(lastAssistantIdx + 1);
  if (newMessages.length === 0) {
    return "";
  }

  // Check if there are any tool results — if not, just return the last user message
  const hasToolResults = newMessages.some((m) => m.role === "tool");
  if (!hasToolResults) {
    return extractLastUserMessage(messages);
  }

  // Format tool results and user messages for the resume prompt
  const parts: string[] = [];
  for (const msg of newMessages) {
    switch (msg.role) {
      case "tool": {
        const toolContent = escapeStructuralTags(
          normalizeContent(msg.content)
        );
        const toolCallId = (msg.tool_call_id || "").replace(
          /[^a-zA-Z0-9_\-]/g,
          ""
        );
        parts.push(
          `<tool_result tool_call_id="${toolCallId}">\n${toolContent}\n</tool_result>`
        );
        break;
      }
      case "user": {
        parts.push(escapeStructuralTags(normalizeContent(msg.content)));
        break;
      }
      // Skip system (handled separately) and assistant (already in CLI session)
    }
  }

  return parts.join("\n\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  // Respect tool_choice
  const toolChoice = request.tool_choice;
  let tools: OpenAITool[] | null = null;

  let toolRequired = false;

  if (toolChoice === "none") {
    tools = null;
  } else if (request.tools && request.tools.length > 0) {
    if (toolChoice === "required") {
      tools = request.tools;
      toolRequired = true;
    } else if (
      toolChoice &&
      typeof toolChoice === "object" &&
      toolChoice.type === "function" &&
      toolChoice.function?.name
    ) {
      const forced = request.tools.filter(
        (t) => t.function.name === toolChoice.function.name
      );
      tools = forced.length > 0 ? forced : null;
      toolRequired = !!tools; // forced function implies required
    } else {
      tools = request.tools;
    }
  }

  return {
    prompt: messagesToPrompt(request.messages),
    systemPrompt: extractSystemPrompt(request.messages),
    model: extractModel(request.model),
    sessionId: request.user,
    hasTools: !!tools,
    toolSystemPrompt: tools ? toolsToSystemPrompt(tools, toolRequired) : null,
    toolNames: tools ? tools.map((t) => t.function.name) : [],
  };
}
