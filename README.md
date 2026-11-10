# smol-omp-antigravity-acp

A smol, [`omp`](https://github.com/can1357/oh-my-pi)-native extension that overrides the `google-antigravity` provider by routing requests through Google's official Antigravity CLI over the Agent Client Protocol (ACP) instead of spoofing raw HTTP requests for ToS compliance.

> [!WARNING]
> **Disclaimer: Use at Your Own Risk**
>
> Using this extension **does not guarantee that your Google account won't be flagged, rate-limited, restricted, or banned**.
>
> It *should* be okay. In the [Google AI Developers Forum ToS clarification thread for T3 Code](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027), Google confirmed that third-party client usage is permitted for **personal, single-user interactive development** as long as it communicates over standard JSON-RPC with the official, unmodified `antigravity-acp` binary using native OAuth rather than proxying tokens or scraping endpoints (see also [T3 Code's provider guidance](https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md#will-i-get-banned-for-using-my-subscription)).
>
> Furthermore, the /usage implementation is quite **gray-area**. It uses `agy -p /usage`, which is greenlit for scripts and explicitly supported, but `agy -p` is blanket-banned for 3rd party coding agents. If you're wary of that, you can explicitly **disable /usage functionality** (see below.) 
>
> Naturally, I cannot guarantee Google won't get mad if they find the traffic suspicious, OR if you use it in an OpenClaw-y autonomous manner, which seems to be forbidden, OR if you don't but Google thinks you do.
>
> This extension is also entirely LLM-written, though curated to not reinvent the wheel and play nicely with `omp`. Tread carefully.
>
> As they say on XDA, "I am not responsible for bricked devices, dead SD cards, thermonuclear war, or you getting fired because the alarm app failed."

---

## Features

- **Direct `google-antigravity` override**: Integrates into existing OMP configs, presets, and subagent workflows without name changes.
- **Local `agy` CLI integration**: Spawns your installed `agy acp` binary and uses your active OS keychain credentials.
- **Zero external dependencies**: Built entirely with standard Node.js built-ins.
- **OMP-native tool execution**: Suspends tool calls so OMP retains full control over permissions, TUI rendering, subagents, and hooks.
- **Cache continuity**: Reuses warm ACP sessions and sends incremental message deltas to minimize cache misses, ensuring your quota doesn't get wrecked.
- **Steering support**: Handles mid-turn user steering (text & images) and graceful cancellation drains on the active session.
- **Dynamic model discovery**: Discovers account-accessible models and wires OMP's thinking effort toggle to ACP's.
- **Quota-aware `/usage`**: Reports Antigravity's Gemini, Claude/GPT, and Gemini Argon quota windows in OMP's native `/usage` and `omp usage` via `agy -p "/usage"`. Disable it with `OMP_AGY_USAGE_SOURCE=off`.
- **Slash commands**: `/agy-status`, `/agy-usage`, and `/agy-reset` for diagnostics, quota-toggle control, and session management.

---

## Background & Architecture

Upstream `google-antigravity` integration makes direct HTTP requests against internal Google endpoints. Upstream `oh-my-pi` functionally deprecated that provider, no longer taking measures to bypass server-side spoofing detection; the native integration still functions, but many have reported account bans and restrictions.

This extension adopts the architecture used by [**`t3code`**](https://github.com/pingdotgg/t3code) ([PR #1204](https://github.com/pingdotgg/t3code/pull/1204)), which interfaces with Google's official Antigravity CLI (`agy`) using its built-in [**Agent Client Protocol**](https://antigravity.google/docs/acp) server over stdio. In developer support forum discussions (notably the [ToS clarification thread on T3 Code](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027)), support confirmed that interacting with the official, unmodified `antigravity-acp` binary using local personal credentials for interactive development complies with platform terms.

By running `agy acp` locally as a subprocess, the official binary handles authentication, OS keyring storage, token refresh, and network requests, while `oh-my-pi` acts as the ACP client and MCP tool host.


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
- `/agy-status` — Display the resolved `agy` binary path, provider status, and the effective `/usage` mode.
- `/agy-usage [on|off|status]` — Toggle the `agy -p "/usage"` quota probe, or print which mode is in effect. Run it bare for an on/off selector.
- `/agy-reset` — Close all live ACP sessions and restart the background `agy acp` process.

### Rate Limits in /usage

The extension registers a native OMP usage provider, so `google-antigravity` quota/rate-limit state shows up in both the live `/usage` command and `omp usage`:

```bash
omp usage --provider google-antigravity
omp usage --provider google-antigravity --json
```

The provider runs the official CLI's read-only slash command:

```bash
agy -p "/usage" --output-format json
```

That command starts no agent turn, spends zero model tokens, and is documented first-party behavior: the CLI changelog explicitly added non-interactive answers for `-p "/usage"`/`/quota` with JSON output, and later improved its timestamps for scripts. Its `groups[].buckets[]` payload is mapped into OMP's normalized `UsageReport` limits (Gemini, Claude/GPT shared, and the separate Gemini Argon window), including reset times and percentage remaining. The official binary calls its own quota backend internally; the plugin does not call Cloud Code `v1internal:*` endpoints directly.

The toggle is first-class and **enabled by default**. Run it bare for a selector, or pass a verb (`on`/`enable`/`cli`, `off`/`disable`, `status`):

```text
/agy-usage            # on/off selector
/agy-usage on         # enable the agy print-mode quota probe
/agy-usage off        # ACP only; /usage shows nothing for this provider
/agy-usage status     # effective mode, config path, and any env override
```

The choice is persisted to `<agent-dir>/antigravity-acp-usage.json` (`PI_CODING_AGENT_DIR` when set, otherwise `~/.omp/agent`). `OMP_AGY_USAGE_SOURCE` is an environment override and wins over the saved setting:

```bash
OMP_AGY_USAGE_SOURCE=off
```

`/agy-status` shows the effective mode. No ACP-observed fallback is kept: either the official CLI query runs, or `/usage` reports nothing for this provider.

> [!IMPORTANT]
> Google's Antigravity FAQ says headless mode (`agy -p`) is intended for **direct scripting and CI workflows**, and that **wrapping `agy` inside third-party coding agents or applications is not supported under consumer plans**. The ACP path (the official unmodified `antigravity-acp` binary over JSON-RPC with native `oauth-personal` sign-in) is the path Google has explicitly described as permitted for single-user interactive development. This plugin nevertheless uses `agy -p "/usage"` as its quota source; set `OMP_AGY_USAGE_SOURCE=off` if you want to stay strictly ACP-only.

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

## Credits

- **[`t3code`](https://github.com/pingdotgg/t3code)** ([PR #1204](https://github.com/pingdotgg/t3code/pull/1204)) for developing the `agy acp` JSON-RPC stdio client & MCP bridge pattern.
- **[`oh-my-pi`](https://github.com/can1357/oh-my-pi)** for the extension API and agent harness.

