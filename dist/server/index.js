/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */
import express from "express";
import { createServer } from "http";
import * as zlib from "zlib";
import { handleChatCompletions, handleModels, handleHealth } from "./routes.js";
import { sessionReady } from "../session/manager.js";
// Runtime feature detection: zstdDecompressSync is available in Node.js 22+.
const zstdDecompressSync = typeof zlib.zstdDecompressSync === "function"
    ? zlib.zstdDecompressSync
    : null;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB, matches express.json limit
let serverInstance = null;
/**
 * Create and configure the Express app
 */
function createApp() {
    const app = express();
    // Decompress zstd-encoded request bodies.
    // Some OpenAI-compatible clients send Content-Encoding: zstd which
    // Express's built-in JSON parser does not handle.
    // Falls back to a 415 error on Node < 22 where zstd is unavailable.
    app.use((req, res, next) => {
        if (req.headers["content-encoding"] === "zstd") {
            if (!zstdDecompressSync) {
                res.status(415).json({
                    error: {
                        message: "zstd content-encoding is not supported on this Node.js version (requires 22+)",
                        type: "invalid_request_error",
                        code: "unsupported_content_encoding",
                    },
                });
                return;
            }
            let totalBytes = 0;
            const chunks = [];
            req.on("data", (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_BODY_BYTES) {
                    req.destroy(new Error("Request body too large"));
                    return;
                }
                chunks.push(chunk);
            });
            req.on("end", () => {
                try {
                    const compressed = Buffer.concat(chunks);
                    const decompressed = zstdDecompressSync(compressed);
                    if (decompressed.length > MAX_BODY_BYTES) {
                        res.status(413).json({
                            error: {
                                message: "Request entity too large",
                                type: "invalid_request_error",
                                code: "entity_too_large",
                            },
                        });
                        return;
                    }
                    req.body = JSON.parse(decompressed.toString());
                    delete req.headers["content-encoding"];
                    delete req.headers["content-length"];
                    next();
                }
                catch (err) {
                    next(err);
                }
            });
            req.on("error", next);
        }
        else {
            next();
        }
    });
    // Middleware
    app.use(express.json({ limit: "10mb" }));
    // Request logging (debug mode)
    app.use((req, _res, next) => {
        if (process.env.DEBUG) {
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
        }
        next();
    });
    // CORS headers for local development
    app.use((_req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        next();
    });
    // Handle OPTIONS preflight
    app.options("*", (_req, res) => {
        res.sendStatus(200);
    });
    // Routes
    app.get("/health", handleHealth);
    app.get("/v1/models", handleModels);
    app.post("/v1/chat/completions", handleChatCompletions);
    // 404 handler
    app.use((_req, res) => {
        res.status(404).json({
            error: {
                message: "Not found",
                type: "invalid_request_error",
                code: "not_found",
            },
        });
    });
    // Error handler
    app.use((err, _req, res, _next) => {
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
export async function startServer(config) {
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
        serverInstance.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                reject(new Error(`Port ${port} is already in use`));
            }
            else {
                reject(err);
            }
        });
        serverInstance.listen(port, host, () => {
            console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
            console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
            resolve(serverInstance);
        });
    });
}
/**
 * Stop the HTTP server
 */
export async function stopServer() {
    if (!serverInstance) {
        return;
    }
    return new Promise((resolve, reject) => {
        serverInstance.close((err) => {
            if (err) {
                reject(err);
            }
            else {
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
export function getServer() {
    return serverInstance;
}
//# sourceMappingURL=index.js.map