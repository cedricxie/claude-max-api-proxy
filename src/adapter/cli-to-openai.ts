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
/**
 * Try to extract a JSON object starting at the given position in text.
 * Handles nested braces so that `</tool_call>` inside a JSON string
 * value does not prematurely terminate the match.
 * Returns the parsed object and end index, or null on failure.
 */
function extractJsonObject(
  text: string,
  start: number
): { value: Record<string, unknown>; end: number } | null {
  let i = start;
  // Skip whitespace
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1).trim();
        try {
          const value = JSON.parse(jsonStr);
          return { value, end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function parseToolCalls(text: string): {
  text: string;
  toolCalls: OpenAIToolCall[];
} {
  const toolCalls: OpenAIToolCall[] = [];
  const parsedRanges: Array<{ start: number; end: number }> = [];
  const OPEN_TAG = "<tool_call>";
  const CLOSE_TAG = "</tool_call>";
  let callIndex = 0;
  let searchFrom = 0;

  while (true) {
    const tagStart = text.indexOf(OPEN_TAG, searchFrom);
    if (tagStart === -1) break;

    const jsonStart = tagStart + OPEN_TAG.length;
    const extracted = extractJsonObject(text, jsonStart);

    if (extracted) {
      const parsed = extracted.value;
      // Find closing tag after the JSON object
      let closeStart = extracted.end;
      // Skip whitespace
      while (closeStart < text.length && /\s/.test(text[closeStart]))
        closeStart++;
      if (text.startsWith(CLOSE_TAG, closeStart)) {
        const blockEnd = closeStart + CLOSE_TAG.length;

        // Validate required fields
        if (typeof parsed.name === "string" && parsed.name) {
          toolCalls.push({
            id:
              typeof parsed.id === "string" && parsed.id
                ? parsed.id
                : `call_${Date.now()}_${callIndex}`,
            type: "function",
            function: {
              name: parsed.name as string,
              arguments:
                typeof parsed.arguments === "string"
                  ? parsed.arguments
                  : JSON.stringify(parsed.arguments || {}),
            },
          });
          parsedRanges.push({ start: tagStart, end: blockEnd });
          callIndex++;
        } else {
          console.error(
            "[parseToolCalls] Missing or invalid 'name':",
            JSON.stringify(parsed).slice(0, 200)
          );
        }
        searchFrom = blockEnd;
      } else {
        // No closing tag found after JSON — skip this occurrence
        searchFrom = tagStart + OPEN_TAG.length;
      }
    } else {
      // Could not extract JSON — try regex fallback for simple cases
      searchFrom = tagStart + OPEN_TAG.length;
    }
  }

  // Remove only successfully parsed blocks from text
  let cleanText = text;
  if (parsedRanges.length > 0) {
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
