/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints with tool-calling support.
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
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
    const subprocess = new ClaudeSubprocess();

    if (stream) {
      await handleStreamingResponse(res, subprocess, cliInput, requestId);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
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
  cliInput: CliInput,
  requestId: string
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.flushHeaders();
  res.write(":ok\n\n");

  const hasTools = cliInput.hasTools;

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;
    // When tools are present, we stream text incrementally but hold back
    // content once we see the start of a potential <tool_call> tag.
    // This avoids fully buffering the response while still catching tool calls.
    let pendingBuffer = "";

    /** Emit a text content chunk, handling the initial role emission */
    function emitTextChunk(content: string): void {
      if (!content || res.writableEnded) return;
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
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        let finishReason: "stop" | "tool_calls" = "stop";

        if (hasTools) {
          // Use result.result as authoritative source for tool-call parsing;
          // fall back to pending buffer if result.result is absent.
          const sourceText = result.result || pendingBuffer;

          if (sourceText) {
            const { text: cleanText, toolCalls } = parseToolCalls(sourceText);

            // Emit remaining text (already-streamed text was flushed
            // incrementally; this covers text after or around tool calls)
            if (cleanText) {
              emitTextChunk(cleanText);
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
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
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
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
        toolSystemPrompt: cliInput.toolSystemPrompt,
        hasTools: cliInput.hasTools,
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
  cliInput: CliInput,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        res.json(cliResultToOpenai(finalResult, requestId, cliInput.hasTools));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
        toolSystemPrompt: cliInput.toolSystemPrompt,
        hasTools: cliInput.hasTools,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
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
