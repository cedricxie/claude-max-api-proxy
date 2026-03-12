/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type {
  OpenAIChatResponse,
  OpenAIChatChunk,
  OpenAIToolCall,
} from "../types/openai.js";

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Parse <tool_call> blocks from Claude's text response.
 * Returns { text, toolCalls } where text has only successfully parsed
 * tool_call blocks removed. Malformed blocks are preserved in text.
 */
export function parseToolCalls(text: string): {
  text: string;
  toolCalls: OpenAIToolCall[];
} {
  const toolCalls: OpenAIToolCall[] = [];
  const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  // Track offsets of successfully parsed blocks for removal
  const parsedRanges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  let callIndex = 0;

  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);

      // Validate required fields
      if (typeof parsed.name !== "string" || !parsed.name) {
        console.error(
          "[parseToolCalls] Missing or invalid 'name':",
          match[1].slice(0, 200)
        );
        continue;
      }

      toolCalls.push({
        id: typeof parsed.id === "string" && parsed.id
          ? parsed.id
          : `call_${Date.now()}_${callIndex}`,
        type: "function",
        function: {
          name: parsed.name,
          arguments:
            typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments || {}),
        },
      });
      parsedRanges.push({ start: match.index, end: match.index + match[0].length });
      callIndex++;
    } catch {
      // Failed to parse — leave this block in text (don't add to parsedRanges)
      console.error(
        "[parseToolCalls] Failed to parse:",
        match[1].slice(0, 200)
      );
    }
  }

  // Remove only successfully parsed blocks from text
  let cleanText = text;
  if (parsedRanges.length > 0) {
    // Remove in reverse order to preserve offsets
    for (let i = parsedRanges.length - 1; i >= 0; i--) {
      const { start, end } = parsedRanges[i];
      cleanText = cleanText.slice(0, start) + cleanText.slice(end);
    }
    cleanText = cleanText.replace(/\n{3,}/g, "\n\n").trim();
  }

  return { text: cleanText, toolCalls };
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(
  requestId: string,
  model: string
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  hasTools: boolean = false
): OpenAIChatResponse {
  const modelName = result.modelUsage
    ? Object.keys(result.modelUsage)[0]
    : "claude-sonnet-4";

  const resultText = result.result || "";
  const { text, toolCalls } = hasTools
    ? parseToolCalls(resultText)
    : { text: resultText, toolCalls: [] };

  const message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  } = {
    role: "assistant",
    content: text || null,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage?.input_tokens || 0,
      completion_tokens: result.usage?.output_tokens || 0,
      total_tokens:
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
    },
  };
}

/**
 * Normalize Claude model names to a consistent format
 */
function normalizeModelName(model: string): string {
  if (!model) return "claude-sonnet-4";
  if (model.includes("opus")) return "claude-opus-4";
  if (model.includes("sonnet")) return "claude-sonnet-4";
  if (model.includes("haiku")) return "claude-haiku-4";
  return model;
}
