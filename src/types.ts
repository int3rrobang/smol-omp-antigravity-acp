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
  /**
   * Server-reported context occupancy, normalized to the OMP model's window.
   * OMP prefers this over input + cacheRead + cacheWrite when anchoring the
   * context bar; without it, per-turn deltas look like the whole context.
   */
  contextTokens?: number;
  /** Thinking tokens, reported separately from `output` for display. */
  reasoningTokens?: number;
  cost: ModelCost;
}

export function createEmptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    reasoningTokens: 0,
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

// ============================================================================
// Usage Reporting Types (omp provider extension hook)
// ============================================================================

export type UsageUnit = "percent" | "tokens" | "requests" | "credits" | "usd" | "minutes" | "bytes" | "unknown";

export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

/** Time window for a limit (e.g. 5h, weekly, monthly). */
export interface UsageWindow {
  id: string;
  label: string;
  durationMs?: number;
  resetsAt?: number;
  resetLabel?: string;
}

/** Quantitative usage data. */
export interface UsageAmount {
  used?: number;
  limit?: number;
  remaining?: number;
  usedFraction?: number;
  remainingFraction?: number;
  unit: UsageUnit;
}

/** Scope metadata describing what the limit applies to. */
export interface UsageScope {
  provider: string;
  accountId?: string;
  projectId?: string;
  orgId?: string;
  modelId?: string;
  tier?: string;
  windowId?: string;
  shared?: boolean;
  sharedGroup?: string;
}

/** Normalized limit entry for a single window or quota bucket. */
export interface UsageLimit {
  id: string;
  label: string;
  scope: UsageScope;
  window?: UsageWindow;
  amount: UsageAmount;
  status?: UsageStatus;
  notes?: string[];
}

/** Aggregated usage report for a provider. */
export interface UsageReport {
  provider: string;
  fetchedAt: number;
  limits: UsageLimit[];
  notes?: string[];
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

/** Credential bundle passed to a usage fetcher. */
export interface UsageCredential {
  type: "api_key" | "oauth";
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  projectId?: string;
  email?: string;
  orgId?: string;
}

/** Parameters provided to a usage fetcher. */
export interface UsageFetchParams {
  provider: string;
  credential: UsageCredential;
  accountKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

/** Optional logger for usage fetchers. */
export interface UsageLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Shared runtime utilities for fetchers. */
export interface UsageFetchContext {
  logger?: UsageLogger;
  retryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  previousReport?: UsageReport;
}

/** Provider implementation for fetching usage information. */
export interface UsageProvider {
  id: string;
  cacheVersion?: number;
  fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null>;
  supports?(params: UsageFetchParams): boolean;
  validatesCredentials?: boolean;
  retainLastGoodOnFailure?: boolean;
  failureBackoffMs?: number;
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
  /** Normalized usage fetcher surfaced by omp's `/usage` and `omp usage`. */
  usage?: UsageProvider;
  [key: string]: any;
}

export interface ExtensionUISelectOption {
  label: string;
  description?: string;
}

export interface ExtensionCommandContext {
  ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void;
    write?(text: string): void;
    select?(
      title: string,
      options: Array<string | ExtensionUISelectOption>,
    ): Promise<string | undefined>;
  };
}

export interface ExtensionCommand {
  description?: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
}

export interface ExtensionAPI {
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  registerCommand?(name: string, command: ExtensionCommand): void;
  on?(event: string, handler: (...args: unknown[]) => unknown): void;
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
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedReadTokens?: number;
      cachedWriteTokens?: number;
      thoughtTokens?: number;
      contextTokens?: number;
      contextWindow?: number;
    }
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

/**
 * Prices (global endpoint, per 1M tokens) for models `agy` may advertise that
 * are not in the static roster — tier-gated releases such as Gemini 4 Carbon,
 * which a pro account is never offered. Without an entry, discovery falls back
 * to a generic placeholder that understates anything priced like a 4-series
 * model. Google moves these to list price on 2026-12-01 08:00 UTC, so the
 * lookup takes the request date rather than baking one number in.
 */
export function antigravityModelPricing(
  baseId: string,
  now: number = Date.now(),
): Pick<ProviderModelConfig, "cost" | "contextWindow" | "maxTokens"> | undefined {
  if (baseId === "gemini-4-carbon") {
    const atListPrice = now >= Date.parse("2026-12-01T08:00:00Z");
    return {
      cost: atListPrice
        ? { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 }
        : { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 65536,
    };
  }
  return undefined;
}

/**
 * Config for an id that only exists in discovery (agy advertised it for this
 * account). Known family prices come from {@link DISCOVERED_MODEL_PRICING}.
 */
export function antigravityDiscoveredModel(baseId: string, name?: string): ProviderModelConfig {
  // Callers pass ids straight from agy, which advertises one row per thinking
  // level (`…-low/-medium/-high`); collapse them onto the family id.
  const id = baseId.replace(/-(low|medium|high)$/i, "");
  const known = antigravityModelPricing(id);
  return {
    id,
    name: (name || baseId).replace(/\s*\((Low|Medium|High)\)\s*$/i, ""),
    api: ANTIGRAVITY_API_NAME,
    reasoning: true,
    thinking: getThinkingConfigForModel(baseId),
    supportsTools: true,
    input: ["text", "image"],
    contextWindow: known?.contextWindow ?? 1048576,
    maxTokens: known?.maxTokens ?? 65536,
    cost: known?.cost ?? { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0 },
  };
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
