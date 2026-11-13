/**
 * index.ts
 *
 * Entry point for omp-antigravity-acp extension.
 * Registers the "google-antigravity" provider with official ACP support,
 * custom streamSimple adapter, keep-alive session pool, and slash commands.
 */

import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type OAuthLoginCallbacks,
  type OAuthCredentials,
  ANTIGRAVITY_API_NAME,
  ANTIGRAVITY_PROVIDER_NAME,
  ANTIGRAVITY_MODELS,
} from "./src/types.ts";
import { AcpSessionPool, resolveAgyBinary, type PersistedAcpSessionState } from "./src/acp-pool.ts";
import { streamAntigravityAcp } from "./src/stream-adapter.ts";
import {
  type AntigravityUsageMode,
  antigravityAcpUsageProvider,
  antigravityUsageConfigPath,
  antigravityUsageEnvOverride,
  antigravityUsageMode,
  setAntigravityUsageMode,
} from "./src/usage.ts";

export { AcpSessionPool, resolveAgyBinary } from "./src/acp-pool.ts";
export { streamAntigravityAcp } from "./src/stream-adapter.ts";
export {
  antigravityAcpUsageProvider,
  antigravityUsageConfigPath,
  antigravityUsageEnvOverride,
  antigravityUsageMode,
  parseAgyUsagePayload,
  setAntigravityUsageMode,
} from "./src/usage.ts";
export * from "./src/types.ts";

/**
 * Session entry that carries the live ACP handle across processes. omp's
 * extension docs ("Session and state patterns") prescribe `appendEntry` +
 * `ctx.sessionManager.getBranch()` for durable extension state, so the handle
 * rides with the session file: it survives --continue/--resume and follows
 * branch switches instead of living in a sidecar keyed by session id.
 */
const SESSION_STATE_ENTRY = "smol.omp-antigravity-acp.session";

interface SessionBranchEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface SessionManagerLike {
  getSessionId?: () => string;
  getBranch?: () => SessionBranchEntry[];
}

function sessionManagerOf(ctx: unknown): SessionManagerLike | undefined {
  if (!ctx || typeof ctx !== "object" || !("sessionManager" in ctx)) return undefined;
  const manager = ctx.sessionManager;
  return manager && typeof manager === "object" ? (manager as SessionManagerLike) : undefined;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.ui?.notify) {
    ctx.ui.notify(message, type);
  } else if (ctx.ui?.write) {
    ctx.ui.write(`${message}\n`);
  } else {
    console.log(message);
  }
}

export default function registerAntigravityAcpExtension(pi: ExtensionAPI): void {
  // Singleton pool for this extension runtime
  const pool = new AcpSessionPool();

  // Only the session this extension was registered for gets a durable handle;
  // subagent sessions run without a session manager here.
  let mainSessionId: string | undefined;

  pool.onWarning = (message) => {
    pi.logger?.warn?.(message);
  };

  pool.onSessionState = (sessionKey, state) => {
    if (!mainSessionId || sessionKey !== mainSessionId) return;
    try {
      pi.appendEntry?.(SESSION_STATE_ENTRY, { sessionKey, state });
    } catch {}
  };

  const restoreResumeCandidate = (ctx: unknown): void => {
    const manager = sessionManagerOf(ctx);
    const sessionId = manager?.getSessionId?.();
    if (!sessionId) return;
    mainSessionId = sessionId;

    let latest: PersistedAcpSessionState | null = null;
    for (const entry of manager?.getBranch?.() ?? []) {
      // A compaction or branch summary rewrites the context; any handle saved
      // before it belongs to a conversation omp no longer has.
      if (entry?.type === "compaction" || entry?.type === "branch_summary") {
        latest = null;
        continue;
      }
      if (entry?.type !== "custom" || entry.customType !== SESSION_STATE_ENTRY) continue;
      const data = entry.data as
        | { sessionKey?: string; state?: PersistedAcpSessionState | null }
        | undefined;
      if (data?.sessionKey && data.sessionKey !== sessionId) continue;
      latest = data?.state ?? null;
    }
    pool.setResumeCandidate(sessionId, latest);
  };

  // A branch forks the transcript, but the live ACP conversation carries the
  // original continuation — reattaching it on the new branch would splice in
  // turns the branch does not have, so drop the handle instead.
  const dropResumeCandidate = (_event: unknown, ctx: unknown): void => {
    const sessionId = sessionManagerOf(ctx)?.getSessionId?.() ?? mainSessionId;
    if (!sessionId) return;
    if (mainSessionId && sessionId !== mainSessionId) return;
    pool.markStale(sessionId);
    pool.setResumeCandidate(sessionId, null);
    pool.clearPersistedSession(sessionId);
  };

  // omp rewrites history behind the plugin's back for compaction, shake,
  // pruning, and image drops. Mark the live ACP conversation stale so the next
  // provider request rebuilds it instead of appending to a pre-rewrite prefix.
  const invalidateSession = (ctx: unknown): void => {
    const sessionId = sessionManagerOf(ctx)?.getSessionId?.() ?? mainSessionId;
    if (!sessionId) return;
    if (mainSessionId && sessionId !== mainSessionId) return;
    pool.markStale(sessionId);
    pool.setResumeCandidate(sessionId, null);
    pool.clearPersistedSession(sessionId);
  };

  // ACP's billing counters are per-turn deltas, so the context bar needs omp's
  // own tokenizer count. Capture it at the boundaries where the retained
  // context changes; the stream adapter prefers this over its local heuristic.
  const contextUsageTokens = (ctx: unknown): number | undefined => {
    if (!ctx || typeof ctx !== "object" || !("getContextUsage" in ctx)) return undefined;
    const getContextUsage = ctx.getContextUsage;
    if (typeof getContextUsage !== "function") return undefined;
    const usage: unknown = getContextUsage.call(ctx);
    if (!usage || typeof usage !== "object" || !("tokens" in usage)) return undefined;
    const tokens = usage.tokens;
    return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
  };

  const captureContextUsage = (ctx: unknown): void => {
    const sessionId = sessionManagerOf(ctx)?.getSessionId?.() ?? mainSessionId;
    if (!sessionId) return;
    if (mainSessionId && sessionId !== mainSessionId) return;
    pool.setOmpContextTokens(sessionId, contextUsageTokens(ctx));
  };

  // Pre-warm the ACP process + MCP bridge when an interactive session starts,
  // so the first turn doesn't pay cold boot cost without spawning `agy acp`
  // from one-shot CLI commands such as `omp usage`. Also restore the handle of
  // a conversation agy may still be holding from an earlier process.
  pi.on?.("session_start", (_event, ctx) => {
    restoreResumeCandidate(ctx);
    captureContextUsage(ctx);
    pool.ensureConnection().catch(() => {});
  });
  pi.on?.("session_branch", dropResumeCandidate);
  pi.on?.("session_tree", (event, ctx) => {
    dropResumeCandidate(event, ctx);
    captureContextUsage(ctx);
  });
  pi.on?.("session_compact", (_event, ctx) => {
    invalidateSession(ctx);
    captureContextUsage(ctx);
  });
  pi.on?.("agent_end", (_event, ctx) => {
    captureContextUsage(ctx);
  });
  // Automatic shake/snapcompact/full summaries emit this pair; the end event
  // is the only signal for shake, which does not append a compaction entry.
  pi.on?.("auto_compaction_end", (event, ctx) => {
    if (!event || typeof event !== "object") return;
    if ("aborted" in event && event.aborted === true) return;
    if ("skipped" in event && event.skipped === true) return;
    invalidateSession(ctx);
    captureContextUsage(ctx);
  });
  // Best-effort manual `/shake` coverage. Programmatic shakes (body-read
  // timeout, dead-end rescue) are caught by the adapter's rewrite fingerprint.
  pi.on?.("input", (event, ctx) => {
    if (
      event &&
      typeof event === "object" &&
      "text" in event &&
      typeof event.text === "string" &&
      /^\s*\/shake(?:\s|$)/.test(event.text)
    ) {
      invalidateSession(ctx);
    }
  });

  // Register the provider
  pi.registerProvider(ANTIGRAVITY_PROVIDER_NAME, {
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    api: ANTIGRAVITY_API_NAME,
    apiKey: "acp-managed",
    auth: "none",
    oauth: {
      name: "Google Antigravity (Official ACP)",
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string> {
        return await pool.authenticateInteractive(callbacks);
      },
      refreshToken(creds: OAuthCredentials): Promise<OAuthCredentials> {
        return Promise.resolve(creds);
      },
      getApiKey(creds: OAuthCredentials): string {
        return creds.access || "acp-managed";
      },
    },
    streamSimple: (model, context, options) => {
      return streamAntigravityAcp(pool, model, context, options);
    },
    usage: antigravityAcpUsageProvider,
    models: ANTIGRAVITY_MODELS,
    fetchDynamicModels: async () => {
      return await pool.discoverModels();
    },
  });

  // Slash commands
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("agy-status", {
      description: "Show Google Antigravity ACP binary status, active sessions, and usage mode",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        let binaryPath = "unknown";
        try {
          binaryPath = resolveAgyBinary();
        } catch (error) {
          binaryPath = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }

        const usageMode = antigravityUsageMode();
        const msg = [
          "Google Antigravity ACP Status:",
          `• Binary: ${binaryPath}`,
          `• Provider: ${ANTIGRAVITY_PROVIDER_NAME} (${ANTIGRAVITY_API_NAME})`,
          `• Auth Mode: native ACP (OAuth / Gemini CLI)`,
          `• Usage: ${usageMode === "cli" ? 'agy -p "/usage"' : "off"} (toggle: /agy-usage)`,
        ].join("\n");

        notify(ctx, msg, usageMode === "cli" ? "info" : "warning");
      },
    });

    pi.registerCommand("agy-usage", {
      description: "Toggle Antigravity quota reporting in /usage (agy -p /usage)",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const envOverride = antigravityUsageEnvOverride();
        const verb = args.trim().toLowerCase();
        let next: AntigravityUsageMode | undefined;

        if (verb === "on" || verb === "enable" || verb === "cli") next = "cli";
        else if (verb === "off" || verb === "disable") next = "off";
        else if (verb && verb !== "status") {
          notify(ctx, "Usage: /agy-usage [on|off|status]", "warning");
          return;
        }

        if (!next && !verb && ctx.ui?.select) {
          const selected = await ctx.ui.select("Antigravity `/usage` source", [
            { label: "On — agy -p /usage", description: "Live quota buckets in /usage" },
            {
              label: "Off — ACP only",
              description: "No quota subprocess; /usage shows nothing for this provider",
            },
          ]);
          if (selected?.startsWith("On")) next = "cli";
          else if (selected?.startsWith("Off")) next = "off";
        }

        if (next) {
          try {
            const effective = setAntigravityUsageMode(next);
            const lines = [
              `Antigravity /usage: ${effective === "cli" ? "on" : "off"}.`,
              `Saved to ${antigravityUsageConfigPath()}`,
            ];
            if (envOverride) {
              lines.push(`Note: OMP_AGY_USAGE_SOURCE=${envOverride} overrides the saved setting.`);
            }
            notify(ctx, lines.join("\n"), effective === "cli" ? "info" : "warning");
          } catch (error) {
            notify(
              ctx,
              `Failed to save /usage setting: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
          return;
        }

        const mode = antigravityUsageMode();
        const lines = [`Antigravity /usage: ${mode === "cli" ? "on" : "off"} (effective).`];
        if (envOverride) lines.push(`Source: OMP_AGY_USAGE_SOURCE=${envOverride} (environment override).`);
        else lines.push(`Config: ${antigravityUsageConfigPath()}`);
        lines.push(mode === "cli" ? "Disable with /agy-usage off." : "Enable with /agy-usage on.");
        notify(ctx, lines.join("\n"), mode === "cli" ? "info" : "warning");
      },
    });

    pi.registerCommand("agy-reset", {
      description: "Reset all live Antigravity ACP sessions and restart the ACP background process",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        await pool.closeAll();
        notify(ctx, "All Antigravity ACP sessions and processes have been reset.", "info");
      },
    });
  }

  // Graceful shutdown on session end (never throw out of teardown:
  // an unhandled rejection here takes down the whole host process).
  pi.on?.("session_shutdown", async () => {
    try {
      await pool.closeAll();
    } catch {}
  });
}
