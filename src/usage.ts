/**
 * usage.ts
 *
 * omp usage provider for the Antigravity ACP extension.
 *
 * Quota data comes from `agy`'s own read-only `/usage` slash command in print
 * mode. That path is part of the official CLI surface (no agent turn, zero
 * tokens) and avoids talking to Cloud Code's internal quota endpoints directly.
 *
 * `agy -p /usage --output-format json` answers with:
 *
 *   { "command": { "data": { "groups": [{ "name", "buckets": [{
 *       "id", "name", "window", "remaining_fraction", "reset_time"
 *     }] }] } } }
 *
 * The provider maps those buckets to omp's normalized UsageReport shape so the
 * limits appear in the live `/usage` command and in `omp usage`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAgyBinary } from "./acp-pool.ts";
import {
  ANTIGRAVITY_PROVIDER_NAME,
  type UsageAmount,
  type UsageFetchContext,
  type UsageFetchParams,
  type UsageLimit,
  type UsageProvider,
  type UsageReport,
  type UsageStatus,
  type UsageWindow,
} from "./types.ts";

// ============================================================================
// Constants
// ============================================================================

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const USAGE_CACHE_MS = 10_000;
const USAGE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const USAGE_SOURCE_ENV = "OMP_AGY_USAGE_SOURCE";
const USAGE_STATE_FILE = "antigravity-acp-usage.json";

// ============================================================================
// Shape Guards
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampFraction(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  if (!record) return String(error);
  const parts: string[] = [];
  const message = asString(record.message);
  if (message) parts.push(message);
  if (record.data !== undefined) {
    try {
      parts.push(JSON.stringify(record.data));
    } catch {
      // Ignore non-serializable error payloads.
    }
  }
  return parts.length > 0 ? parts.join(" ") : String(error);
}

// ============================================================================
// Window / Amount Helpers
// ============================================================================

interface WindowDescriptor {
  id: string;
  label: string;
  durationMs?: number;
}

function classifyWindow(id: string | undefined, label: string | undefined): WindowDescriptor | undefined {
  const source = `${id ?? ""} ${label ?? ""}`.toLowerCase();
  if (source.includes("week") || source.includes("7d") || /7[\s_-]*day/.test(source)) {
    return { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
  }
  if (source.includes("5h") || source.includes("five hour") || /5[\s_-]*hour/.test(source)) {
    return { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS };
  }
  if (source.includes("day") || source.includes("daily") || source.includes("24h")) {
    return { id: "daily", label: "Daily", durationMs: DAY_MS };
  }
  if (id || label) return { id: id ?? label ?? "default", label: label ?? id ?? "Default" };
  return undefined;
}

function parseWindow(row: BucketRow): UsageWindow | undefined {
  const descriptor = classifyWindow(row.window, row.bucketName);
  const resetAt = row.resetTime ? Date.parse(row.resetTime) : Number.NaN;
  const resetsAt = Number.isFinite(resetAt) ? resetAt : undefined;
  if (!descriptor && resetsAt === undefined) return undefined;
  return {
    id: descriptor?.id ?? row.window ?? "default",
    label: descriptor?.label ?? row.window ?? "Default",
    ...(descriptor?.durationMs !== undefined ? { durationMs: descriptor.durationMs } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function buildPercentAmount(remainingFraction: number | undefined): UsageAmount {
  const amount: UsageAmount = { unit: "percent" };
  if (remainingFraction === undefined) return amount;
  const usedFraction = 1 - remainingFraction;
  amount.remainingFraction = remainingFraction;
  amount.usedFraction = usedFraction;
  amount.remaining = remainingFraction * 100;
  amount.used = usedFraction * 100;
  amount.limit = 100;
  return amount;
}

function statusFor(remainingFraction: number | undefined): UsageStatus {
  if (remainingFraction === undefined) return "unknown";
  if (remainingFraction <= 0) return "exhausted";
  if (remainingFraction <= 0.1) return "warning";
  return "ok";
}

// ============================================================================
// Counter Mapping (must match omp's built-in antigravity ranking strategy)
// ============================================================================

function counterKeysFor(groupName: string | undefined, bucketId: string | undefined): string[] {
  const bucket = bucketId?.toLowerCase() ?? "";
  const group = groupName?.toLowerCase() ?? "";
  if (bucket.startsWith("gemini-") || group.includes("gemini")) return ["google"];
  if (
    bucket.startsWith("3p-") ||
    group.includes("claude") ||
    group.includes("gpt") ||
    group.includes("third party")
  ) {
    // Antigravity exposes one shared third-party group. Duplicate it into the
    // existing model-family scopes so Claude and GPT requests both participate
    // in credential ranking without inventing a second quota.
    return ["anthropic", "openai"];
  }
  return ["default"];
}

function counterName(counterKey: string): string | undefined {
  switch (counterKey) {
    case "google":
      return "Google";
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    default:
      return undefined;
  }
}

// ============================================================================
// agy /usage Parsing
// ============================================================================

interface BucketRow {
  bucketId?: string;
  bucketName?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
  groupName?: string;
}

function rowFromBucket(value: unknown, groupName: string | undefined): BucketRow | undefined {
  const bucket = asRecord(value);
  if (!bucket || bucket.disabled === true) return undefined;

  const bucketId = asString(bucket.id) ?? asString(bucket.bucketId);
  const bucketName = asString(bucket.name) ?? asString(bucket.displayName);
  const window = asString(bucket.window);
  const resetTime = asString(bucket.reset_time) ?? asString(bucket.resetTime);
  const remainingFraction = clampFraction(
    asFiniteNumber(bucket.remaining_fraction) ?? asFiniteNumber(bucket.remainingFraction),
  );

  if (bucketId === undefined && bucketName === undefined && remainingFraction === undefined) return undefined;
  return { bucketId, bucketName, window, remainingFraction, resetTime, groupName };
}

function rowsFromJson(payload: unknown): { rows: BucketRow[]; description?: string } | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const command = asRecord(root.command);
  if (asString(command?.name) !== "usage") return undefined;
  const data = asRecord(command?.data);
  if (!data) return undefined;

  const description = asString(data.description);
  const rows: BucketRow[] = [];
  let grouped = false;

  for (const groupValue of asArray(data.groups)) {
    const group = asRecord(groupValue);
    if (!group) continue;
    const buckets = asArray(group.buckets);
    if (buckets.length === 0) continue;
    grouped = true;
    const groupName = asString(group.name);
    for (const bucketValue of buckets) {
      const row = rowFromBucket(bucketValue, groupName);
      if (row) rows.push(row);
    }
  }

  if (!grouped) {
    for (const bucketValue of asArray(data.buckets)) {
      const row = rowFromBucket(bucketValue, undefined);
      if (row) rows.push(row);
    }
  }

  return rows.length > 0 ? { rows, description } : undefined;
}

function parsePercent(value: string): number | undefined {
  const match = /(-?\d+(?:\.\d+)?)\s*%/.exec(value);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? clampFraction(parsed / 100) : undefined;
}

function rowsFromText(text: string): BucketRow[] | undefined {
  const rows: BucketRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split("\t").map(column => column.trim());
    if (columns.length < 3) continue;
    const groupName = columns[0];
    const bucketName = columns[1];
    const remainingFraction = parsePercent(columns[2] ?? "");
    if (remainingFraction === undefined) continue;
    const resetTime = columns[3];
    rows.push({
      bucketId: `${groupName}-${bucketName}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
      bucketName,
      window: bucketName,
      remainingFraction,
      resetTime,
      groupName,
    });
  }
  return rows.length > 0 ? rows : undefined;
}

function buildReport(
  rows: BucketRow[],
  params: UsageFetchParams,
  nowMs: number,
  description: string | undefined,
  raw: unknown,
): UsageReport | null {
  const limits: UsageLimit[] = [];

  for (const row of rows) {
    const window = parseWindow(row);
    const remainingFraction = clampFraction(row.remainingFraction ?? (row.resetTime ? 0 : undefined));
    const amount = buildPercentAmount(remainingFraction);
    const counterKeys = counterKeysFor(row.groupName, row.bucketId);
    const sharedGroup =
      counterKeys.length > 1
        ? `${row.bucketId ?? row.groupName ?? "third-party"}:${window?.id ?? row.window ?? "default"}`
        : undefined;
    const bucketLabel =
      row.bucketId?.toLowerCase().startsWith("gemini-argon-") || row.groupName?.toLowerCase().includes("argon")
        ? "Gemini (Argon)"
        : undefined;

    for (const counterKey of counterKeys) {
      const windowId = window?.id ?? row.window ?? row.bucketId ?? "default";
      const name = counterName(counterKey);
      const label =
        sharedGroup !== undefined ? "Claude & GPT (shared)" : (bucketLabel ?? (counterKey === "google" ? "Gemini" : name));
      limits.push({
        id: `${params.provider}:${counterKey}:default:${row.bucketId ?? windowId}`,
        label: label ?? row.groupName ?? row.bucketName ?? "Usage",
        scope: {
          provider: params.provider,
          accountId: params.credential.accountId,
          projectId: params.credential.projectId,
          windowId,
          ...(sharedGroup !== undefined ? { shared: true, sharedGroup } : {}),
        },
        window,
        amount,
        status: statusFor(amount.remainingFraction),
      });
    }
  }

  if (limits.length === 0) return null;

  limits.sort((a, b) => (a.amount.remainingFraction ?? 1) - (b.amount.remainingFraction ?? 1));

  const metadata: Record<string, unknown> = { source: "agy-usage-command" };
  if (params.credential.accountId) metadata.accountId = params.credential.accountId;
  if (params.credential.projectId) metadata.projectId = params.credential.projectId;
  if (params.credential.email) metadata.email = params.credential.email;
  if (description !== undefined) metadata.description = description;

  return {
    provider: params.provider,
    fetchedAt: nowMs,
    limits,
    metadata,
    raw,
  };
}

/** Parse the JSON (or text fallback) produced by `agy -p /usage`. */
export function parseAgyUsagePayload(
  payload: unknown,
  params: UsageFetchParams,
  nowMs = Date.now(),
): UsageReport | null {
  const parsed = rowsFromJson(payload);
  if (parsed) return buildReport(parsed.rows, params, nowMs, parsed.description, payload);

  const response = asString(asRecord(payload)?.response);
  if (response) {
    const rows = rowsFromText(response);
    if (rows) return buildReport(rows, params, nowMs, undefined, payload);
  }

  return null;
}

// ============================================================================
// agy Process Invocation
// ============================================================================

function extractJson(stdout: string): unknown {
  const cleaned = stdout.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!cleaned) return undefined;

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through to line/object extraction.
  }

  for (const line of cleaned.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep looking.
    }
  }

  const start = cleaned.indexOf("{");
  if (start >= 0) {
    try {
      return JSON.parse(cleaned.slice(start));
    } catch {
      // Not JSON.
    }
  }
  return undefined;
}

function runAgy(args: string[], signal?: AbortSignal, timeoutMs = USAGE_TIMEOUT_MS): Promise<string> {
  const binary = resolveAgyBinary();
  const shell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary);

  const { promise, resolve, reject } = Promise.withResolvers<string>();

  if (signal?.aborted) {
    reject(new Error("agy /usage aborted"));
    return promise;
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("ANTIGRAVITY_")) env[key] = value;
  }
  env.PYTHONUNBUFFERED = "1";
  // CodexBar sets this for every agy child so passive quota probes cannot
  // start an auto-update. The literal lowercase `true` is the supported value.
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";

  const child = spawn(binary, args, {
    cwd: os.tmpdir(),
    env,
    windowsHide: true,
    shell,
  });

  let stdout = "";
  let stderr = "";
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  const finish = (action: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    action();
  };
  const onAbort = () => {
    try {
      child.kill();
    } catch {
      // Ignore kill failures.
    }
    finish(() => reject(new Error("agy /usage aborted")));
  };

  signal?.addEventListener("abort", onAbort, { once: true });

  timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // Ignore kill failures.
    }
    finish(() => reject(new Error(`agy ${args.join(" ")} timed out after ${timeoutMs}ms`)));
  }, timeoutMs);

  child.stdout?.on("data", chunk => {
    stdout += String(chunk);
    if (stdout.length > MAX_OUTPUT_BYTES) {
      try {
        child.kill();
      } catch {
        // Ignore kill failures.
      }
      finish(() => reject(new Error("agy /usage produced too much output")));
    }
  });
  child.stderr?.on("data", chunk => {
    stderr += String(chunk);
    if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
  });
  child.on("error", error => finish(() => reject(error)));
  child.on("close", code => {
    finish(() => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim().slice(0, 500);
      reject(new Error(`agy /usage exited with code ${String(code)}${detail ? `: ${detail}` : ""}`));
    });
  });

  return promise;
}

// `agy -p "/usage"` gained non-interactive read-only slash-command answers in
// 1.1.11. Older binaries treat it as a model prompt, so gate before spawning.
const MIN_PRINT_USAGE_VERSION = [1, 1, 11] as const;
let printUsageSupport: Promise<boolean> | undefined;

function supportsPrintUsage(): Promise<boolean> {
  printUsageSupport ??= (async () => {
    try {
      const output = await runAgy(["--version"], undefined, 5_000);
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
      if (!match) return false;
      const [minMajor, minMinor, minPatch] = MIN_PRINT_USAGE_VERSION;
      const major = Number(match[1]);
      const minor = Number(match[2]);
      const patch = Number(match[3]);
      return (
        major > minMajor ||
        (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)))
      );
    } catch {
      return false;
    }
  })();
  return printUsageSupport;
}

// ============================================================================
// Provider
// ============================================================================

let cached: { at: number; report: UsageReport | null } | undefined;
let inflight: Promise<UsageReport | null> | undefined;

export type AntigravityUsageMode = "cli" | "off";

function usageStatePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".omp", "agent");
  return path.join(agentDir, USAGE_STATE_FILE);
}

/** Path of the persisted `/agy-usage` toggle. */
export function antigravityUsageConfigPath(): string {
  return usageStatePath();
}

/** Explicit environment override, if one is set. */
export function antigravityUsageEnvOverride(): AntigravityUsageMode | undefined {
  const raw = process.env[USAGE_SOURCE_ENV];
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  return value === "off" || value === "disabled" || value === "none" || value === "acp" || value === "observed" || value === "no"
    ? "off"
    : "cli";
}

function readPersistedUsageMode(): AntigravityUsageMode | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(usageStatePath(), "utf8"));
    if (parsed && typeof parsed === "object" && "mode" in parsed) {
      const mode = parsed.mode;
      if (mode === "off" || mode === "cli") return mode;
    }
  } catch {
    // Missing or malformed state falls back to the default.
  }
  return undefined;
}

/**
 * Effective mode: env override > persisted `/agy-usage` setting > default `cli`.
 *
 * Google's FAQ notes that headless mode is intended for direct scripting/CI and
 * that wrapping `agy` inside third-party applications is not supported under
 * consumer plans, so `off` is the escape hatch.
 */
export function antigravityUsageMode(): AntigravityUsageMode {
  return antigravityUsageEnvOverride() ?? readPersistedUsageMode() ?? "cli";
}

/** Persist the command-level toggle. Returns the effective mode after writing. */
export function setAntigravityUsageMode(mode: AntigravityUsageMode): AntigravityUsageMode {
  const file = usageStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ mode }, null, 2)}\n`, "utf8");
  cached = undefined;
  return antigravityUsageMode();
}

/** omp usage provider backed by `agy -p /usage`. */
export const antigravityAcpUsageProvider: UsageProvider = {
  id: ANTIGRAVITY_PROVIDER_NAME,
  cacheVersion: 1,
  supports: params => params.provider === ANTIGRAVITY_PROVIDER_NAME,
  retainLastGoodOnFailure: true,
  async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
    if (antigravityUsageMode() === "off") return null;

    const now = Date.now();
    if (cached && now - cached.at < USAGE_CACHE_MS) return cached.report;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        if (!(await supportsPrintUsage())) {
          throw new Error("agy >= 1.1.11 is required for non-interactive /usage");
        }
        const stdout = await runAgy(["-p", "/usage", "--output-format", "json"], params.signal);
        const payload = extractJson(stdout);
        const report = payload !== undefined ? parseAgyUsagePayload(payload, params, Date.now()) : null;
        if (report) {
          cached = { at: Date.now(), report };
          return report;
        }
        throw new Error("agy /usage returned no quota data");
      } catch (error) {
        ctx.logger?.warn("Antigravity ACP usage fetch failed", { error: describeError(error) });
        cached = { at: Date.now(), report: null };
        return null;
      } finally {
        inflight = undefined;
      }
    })();

    return inflight;
  },
};
