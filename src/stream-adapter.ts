/**
 * stream-adapter.ts
 *
 * Implements streamAntigravityAcp() for oh-my-pi.
 * Adapts ACP (agy acp) streaming updates and suspended MCP tool turns
 * into oh-my-pi's AssistantMessageEventStream.
 */

import { createHash } from "node:crypto";
import {
  type Context,
  type Model,
  type Message,
  type UserMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type DeveloperMessage,
  type TextContent,
  type ThinkingContent,
  type ImageContent,
  type ToolCall,
  type SimpleStreamOptions,
  type AcpUpdateEvent,
  type HeldMcpToolCall,
  type McpToolResultContent,
  AssistantMessageEventStream,
  createEmptyUsage,
} from "./types.ts";
import { type AcpSessionPool, type LiveAcpSession } from "./acp-pool.ts";

// ============================================================================
// Hash & Content Formatting Utilities
// ============================================================================

export function computeMessagesHash(messages: Message[]): string {
  const hash = createHash("sha256");
  for (const msg of messages) {
    hash.update(msg.role);
    if (msg.role === "user" || msg.role === "developer" || msg.role === "system") {
      if (typeof msg.content === "string") {
        hash.update(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          hash.update(b.type || "");
          if (b.type === "text" && b.text) hash.update(b.text);
          // Full bytes: PNG/JPEG base64 prefixes are shared headers, so a
          // truncated slice cannot distinguish snapcompact frames or edits.
          if (b.type === "image" && b.data) hash.update(b.data);
        }
      }
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Hash structural identity (toolCall IDs/names) without hashing thinking/text that omp may normalize
      for (const b of msg.content) {
        if (b.type === "toolCall" || (b as any).type === "tool_use") {
          hash.update(`tc:${b.id || ""}:${b.name || ""}`);
        }
      }
    } else if (msg.role === "toolResult" || msg.role === "tool") {
      // Hash only toolCallId, NOT toolResult body text!
      // oh-my-pi mutates old duplicate toolResult bodies in-place ("[You have received this identical output N times...]")
      // which must not invalidate the live ACP session or its server-side KV cache.
      if ((msg as any).toolCallId) {
        hash.update(`tr:${String((msg as any).toolCallId)}`);
      }
    }
  }
  return hash.digest("hex");
}

/**
 * omp isolates one-shot provider calls under `:side:` / `:spec:` keys. Those
 * must never be treated as the live conversation, even when they carry tools
 * (handoff, `/btw`, speculative compaction).
 */
export function hasSideSessionSuffix(sessionId: string): boolean {
  return /:(?:side|spec)(?::|$)/i.test(sessionId);
}

function countShakenMarkers(text: string): number {
  let count = 0;
  let index = text.indexOf("[shaken ");
  while (index !== -1) {
    count++;
    index = text.indexOf("[shaken ", index + 8);
  }
  return count;
}

/**
 * Structural fingerprint for history rewrites whose content the continuation
 * hash deliberately ignores: `shake` replaces tool/assistant text in place and
 * removes thinking blocks, while omp's duplicate-output notice changes tool
 * result bodies without meaning to invalidate the live session.
 *
 * Counting shake markers and thinking-block presence catches `shake elide`
 * and `shake thinking` without hashing the bodies that the cache path
 * intentionally skips. Image changes are already covered by
 * {@link computeMessagesHash}.
 */
export function computeRewriteFingerprint(messages: Message[]): string {
  let shaken = 0;
  let thinkingBlocks = 0;
  let images = 0;

  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      shaken += countShakenMarkers(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        shaken += countShakenMarkers(block.text);
      } else if (block.type === "thinking") {
        // Count only: omp may normalize thinking text without intending a
        // rewrite, but `shake thinking` removes the blocks entirely.
        thinkingBlocks++;
      } else if (block.type === "image") {
        images++;
      }
    }
  }

  return `${shaken}:${thinkingBlocks}:${images}`;
}

function formatToolResultContent(content: string | (TextContent | ImageContent)[]): McpToolResultContent[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (c.type === "image") {
        return { type: "image", data: c.data, mimeType: c.mimeType };
      }
      return { type: "text", text: (c as TextContent).text || "" };
    });
  }
  return [{ type: "text", text: String(content ?? "") }];
}

function formatTrailingSteeringBlocks(trailingMessages: Message[]): McpToolResultContent[] {
  const textParts: string[] = [];
  const imageBlocks: McpToolResultContent[] = [];

  for (const m of trailingMessages) {
    const label = m.role === "user" ? "User Steering Message" : "System Reminder";
    if (typeof m.content === "string") {
      if (m.content.trim()) {
        textParts.push(`[${label}]:\n${m.content}`);
      }
    } else if (Array.isArray(m.content)) {
      const msgTexts: string[] = [];
      for (const part of m.content) {
        if (part.type === "text" && part.text) {
          msgTexts.push(part.text);
        } else if (part.type === "image" && part.data) {
          imageBlocks.push({
            type: "image",
            data: part.data,
            mimeType: part.mimeType,
          });
        }
      }
      if (msgTexts.length > 0) {
        textParts.push(`[${label}]:\n${msgTexts.join("\n")}`);
      }
    }
  }

  const result: McpToolResultContent[] = [];
  if (textParts.length > 0) {
    result.push({
      type: "text",
      text: `\n\n<system-reminder>\n${textParts.join("\n\n")}\n</system-reminder>`,
    });
  }
  result.push(...imageBlocks);
  return result;
}

function contentToBlocks(content: unknown): any[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: JSON.stringify(content) }];
  }
  const blocks: any[] = [];
  for (const item of content) {
    if (item.type === "text") {
      if (item.text) blocks.push({ type: "text", text: item.text });
    } else if (item.type === "image") {
      blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  return blocks;
}

interface ToolCallLike {
  type: string;
  name?: string;
  arguments?: unknown;
}

function asToolCallLike(block: unknown): ToolCallLike | undefined {
  if (!block || typeof block !== "object" || !("type" in block)) return undefined;
  const type = block.type;
  return type === "toolCall" || type === "tool_use" ? (block as ToolCallLike) : undefined;
}

/** Flush a label into ordered text/image blocks without dropping images. */
function labeledContentBlocks(label: string, content: unknown): any[] {
  const blocks: any[] = [];
  let text = label;
  const flush = () => {
    if (text) {
      blocks.push({ type: "text", text });
      text = "";
    }
  };

  if (typeof content === "string") {
    text += `\n${content}`;
    flush();
    return blocks;
  }
  if (!Array.isArray(content)) {
    text += `\n${JSON.stringify(content)}`;
    flush();
    return blocks;
  }
  for (const item of content) {
    if (item.type === "text") {
      text += `\n${item.text}`;
    } else if (item.type === "image") {
      flush();
      blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  flush();
  return blocks;
}

/** agy concatenates adjacent text blocks without separators; merge them. */
function mergeAdjacentTextBlocks(blocks: any[]): any[] {
  const merged: any[] = [];
  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    if (block.type === "text" && prev?.type === "text") {
      prev.text = `${prev.text}\n\n${block.text}`;
    } else {
      merged.push(block);
    }
  }
  return merged;
}

function messagesToContentBlocks(messages: Message[]): any[] {
  const blocks: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      blocks.push(...contentToBlocks(msg.content));
    } else if (msg.role === "developer" || msg.role === "system") {
      blocks.push(...labeledContentBlocks("[System Reminder]:", msg.content));
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Thinking is internal: omit it rather than replaying it as model-visible text.
      const parts = msg.content
        .map((c) => {
          if (c.type === "text") return c.text;
          const toolCall = asToolCallLike(c);
          if (toolCall) {
            return `[Assistant Tool Call: ${toolCall.name}(${JSON.stringify(toolCall.arguments ?? {})})]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (parts) {
        blocks.push({ type: "text", text: `[Previous Assistant Turn]:\n${parts}` });
      }
    } else if (msg.role === "toolResult" || msg.role === "tool") {
      const toolCallId = "toolCallId" in msg && typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
      blocks.push(...labeledContentBlocks(`[Tool Result for ${toolCallId}]:`, msg.content));
    }
  }

  return mergeAdjacentTextBlocks(blocks);
}

export function formatFullHistoryTranscript(messages: Message[]): any[] {
  if (messages.length === 0) {
    return [{ type: "text", text: "Hello" }];
  }

  // Find the index of the final user message
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx <= 0) {
    return messagesToContentBlocks(messages);
  }

  const blocks: any[] = [];
  let transcript =
    "These are your own earlier messages in this conversation, for context only. " +
    "Do not summarize or describe this history. The user's current request is the final message below.\n\n";

  const flush = () => {
    if (transcript) {
      blocks.push({ type: "text", text: transcript });
      transcript = "";
    }
  };
  const addText = (text: string) => {
    transcript += text;
  };
  const addImage = (image: ImageContent) => {
    flush();
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  };
  const addContent = (prefix: string, content: unknown) => {
    addText(prefix);
    if (typeof content === "string") {
      addText(`${content}\n\n`);
      return;
    }
    if (!Array.isArray(content)) {
      addText(`${JSON.stringify(content)}\n\n`);
      return;
    }
    for (const item of content) {
      if (item.type === "text") {
        addText(item.text);
      } else if (item.type === "image") {
        addImage(item);
      }
    }
    addText("\n\n");
  };

  for (let i = 0; i < lastUserIdx; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      addContent("User: ", msg.content);
    } else if (msg.role === "assistant") {
      // Thinking is internal: replaying it as text would promote discarded
      // reasoning and defeat `shake thinking`.
      const text = msg.content
        .map((c) => {
          if (c.type === "text") return c.text;
          const toolCall = asToolCallLike(c);
          if (toolCall) return `[Tool Call: ${toolCall.name}]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
      addText(`Assistant: ${text}\n\n`);
    } else if (msg.role === "toolResult" || msg.role === "tool") {
      const toolCallId = "toolCallId" in msg && typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
      addContent(`[Tool Result for ${toolCallId}]:\n`, msg.content);
    } else if (msg.role === "developer" || msg.role === "system") {
      addContent("[System Instruction]:\n", msg.content);
    }
  }
  addText("--- END OF EARLIER MESSAGES ---\nThe user's current request follows. Answer it directly.\n\n");
  flush();

  blocks.push(...messagesToContentBlocks(messages.slice(lastUserIdx)));
  return mergeAdjacentTextBlocks(blocks);
}

// ============================================================================
// Antigravity Prompt Sanitizing
// ============================================================================

/**
 * Google's Cloud Code Assist backend answers a false HTTP 429
 * RESOURCE_EXHAUSTED when the system instruction carries the RFC-2119 keyword
 * sentence (or the `<system-conventions>` / `<system-directive>` section tags)
 * that harness prompts such as omp's ship verbatim: the payload trips a
 * server-side rule and the rejection is misreported as quota. The `agy` CLI is
 * unaffected because its own prompt lacks those literals.
 *
 * Rewriting them keeps the instruction's meaning while avoiding the match.
 * Set OMP_AGY_SANITIZE_PROMPT=off to send the prompt exactly as omp built it.
 */
export function sanitizeSystemPrompt(prompt: string): string {
  const mode = (process.env.OMP_AGY_SANITIZE_PROMPT ?? "").trim().toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false" || mode === "no") {
    return prompt;
  }

  return prompt
    .replaceAll("RFC 2119 keywords:", "Spec keywords:")
    .replaceAll("RFC 2119:", "Spec keywords:")
    .replaceAll("RFC 2119", "spec keywords")
    .replaceAll("system-conventions", "system_conventions")
    .replaceAll("system-directive", "system_directive");
}

/** Shape shared by `usage_update` events and the `session/prompt` result. */
interface AcpUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}

/**
 * Fold a usage snapshot into the partial message. agy reports the authoritative
 * totals on the `session/prompt` result and only occasionally emits interim
 * `usage_update` events, so both paths share this mapping — without the final
 * one, short turns record zero tokens and no cost. `outputTokens` already
 * includes thinking tokens, so thoughts must not be added again.
 */
function applyUsage(
  partial: AssistantMessage,
  usage: AcpUsageSnapshot | undefined,
  model: Model<any>,
): void {
  if (!usage) return;

  const u = (partial.usage = partial.usage ?? createEmptyUsage());
  u.input = usage.inputTokens ?? u.input;
  u.output = usage.outputTokens ?? u.output;
  u.cacheRead = usage.cachedReadTokens ?? u.cacheRead;
  u.cacheWrite = usage.cachedWriteTokens ?? u.cacheWrite;
  // omp totals every billed bucket, and surfaces thinking separately. agy
  // already counts thoughts inside `outputTokens`, so this is display only.
  u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  if (usage.thoughtTokens) u.reasoningTokens = usage.thoughtTokens;

  if (!model.cost) return;
  u.cost = {
    input: (u.input / 1_000_000) * (model.cost.input ?? 0),
    output: (u.output / 1_000_000) * (model.cost.output ?? 0),
    cacheRead: (u.cacheRead / 1_000_000) * (model.cost.cacheRead ?? 0),
    cacheWrite: (u.cacheWrite / 1_000_000) * (model.cost.cacheWrite ?? 0),
    total: 0,
  };
  u.cost.total = u.cost.input + u.cost.output + u.cost.cacheRead + u.cost.cacheWrite;
}

// ============================================================================
// Main Stream Adapter
// ============================================================================

let ephemeralCounter = 0;

/**
 * agy surfaces a backend quota 429 as a normal assistant chunk instead of an
 * ACP error. The banner is the only reliable signal: "Individual quota
 * reached ... upgrade your subscription ... Resets in N". Match both halves so
 * a legitimate answer that merely discusses quota does not trip it.
 */
const QUOTA_BANNER_RE =
  /individual\s+quota\s+reached[\s\S]{0,240}(?:upgrade\s+your\s+subscription|resets?\s+in\s+\d)/i;
const QUOTA_PROBE_LIMIT = 256;

export function streamAntigravityAcp(
  pool: AcpSessionPool,
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  // Run the async turn logic in background IIFE
  (async () => {
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: createEmptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // Emit start event immediately
    stream.push({ type: "start", partial });

    const hasTools = Boolean(context.tools && context.tools.length > 0);
    const cwd = options?.cwd || process.cwd();
    const requestedEffort =
      options?.disableReasoning || options?.forceReasoningOff
        ? "low"
        : (options?.reasoning ?? options?.effort);

    // Tool routing instruction appended to system prompt only when tools are enabled
    const toolRoutingInstruction =
      "IMPORTANT: You have access to tools provided by the \"omp\" MCP server (named omp_<toolName>, e.g. omp_read, omp_edit, omp_write, omp_bash, omp_task, omp_irc, omp_yield). " +
      "You must EXCLUSIVELY use these omp_* tools for all workspace actions, tool execution, terminal commands, file edits, and subagent coordination. " +
      "Never use internal or non-MCP file editing or terminal tools.";

    const rawSystemPrompt = Array.isArray(context.systemPrompt)
      ? context.systemPrompt.filter(Boolean).join("\n\n")
      : typeof context.systemPrompt === "string"
        ? context.systemPrompt
        : "";

    const systemPromptAppend = sanitizeSystemPrompt(
      hasTools
        ? rawSystemPrompt
          ? `${rawSystemPrompt}\n\n${toolRoutingInstruction}`
          : toolRoutingInstruction
        : rawSystemPrompt,
    );

    const requestedSessionId = options?.sessionId;
    const existingSession = requestedSessionId ? pool.getSession(requestedSessionId) : undefined;
    const systemPromptHash = createHash("sha256").update(systemPromptAppend).digest("hex");

    // omp's one-shot calls reuse the live sessionId for cache routing. A bare
    // summarizer/utility Context has no `tools` and a different system prompt
    // from the live conversation, so it must never enter the live lane. Side
    // keys (`:side:`/`:spec:`) are one-shot by construction, even with tools.
    const isSideRequest =
      (requestedSessionId ? hasSideSessionSuffix(requestedSessionId) : false) ||
      (context.tools === undefined &&
        existingSession !== undefined &&
        systemPromptHash !== existingSession.systemPromptHash);
    const isEphemeral = isSideRequest || !requestedSessionId;
    const sessionKey = isSideRequest
      ? `side:${requestedSessionId ?? "anon"}:${++ephemeralCounter}`
      : (requestedSessionId ?? `ephemeral_${Date.now()}_${++ephemeralCounter}`);

    // Sync current tools to MCP bridge only when tools are present
    if (hasTools) {
      pool.mcpBridge.setSessionTools(sessionKey, context.tools ?? []);
    }

    let session = pool.getSession(sessionKey);

    // A compaction/shake/prune notice may have arrived between turns. Never
    // resume a rewritten conversation from its pre-rewrite prefix.
    if (session?.stale) {
      await pool.resetSession(sessionKey);
      session = undefined;
    }

    // Backstop for rewrites whose event was detached or never emitted (mid-turn
    // shake, body-read timeout, rescue elide). The continuation hash ignores
    // tool/assistant bodies by design; this fingerprint does not.
    if (session && session.rewriteFingerprint && session.syncedMessageCount > 0) {
      const prefixCount = session.syncedMessageCount - 1;
      if (
        context.messages.length >= prefixCount &&
        computeRewriteFingerprint(context.messages.slice(0, prefixCount)) !== session.rewriteFingerprint
      ) {
        await pool.resetSession(sessionKey);
        session = undefined;
      }
    }

    // Track active content block state for stream events
    let currentBlockType: "none" | "thinking" | "text" = "none";
    let currentBlockIndex = -1;

    const closeCurrentBlock = () => {
      if (currentBlockType === "thinking") {
        const blk = partial.content[currentBlockIndex] as ThinkingContent;
        stream.push({
          type: "thinking_end",
          contentIndex: currentBlockIndex,
          content: blk.thinking,
          partial,
        });
        currentBlockType = "none";
      } else if (currentBlockType === "text") {
        const blk = partial.content[currentBlockIndex] as TextContent;
        stream.push({
          type: "text_end",
          contentIndex: currentBlockIndex,
          content: blk.text,
          partial,
        });
        currentBlockType = "none";
      }
    };

    const emitTextDelta = (text: string) => {
      if (!text) return;
      if (currentBlockType !== "text") {
        closeCurrentBlock();
        partial.content.push({ type: "text", text: "" });
        currentBlockIndex = partial.content.length - 1;
        currentBlockType = "text";
        stream.push({
          type: "text_start",
          contentIndex: currentBlockIndex,
          partial,
        });
      }
      const blk = partial.content[currentBlockIndex] as TextContent;
      blk.text += text;
      stream.push({
        type: "text_delta",
        contentIndex: currentBlockIndex,
        delta: text,
        partial,
      });
    };

    // agy's quota banner must fail the turn before any text is emitted:
    // omp only rotates credentials/falls back while the turn is replay-safe.
    let quotaProbe: string | null = "";
    const flushQuotaProbe = () => {
      if (quotaProbe === null) return;
      const buffered = quotaProbe;
      quotaProbe = null;
      emitTextDelta(buffered);
    };
    const failQuotaTurn = (activeSession: LiveAcpSession, banner: string) => {
      quotaProbe = null;
      closeCurrentBlock();
      activeSession.eventListener = null;
      pool.unbindAbortSignal(activeSession);
      pool.clearPersistedSession(sessionKey);
      pool.resetSession(sessionKey).catch(() => {});
      stream.fail(new Error(banner.trim() || "Antigravity quota reached"));
    };

    const attachEventListener = (activeSession: LiveAcpSession, activePromptPromise: Promise<any>) => {
      const turnListener = (ev: AcpUpdateEvent) => {
        if (stream.done || activeSession.eventListener !== turnListener) return;

        if (ev.type === "thinking_delta") {
          if (currentBlockType !== "thinking") {
            closeCurrentBlock();
            partial.content.push({ type: "thinking", thinking: "" });
            currentBlockIndex = partial.content.length - 1;
            currentBlockType = "thinking";
            stream.push({
              type: "thinking_start",
              contentIndex: currentBlockIndex,
              partial,
            });
          }
          const blk = partial.content[currentBlockIndex] as ThinkingContent;
          blk.thinking += ev.text;
          stream.push({
            type: "thinking_delta",
            contentIndex: currentBlockIndex,
            delta: ev.text,
            partial,
          });
        } else if (ev.type === "text_delta") {
          if (quotaProbe !== null) {
            quotaProbe += ev.text;
            if (QUOTA_BANNER_RE.test(quotaProbe)) {
              failQuotaTurn(activeSession, quotaProbe);
              return;
            }
            // Hold only the opening window; normal streaming resumes as soon
            // as it is clear this is not the banner.
            if (quotaProbe.length < QUOTA_PROBE_LIMIT && !quotaProbe.includes("\n")) {
              return;
            }
            const buffered = quotaProbe;
            quotaProbe = null;
            emitTextDelta(buffered);
          } else {
            // Late backstop: a banner split across chunks after the opening
            // window still fails the turn, though it may no longer be retryable.
            if (QUOTA_BANNER_RE.test(ev.text)) {
              failQuotaTurn(activeSession, ev.text);
              return;
            }
            emitTextDelta(ev.text);
          }
        } else if (ev.type === "usage") {
          applyUsage(partial, ev, model);
        } else if (ev.type === "mcp_tool_calls_ready") {
          flushQuotaProbe();
          closeCurrentBlock();

          activeSession.pendingMcpBatch = {
            calls: new Map(ev.calls.map((c) => [c.callId, c])),
            promptPromise: activePromptPromise,
          };

          for (const call of ev.calls) {
            const toolCall: ToolCall = {
              type: "toolCall",
              id: call.callId,
              name: call.toolName,
              arguments: call.arguments,
            };
            partial.content.push(toolCall);
            const callIndex = partial.content.length - 1;
            stream.push({
              type: "toolcall_start",
              contentIndex: callIndex,
              partial,
            });
            stream.push({
              type: "toolcall_delta",
              contentIndex: callIndex,
              delta: JSON.stringify(call.arguments),
              partial,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: callIndex,
              toolCall,
              partial,
            });
          }

          partial.stopReason = "toolUse";
          activeSession.syncedMessageCount = context.messages.length + 1;
          activeSession.prefixHash = computeMessagesHash(context.messages);
          activeSession.rewriteFingerprint = computeRewriteFingerprint(context.messages);
          pool.recordSessionState(sessionKey);
          // Unbind abort signal while oh-my-pi executes the tool locally so a user
          // steer/interrupt during tool execution aborts only the local tool, keeping
          // pendingMcpBatch alive to receive the aborted toolResult + steer on the next step.
          pool.unbindAbortSignal(activeSession);

          stream.push({
            type: "done",
            reason: "toolUse",
            message: structuredClone(partial),
          });
          stream.end();
        } else if (ev.type === "prompt_done") {
          // Check the still-buffered opening before emitting it: a short banner
          // must fail without making the turn replay-unsafe.
          if (quotaProbe !== null && QUOTA_BANNER_RE.test(quotaProbe)) {
            failQuotaTurn(activeSession, quotaProbe);
            return;
          }
          flushQuotaProbe();
          closeCurrentBlock();
          // Authoritative totals for the turn — the interim usage_update stream
          // is sparse, so most turns only ever get their numbers here.
          applyUsage(partial, ev.usage, model);

          const fullText = partial.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join("");
          if (QUOTA_BANNER_RE.test(fullText)) {
            failQuotaTurn(activeSession, fullText);
            return;
          }

          const acpStopReason = ev.stopReason;
          if (acpStopReason === "refusal" || acpStopReason === "error") {
            activeSession.eventListener = null;
            pool.unbindAbortSignal(activeSession);
            pool.clearPersistedSession(sessionKey);
            pool.resetSession(sessionKey).catch(() => {});
            const refusalText = fullText.trim();
            stream.fail(
              new Error(
                refusalText
                  ? `Antigravity refused to continue the turn: ${refusalText}`
                  : "Antigravity refused to continue the turn",
              ),
            );
            return;
          }
          if (acpStopReason === "cancelled") {
            activeSession.eventListener = null;
            pool.unbindAbortSignal(activeSession);
            partial.stopReason = "aborted";
            stream.push({
              type: "done",
              reason: "aborted",
              message: structuredClone(partial),
            });
            stream.end();
            if (isEphemeral) {
              pool.resetSession(sessionKey).catch(() => {});
            }
            return;
          }

          partial.stopReason =
            acpStopReason === "max_tokens" || acpStopReason === "max_turn_requests"
              ? "length"
              : "stop";
          activeSession.syncedMessageCount = context.messages.length + 1;
          activeSession.prefixHash = computeMessagesHash(context.messages);
          activeSession.rewriteFingerprint = computeRewriteFingerprint(context.messages);
          pool.recordSessionState(sessionKey);
          pool.unbindAbortSignal(activeSession);

          stream.push({
            type: "done",
            reason: "stop",
            message: structuredClone(partial),
          });
          stream.end();
          if (isEphemeral) {
            pool.resetSession(sessionKey).catch(() => {});
          }
        } else if (ev.type === "prompt_error") {
          flushQuotaProbe();
          closeCurrentBlock();
          pool.unbindAbortSignal(activeSession);
          stream.fail(ev.error);
          if (isEphemeral) {
            pool.resetSession(sessionKey).catch(() => {});
          }
        }
      };

      activeSession.eventListener = turnListener;

      // Set tool batch handler on bridge
      pool.mcpBridge.setToolCallBatchHandler(sessionKey, (calls: HeldMcpToolCall[]) => {
        if (activeSession.eventListener === turnListener && !stream.done) {
          turnListener({
            type: "mcp_tool_calls_ready",
            calls,
          });
        }
      });

      activePromptPromise
        .then((res) => {
          if (activeSession.eventListener === turnListener && !stream.done) {
            turnListener({
              type: "prompt_done",
              stopReason: res?.stopReason || "stop",
              usage: res?.usage,
            });
          }
        })
        .catch((err) => {
          if (activeSession.eventListener === turnListener && !stream.done) {
            turnListener({
              type: "prompt_error",
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
        });
    };

    // ========================================================================
    // Turn Case Routing
    // ========================================================================

    // Case 1: Resuming a Suspended MCP Tool Call Turn
    if (session && session.pendingMcpBatch && session.pendingMcpBatch.calls.size > 0) {
      const prefixCount = session.syncedMessageCount - 1;
      const prefixIntact =
        session.syncedMessageCount > 0 &&
        context.messages.length > prefixCount &&
        context.messages[prefixCount]?.role === "assistant" &&
        computeMessagesHash(context.messages.slice(0, prefixCount)) === session.prefixHash;

      if (!prefixIntact) {
        // The transcript was rewritten under the suspended turn (compaction,
        // shake, prune). Results belong to the old prefix; resolve nothing and
        // rebuild on a fresh ACP conversation.
        pool.abortPendingMcpBatch(session);
        session = undefined;
      } else {
        const delta = context.messages.slice(session.syncedMessageCount);
        const toolResults = delta.filter(
          (m): m is ToolResultMessage => m.role === "tool" || (m as any).role === "toolResult",
        );
        const trailingMessages = delta.filter(
          (m) => m.role === "user" || m.role === "developer" || m.role === "system",
        );

        const heldCalls = session.pendingMcpBatch.calls;
        // Match only by toolCallId. The old positional/idless fallback could
        // resolve a held call from an unrelated turn after a history rewrite.
        const matchedResults = new Map<string, ToolResultMessage>();
        const allCallsMatched = Array.from(heldCalls.values()).every((call) => {
          const matched = toolResults.find((tr) => {
            const legacyId = "id" in tr && typeof tr.id === "string" ? tr.id : undefined;
            return tr.toolCallId === call.callId || legacyId === call.callId;
          });
          if (!matched) return false;
          matchedResults.set(call.callId, matched);
          return true;
        });

        if (allCallsMatched) {
          const activePromptPromise = session.pendingMcpBatch.promptPromise!;
          session.pendingMcpBatch = null;

          // Checkpoint the messages sent up through this resumed tool turn immediately
          // so an abort/steer-flush mid-generation still preserves prefix continuity.
          session.syncedMessageCount = context.messages.length + 1;
          session.prefixHash = computeMessagesHash(context.messages);
          session.rewriteFingerprint = computeRewriteFingerprint(context.messages);
          pool.recordSessionState(sessionKey);

          // Attach listener & abort signal for this resumed step
          attachEventListener(session, activePromptPromise);
          pool.bindAbortSignal(session, options?.signal);

          // Resolve each held tool call with its corresponding result
          const callList = Array.from(heldCalls.values());
          for (let i = 0; i < callList.length; i++) {
            const call = callList[i];
            const matchedResult = matchedResults.get(call.callId)!;

            const contentBlocks = formatToolResultContent(matchedResult.content ?? "");

            // If there are trailing user/developer steering messages, format their text & images cleanly
            if (i === callList.length - 1 && trailingMessages.length > 0) {
              contentBlocks.push(...formatTrailingSteeringBlocks(trailingMessages));
            }

            call.resolve({
              content: contentBlocks,
              isError: matchedResult.isError,
            });
          }

          return;
        } else {
          // Mismatch: abort batch and recreate
          pool.abortPendingMcpBatch(session);
          session = undefined;
        }
      }
    }

    // Case 2: Append-Only Delta Turn on Existing Session (including after an aborted/steer-flushed turn)
    if (
      session &&
      !session.pendingMcpBatch &&
      session.syncedMessageCount > 0 &&
      context.messages.length >= session.syncedMessageCount - 1
    ) {
      const prefixCount = session.syncedMessageCount - 1;
      const expectedPrefixHash = session.prefixHash;
      const actualPrefixHash = computeMessagesHash(context.messages.slice(0, prefixCount));
      const hasAssistantAtBorder = context.messages[prefixCount]?.role === "assistant";
      // When a turn is aborted before emitting text, oh-my-pi drops the empty assistant message
      // and places the next user/steer message directly at `prefixCount`.
      const hasAbortedTurnContinuation =
        !hasAssistantAtBorder && context.messages.length > prefixCount;

      if (actualPrefixHash === expectedPrefixHash && (hasAssistantAtBorder || hasAbortedTurnContinuation)) {
        const deltaStart = hasAssistantAtBorder ? session.syncedMessageCount : prefixCount;
        const deltaMessages = context.messages.slice(deltaStart);
        const promptBlocks = messagesToContentBlocks(deltaMessages);

        if (promptBlocks.length === 0) {
          promptBlocks.push({ type: "text", text: "Proceed." });
        }

        // Wait for any cancelled in-flight turn on this session to finish draining on ACP
        await pool.drainInFlightPrompt(session);

        // Update model or effort if changed
        await pool.configureSessionModel(session, model.id, requestedEffort);

        // Checkpoint prefix before dispatching so an abort mid-stream preserves continuity
        session.syncedMessageCount = context.messages.length + 1;
        session.prefixHash = computeMessagesHash(context.messages);
        session.rewriteFingerprint = computeRewriteFingerprint(context.messages);
        pool.recordSessionState(sessionKey);

        const promptPromise = pool.sendPrompt(session, promptBlocks, options?.signal);
        attachEventListener(session, promptPromise);

        return;
      }
    }

    // Case 3: New Session or History Rewrite / Compaction
    if (session) {
      // The old ACP conversation no longer matches omp's history. Drop its
      // durable handle before rebuilding so a restart cannot reattach it.
      pool.clearPersistedSession(sessionKey);
      await pool.resetSession(sessionKey);
    }

    session = await pool.createSession(
      sessionKey,
      cwd,
      systemPromptAppend,
      model.id,
      requestedEffort,
      options?.apiKey,
      hasTools,
    );

    // Checkpoint prefix before dispatching so an abort on Turn 1 still preserves continuity for Turn 2
    session.syncedMessageCount = context.messages.length + 1;
    session.prefixHash = computeMessagesHash(context.messages);
    session.rewriteFingerprint = computeRewriteFingerprint(context.messages);
    pool.recordSessionState(sessionKey);

    const promptBlocks = formatFullHistoryTranscript(context.messages);
    const promptPromise = pool.sendPrompt(session, promptBlocks, options?.signal);
    attachEventListener(session, promptPromise);
  })().catch((err) => {
    stream.fail(err);
  });

  return stream;
}
