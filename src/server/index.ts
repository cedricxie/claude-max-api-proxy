/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import * as zlib from "zlib";
import { handleChatCompletions, handleModels, handleHealth } from "./routes.js";
import { sessionReady } from "../session/manager.js";

// Runtime feature detection: zstdDecompressSync is available in Node.js 22+.
// The second options argument (e.g. maxOutputLength) exists at runtime but
// is not yet reflected in @types/node, so we use a broad signature here.
const zstdDecompressSync: ((buf: Buffer, opts?: Record<string, unknown>) => Buffer) | null =
  typeof (zlib as any).zstdDecompressSync === "function"
    ? (zlib as any).zstdDecompressSync
    : null;

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB, matches express.json limit

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

/**
 * Create and configure the Express app
 */
function createApp(): Express {
  const app = express();

  // Decompress zstd-encoded request bodies.
  // Some OpenAI-compatible clients send Content-Encoding: zstd which
  // Express's built-in JSON parser does not handle.
  // Falls back to a 415 error on Node < 22 where zstd is unavailable.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers["content-encoding"] === "zstd") {
      if (!zstdDecompressSync) {
        res.status(415).json({
          error: {
            message:
              "zstd content-encoding is not supported on this Node.js version (requires 22+)",
            type: "invalid_request_error",
            code: "unsupported_content_encoding",
          },
        });
        return;
      }
      let totalBytes = 0;
      let aborted = false;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          aborted = true;
          res.status(413).json({
            error: {
              message: "Request entity too large",
              type: "invalid_request_error",
              code: "entity_too_large",
            },
          });
          req.resume(); // drain remaining data
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (aborted) return;
        try {
          const compressed = Buffer.concat(chunks);
          // Use maxOutputLength to cap decompressed size during decompression,
          // preventing high-ratio zstd bombs from exhausting memory.
          const decompressed = zstdDecompressSync!(compressed, {
            maxOutputLength: MAX_BODY_BYTES,
          });
          const parsed = JSON.parse(decompressed.toString());
          if (parsed == null || typeof parsed !== "object") {
            res.status(400).json({
              error: {
                message: "Request body must be a JSON object",
                type: "invalid_request_error",
                code: "invalid_body",
              },
            });
            return;
          }
          req.body = parsed;
          delete req.headers["content-encoding"];
          delete req.headers["content-length"];
          next();
        } catch (err: any) {
          if (err?.code === "ERR_BUFFER_TOO_LARGE") {
            res.status(413).json({
              error: {
                message: "Decompressed request entity too large",
                type: "invalid_request_error",
                code: "entity_too_large",
              },
            });
            return;
          }
          next(err);
        }
      });
      req.on("error", next);
    } else {
      next();
    }
  });

  // Middleware
  app.use(express.json({ limit: "10mb" }));

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS headers for local development
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });

  // Handle OPTIONS preflight
  app.options("*", (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  // Routes
  app.get("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Server Error]:", err.message);
    res.status(500).json({
      error: {
        message: err.message,
        type: "server_error",
        code: null,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  // Ensure sessions are loaded from disk before accepting requests
  await sessionReady;

  const app = createApp();

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
      console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
      resolve(serverInstance!);
    });
  });
}

/**
 * Stop the HTTP server
 */
export async function stopServer(): Promise<void> {
  if (!serverInstance) {
    return;
  }

  return new Promise((resolve, reject) => {
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
