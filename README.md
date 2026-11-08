# smol-omp-antigravity-acp

A smol, [`oh-my-pi` (`omp`)](https://github.com/can1357/oh-my-pi)-native extension that overrides the `google-antigravity` provider by routing requests through Google's official Antigravity CLI (`agy acp`) over the Agent Client Protocol (ACP) instead of sending raw HTTP requests.

> [!WARNING]
> **Disclaimer — Use at Your Own Risk**
>
> Using this extension **does not guarantee that your Google account won't be flagged, rate-limited, restricted, or banned**.
>
> While this integration communicates with the official `agy` binary via its built-in `agy acp` protocol rather than sending direct HTTP requests to internal endpoints, automated account protections remain active. In the [Google AI Developers Forum ToS clarification thread for T3 Code](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027), Google confirmed that third-party client usage is permitted for personal, single-user interactive development as long as it communicates over standard JSON-RPC with the official, unmodified `antigravity-acp` binary using native OAuth (`"auth": { "type": "oauth-personal" }`) rather than proxying tokens or scraping endpoints (see also [T3 Code's provider guidance](https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md#will-i-get-banned-for-using-my-subscription)).
>
> This extension is also entirely LLM-written, though curated to not reinvent the wheel and play nicely with `omp`. Tread carefully.
>
> As they say on XDA, "I am not responsible for bricked devices, dead SD cards, thermonuclear war, or you getting fired because the alarm app failed."

---

## Features

- **Direct `google-antigravity` override**: Integrates into existing OMP configs, presets, and subagent workflows without name changes.
- **Local `agy` CLI integration**: Spawns your installed `agy acp` binary and uses your active OS keychain credentials.
- **Zero external dependencies**: Built entirely with standard Node.js built-ins.
- **Named pipe & domain socket bridge**: Fast, lightweight local OS IPC for stdio MCP tool handoffs.
- **OMP-native tool execution**: Suspends tool calls so OMP retains full control over permissions, TUI rendering, subagents, and hooks.
- **KV-cache continuity**: Reuses warm ACP sessions and sends incremental message deltas to minimize prompt prefill latency.
- **Steering support**: Handles mid-turn user steering (text & images) and graceful cancellation drains on the active session.
- **In-place session updates**: Switches models and thinking effort levels in-place without resetting conversation history.
- **Dynamic model discovery**: Discovers account-accessible models and wires OMP's thinking effort toggle to ACP's `thought_level`.
- **Slash commands**: `/agy-status` and `/agy-reset` for quick diagnostics and session management.

---

## Background & Architecture

Upstream `google-antigravity` integration makes direct HTTP requests against internal Google endpoints. Upstream `oh-my-pi` functionally deprecated that provider, no longer taking measures to bypass server-side spoofing detection; the native integration still functions, but many have reported account bans and restrictions.

This extension adopts the architecture used by [**`t3code`**](https://github.com/pingdotgg/t3code) ([PR #1204](https://github.com/pingdotgg/t3code/pull/1204)), which interfaces with Google's official Antigravity CLI (`agy`) using its built-in [**Agent Client Protocol (`agy acp`)**](https://antigravity.google/docs/acp) server over stdio. In developer support forum discussions (notably the [ToS clarification thread on T3 Code](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027)), support confirmed that interacting with the official, unmodified `antigravity-acp` binary using local personal credentials for interactive development complies with platform terms.

By running `agy acp` locally as a subprocess, the official binary handles authentication, OS keyring storage, token refresh, and network requests, while `oh-my-pi` acts as the ACP client and MCP tool host.

---

## How It Works

`oh-my-pi` expects an LLM provider to stream completions and yield on tool calls so the harness can execute them, whereas `agy acp` expects to run an internal tool execution loop. `smol-omp-antigravity-acp` bridges the two using two core mechanisms:

### 1. Two-Turn Suspended MCP Bridge ([`src/mcp-bridge.ts`](./src/mcp-bridge.ts))
1. When creating an ACP session, the extension registers a local MCP server named `"omp"` over a Named Pipe (Windows) or Unix Domain Socket (POSIX) with `disableBuiltInTools: true`.
2. `oh-my-pi`'s active tool definitions are exposed to `agy` as `omp_<toolName>` (`omp_read`, `omp_bash`, `omp_task`, etc.).
3. When the model invokes a tool, `agy` sends an MCP `tools/call` request over the pipe.
4. Instead of executing the tool inside the bridge, the adapter **holds the MCP Promise open**, emits a `toolUse` stop event back to `oh-my-pi`, and ends the stream.
5. `oh-my-pi` executes the tool natively (running UI rendering, permission prompts, hooks, and subagent workers).
6. On the resume turn, the adapter resolves the held MCP Promise with `oh-my-pi`'s `toolResult` (along with any mid-flight user steering), allowing `agy acp` to continue its active turn immediately.

### 2. Session Keep-Alive & Delta Sync ([`src/stream-adapter.ts`](./src/stream-adapter.ts))
- Active sessions are kept alive in memory keyed by OMP's `sessionId`. Follow-up turns append incremental message deltas rather than re-uploading the entire transcript, keeping server-side KV cache warm.
- Model and thinking effort updates apply in-place via `session/set_config_option` without wiping session history.
- If a turn is interrupted or cancelled, the adapter drains the server response and checkpoints the accepted boundary so subsequent steering turns continue on the warm session without triggering a cold replay.

---

## Prerequisites

1. **[`oh-my-pi` (`omp`)](https://github.com/can1357/oh-my-pi)** installed.
2. **Google Antigravity CLI (`agy`)** installed and authenticated:
   - Installed via the Antigravity IDE / CLI installer, or via `npx @agyrpc/cli`.
   - If `agy` is installed in a non-standard path, set the `AGY_PATH` environment variable to point to the `agy` (or `agy.exe`) binary.

---

## Installation

### Option 1: Direct GitHub Install (Recommended)

Install directly via `oh-my-pi`'s built-in plugin manager:

```bash
omp plugin install github:int3rrobang/smol-omp-antigravity-acp
```

Or from inside the `omp` TUI:
```text
/plugin install github:int3rrobang/smol-omp-antigravity-acp
```

### Option 2: Via OMP Marketplace Catalog

Because this repository includes `.omp-plugin/marketplace.json`, you can register it as an OMP marketplace source:

```bash
omp plugin marketplace add int3rrobang/smol-omp-antigravity-acp
omp plugin install smol-omp-antigravity-acp@smol-omp-antigravity-acp
```

Or from inside the `omp` TUI:
```text
/marketplace add int3rrobang/smol-omp-antigravity-acp
/marketplace install smol-omp-antigravity-acp
```

### Option 3: Manual Installation

Clone or copy into `~/.omp/agent/extensions/smol-omp-antigravity-acp`:

**Windows (PowerShell):**
```powershell
# Clone directly:
git clone https://github.com/int3rrobang/smol-omp-antigravity-acp.git "$HOME\.omp\agent\extensions\smol-omp-antigravity-acp"

# Or copy a local clone:
Copy-Item -Path .\smol-omp-antigravity-acp -Destination "$HOME\.omp\agent\extensions\smol-omp-antigravity-acp" -Recurse -Force
```

**macOS / Linux:**
```bash
# Clone directly:
git clone https://github.com/int3rrobang/smol-omp-antigravity-acp.git ~/.omp/agent/extensions/smol-omp-antigravity-acp

# Or copy a local clone:
mkdir -p ~/.omp/agent/extensions
cp -R ./smol-omp-antigravity-acp ~/.omp/agent/extensions/smol-omp-antigravity-acp
```

---

## Usage

Once installed in `~/.omp/agent/extensions/smol-omp-antigravity-acp`, `oh-my-pi` loads the extension automatically on startup:

```bash
# List discovered Antigravity models
omp models google-antigravity

# Start omp with a specific Antigravity model
omp --model google-antigravity/gemini-3.8-flash
```

Inside the `omp` TUI:
- Open the model selector (`/model`) and pick any `google-antigravity/*` model.
- Use `omp`'s native thinking effort toggle (`low` / `medium` / `high`) to switch `agy`'s `thought_level` on the fly.
- Assign `google-antigravity/*` models to subagent roles or invoke them with `^google-antigravity/gemini-3.8-flash` via `omp`'s `task` tool just like any built-in provider.
- If your `agy` CLI is not logged in yet, run `omp login google-antigravity` to trigger `agy`'s OAuth flow.

### Slash Commands
- `/agy-status` — Display the resolved `agy` binary path and provider status.
- `/agy-reset` — Close all live ACP sessions and restart the background `agy acp` process.

---

## Credits

- **[`t3code`](https://github.com/pingdotgg/t3code)** ([PR #1204](https://github.com/pingdotgg/t3code/pull/1204)) for developing the `agy acp` JSON-RPC stdio client & MCP bridge pattern.
- **[`oh-my-pi`](https://github.com/can1357/oh-my-pi)** for the extension API and agent harness.

