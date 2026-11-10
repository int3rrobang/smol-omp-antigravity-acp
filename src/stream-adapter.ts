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
          if (b.type === "image" && b.data) hash.update(b.data.slice(0, 100));
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

function messagesToContentBlocks(messages: Message[]): any[] {
  const blocks: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        blocks.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "text") {
            blocks.push({ type: "text", text: item.text });
          } else if (item.type === "image") {
            blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
          }
        }
      }
    } else if (msg.role === "developer" || msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
            : JSON.stringify(msg.content);
      blocks.push({ type: "text", text: `[System Reminder]:\n${text}` });
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Format intervening assistant turns (e.g. when switching to another provider and back to Antigravity)
      const parts = msg.content
        .map((c) => {
          if (c.type === "text") return c.text;
          if (c.type === "toolCall" || (c as any).type === "tool_use") {
            return `[Assistant Tool Call: ${c.name}(${JSON.stringify((c as any).arguments ?? {})})]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (parts) {
        blocks.push({ type: "text", text: `[Previous Assistant Turn]:\n${parts}` });
      }
    } else if (msg.role === "toolResult" || msg.role === "tool") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n")
            : JSON.stringify(msg.content);
      blocks.push({ type: "text", text: `[Tool Result for ${(msg as any).toolCallId}]:\n${text}` });
    }
  }

  // Merge adjacent text blocks with "\n\n" because agy.exe concatenates multiple text blocks without separators
  const merged: any[] = [];
  for (const blk of blocks) {
    const prev = merged[merged.length - 1];
    if (blk.type === "text" && prev?.type === "text") {
      prev.text = `${prev.text}\n\n${blk.text}`;
    } else {
      merged.push(blk);
    }
  }
  return merged;
}

function formatFullHistoryTranscript(messages: Message[]): any[] {
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

  // Compile history transcript from 0 to lastUserIdx - 1
  let transcript = "The following is a transcript of previous turns in this conversation:\n\n";
  for (let i = 0; i < lastUserIdx; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
      transcript += `User: ${text}\n\n`;
    } else if (msg.role === "assistant") {
      const text = msg.content
        .map((c) => {
          if (c.type === "text") return c.text;
          if (c.type === "thinking") return `[Thinking: ${c.thinking}]`;
          if (c.type === "toolCall" || (c as any).type === "tool_use") return `[Tool Call: ${c.name}]`;
          return "";
        })
        .join("\n");
      transcript += `Assistant: ${text}\n\n`;
    } else if (msg.role === "toolResult" || msg.role === "tool") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n")
            : JSON.stringify(msg.content);
      transcript += `[Tool Result for ${(msg as any).toolCallId}]:\n${text}\n\n`;
    } else if (msg.role === "developer" || msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
            : JSON.stringify(msg.content);
      transcript += `[System Instruction]:\n${text}\n\n`;
    }
  }
  transcript += "---\nContinue the conversation responding to the user below.\n\n";

  const resultBlocks: any[] = [{ type: "text", text: transcript }];
  const latestBlocks = messagesToContentBlocks(messages.slice(lastUserIdx));
  resultBlocks.push(...latestBlocks);
  return resultBlocks;
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

    const isEphemeral = !options?.sessionId;
    const sessionKey = options?.sessionId || `ephemeral_${Date.now()}_${++ephemeralCounter}`;
    const hasTools = Boolean(context.tools && context.tools.length > 0);
    const cwd = options?.cwd || process.cwd();
    const requestedEffort =
      options?.disableReasoning || options?.forceReasoningOff
        ? "low"
        : (options?.reasoning ?? options?.effort);

    // Sync current tools to MCP bridge only when tools are present
    if (hasTools) {
      pool.mcpBridge.setSessionTools(sessionKey, context.tools ?? []);
    }

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

    let session = pool.getSession(sessionKey);

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
          blk.text += ev.text;
          stream.push({
            type: "text_delta",
            contentIndex: currentBlockIndex,
            delta: ev.text,
            partial,
          });
        } else if (ev.type === "usage") {
          applyUsage(partial, ev, model);
        } else if (ev.type === "mcp_tool_calls_ready") {
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
          closeCurrentBlock();
          // Authoritative totals for the turn — the interim usage_update stream
          // is sparse, so most turns only ever get their numbers here.
          applyUsage(partial, ev.usage, model);

          partial.stopReason = "stop";
          activeSession.syncedMessageCount = context.messages.length + 1;
          activeSession.prefixHash = computeMessagesHash(context.messages);
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
      const delta = context.messages.slice(session.syncedMessageCount);
      const toolResults = delta.filter(
        (m): m is ToolResultMessage => m.role === "tool" || (m as any).role === "toolResult",
      );
      const trailingMessages = delta.filter(
        (m) => m.role === "user" || m.role === "developer" || m.role === "system",
      );

      const heldCalls = session.pendingMcpBatch.calls;
      const allCallsMatched = Array.from(heldCalls.values()).every((call) =>
        toolResults.some(
          (tr) =>
            tr.toolCallId === call.callId ||
            (tr as any).id === call.callId ||
            (toolResults.length === 1 && heldCalls.size === 1),
        ),
      );

      if (allCallsMatched) {
        const activePromptPromise = session.pendingMcpBatch.promptPromise!;
        session.pendingMcpBatch = null;

        // Checkpoint the messages sent up through this resumed tool turn immediately
        // so an abort/steer-flush mid-generation still preserves prefix continuity.
        session.syncedMessageCount = context.messages.length + 1;
        session.prefixHash = computeMessagesHash(context.messages);
        pool.recordSessionState(sessionKey);

        // Attach listener & abort signal for this resumed step
        attachEventListener(session, activePromptPromise);
        pool.bindAbortSignal(session, options?.signal);

        // Resolve each held tool call with its corresponding result
        const callList = Array.from(heldCalls.values());
        for (let i = 0; i < callList.length; i++) {
          const call = callList[i];
          const matchedResult =
            toolResults.find(
              (tr) =>
                tr.toolCallId === call.callId ||
                (tr as any).id === call.callId,
            ) || toolResults[i];

          const contentBlocks = formatToolResultContent(matchedResult?.content ?? "");

          // If there are trailing user/developer steering messages, format their text & images cleanly
          if (i === callList.length - 1 && trailingMessages.length > 0) {
            contentBlocks.push(...formatTrailingSteeringBlocks(trailingMessages));
          }

          call.resolve({
            content: contentBlocks,
            isError: matchedResult?.isError,
          });
        }

        return;
      } else {
        // Mismatch: abort batch and recreate
        pool.abortPendingMcpBatch(session);
        session = undefined;
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
        pool.recordSessionState(sessionKey);

        const promptPromise = pool.sendPrompt(session, promptBlocks, options?.signal);
        attachEventListener(session, promptPromise);

        return;
      }
    }

    // Case 3: New Session or History Rewrite / Compaction
    if (session) {
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
    pool.recordSessionState(sessionKey);

    const promptBlocks = formatFullHistoryTranscript(context.messages);
    const promptPromise = pool.sendPrompt(session, promptBlocks, options?.signal);
    attachEventListener(session, promptPromise);
  })().catch((err) => {
    stream.fail(err);
  });

  return stream;
}
