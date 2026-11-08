/**
 * index.ts
 *
 * Entry point for omp-antigravity-acp extension.
 * Registers the "google-antigravity" provider with official ACP support,
 * custom streamSimple adapter, keep-alive session pool, and slash commands.
 */

import {
  type ExtensionAPI,
  type OAuthLoginCallbacks,
  type OAuthCredentials,
  ANTIGRAVITY_API_NAME,
  ANTIGRAVITY_PROVIDER_NAME,
  ANTIGRAVITY_MODELS,
} from "./src/types.ts";
import { AcpSessionPool, resolveAgyBinary } from "./src/acp-pool.ts";
import { streamAntigravityAcp } from "./src/stream-adapter.ts";

export { AcpSessionPool, resolveAgyBinary } from "./src/acp-pool.ts";
export { streamAntigravityAcp } from "./src/stream-adapter.ts";
export * from "./src/types.ts";

export default function registerAntigravityAcpExtension(pi: ExtensionAPI): void {
  // Singleton pool for this extension runtime
  const pool = new AcpSessionPool();

  // Pre-warm the ACP process + MCP bridge in the background so the first turn doesn't pay cold boot cost
  pool.ensureConnection().catch(() => {});

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
    models: ANTIGRAVITY_MODELS,
    fetchDynamicModels: async () => {
      return await pool.discoverModels();
    },
  });

  // Slash commands
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("agy-status", {
      description: "Show Google Antigravity ACP binary status and active session count",
      handler: async (_args: string, ctx: any) => {
        let binaryPath = "unknown";
        try {
          binaryPath = resolveAgyBinary();
        } catch (e: any) {
          binaryPath = `Error: ${e.message}`;
        }

        const msg = [
          "Google Antigravity ACP Status:",
          `• Binary: ${binaryPath}`,
          `• Provider: ${ANTIGRAVITY_PROVIDER_NAME} (${ANTIGRAVITY_API_NAME})`,
          `• Auth Mode: native ACP (OAuth / Gemini CLI)`,
        ].join("\n");

        if (ctx?.ui?.notify) {
          ctx.ui.notify(msg, "info");
        } else if (ctx?.ui?.write) {
          ctx.ui.write(`${msg}\n`);
        } else {
          console.log(msg);
        }
      },
    });

    pi.registerCommand("agy-reset", {
      description: "Reset all live Antigravity ACP sessions and restart the ACP background process",
      handler: async (_args: string, ctx: any) => {
        await pool.closeAll();
        const msg = "All Antigravity ACP sessions and processes have been reset.";
        if (ctx?.ui?.notify) {
          ctx.ui.notify(msg, "info");
        } else if (ctx?.ui?.write) {
          ctx.ui.write(`${msg}\n`);
        } else {
          console.log(msg);
        }
      },
    });
  }

  // Graceful shutdown on session end
  if (typeof (pi as any).on === "function") {
    (pi as any).on("session_shutdown", async () => {
      await pool.closeAll();
    });
  }
}
