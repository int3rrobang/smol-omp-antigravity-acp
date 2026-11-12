import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { HeldMcpToolCall, McpCallToolResult, Tool } from "./types.ts";

let callCounter = 0;

export function sanitizeInputSchema(parameters: any): Record<string, any> {
  if (!parameters || typeof parameters !== "object") {
    return { type: "object", properties: {} };
  }
  const schema = JSON.parse(JSON.stringify(parameters));
  delete schema.$schema;
  delete schema.$id;
  if (schema.type !== "object") {
    schema.type = "object";
  }
  if (!schema.properties || typeof schema.properties !== "object") {
    schema.properties = {};
  }
  return schema;
}

/**
 * Unix sockets live in `sun_path`, which is 108 bytes on Linux and 104 on macOS,
 * terminator included. Bun happily binds and connects beyond that, but a
 * Node-based client cannot — and a socket nobody can connect to means the relay
 * silently loses every tool, with no error anywhere.
 */
const MAX_UNIX_SOCKET_PATH = 100;

function generatePipePath(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const id = `omp-agy-mcp-${process.pid}-${Date.now()}-${rand}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${id}`;
  }
  const shortId = `oam-${process.pid}-${rand}`;
  // Shorten the name before moving out of the caller's TMPDIR: that directory
  // may be the only writable, socket-capable place (sandboxes, private mounts).
  const candidates = [
    path.join(os.tmpdir(), `${id}.sock`),
    path.join(os.tmpdir(), `${shortId}.sock`),
    path.join("/tmp", `${id}.sock`),
    path.join("/tmp", `${shortId}.sock`),
  ];
  for (const candidate of new Set(candidates)) {
    if (Buffer.byteLength(candidate) <= MAX_UNIX_SOCKET_PATH) return candidate;
  }
  throw new Error(
    `Cannot fit the Antigravity MCP socket in ${MAX_UNIX_SOCKET_PATH} bytes (unix socket limit); point TMPDIR at a shorter directory.`,
  );
}

interface SessionState {
  tools: Tool[];
  onToolCallBatch: ((calls: HeldMcpToolCall[]) => void) | null;
  pendingBatchBuffer: HeldMcpToolCall[];
  batchTimer: ReturnType<typeof setTimeout> | null;
}

export class McpBridgeServer {
  private pipePath: string;
  private server: net.Server | null = null;
  private listening = false;
  private sessions = new Map<string, SessionState>();
  private sockets = new Set<net.Socket>();
  /** In-flight listen, so concurrent callers share one server instead of racing the pipe. */
  private startPromise: Promise<string> | null = null;

  constructor(customPipePath?: string) {
    this.pipePath = customPipePath || generatePipePath();
  }

  public getPipePath(): string {
    return this.pipePath;
  }

  public getRelayScriptPath(): string {
    return fileURLToPath(new URL("./mcp-stdio-relay.mjs", import.meta.url));
  }

  private getOrCreateSession(sessionKey: string): SessionState {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        tools: [],
        onToolCallBatch: null,
        pendingBatchBuffer: [],
        batchTimer: null,
      };
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  public setSessionTools(sessionKey: string, tools: Tool[]): void {
    const session = this.getOrCreateSession(sessionKey);
    session.tools = tools;
  }

  public getSessionTools(sessionKey: string): Tool[] {
    const session = this.sessions.get(sessionKey);
    return session ? session.tools : [];
  }

  public setSessionToolBatchListener(
    sessionKey: string,
    listener: ((calls: HeldMcpToolCall[]) => void) | null,
  ): void {
    const session = this.getOrCreateSession(sessionKey);
    session.onToolCallBatch = listener;
    if (listener && session.pendingBatchBuffer.length > 0 && !session.batchTimer) {
      const batch = session.pendingBatchBuffer.splice(0, session.pendingBatchBuffer.length);
      listener(batch);
    }
  }

  public setToolCallBatchHandler(
    sessionKey: string,
    handler: ((calls: HeldMcpToolCall[]) => void) | null,
  ): void {
    this.setSessionToolBatchListener(sessionKey, handler);
  }

  public close(): Promise<void> {
    return this.stop();
  }

  public removeSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      if (session.batchTimer) {
        clearTimeout(session.batchTimer);
        session.batchTimer = null;
      }
      session.pendingBatchBuffer.length = 0;
      this.sessions.delete(sessionKey);
    }
  }

  public start(): Promise<string> {
    // Single-flight: two concurrent createSession calls both used to reach
    // listen() before `listening` flipped, and the second one died with
    // EADDRINUSE on its own pipe.
    if (this.listening) return Promise.resolve(this.pipePath);
    if (this.startPromise) return this.startPromise;

    const pending = this.listen().then(
      (path) => {
        this.startPromise = null;
        return path;
      },
      (err) => {
        this.startPromise = null;
        throw err;
      },
    );
    this.startPromise = pending;
    return pending;
  }

  private listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (process.platform !== "win32" && Buffer.byteLength(this.pipePath) > MAX_UNIX_SOCKET_PATH) {
        reject(
          new Error(
            `MCP bridge socket path is ${Buffer.byteLength(this.pipePath)} bytes, over the ${MAX_UNIX_SOCKET_PATH}-byte unix limit: ${this.pipePath}`,
          ),
        );
        return;
      }

      if (process.platform !== "win32") {
        try {
          if (fs.existsSync(this.pipePath)) {
            fs.unlinkSync(this.pipePath);
          }
        } catch {}
      }

      this.server = net.createServer((socket) => {
        socket.setNoDelay(true);
        socket.unref();
        this.sockets.add(socket);
        socket.on("close", () => {
          this.sockets.delete(socket);
        });
        let buffer = "";

        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (line) {
              this.handleMessage(line, socket);
            }
          }
        });

        socket.on("end", () => {
          const line = buffer.trim();
          if (line) {
            buffer = "";
            this.handleMessage(line, socket);
          }
        });

        socket.on("error", () => {
          // Socket errors can occur on client disconnect; ignore
        });
      });

      this.server.on("error", (err) => {
        reject(err);
      });

      this.server.listen(this.pipePath, () => {
        this.listening = true;
        resolve(this.pipePath);
      });
    });
  }

  public stop(): Promise<void> {
    this.startPromise = null;
    return new Promise((resolve) => {
      for (const session of this.sessions.values()) {
        if (session.batchTimer) {
          clearTimeout(session.batchTimer);
          session.batchTimer = null;
        }
        session.pendingBatchBuffer.length = 0;
      }
      this.sessions.clear();

      for (const socket of this.sockets) {
        try {
          socket.destroy();
        } catch {}
      }
      this.sockets.clear();

      if (!this.server || !this.listening) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.listening = false;
        if (process.platform !== "win32") {
          try {
            if (fs.existsSync(this.pipePath)) {
              fs.unlinkSync(this.pipePath);
            }
          } catch {}
        }
        resolve();
      });
    });
  }

  private handleMessage(line: string, socket: net.Socket): void {
    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch (err: any) {
      try {
        socket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: `Parse error: ${err?.message || String(err)}` },
          }) + "\n",
        );
      } catch {}
      return;
    }

    const sessionKey: string = payload?.sessionKey || "";
    const rpc = payload?.rpc;

    if (!rpc || typeof rpc !== "object") {
      try {
        socket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request: missing rpc object" },
          }) + "\n",
        );
      } catch {}
      return;
    }

    // Notifications without id or notifications/initialized
    if (rpc.id === undefined || rpc.id === null || rpc.method === "notifications/initialized") {
      try {
        socket.write("\n");
      } catch {}
      return;
    }

    if (rpc.method === "server/discover") {
      const resp = {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32601,
          message: "Method not found: server/discover",
        },
      };
      try {
        socket.write(JSON.stringify(resp) + "\n");
      } catch {}
      return;
    }

    if (rpc.method === "initialize") {
      const resp = {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {
              listChanged: true,
            },
          },
          serverInfo: {
            name: "omp-tools",
            version: "0.1.0",
          },
        },
      };
      try {
        socket.write(JSON.stringify(resp) + "\n");
      } catch {}
      return;
    }

    if (rpc.method === "tools/list") {
      const session = this.getOrCreateSession(sessionKey);
      const formattedTools = (session.tools || []).map((t) => {
        const name = t.name.startsWith("omp_") ? t.name : `omp_${t.name}`;
        return {
          name,
          description: t.description || "",
          inputSchema: sanitizeInputSchema(t.parameters),
        };
      });

      const resp = {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: formattedTools,
        },
      };
      try {
        socket.write(JSON.stringify(resp) + "\n");
      } catch {}
      return;
    }

    if (rpc.method === "tools/call") {
      const mcpToolName = String(rpc.params?.name ?? "");
      const toolName = mcpToolName.replace(/^omp_/, "");

      let args = rpc.params?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {}
      }
      if (!args || typeof args !== "object") {
        args = {};
      }

      const callId = `agy_call_${Date.now()}_${++callCounter}`;

      let settled = false;
      const sendResult = (resultPayload: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        // The socket may already be closed (ACP process exited, session reset).
        // A per-call `close` listener here leaks one listener per tool call and
        // triggers Node's MaxListenersExceededWarning on long-lived bridges;
        // `destroyed` gives the same guard without accumulating listeners.
        if (socket.destroyed) return;
        try {
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...resultPayload }) + "\n");
        } catch {}
      };

      const heldCall: HeldMcpToolCall = {
        callId,
        toolName,
        mcpToolName,
        arguments: args,
        resolve: (result: McpCallToolResult) => {
          sendResult({ result });
        },
        reject: (err: Error) => {
          sendResult({
            result: {
              content: [
                {
                  type: "text",
                  text: `Tool execution cancelled: ${err?.message || String(err)}`,
                },
              ],
              isError: true,
            },
          });
        },
        createdAt: Date.now(),
      };

      const session = this.getOrCreateSession(sessionKey);
      session.pendingBatchBuffer.push(heldCall);

      // Dispatch on next microtask (0ms timer overhead; agy's MCP client dispatches sequentially)
      if (!session.batchTimer) {
        session.batchTimer = true as any;
        queueMicrotask(() => {
          session.batchTimer = null;
          const batch = session.pendingBatchBuffer.splice(0, session.pendingBatchBuffer.length);
          if (batch.length > 0 && session.onToolCallBatch) {
            session.onToolCallBatch(batch);
          }
        });
      }

      return;
    }

    // Default: method not found
    const resp = {
      jsonrpc: "2.0",
      id: rpc.id,
      error: {
        code: -32601,
        message: `Method not found: ${rpc.method}`,
      },
    };
    try {
      socket.write(JSON.stringify(resp) + "\n");
    } catch {}
  }
}
