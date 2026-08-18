/**
 * @pattern/agent — thin adapter over Vercel AI SDK.
 *
 * Replaces the hand-rolled fetch + tool-call loop in sidecar/src/index.ts with
 * the mature streaming + tool-calling primitives from the AI SDK. Pattern's
 * unique layers (memory, pattern, proactive, presence, computer use) plug in
 * as tool definitions and system-prompt context — the agent harness itself
 * is delegated to the SDK.
 */
import {streamText, generateText, generateObject, type CoreMessage, type Tool} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createAnthropic} from '@ai-sdk/anthropic';

/** Provider-agnostic model reference used by Pattern. */
export interface ModelConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  /** Optional: a different model for utility/extraction tasks. */
  utility?: ModelConfig;
}

/** A tool definition compatible with AI SDK's Tool interface. */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
  onFinish?: (text: string, toolCalls: Array<{name: string; args: Record<string, unknown>}>) => void;
  onError?: (error: Error) => void;
}

export interface GenerateOptions {
  system: string;
  messages: CoreMessage[];
  tools?: Record<string, Tool>;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  toolCalls: Array<{name: string; args: Record<string, unknown>}>;
}

/** Resolve a Pattern ModelConfig into a Vercel AI SDK model instance. */
export function resolveModel(cfg: ModelConfig) {
  const provider = cfg.provider.toLowerCase();
  if (provider.includes('anthropic')) {
    const anthropic = createAnthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.endpoint.replace(/\/+$/, ''),
    });
    return anthropic(cfg.model);
  }
  // Default: OpenAI-compatible (covers OpenAI, Azure, local llama.cpp, etc.)
  const openai = createOpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.endpoint.replace(/\/+$/, ''),
  });
  return openai(cfg.model);
}

/** Resolve the utility model (for extraction/routing), falling back to the primary. */
export function resolveUtilityModel(cfg: ModelConfig) {
  return resolveModel(cfg.utility || cfg);
}

/**
 * Stream a chat response with tool-calling support.
 * Deltas and tool events are delivered via callbacks — the caller maps
 * these to the WS chat.delta / chat.event protocol.
 */
export async function streamChat(
  model: ReturnType<typeof resolveModel>,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<string> {
  let fullText = '';
  const toolCalls: Array<{name: string; args: Record<string, unknown>}> = [];

  try {
    const result = streamText({
      model,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      maxSteps: opts.maxSteps ?? 8,
      temperature: opts.temperature ?? 0.7,
      ...(opts.maxTokens ? {maxOutputTokens: opts.maxTokens} : {}),
      ...(opts.signal ? {abortSignal: opts.signal} : {}),
      onStepFinish: (event: any) => {
        for (const call of event.toolCalls || []) {
          toolCalls.push({name: call.toolName, args: call.args});
          callbacks.onToolCall?.(call.toolName, call.args);
        }
        for (const tr of event.toolResults || []) {
          callbacks.onToolResult?.(tr.toolName, tr.result);
        }
      },
    });

    for await (const delta of result.textStream) {
      fullText += delta;
      callbacks.onDelta(delta);
    }

    callbacks.onFinish?.(fullText, toolCalls);
    return fullText;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    callbacks.onError?.(err);
    throw err;
  }
}

/** Non-streaming generation (for extraction, routing, dreaming, pattern pipeline). */
export async function generate(
  model: ReturnType<typeof resolveModel>,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const result = await generateText({
    model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    maxSteps: opts.maxSteps ?? 1,
    temperature: opts.temperature ?? 0,
    ...(opts.maxTokens ? {maxOutputTokens: opts.maxTokens} : {}),
    ...(opts.signal ? {abortSignal: opts.signal} : {}),
  });
  return {
    text: result.text,
    toolCalls: (result.toolCalls || []).map((call: any) => ({
      name: call.toolName,
      args: call.args,
    })),
  };
}

/** Generate structured JSON output (for pattern decisions, route classification, etc.). */
export async function generateJson<T>(
  model: ReturnType<typeof resolveModel>,
  system: string,
  prompt: string,
  schema: Record<string, unknown>,
  opts?: {temperature?: number; signal?: AbortSignal},
): Promise<T | null> {
  try {
    const {object} = await generateObject({
      model,
      system,
      prompt,
      schema: schema as any,
      temperature: opts?.temperature ?? 0,
      ...(opts?.signal ? {abortSignal: opts.signal} : {}),
    });
    return object as T;
  } catch {
    return null;
  }
}

/** Convert Pattern's tool definitions into AI SDK Tool records. */
export function buildTools(tools: AgentTool[]): Record<string, Tool> {
  const record: Record<string, Tool> = {};
  for (const tool of tools) {
    record[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema as any,
      execute: tool.execute,
    };
  }
  return record;
}

export {type CoreMessage, type Tool};
