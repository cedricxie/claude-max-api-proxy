/**
 * Types for OpenAI-compatible API
 * Used for Clawdbot integration
 */

export interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenAIContentPart =
  | string
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string; // Used for session mapping
  tools?: OpenAITool[];
  tool_choice?: "none" | "auto" | { type: "function"; function: { name: string } };
}

export interface OpenAIChatResponseChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatResponseChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatChunkDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: OpenAIChatChunkDelta;
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
}

export interface OpenAIModel {
  id: string;
  object: "model";
  owned_by: string;
  created?: number;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}
