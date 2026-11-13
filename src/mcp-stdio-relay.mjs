#!/usr/bin/env node
import net from "node:net";
import readline from "node:readline";

const pipePath = process.env.OMP_ACP_MCP_PIPE;
const sessionKey = process.env.OMP_ACP_SESSION_KEY || "";

let persistentSocket = null;
let socketConnecting = null;
let socketBuffer = "";
const pendingCallbacks = new Map();

function ensureSocket() {
  if (persistentSocket && !persistentSocket.destroyed) {
    return Promise.resolve(persistentSocket);
  }
  if (socketConnecting) {
    return socketConnecting;
  }

  socketConnecting = new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    socket.setNoDelay(true);

    const onConnect = () => {
      socket.removeListener("error", onConnectError);
      persistentSocket = socket;
      socketConnecting = null;
      resolve(socket);
    };

    const onConnectError = (err) => {
      socketConnecting = null;
      reject(err);
    };

    socket.once("connect", onConnect);
    socket.once("error", onConnectError);

    socket.on("data", (chunk) => {
      socketBuffer += chunk.toString("utf8");
      let newlineIdx;
      while ((newlineIdx = socketBuffer.indexOf("\n")) !== -1) {
        const respLine = socketBuffer.slice(0, newlineIdx).trim();
        socketBuffer = socketBuffer.slice(newlineIdx + 1);
        if (respLine) {
          process.stdout.write(respLine + "\n");
          try {
            const parsed = JSON.parse(respLine);
            if (parsed && parsed.id !== undefined && pendingCallbacks.has(parsed.id)) {
              const cb = pendingCallbacks.get(parsed.id);
              pendingCallbacks.delete(parsed.id);
              cb.resolve();
            }
          } catch {}
        }
      }
    });

    socket.on("close", () => {
      if (persistentSocket === socket) {
        persistentSocket = null;
      }
      for (const [, cb] of pendingCallbacks.entries()) {
        cb.reject(new Error("MCP bridge socket closed"));
      }
      pendingCallbacks.clear();
    });

    socket.on("error", () => {
      // Handled via close or per-request reject
    });
  });

  return socketConnecting;
}

// Pre-connect immediately on startup so the pipe is warm before tools/list
if (pipePath) {
  ensureSocket().catch(() => {});
}

async function sendToPipe(rpc) {
  const socket = await ensureSocket();
  return new Promise((resolve, reject) => {
    if (rpc.id !== undefined && rpc.id !== null) {
      pendingCallbacks.set(rpc.id, { resolve, reject });
    }
    const payload = JSON.stringify({ sessionKey, rpc }) + "\n";
    socket.write(payload, (err) => {
      if (err) {
        if (rpc.id !== undefined && rpc.id !== null) {
          pendingCallbacks.delete(rpc.id);
        }
        reject(err);
      } else if (rpc.id === undefined || rpc.id === null) {
        resolve();
      }
    });
  });
}

async function handleLine(line) {
  let rpc;
  try {
    rpc = JSON.parse(line);
  } catch (err) {
    const errorResponse = {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Parse error: " + (err?.message || String(err)),
      },
    };
    process.stdout.write(JSON.stringify(errorResponse) + "\n");
    return;
  }

  // Fast-path in-process responses for MCP handshake (0ms, no IPC round-trip)
  if (rpc.id === undefined || rpc.id === null || rpc.method === "notifications/initialized") {
    return;
  }

  if (rpc.method === "server/discover") {
    // MCP 2026-07-28 discovery probe. agy 1.5.8 sends this before the legacy
    // `initialize` handshake; a -32601 makes its client mark the server
    // unusable and fail every MCP tool call after the permission gate. Advertise
    // the legacy revision this relay actually speaks so the client falls back.
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          resultType: "complete",
          supportedVersions: ["2024-11-05"],
          capabilities: {
            tools: {
              listChanged: true,
            },
          },
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "omp-tools",
              version: "0.1.0",
            },
          },
        },
      }) + "\n",
    );
    return;
  }

  if (rpc.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
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
      }) + "\n",
    );
    return;
  }

  if (!pipePath) {
    if (rpc && rpc.id !== undefined) {
      const errorResponse = {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32603,
          message: "Internal error: OMP_ACP_MCP_PIPE environment variable is not set",
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
    }
    return;
  }

  try {
    await sendToPipe(rpc);
  } catch (err) {
    if (rpc && rpc.id !== undefined) {
      const errorResponse = {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32603,
          message: "Bridge communication error: " + (err?.message || String(err)),
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
    }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed) {
    handleLine(trimmed);
  }
});

rl.on("close", () => {
  if (persistentSocket && !persistentSocket.destroyed) {
    persistentSocket.destroy();
  }
  process.exit(0);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
