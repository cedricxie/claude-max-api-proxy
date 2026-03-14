/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints with tool-calling support
 * and session management for multi-turn conversations.
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, extractNewTurnContent } from "../adapter/openai-to-cli.js";
import type { CliInput } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
  parseToolCalls,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type {
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import { sessionManager } from "../session/manager.js";

/**
 * Normalize message content to a stable string for hashing.
 * Handles both string and array-of-parts formats so that
 * semantically identical content produces the same key.
 */
function normalizeContentForKey(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((p: unknown) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const obj = p as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

interface SessionInput {
  prompt: string;
  systemPrompt?: string | null;
  model: string;
  sessionId?: string;
  useResume: boolean;
  conversationKey: string | null;
  toolSystemPrompt?: string | null;
  hasTools?: boolean;
  toolNames?: string[];
}

/**
 * Derive a stable conversation key from the messages array when body.user is not set.
 *
 * Uses the first user message content (+ a prefix of the system prompt for disambiguation)
 * as a fingerprint. This is stable across all turns of the same conversation because
 * the first user message never changes once the conversation starts.
 */
function deriveConversationKey(
  messages: OpenAIChatRequest["messages"]
): string | null {
  if (!messages || messages.length < 2) return null;

  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return null;

  const userContent = normalizeContentForKey(firstUser.content);

  const sys = messages.find((m) => m.role === "system");
  const sysPrefix = sys
    ? normalizeContentForKey(sys.content).slice(0, 200)
    : "";

  return createHash("sha256")
    .update(sysPrefix + "|" + userContent)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Resolve session info for a request.
 *
 * - If body.user is set, use it as a stable conversation key.
 * - Otherwise, derive a key from the first user message so sessions can be
 *   resumed across turns even when the caller doesn't set body.user.
 *   - First turn: create a new pinned session ID, send full prompt.
 *   - Subsequent turns: resume that session, send only the latest user message.
 */
function resolveSessionInput(
  body: OpenAIChatRequest,
  cliInput: CliInput
): SessionInput {
  const conversationKey =
    body.user || deriveConversationKey(body.messages);

  if (!conversationKey) {
    return {
      prompt: cliInput.prompt,
      model: cliInput.model,
      sessionId: undefined,
      useResume: false,
      conversationKey: null,
    };
  }

  const existing = sessionManager.get(conversationKey);

  if (existing) {
    // Resume: only send the latest user message — Claude has the rest in its session file
    // Call getOrCreate (not just get) so lastUsedAt is updated and session won't expire
    const sessionId = sessionManager.getOrCreate(
      conversationKey,
      existing.model
    );
    // Extract new turn content — includes tool results + latest user message.
    // This is critical: without tool results, Claude can't see tool execution output.
    const newContent = extractNewTurnContent(body.messages);
    if (!newContent) {
      // No new content found — can't resume with empty prompt.
      // Delete stale session and start fresh to avoid duplicating history.
      sessionManager.delete(conversationKey);
      const freshSessionId = sessionManager.getOrCreate(
        conversationKey,
        cliInput.model
      );
      console.log(
        `[Session] No new content for resume, starting fresh session ${freshSessionId} for key "${conversationKey}"`
      );
      return {
        prompt: cliInput.prompt,
        model: cliInput.model,
        sessionId: freshSessionId,
        useResume: false,
        conversationKey,
      };
    }
    console.log(
      `[Session] Resuming session ${sessionId} for key "${conversationKey}" (${existing.cumulativeInputTokens || 0} tokens)`
    );
    return {
      prompt: newContent,
      model: existing.model,
      sessionId,
      useResume: true,
      conversationKey,
    };
  } else {
    // First turn: pin a UUID session ID so we can resume it later
    const sessionId = sessionManager.getOrCreate(
      conversationKey,
      cliInput.model
    );
    console.log(
      `[Session] New session ${sessionId} for key "${conversationKey}"`
    );
    return {
      prompt: cliInput.prompt,
      model: cliInput.model,
      sessionId,
      useResume: false,
      conversationKey,
    };
  }
}

/**
 * Handle POST /v1/chat/completions
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    if (
      !body.messages ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    const cliInput = openaiToCli(body);
    const sessionInput = resolveSessionInput(body, cliInput);
    sessionInput.systemPrompt = cliInput.systemPrompt || null;
    sessionInput.toolSystemPrompt = cliInput.toolSystemPrompt || null;
    sessionInput.hasTools = cliInput.hasTools || false;
    sessionInput.toolNames = cliInput.toolNames || [];

    // Serialize concurrent requests for the same session to avoid
    // race conditions in the CLI subprocess
    const lockKey = sessionInput.conversationKey;
    const releaseLock = lockKey
      ? await sessionManager.acquireLock(lockKey)
      : null;

    try {
      const subprocess = new ClaudeSubprocess();

      if (stream) {
        await handleStreamingResponse(
          res,
          subprocess,
          sessionInput,
          requestId
        );
      } else {
        await handleNonStreamingResponse(
          res,
          subprocess,
          sessionInput,
          requestId
        );
      }
    } finally {
      releaseLock?.();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle streaming response (SSE)
 *
 * When tools are present, text is buffered until completion so we can
 * detect <tool_call> blocks and emit them as proper OpenAI tool_calls
 * chunks instead of raw text.
 *
 * Uses result.result as authoritative source for tool-call parsing when
 * available, falling back to buffered content_delta text.
 */
async function handleStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  sessionInput: SessionInput,
  requestId: string
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.flushHeaders();
  res.write(":ok\n\n");

  const hasTools = sessionInput.hasTools || false;
  const conversationKey = sessionInput.conversationKey;

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;
    // When tools are present, we stream text incrementally but hold back
    // content once we see the start of a potential <tool_call> tag.
    let pendingBuffer = "";
    // Track how many chars of text were already streamed to clients
    let streamedCharCount = 0;
    // Track the last assistant message's usage — this reflects the ACTUAL
    // current context size, unlike result.usage which is cumulative across
    // all API calls (tool-use turns) within a single CLI invocation.
    let lastAssistantUsage: ClaudeCliAssistant["message"]["usage"] | null =
      null;

    /** Emit a text content chunk, handling the initial role emission */
    function emitTextChunk(
      content: string,
      trackStreamed: boolean = true
    ): void {
      if (!content || res.writableEnded) return;
      if (trackStreamed) streamedCharCount += content.length;
      const chunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: lastModel,
        choices: [
          {
            index: 0,
            delta: {
              role: isFirst ? ("assistant" as const) : undefined,
              content,
            },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      isFirst = false;
    }

    res.on("close", () => {
      if (!isComplete) {
        subprocess.kill();
      }
      resolve();
    });

    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const text = event.event.delta?.text || "";
      if (!text || res.writableEnded) return;

      if (!hasTools) {
        emitTextChunk(text);
        return;
      }

      // Incremental streaming with tool-call awareness:
      // Buffer text and flush everything before any `<tool_call>` prefix.
      pendingBuffer += text;
      const tagIdx = pendingBuffer.indexOf("<tool_call>");
      if (tagIdx === -1) {
        // No tool_call tag seen. Check if the tail could be a partial tag.
        // "<tool_call>" is 11 chars; keep up to 10 chars as lookahead.
        const safeEnd = Math.max(0, pendingBuffer.length - 10);
        if (safeEnd > 0) {
          emitTextChunk(pendingBuffer.slice(0, safeEnd));
          pendingBuffer = pendingBuffer.slice(safeEnd);
        }
      }
      // If tag found, hold the buffer — will be processed on result
    });

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
      if (message.message.usage) {
        lastAssistantUsage = message.message.usage;
      }
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;

      // Handle CLI error results (auth expired, context exceeded, etc.)
      if (result.is_error || result.subtype === "error") {
        console.error("[Streaming] CLI error result:", result.result?.slice(0, 200));
        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: result.result || "Claude CLI returned an error",
                type: "server_error",
                code: "cli_error",
              },
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
        // Reset session on error to avoid resuming a broken state
        if (conversationKey) {
          sessionManager.delete(conversationKey);
        }
        resolve();
        return;
      }

      // Use lastAssistantUsage (last API call) for context-related metrics.
      // result.usage is cumulative across all tool-use turns and would
      // inflate context size by N× where N = number of turns.
      const contextUsage = lastAssistantUsage || result?.usage;

      // Track context growth for cap (exclude cache_read — it's re-reading
      // existing context, not new growth)
      const contextGrowth =
        (contextUsage?.input_tokens || 0) +
        (contextUsage?.cache_creation_input_tokens || 0);
      if (conversationKey && contextGrowth > 0) {
        sessionManager.addTokens(conversationKey, contextGrowth);
      }

      // Detect CLI auto-compaction by total context token drop.
      // Total context = input_tokens + cache_read + cache_creation.
      // After compaction, cache_read drops to ~0 and total shrinks dramatically.
      // If total dropped >50% vs last turn, CLI compacted — reset session.
      if (conversationKey && sessionInput.useResume) {
        const session = sessionManager.get(conversationKey);
        const totalContext =
          (contextUsage?.input_tokens || 0) +
          (contextUsage?.cache_read_input_tokens || 0) +
          (contextUsage?.cache_creation_input_tokens || 0);
        if (
          session?.lastTotalContext &&
          totalContext > 0 &&
          totalContext < session.lastTotalContext * 0.5
        ) {
          console.log(
            `[Session] Compaction detected for "${conversationKey}" — context dropped ${session.lastTotalContext} → ${totalContext}. Resetting session.`
          );
          sessionManager.delete(conversationKey);
        } else if (session && totalContext > 0) {
          session.lastTotalContext = totalContext;
          sessionManager.save().catch(() => {});
        }
      }

      if (!res.writableEnded) {
        let finishReason: "stop" | "tool_calls" = "stop";

        if (hasTools) {
          // Use result.result as authoritative source for tool-call parsing;
          // fall back to pending buffer if result.result is absent.
          const sourceText = result.result || pendingBuffer;

          if (sourceText) {
            const { text: cleanText, toolCalls } = parseToolCalls(sourceText, sessionInput.toolNames);

            // Only emit text that hasn't been streamed yet.
            if (cleanText && cleanText.length > streamedCharCount) {
              const remaining = cleanText.slice(streamedCharCount);
              if (remaining) emitTextChunk(remaining, false);
            }

            if (toolCalls.length > 0) {
              finishReason = "tool_calls";
              // Ensure role chunk is emitted before tool_calls
              if (isFirst) {
                const roleChunk = {
                  id: `chatcmpl-${requestId}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: lastModel,
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant" as const },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
                isFirst = false;
              }
              for (let i = 0; i < toolCalls.length; i++) {
                const tc = toolCalls[i];
                const toolChunk = {
                  id: `chatcmpl-${requestId}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: lastModel,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: i,
                            id: tc.id,
                            type: "function" as const,
                            function: {
                              name: tc.function.name,
                              arguments: tc.function.arguments,
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
              }
            }
          } else if (pendingBuffer) {
            // No result.result and no tool calls — flush remaining buffer
            emitTextChunk(pendingBuffer);
          }
        }

        // Emit usage chunk if the CLI provided token counts.
        // Use contextUsage for prompt_tokens (actual context size),
        // but result.usage for output_tokens (cumulative is correct for billing).
        const cu = contextUsage;
        const cumulativeOutput = result?.usage?.output_tokens || 0;
        if (cu && ((cu.input_tokens || 0) > 0 || cumulativeOutput > 0)) {
          const usageChunk = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: lastModel,
            choices: [
              { index: 0, delta: {}, finish_reason: finishReason },
            ],
            usage: {
              prompt_tokens:
                (cu.input_tokens || 0) +
                (cu.cache_read_input_tokens || 0) +
                (cu.cache_creation_input_tokens || 0),
              completion_tokens: cumulativeOutput,
              total_tokens:
                (cu.input_tokens || 0) +
                cumulativeOutput +
                (cu.cache_read_input_tokens || 0) +
                (cu.cache_creation_input_tokens || 0),
              input_tokens: cu.input_tokens || 0,
              output_tokens: cumulativeOutput,
              cache_read_input_tokens: cu.cache_read_input_tokens || 0,
              cache_creation_input_tokens:
                cu.cache_creation_input_tokens || 0,
            },
          };
          res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
        }

        const doneChunk = createDoneChunk(requestId, lastModel);
        if (finishReason === "tool_calls") {
          doneChunk.choices[0].finish_reason = "tool_calls";
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: error.message,
              type: "server_error",
              code: null,
            },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (!isComplete && !res.writableEnded) {
        // Only handle close if result handler didn't already finish the response
        if (code !== 0) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: `Process exited with code ${code}`,
                type: "server_error",
                code: null,
              },
            })}\n\n`
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess
      .start(sessionInput.prompt, {
        model: sessionInput.model as import("../adapter/openai-to-cli.js").ClaudeModel,
        sessionId: sessionInput.sessionId,
        useResume: sessionInput.useResume,
        systemPrompt: sessionInput.systemPrompt,
        toolSystemPrompt: sessionInput.toolSystemPrompt,
        hasTools: sessionInput.hasTools,
      })
      .catch((err) => {
        console.error("[Streaming] Subprocess start error:", err);
        reject(err);
      });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  sessionInput: SessionInput,
  requestId: string
): Promise<void> {
  const hasTools = sessionInput.hasTools || false;
  const conversationKey = sessionInput.conversationKey;

  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    let cliErrorMessage: string | null = null;
    let lastAssistantUsage: ClaudeCliAssistant["message"]["usage"] | null =
      null;

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      if (message.message.usage) {
        lastAssistantUsage = message.message.usage;
      }
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      // Handle CLI error results (auth expired, context exceeded, etc.)
      if (result.is_error || result.subtype === "error") {
        console.error("[NonStreaming] CLI error result:", result.result?.slice(0, 200));
        cliErrorMessage = result.result || "Claude CLI returned an error";
        if (conversationKey) {
          sessionManager.delete(conversationKey);
        }
        return;
      }

      finalResult = result;

      // Track context growth
      const contextUsage = lastAssistantUsage || result?.usage;
      const contextGrowth =
        (contextUsage?.input_tokens || 0) +
        (contextUsage?.cache_creation_input_tokens || 0);
      if (conversationKey && contextGrowth > 0) {
        sessionManager.addTokens(conversationKey, contextGrowth);
      }

      // Detect CLI auto-compaction (same logic as streaming handler)
      if (conversationKey && sessionInput.useResume) {
        const session = sessionManager.get(conversationKey);
        const totalContext =
          (contextUsage?.input_tokens || 0) +
          (contextUsage?.cache_read_input_tokens || 0) +
          (contextUsage?.cache_creation_input_tokens || 0);
        if (
          session?.lastTotalContext &&
          totalContext > 0 &&
          totalContext < session.lastTotalContext * 0.5
        ) {
          console.log(
            `[Session] Compaction detected for "${conversationKey}" — context dropped ${session.lastTotalContext} → ${totalContext}. Resetting session.`
          );
          sessionManager.delete(conversationKey);
        } else if (session && totalContext > 0) {
          session.lastTotalContext = totalContext;
          sessionManager.save().catch(() => {});
        }
      }
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      try {
        if (finalResult) {
          res.json(cliResultToOpenai(finalResult, requestId, hasTools, sessionInput.toolNames));
        } else if (!res.headersSent) {
          res.status(500).json({
            error: {
              message: cliErrorMessage || `Claude CLI exited with code ${code} without response`,
              type: "server_error",
              code: cliErrorMessage ? "cli_error" : null,
            },
          });
        }
      } catch (err) {
        console.error("[NonStreaming] Error sending response:", err);
        if (!res.headersSent) {
          res.status(500).json({
            error: {
              message: String(err),
              type: "server_error",
              code: null,
            },
          });
        }
      }
      resolve();
    });

    subprocess
      .start(sessionInput.prompt, {
        model: sessionInput.model as import("../adapter/openai-to-cli.js").ClaudeModel,
        sessionId: sessionInput.sessionId,
        useResume: sessionInput.useResume,
        systemPrompt: sessionInput.systemPrompt,
        toolSystemPrompt: sessionInput.toolSystemPrompt,
        hasTools: sessionInput.hasTools,
      })
      .catch((error) => {
        if (!res.headersSent) {
          res.status(500).json({
            error: {
              message: error.message,
              type: "server_error",
              code: null,
            },
          });
        }
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 */
export function handleModels(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: [
      {
        id: "claude-opus-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-sonnet-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-haiku-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
    ],
  });
}

/**
 * Handle GET /health
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
