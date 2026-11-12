/**
 * acp-pool.ts
 *
 * Manages the agy acp child process, JSON-RPC 2.0 communication,
 * and the pool of kept-alive LiveAcpSession instances for oh-my-pi.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  type AcpUpdateEvent,
  type HeldMcpToolCall,
  type ProviderModelConfig,
  type OAuthLoginCallbacks,
  type OAuthCredentials,
  ANTIGRAVITY_MODELS,
  antigravityDiscoveredModel,
} from "./types.ts";
import { McpBridgeServer } from "./mcp-bridge.ts";

// ============================================================================
// 1. Binary Discovery
// ============================================================================

/** Extract a message from anything a rejected ACP request can throw. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveAgyBinary(): string {
  // 1. Explicit override via environment
  if (process.env.OMP_AGY_BINARY && fs.existsSync(process.env.OMP_AGY_BINARY)) {
    return path.resolve(process.env.OMP_AGY_BINARY);
  }

  const isWindows = process.platform === "win32";

  if (isWindows) {
    const candidates = [
      path.join(process.env.LOCALAPPDATA ?? "", "agy", "bin", "agy.exe"),
      path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe"),
    ];

    for (const cand of candidates) {
      if (cand && fs.existsSync(cand)) {
        return cand;
      }
    }

    // Check PATH entries for agy.exe, agy.cmd, agy.bat
    const pathEntries = (process.env.PATH || "").split(path.delimiter);
    for (const dir of pathEntries) {
      for (const ext of ["agy.exe", "agy.cmd", "agy.bat", "agy"]) {
        const full = path.join(dir, ext);
        if (fs.existsSync(full)) {
          return full;
        }
      }
    }
  } else {
    // macOS / Linux
    const candidates = [
      path.join(os.homedir(), ".local", "bin", "agy"),
      "/usr/local/bin/agy",
      "/opt/homebrew/bin/agy",
    ];

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return cand;
      }
    }

    // Check PATH entries
    const pathEntries = (process.env.PATH || "").split(path.delimiter);
    for (const dir of pathEntries) {
      const full = path.join(dir, "agy");
      if (fs.existsSync(full)) {
        return full;
      }
    }
  }

  throw new Error(
    "Could not locate Google Antigravity binary (agy / agy.exe).\n" +
      "Please install the Antigravity CLI or set the OMP_AGY_BINARY environment variable.",
  );
}

// ============================================================================
// 2. ACP Connection (JSON-RPC 2.0 over child process stdio)
// ============================================================================

interface PendingRpcRequest {
  resolve: (value: any) => void;
  reject: (err: any) => void;
  timer?: NodeJS.Timeout;
}

export class AcpConnection {
  private child: ChildProcess | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number | string, PendingRpcRequest>();
  private logFilePath: string;
  private isAlive = false;
  private initPromise: Promise<any> | null = null;

  public onSessionUpdate?: (sessionId: string, update: any) => void;
  public onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
    this.logFilePath = path.join(
      os.tmpdir(),
      `omp-agy-acp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`,
    );
  }

  public getLogFilePath(): string {
    return this.logFilePath;
  }

  public getChildProcess(): ChildProcess | null {
    return this.child;
  }

  public isConnected(): boolean {
    return this.isAlive && this.child !== null && !this.child.killed;
  }

  public async start(): Promise<any> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const agyBin = resolveAgyBinary();

      // Clean environment: preserve real user environment (OAuth, tokens),
      // strip parent IDE/CLI ANTIGRAVITY_* variables, set unbuffered Python
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("ANTIGRAVITY_")) {
          env[k] = v;
        }
      }
      env.PYTHONUNBUFFERED = "1";

      const isRealApiKey = (k?: string) =>
        Boolean(k && k !== "acp-managed" && !k.startsWith("{") && !k.startsWith("<"));
      const effectiveApiKey = isRealApiKey(this.apiKey) ? this.apiKey : process.env.GEMINI_API_KEY;
      if (effectiveApiKey && isRealApiKey(effectiveApiKey)) {
        env.GEMINI_API_KEY = effectiveApiKey;
      }

      const args = ["acp", "--log-file", this.logFilePath];
      if (process.env.OMP_AGY_GEMINI_DIR) {
        args.push("--gemini-dir", process.env.OMP_AGY_GEMINI_DIR);
      }

      const child = spawn(agyBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        windowsHide: true,
      });

      this.child = child;
      this.isAlive = true;

      child.on("error", (err) => {
        this.cleanup(new Error(`Failed to spawn agy acp: ${err.message}`));
      });

      child.on("exit", (code, signal) => {
        this.isAlive = false;
        this.cleanup(new Error(`agy acp process exited with code ${code}, signal ${signal}`));
        if (this.onExit) {
          this.onExit(code, signal);
        }
      });

      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          // Keep stderr open for diagnostics; silent by default
        });
      }

      if (!child.stdout || !child.stdin) {
        throw new Error("Failed to initialize stdin/stdout pipes for agy acp");
      }
      // Async pipe errors (EPIPE once agy is gone) arrive as 'error' events,
      // not synchronous throws — without these listeners they are fatal.
      child.stdin.on("error", () => {
        // Per-write callbacks below observe failures; nothing to do here.
      });
      child.stdout.on("error", () => {});

      const rl = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
        terminal: false,
      });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        this.handleIncomingLine(trimmed);
      });

      // Handshake: initialize
      const initResult = await this.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            session: { notices: {} },
          },
          clientInfo: { name: "t3-code", title: "T3 Code", version: "0.1.0" },
        },
        30000,
      );

      return initResult;
    })();

    return this.initPromise;
  }

  /**
   * Best-effort JSON-RPC line write. Returns false when the pipe is already
   * gone. Async failures (EPIPE) arrive via the write callback, never as a
   * throw — the callback keeps them from becoming uncaught exceptions.
   */
  private writeStdin(payload: string, onError?: (err: Error) => void): boolean {
    const stdin = this.child?.stdin;
    if (!this.isConnected() || !stdin || stdin.destroyed) return false;
    try {
      stdin.write(payload, (err) => {
        if (err) onError?.(err);
      });
      return true;
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  public request(method: string, params?: any, timeoutMs = 60000): Promise<any> {
    if (!this.isConnected() || !this.child?.stdin) {
      return Promise.reject(new Error("ACP process is not connected"));
    }

    const id = ++this.nextRequestId;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }) + "\n";

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`ACP request '${method}' (id: ${id}) timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pendingRequests.set(id, { resolve, reject, timer });

      const onWriteError = (err: Error) => {
        if (timer) clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      };

      // writeStdin reports sync AND async (EPIPE) failures via onWriteError.
      // When the pipe is already gone writeStdin returns false without
      // calling back — reject now instead of hanging until timeout
      // (session/prompt uses timeout 0, i.e. it would hang forever).
      // If onWriteError already ran (sync throw) the entry is deleted,
      // so the has() guard also prevents a double reject.
      if (!this.writeStdin(payload, onWriteError) && this.pendingRequests.has(id)) {
        if (timer) clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`ACP request '${method}' failed: pipe closed`));
      }
    });
  }

  public notify(method: string, params?: any): void {
    if (!this.isConnected() || !this.child?.stdin) {
      return;
    }
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    }) + "\n";
    this.writeStdin(payload);
  }

  public sendResponse(id: number | string, result: any): void {
    if (!this.isConnected() || !this.child?.stdin) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result,
    }) + "\n";
    this.writeStdin(payload);
  }

  public sendError(id: number | string, code: number, message: string, data?: any): void {
    if (!this.isConnected() || !this.child?.stdin) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, data },
    }) + "\n";
    this.writeStdin(payload);
  }

  private handleIncomingLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (!msg || typeof msg !== "object") return;

    // 1. Response to our pending request
    if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          const err: any = new Error(msg.error.message || "ACP RPC Error");
          err.code = msg.error.code;
          err.data = msg.error.data;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // 2. Incoming request from server
    if (msg.id !== undefined && msg.id !== null && msg.method) {
      this.handleServerRequest(msg);
      return;
    }

    // 3. Incoming notification from server
    if (msg.method) {
      this.handleServerNotification(msg);
    }
  }

  private handleServerRequest(msg: { id: number | string; method: string; params?: any }): void {
    if (msg.method === "session/request_permission") {
      const toolCall = msg.params?.toolCall;
      const options = Array.isArray(msg.params?.options) ? msg.params.options : [];

      // Check if tool is from our MCP bridge (has _meta.is_mcp_tool_call or omp prefix)
      const isMcp =
        toolCall?._meta?.is_mcp_tool_call === true ||
        String(toolCall?.name || "").startsWith("omp_") ||
        String(toolCall?.title || "").toLowerCase().includes("omp_") ||
        String(toolCall?.name || "").toLowerCase().includes("omp") ||
        String(toolCall?.title || "").toLowerCase().includes("omp");

      if (isMcp) {
        // Auto-allow our own MCP tools
        const allowOpt =
          options.find((o: any) => o.kind === "allow_always") ||
          options.find((o: any) => o.kind === "allow_once") ||
          options[0];

        if (allowOpt) {
          this.sendResponse(msg.id, { outcome: "selected", optionId: allowOpt.optionId });
        } else {
          this.sendResponse(msg.id, { outcome: "cancelled" });
        }
      } else {
        // Reject built-in tools (run_command, write_file, etc.) so agy does not mutate files behind omp's back!
        const rejectOpt =
          options.find((o: any) => o.kind === "reject_once") ||
          options.find((o: any) => o.kind === "reject_always");

        if (rejectOpt) {
          this.sendResponse(msg.id, { outcome: "selected", optionId: rejectOpt.optionId });
        } else {
          this.sendResponse(msg.id, { outcome: "cancelled" });
        }
      }
      return;
    }

    // Default: method not found
    this.sendError(msg.id, -32601, `Method not found: ${msg.method}`);
  }

  private handleServerNotification(msg: { method: string; params?: any }): void {
    if (msg.method === "session/update") {
      const sessionId = msg.params?.sessionId;
      const update = msg.params?.update;
      if (sessionId && update && this.onSessionUpdate) {
        this.onSessionUpdate(sessionId, update);
      }
    }
  }

  public async authenticate(params: { methodId: string }): Promise<any> {
    return this.request("authenticate", params, 60000);
  }

  public cleanup(reason?: Error): void {
    this.isAlive = false;
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(reason || new Error("ACP connection closed"));
    }
    this.pendingRequests.clear();
    this.initPromise = null;

    if (this.child) {
      try {
        if (!this.child.killed) {
          this.child.kill();
        }
      } catch {}
      this.child = null;
    }
  }

  public async close(): Promise<void> {
    this.cleanup(new Error("ACP connection closed by caller"));
  }
}

// ============================================================================
// 3. LiveAcpSession & Session Keep-Alive Pool
// ============================================================================

export interface LiveAcpSession {
  sessionKey: string;
  acpSessionId: string;
  cwd: string;
  currentModelId: string;
  currentEffort?: string;
  systemPromptHash: string;
  syncedMessageCount: number;
  prefixHash: string;
  /**
   * Set when omp has rewritten the history behind this conversation (compaction,
   * shake, prune, image drop). The next provider request must rebuild instead of
   * trusting the append-only prefix.
   */
  stale: boolean;
  /**
   * Structural fingerprint of the checkpointed prefix (shake markers, thinking
   * shape, image count). Cheap backstop for rewrites whose event was detached
   * or never emitted.
   */
  rewriteFingerprint: string;
  inFlightPrompt: Promise<any> | null;
  unbindAbort: (() => void) | null;
  pendingMcpBatch: {
    calls: Map<string, HeldMcpToolCall>;
    promptPromise?: Promise<any>;
  } | null;
  eventListener: ((ev: AcpUpdateEvent) => void) | null;
  lastUsedAt: number;
}

/**
 * Durable handle for a live ACP conversation, persisted by the host extension
 * (omp session entries) so a later process can reattach with `session/load`
 * instead of replaying the transcript.
 */
export interface PersistedAcpSessionState {
  acpSessionId: string;
  cwd: string;
  model: string;
  effort?: string;
  systemPromptHash: string;
  syncedMessageCount: number;
  prefixHash: string;
  /** See {@link LiveAcpSession.rewriteFingerprint}; omitted for older entries. */
  rewriteFingerprint?: string;
}

export class AcpSessionPool {
  public mcpBridge: McpBridgeServer;
  private conn: AcpConnection | null = null;
  private sessions = new Map<string, LiveAcpSession>();
  private acpToLiveSession = new Map<string, LiveAcpSession>();
  private lastSessionNewResult: any = null;
  private evictionInterval: NodeJS.Timeout | null = null;
  private connecting: Promise<AcpConnection> | null = null;
  private resumeCandidates = new Map<string, PersistedAcpSessionState>();
  /** omp's tokenizer estimate for the session, captured outside the stream. */
  private ompContextTokens = new Map<string, number>();
  /** In-flight session setup per key, so concurrent turns cannot interleave it. */
  private sessionCreations = new Map<string, Promise<unknown>>();
  /**
   * Persist (or clear, with `null`) this session's ACP handle. The host wires
   * this to `pi.appendEntry` so the handle rides along with the omp session.
   */
  public onSessionState?: (sessionKey: string, state: PersistedAcpSessionState | null) => void;
  /** Non-fatal problems worth showing the user (e.g. a model switch agy rejected). */
  public onWarning?: (message: string) => void;

  constructor(apiKey?: string) {
    this.mcpBridge = new McpBridgeServer();
  }

  /** Start the idle-session eviction timer only when ACP is actually in use. */
  private ensureEvictionTimer(): void {
    if (this.evictionInterval) return;
    // 15-minute idle eviction interval
    this.evictionInterval = setInterval(() => {
      this.evictIdleSessions(15 * 60 * 1000);
    }, 60 * 1000);
    if (this.evictionInterval.unref) {
      this.evictionInterval.unref();
    }
  }

  public ensureConnection(apiKey?: string): Promise<AcpConnection> {
    this.ensureEvictionTimer();
    if (this.conn && this.conn.isConnected()) {
      return Promise.resolve(this.conn);
    }

    // Single-flight: concurrent createSession calls (main turn + agents) must
    // share one agy process, not spawn one each.
    if (!this.connecting) {
      this.connecting = this.openConnection(apiKey).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async openConnection(apiKey?: string): Promise<AcpConnection> {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }

    // Ensure MCP bridge pipe server is up
    await this.mcpBridge.start();

    const conn = new AcpConnection(apiKey);
    conn.onSessionUpdate = (sessionId, update) => {
      this.handleSessionUpdate(sessionId, update);
    };

    conn.onExit = () => {
      // Clear sessions that were tied to the dead process
      this.sessions.clear();
      this.acpToLiveSession.clear();
    };

    await conn.start();
    this.conn = conn;
    return conn;
  }

  public getSession(sessionKey: string): LiveAcpSession | undefined {
    return this.sessions.get(sessionKey);
  }

  /** Mark a live conversation as rewritten so the next request rebuilds it. */
  public markStale(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) session.stale = true;
  }

  public setOmpContextTokens(sessionKey: string, tokens: number | null | undefined): void {
    if (tokens !== undefined && tokens !== null && Number.isFinite(tokens) && tokens > 0) {
      this.ompContextTokens.set(sessionKey, Math.floor(tokens));
    } else {
      this.ompContextTokens.delete(sessionKey);
    }
  }

  public getOmpContextTokens(sessionKey: string): number | undefined {
    return this.ompContextTokens.get(sessionKey);
  }

  /** Offer a previously persisted handle; `null` means "nothing to reattach to". */
  public setResumeCandidate(sessionKey: string, state: PersistedAcpSessionState | null): void {
    if (state) this.resumeCandidates.set(sessionKey, state);
    else this.resumeCandidates.delete(sessionKey);
  }

  /** Snapshot the checkpoint so a later process can resume from it. */
  public recordSessionState(sessionKey: string): void {
    if (!this.onSessionState) return;
    const session = this.sessions.get(sessionKey);
    const state = session ? this.snapshotSession(session) : null;
    if (state) this.onSessionState(sessionKey, state);
  }

  /** A conversation is resumable once at least one turn has been checkpointed. */
  private snapshotSession(session: LiveAcpSession): PersistedAcpSessionState | null {
    // A stale handle points at a conversation omp has already rewritten; never
    // carry it across a restart.
    if (session.stale || !session.prefixHash) return null;
    return {
      acpSessionId: session.acpSessionId,
      cwd: session.cwd,
      model: session.currentModelId,
      effort: session.currentEffort,
      systemPromptHash: session.systemPromptHash,
      syncedMessageCount: session.syncedMessageCount,
      prefixHash: session.prefixHash,
      rewriteFingerprint: session.rewriteFingerprint,
    };
  }

  /** Drop any durable handle for this session (branch switch, reset). */
  public clearPersistedSession(sessionKey: string): void {
    this.onSessionState?.(sessionKey, null);
  }

  public async createSession(
    sessionKey: string,
    cwd: string,
    systemPromptAppend?: string,
    modelId?: string,
    effort?: string,
    apiKey?: string,
    hasTools: boolean = true,
  ): Promise<LiveAcpSession> {
    // Setup for one omp session must not interleave: every call resets the
    // previous live session and consumes the resume handle, so two concurrent
    // calls for the same key would tear down each other's session. Distinct
    // keys (a main turn waking several subagents) still run concurrently.
    const previous = this.sessionCreations.get(sessionKey);
    const pending = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() =>
      this.createSessionNow(sessionKey, cwd, systemPromptAppend, modelId, effort, apiKey, hasTools),
    );
    this.sessionCreations.set(sessionKey, pending);
    try {
      return await pending;
    } finally {
      if (this.sessionCreations.get(sessionKey) === pending) {
        this.sessionCreations.delete(sessionKey);
      }
    }
  }

  private async createSessionNow(
    sessionKey: string,
    cwd: string,
    systemPromptAppend?: string,
    modelId?: string,
    effort?: string,
    apiKey?: string,
    hasTools: boolean = true,
  ): Promise<LiveAcpSession> {
    const conn = await this.ensureConnection(apiKey);
    const resume = this.resumeCandidates.get(sessionKey);

    // Close any previous session for this key
    await this.resetSession(sessionKey);

    const relayScriptPath = this.mcpBridge.getRelayScriptPath();
    const pipePath = this.mcpBridge.getPipePath();

    // Skip spawning an MCP server subprocess when the turn has no tools (e.g. background title generation)
    const mcpServers = hasTools
      ? [
          {
            name: "omp",
            command: process.execPath,
            args: [relayScriptPath],
            env: [
              { name: "BUN_BE_BUN", value: "1" },
              { name: "OMP_ACP_MCP_PIPE", value: pipePath },
              { name: "OMP_ACP_SESSION_KEY", value: sessionKey },
            ],
          },
        ]
      : [];

    const disabledTools = [
      "run_command",
      "read_file",
      "write_file",
      "edit_file",
      "replace_file_content",
      "multi_replace_file_content",
      "grep_search",
      "find_by_name",
      "list_dir",
      "view_file_outline",
      "view_code_item",
      "run_workflow",
      "invoke_subagent",
      "start_subagent",
      "browser_subagent",
      "send_command_input",
    ];

    const metaAntigravity: Record<string, any> = {
      disableBuiltInTools: true,
      disabledTools,
    };

    if (systemPromptAppend) {
      metaAntigravity.systemPrompt = { append: systemPromptAppend };
    }

    const sessionParams = {
      cwd,
      mcpServers,
      _meta: {
        antigravity: metaAntigravity,
      },
    };

    const systemPromptHash = systemPromptAppend
      ? createHash("sha256").update(systemPromptAppend).digest("hex")
      : "";

    let sessionNewResult: any;
    let resumed = false;

    // Reattach to the conversation agy still holds instead of replaying the
    // history: same server-side context (thinking included), no transcript, no
    // re-billed tokens. `session/resume` is the validating call — it fails for a
    // conversation agy no longer has, whereas `session/load` silently starts an
    // empty one under the same id and would drop the history without a trace.
    if (resume && resume.cwd === cwd && resume.systemPromptHash === systemPromptHash) {
      try {
        const restored = (await conn.request(
          "session/resume",
          { sessionId: resume.acpSessionId, ...sessionParams },
          60000,
        )) as { sessionId?: string } | null;
        if (restored?.sessionId) {
          sessionNewResult = restored;
          resumed = true;
        }
      } catch {
        // Conversation gone (agy restart, cleanup), or a build without
        // session/resume — a fresh session is the safe fallback.
      }
    }

    if (!resumed) {
      try {
        sessionNewResult = await conn.request("session/new", sessionParams, 60000);
      } catch (err: any) {
        // Authentication required error code (-32000)
        if (err?.code === -32000 || String(err?.message || "").includes("Authentication required")) {
          const hasRealKey = (k?: string) =>
            Boolean(k && k !== "acp-managed" && !k.startsWith("{") && !k.startsWith("<"));
          const methodId =
            hasRealKey(apiKey) || hasRealKey(process.env.GEMINI_API_KEY)
              ? "gemini-api-key"
              : "oauth-personal";
          await conn.authenticate({ methodId });
          sessionNewResult = await conn.request("session/new", sessionParams, 60000);
        } else {
          throw err;
        }
      }
    }

    this.lastSessionNewResult = sessionNewResult;
    const acpSessionId = sessionNewResult.sessionId;

    // Extract initial model & thought_level from sessionNewResult.configOptions so we don't fire redundant RPCs
    let initialModelId = "";
    let initialEffort: string | undefined = undefined;
    if (Array.isArray(sessionNewResult?.configOptions)) {
      const modelOpt = sessionNewResult.configOptions.find((o: any) => o.id === "model");
      const thoughtOpt = sessionNewResult.configOptions.find((o: any) => o.id === "thought_level");
      if (modelOpt?.currentValue) initialModelId = String(modelOpt.currentValue);
      if (thoughtOpt?.currentValue) initialEffort = String(thoughtOpt.currentValue).toLowerCase();
    }

    const liveSession: LiveAcpSession = {
      sessionKey,
      acpSessionId,
      cwd,
      currentModelId: initialModelId,
      currentEffort: initialEffort,
      systemPromptHash,
      syncedMessageCount: resumed && resume ? resume.syncedMessageCount : 0,
      prefixHash: resumed && resume ? resume.prefixHash : "",
      stale: false,
      rewriteFingerprint: resumed && resume?.rewriteFingerprint ? resume.rewriteFingerprint : "",
      inFlightPrompt: null,
      unbindAbort: null,
      pendingMcpBatch: null,
      eventListener: null,
      lastUsedAt: Date.now(),
    };

    this.sessions.set(sessionKey, liveSession);
    this.acpToLiveSession.set(acpSessionId, liveSession);

    // Apply model & effort configuration. A loaded conversation comes back on
    // the account default model (e.g. gemini-4-argon), not the one the session
    // recorded, so this must run on resume too — otherwise the turn is billed
    // against whatever default bucket happens to be free.
    if (resumed || modelId || effort) {
      await this.configureSessionModel(liveSession, modelId, effort);
    }

    this.recordSessionState(sessionKey);
    return liveSession;
  }

  public async configureSessionModel(
    session: LiveAcpSession,
    modelId?: string,
    effort?: string,
  ): Promise<void> {
    if (!this.conn) return;

    const targetModelId = modelId || session.currentModelId || "gemini-3.8-flash";
    const targetEffort = effort ?? session.currentEffort;

    // If a caller/config passed an explicit -low/-medium/-high suffix, normalize to baseModelId + effort
    let baseModelId = targetModelId;
    let inferredEffort: string | undefined;

    const suffixMatch = targetModelId.match(/^(.*)-(low|medium|high)$/i);
    if (suffixMatch) {
      baseModelId = suffixMatch[1];
      inferredEffort = suffixMatch[2].toLowerCase();
    }

    const effectiveEffort = (targetEffort || inferredEffort || "").toLowerCase();
    let mappedEffort: "low" | "medium" | "high" | undefined;
    if (effectiveEffort === "minimal" || effectiveEffort === "low" || effectiveEffort === "none") {
      mappedEffort = "low";
    } else if (effectiveEffort === "medium") {
      mappedEffort = "medium";
    } else if (
      effectiveEffort === "high" ||
      effectiveEffort === "xhigh" ||
      effectiveEffort === "max"
    ) {
      mappedEffort = "high";
    }

    // Skip RPCs if nothing changed on this live session
    if (
      session.currentModelId === baseModelId &&
      (!mappedEffort || session.currentEffort === mappedEffort)
    ) {
      return;
    }

    // 1. Primary ACP configuration via session/set_config_option ("model" + "thought_level")
    let modelConfigSet = false;
    let switchError: string | undefined;
    if (baseModelId && session.currentModelId !== baseModelId) {
      try {
        const res = await this.conn.request("session/set_config_option", {
          sessionId: session.acpSessionId,
          configId: "model",
          value: baseModelId,
        });
        modelConfigSet = true;
        session.currentModelId = baseModelId;
        // Switching "model" sets a default "thought_level" on the server (e.g. "medium" for gemini-3.8-flash);
        // read it from the response so we can skip the second RPC if it already matches mappedEffort!
        if (Array.isArray(res?.configOptions)) {
          const thoughtOpt = res.configOptions.find((o: any) => o.id === "thought_level");
          if (thoughtOpt?.currentValue) {
            session.currentEffort = String(thoughtOpt.currentValue).toLowerCase();
          }
        }
      } catch (err) {
        switchError = errorMessage(err);
      }
    } else {
      modelConfigSet = true;
    }

    if (mappedEffort && session.currentEffort !== mappedEffort) {
      try {
        await this.conn.request("session/set_config_option", {
          sessionId: session.acpSessionId,
          configId: "thought_level",
          value: mappedEffort,
        });
        session.currentEffort = mappedEffort;
      } catch {
        // Fallback to "high" if "medium" is unsupported for that model (e.g. gemini-3.1-pro only has low/high)
        if (mappedEffort === "medium" && session.currentEffort !== "high") {
          try {
            await this.conn.request("session/set_config_option", {
              sessionId: session.acpSessionId,
              configId: "thought_level",
              value: "high",
            });
            session.currentEffort = "high";
          } catch {}
        }
      }
    }

    // 2. Fallback to session/set_model if session/set_config_option wasn't supported
    if (!modelConfigSet && baseModelId) {
      const candidateIds = mappedEffort
        ? [`${baseModelId}-${mappedEffort}`, baseModelId]
        : [baseModelId];
      for (const candidateId of candidateIds) {
        try {
          await this.conn.request("session/set_model", {
            sessionId: session.acpSessionId,
            modelId: candidateId,
          });
          modelConfigSet = true;
          break;
        } catch (err) {
          switchError = errorMessage(err);
        }
      }
    }

    if (!modelConfigSet && baseModelId) {
      const reason = switchError ?? "no matching model configuration method";
      // The picker can outlive a model — omp unions dynamic discovery onto the
      // static roster, so a retired id stays selectable. Continuing silently on
      // the previous model is worse than saying which model actually ran.
      if (/unknown model|not found|unsupported|invalid/i.test(reason)) {
        const available = this.advertisedModelIds();
        throw new Error(
          `Antigravity does not serve model "${baseModelId}" (${reason}).` +
            (available.length ? ` Available: ${available.join(", ")}.` : ""),
        );
      }
      this.onWarning?.(
        `Antigravity model switch to "${baseModelId}" failed (${reason}); continuing on "${session.currentModelId}".`,
      );
      return;
    }

    session.currentModelId = baseModelId;
    if (mappedEffort) session.currentEffort = mappedEffort;
  }

  public bindAbortSignal(session: LiveAcpSession, signal?: AbortSignal): void {
    this.unbindAbortSignal(session);
    if (!signal) return;

    const onAbort = () => {
      this.unbindAbortSignal(session);
      session.eventListener = null;
      this.abortPendingMcpBatch(session);
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      session.unbindAbort = () => {
        signal.removeEventListener("abort", onAbort);
        session.unbindAbort = null;
      };
    }
  }

  public unbindAbortSignal(session: LiveAcpSession): void {
    if (session.unbindAbort) {
      session.unbindAbort();
      session.unbindAbort = null;
    }
  }

  public async drainInFlightPrompt(session: LiveAcpSession): Promise<void> {
    if (session.inFlightPrompt) {
      const prev = session.inFlightPrompt;
      await Promise.race([
        prev.catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
  }

  public sendPrompt(
    session: LiveAcpSession,
    promptBlocks: any[],
    signal?: AbortSignal,
  ): Promise<any> {
    if (!this.conn) {
      return Promise.reject(new Error("No active ACP connection"));
    }

    if (signal?.aborted) {
      return Promise.reject(new Error("Request was aborted"));
    }

    session.lastUsedAt = Date.now();

    const promptPromise = this.conn.request(
      "session/prompt",
      {
        sessionId: session.acpSessionId,
        prompt: promptBlocks,
      },
      0, // turns can take significant time
    );

    const tracked = promptPromise.finally(() => {
      if (session.inFlightPrompt === tracked) {
        session.inFlightPrompt = null;
      }
      this.unbindAbortSignal(session);
    });
    // Pool-owned fork: the adapter handles the original promise, so mark this
    // one handled here. Otherwise closeAll() settling it mid-turn escapes as
    // an unhandled rejection and kills the host process.
    tracked.catch(() => {});
    session.inFlightPrompt = tracked;

    this.bindAbortSignal(session, signal);

    return promptPromise;
  }

  public abortPendingMcpBatch(session: LiveAcpSession): void {
    this.unbindAbortSignal(session);
    if (session.pendingMcpBatch) {
      for (const call of session.pendingMcpBatch.calls.values()) {
        try {
          call.reject(new Error("Turn aborted"));
        } catch {}
      }
      session.pendingMcpBatch = null;
    }
    if (this.conn) {
      this.conn.notify("session/cancel", { sessionId: session.acpSessionId });
    }
  }

  public async authenticateInteractive(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const conn = await this.ensureConnection();

    // Call authenticate with oauth-personal
    try {
      const res = await conn.request("authenticate", { methodId: "oauth-personal" }, 120000);
      if (res?.authUrl && callbacks.openUrl) {
        await callbacks.openUrl(res.authUrl);
      }
      return { access: "acp-managed" };
    } catch (err: any) {
      throw new Error(`Google Antigravity authentication failed: ${err?.message || String(err)}`);
    }
  }

  /** Canonical model ids agy advertised for this account in the last `session/new`. */
  private advertisedModelIds(): string[] {
    const result: any = this.lastSessionNewResult;
    if (!result) return [];
    const ids = new Set<string>();
    const modelOpt = (result.configOptions ?? []).find((opt: any) => opt.id === "model");
    for (const opt of modelOpt?.options ?? []) {
      const id = String(opt.value ?? opt.id ?? "").trim().replace(/-(low|medium|high)$/i, "");
      if (id) ids.add(id);
    }
    for (const m of result.models?.availableModels ?? []) {
      const id = String(m.modelId ?? m.id ?? "").trim().replace(/-(low|medium|high)$/i, "");
      if (id) ids.add(id);
    }
    return [...ids];
  }

  public async discoverModels(): Promise<ProviderModelConfig[]> {
    const modelsMap = new Map<string, ProviderModelConfig>();

    // Add static fallback models first
    for (const m of ANTIGRAVITY_MODELS) {
      modelsMap.set(m.id, { ...m });
    }

    const inspectResult = (result: any) => {
      if (!result) return;

      // 1. Canonical family IDs from configOptions (id === "model")
      if (Array.isArray(result.configOptions)) {
        const modelOpt = result.configOptions.find((opt: any) => opt.id === "model");
        if (modelOpt && Array.isArray(modelOpt.options)) {
          for (const opt of modelOpt.options) {
            const rawId = String(opt.value || opt.id || "").trim();
            if (!rawId) continue;
            // Strip any redundant -low/-medium/-high suffix so only canonical models appear in picker
            const id = rawId.replace(/-(low|medium|high)$/i, "");
            if (id && !modelsMap.has(id)) {
              modelsMap.set(id, antigravityDiscoveredModel(id, opt.name));
            }
          }
        }
      }

      // 2. Fallback: extract canonical base IDs from models.availableModels (ignoring -low/-medium/-high duplicates)
      if (result.models && Array.isArray(result.models.availableModels)) {
        for (const m of result.models.availableModels) {
          const rawId = String(m.modelId || m.id || "").trim();
          if (!rawId) continue;
          const baseId = rawId.replace(/-(low|medium|high)$/i, "");
          if (baseId && !modelsMap.has(baseId)) {
            modelsMap.set(baseId, antigravityDiscoveredModel(baseId, m.name));
          }
        }
      }
    };

    if (this.lastSessionNewResult) {
      inspectResult(this.lastSessionNewResult);
    } else {
      try {
        // Quick probe session to discover models if none created yet
        const probeSession = await this.createSession(
          "probe-discovery",
          process.cwd(),
          undefined,
          undefined,
          undefined,
          undefined,
          false,
        );
        if (this.lastSessionNewResult) {
          inspectResult(this.lastSessionNewResult);
        }
        await this.resetSession("probe-discovery");
      } catch {}
    }

    return Array.from(modelsMap.values());
  }

  private handleSessionUpdate(acpSessionId: string, update: any): void {
    const session = this.acpToLiveSession.get(acpSessionId);
    if (!session || !session.eventListener) return;

    session.lastUsedAt = Date.now();

    if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content?.type === "text" && update.content.text) {
        session.eventListener({
          type: "thinking_delta",
          text: update.content.text,
        });
      }
    } else if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content?.type === "text" && update.content.text) {
        session.eventListener({
          type: "text_delta",
          text: update.content.text,
        });
      }
    } else if (update.sessionUpdate === "usage_update") {
      session.eventListener({
        type: "usage",
        inputTokens: update.inputTokens ?? 0,
        outputTokens: update.outputTokens ?? 0,
        cachedReadTokens: update.cachedTokens ?? update.cacheReadTokens,
        cachedWriteTokens: update.cachedWriteTokens,
        thoughtTokens: update.thoughtsTokens ?? update.thoughtTokens,
        contextTokens: update.used,
        contextWindow: update.size,
      });
    }
  }

  public evictIdleSessions(maxIdleMs: number): void {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      // Never drop a conversation out from under a running turn.
      if (session.inFlightPrompt || session.pendingMcpBatch) continue;
      if (now - session.lastUsedAt <= maxIdleMs) continue;

      // Eviction is a memory decision, not a context decision: keep the handle
      // so the next turn reattaches with session/resume instead of replaying
      // the transcript into a fresh session.
      const candidate = this.snapshotSession(session);
      this.resetSession(key).catch(() => {});
      if (candidate) this.setResumeCandidate(key, candidate);
    }
  }

  public async resetSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    this.abortPendingMcpBatch(session);
    this.mcpBridge.removeSession(sessionKey);
    this.sessions.delete(sessionKey);
    this.acpToLiveSession.delete(session.acpSessionId);
    this.resumeCandidates.delete(sessionKey);
  }

  public async closeAll(): Promise<void> {
    if (this.evictionInterval) {
      clearInterval(this.evictionInterval);
      this.evictionInterval = null;
    }

    for (const session of this.sessions.values()) {
      // Detach listeners first: the process is going away, so late prompt
      // settlements must not surface as provider errors on dead streams.
      session.eventListener = null;
      this.abortPendingMcpBatch(session);
    }
    this.sessions.clear();
    this.acpToLiveSession.clear();

    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }

    await this.mcpBridge.close();
  }
}
