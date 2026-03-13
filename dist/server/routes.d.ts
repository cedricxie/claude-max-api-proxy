/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints with tool-calling support
 * and session management for multi-turn conversations.
 */
import type { Request, Response } from "express";
/**
 * Handle POST /v1/chat/completions
 */
export declare function handleChatCompletions(req: Request, res: Response): Promise<void>;
/**
 * Handle GET /v1/models
 */
export declare function handleModels(_req: Request, res: Response): void;
/**
 * Handle GET /health
 */
export declare function handleHealth(_req: Request, res: Response): void;
//# sourceMappingURL=routes.d.ts.map