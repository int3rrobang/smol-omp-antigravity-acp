/**
 * Types and Model configurations for omp-antigravity-acp
 */

// ============================================================================
// Core oh-my-pi Model & Message Types
// ============================================================================

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | string;

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
  [key: string]: any;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  signature?: string;
  summary?: boolean;
  [key: string]: any;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
  [key: string]: any;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  intent?: string;
  thoughtSignature?: string;
  [key: string]: any;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total?: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: ModelCost;
}

export function createEmptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  [key: string]: any;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  stopReason?: StopReason;
  usage?: Usage;
  [key: string]: any;
}

export interface ToolResultMessage {
  role: "toolResult" | "tool";
  toolCallId: string;
  toolName?: string;
  content: string | (TextContent | ImageContent)[];
  isError?: boolean;
  timestamp?: number;
  [key: string]: any;
}

export interface DeveloperMessage {
  role: "developer" | "system";
  content: string | (TextContent | ImageContent)[];
  [key: string]: any;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage | DeveloperMessage;

export interface Tool {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  [key: string]: any;
}

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "none" | string;
export type CacheRetention = "none" | "short" | "long" | string;

export interface ThinkingConfig {
  mode: "effort" | "budget" | "google-level" | "anthropic-adaptive" | "anthropic-budget-effort";
  efforts: readonly Effort[];
  defaultLevel?: Effort;
  [key: string]: any;
}

export interface Context {
  systemPrompt?: string | string[];
  messages: Message[];
  tools?: Tool[];
  [key: string]: any;
}

export interface StreamOptions {
  signal?: AbortSignal;
  apiKey?: string;
  sessionId?: string;
  cwd?: string;
  [key: string]: any;
}

export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: Effort;
  effort?: Effort;
  disableReasoning?: boolean;
  cacheRetention?: CacheRetention;
  [key: string]: any;
}

export type AssistantMessageEvent =
  | { type: "start"; contentIndex?: undefined; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "image_end"; contentIndex: number; content: ImageContent; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; contentIndex?: undefined; reason: StopReason; message: AssistantMessage }
  | { type: "error"; contentIndex?: undefined; reason?: StopReason; error: AssistantMessage }
  | { type: string; [key: string]: any };

export interface Model<TApi = string> {
  id: string;
  name: string;
  provider: string;
  api: TApi;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
  [key: string]: any;
}

export interface ProviderModelConfig {
  id: string;
  name: string;
  api?: string;
  kind?: string;
  reasoning: boolean;
  thinking?: ThinkingConfig;
  supportsTools?: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  [key: string]: any;
}

export interface OAuthCredentials {
  access: string;
  refresh?: string;
  expires?: number;
  projectId?: string;
  [key: string]: any;
}

export interface OAuthPrompt {
  url: string;
  userCode?: string;
  [key: string]: any;
}

export interface OAuthAuthInfo {
  url: string;
  [key: string]: any;
}

export interface OAuthLoginCallbacks {
  openUrl(url: string): Promise<void> | void;
  prompt(prompt: OAuthPrompt | string): Promise<string>;
  [key: string]: any;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  streamSimple?: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ProviderModelConfig[];
  oauth?: {
    name: string;
    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
    refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    getApiKey?(credentials: OAuthCredentials): string;
    modifyModels?(models: Model<any>[], credentials: OAuthCredentials): Model<any>[];
  };
  fetchDynamicModels?: (apiKey: string | undefined) => Promise<readonly ProviderModelConfig[]>;
  [key: string]: any;
}

export interface ExtensionAPI {
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  [key: string]: any;
}

// ============================================================================
// AssistantMessageEventStream Implementation
// ============================================================================

export class AssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
  private queue: AssistantMessageEvent[] = [];
  private queueHead = 0;
  private waiting: Array<{ resolve: (value: IteratorResult<AssistantMessageEvent>) => void; reject: (err: unknown) => void }> = [];
  public done = false;
  private resultSettled = false;
  private failed = false;
  private error: unknown = undefined;

  private pendingLocalWork = 0;
  private _localWorkSettledAt = 0;

  private finalResultPromise: Promise<AssistantMessage>;
  private resolveFinalResult!: (result: AssistantMessage) => void;
  private rejectFinalResult!: (err: unknown) => void;

  constructor() {
    this.finalResultPromise = new Promise<AssistantMessage>((resolve, reject) => {
      this.resolveFinalResult = resolve;
      this.rejectFinalResult = reject;
    });
    // Prevent unhandled rejections if result() is not immediately awaited
    this.finalResultPromise.catch(() => {});
  }

  get hasPendingLocalWork(): boolean {
    return this.pendingLocalWork > 0;
  }

  get localWorkSettledAt(): number {
    return this._localWorkSettledAt;
  }

  async trackLocalWork<T>(work: Promise<T>): Promise<T> {
    this.pendingLocalWork++;
    try {
      return await work;
    } finally {
      this.pendingLocalWork--;
      if (this.pendingLocalWork === 0) {
        this._localWorkSettledAt = Date.now();
      }
    }
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return;

    if (event.type === "done") {
      this.done = true;
      this.resultSettled = true;
      this.resolveFinalResult(event.message);
    } else if (event.type === "error") {
      this.done = true;
      this.resultSettled = true;
      this.resolveFinalResult(event.error);
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result !== undefined) {
      this.resultSettled = true;
      this.resolveFinalResult(result);
    } else if (!this.resultSettled) {
      this.resultSettled = true;
      this.rejectFinalResult(new Error("Stream ended without a final result"));
    }

    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter.resolve({ value: undefined as any, done: true });
    }
  }

  fail(reason: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failed = true;
    this.error = reason;
    this.resultSettled = true;
    this.rejectFinalResult(reason);

    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter.reject(reason);
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalResultPromise;
  }

  private dequeue(): AssistantMessageEvent {
    const event = this.queue[this.queueHead];
    this.queue[this.queueHead] = undefined as any;
    this.queueHead++;
    if (this.queueHead >= 64 && this.queueHead * 2 >= this.queue.length) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    }
    return event;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      if (this.queueHead < this.queue.length) {
        yield this.dequeue();
      } else if (this.failed) {
        throw this.error;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => {
          this.waiting.push({ resolve, reject });
        });
        if (result.done) return;
        yield result.value;
      }
    }
  }
}

// ============================================================================
// Shared Bridge & Session Types
// ============================================================================

export interface McpToolResultContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpCallToolResult {
  content: McpToolResultContent[];
  isError?: boolean;
}

export interface HeldMcpToolCall {
  callId: string;
  /** Original omp tool name (without omp_ prefix) */
  toolName: string;
  /** Raw MCP tool name (with omp_ prefix) */
  mcpToolName: string;
  arguments: Record<string, any>;
  resolve: (result: McpCallToolResult) => void;
  reject: (error: Error) => void;
  createdAt: number;
}

export type AcpUpdateEvent =
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedReadTokens?: number; cachedWriteTokens?: number; thoughtTokens?: number }
  | { type: "mcp_tool_calls_ready"; calls: HeldMcpToolCall[] }
  | { type: "prompt_done"; stopReason: string; usage?: any }
  | { type: "prompt_error"; error: Error };

// ============================================================================
// Provider Constants & Models
// ============================================================================

export const ANTIGRAVITY_API_NAME = "google-antigravity-acp";
export const ANTIGRAVITY_PROVIDER_NAME = "google-antigravity";

const DEFAULT_EFFORT_THINKING: ThinkingConfig = {
  mode: "effort",
  efforts: ["low", "medium", "high"],
  defaultLevel: "medium",
};

const PRO_3_1_EFFORT_THINKING: ThinkingConfig = {
  mode: "effort",
  efforts: ["low", "high"],
  defaultLevel: "high",
};

export function getThinkingConfigForModel(modelId: string): ThinkingConfig {
  if (modelId === "gemini-3.1-pro" || modelId === "gemini-3-pro") {
    return PRO_3_1_EFFORT_THINKING;
  }
  return DEFAULT_EFFORT_THINKING;
}

export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0 },
  },
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0 },
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0 },
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: PRO_3_1_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65535,
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 },
  },
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: PRO_3_1_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65535,
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 },
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0.25 },
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.15, output: 1.0, cacheRead: 0.015, cacheWrite: 0 },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "gpt-oss-120b",
    name: "GPT OSS 120B",
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: DEFAULT_EFFORT_THINKING,
    supportsTools: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    cost: { input: 0.8, output: 2.4, cacheRead: 0.08, cacheWrite: 0 },
  },
];
