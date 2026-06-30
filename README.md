# LM Studio Code

An agentic coding panel for **your local [LM Studio](https://lmstudio.ai) models** — a Claude Code / Codex–style chat experience that runs entirely on your machine.

Under the hood it drives the open-source [**OpenCode**](https://opencode.ai) agent (Apache/MIT) as a headless server, pointed at LM Studio's OpenAI-compatible endpoint. You get a real agent — file edits, shell tools, permissions, multi-step reasoning — with no cloud model and no API key.

## Demo

![LM Studio Code demo](media/sample.gif)

## Why

The official Claude Code and Codex VS Code extensions are **not open source**, so they can't be adapted to local models. The *CLIs* behind several agents are open, though — and OpenCode in particular ships a headless server + provider-agnostic model layer that happily talks to LM Studio. This extension wraps that server in a native chat panel.

## Features

- **Chat panel** in the Activity Bar (and "Open in Editor Tab" for parallel conversations)
- **Streaming** responses with markdown + code rendering
- **Reasoning** blocks (collapsible "Thinking")
- **Agent tools** — file reads/edits, shell, search — surfaced as tool cards
- **MCP servers** — extend the agent with [Model Context Protocol](https://modelcontextprotocol.io) tools; servers you already configured for **Claude Code** (`.mcp.json`) or **VS Code** (`.vscode/mcp.json`) are picked up automatically. Type `/mcp` to see their live status
- **Permission prompts** — Allow once / Allow always / Deny, inline
- **Model picker** populated live from LM Studio (shows loaded ● / unloaded ○ + context size)
- **Agent modes** — `build` (can edit) and `plan` (read-only)
- **Session history** — browse, resume, rename-by-first-message, delete
- **Auto-context** — reloads the selected model with an adequate context window via the `lms` CLI so OpenCode's large system prompt doesn't overflow a 4096-token default

## Requirements

- **VS Code** 1.104+
- **[LM Studio](https://lmstudio.ai)** running with its local server started (default `http://127.0.0.1:1234`) and at least one chat model
- *(recommended)* the **`lms` CLI** for automatic context-window management

> **[OpenCode](https://opencode.ai) is bundled** — the matching platform binary ships inside the extension, so there's nothing extra to install and it works offline. Power users can point at their own build with `lmstudioCode.opencodePath`; an install on your `PATH` or in `~/.opencode/bin` is preferred over the bundled copy if present.

## Quick start

1. Start LM Studio's server and load a model.
2. Install this extension (or run it from source — see below).
3. Click the spark icon in the Activity Bar.
4. Pick a model, type a task, hit Enter.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `lmstudioCode.lmStudioBaseUrl` | `http://127.0.0.1:1234/v1` | LM Studio OpenAI-compatible base URL |
| `lmstudioCode.opencodePath` | _(bundled)_ | Override path to an `opencode` binary; empty uses your own install (PATH / `~/.opencode`) or the bundled one |
| `lmstudioCode.serverPort` | `0` | Embedded server port (0 = auto) |
| `lmstudioCode.defaultModel` | _(first)_ | Default model id |
| `lmstudioCode.agent` | `build` | `build` or `plan` |
| `lmstudioCode.autoEnsureContext` | `true` | Reload model with adequate context before prompting |
| `lmstudioCode.minContextLength` | `16384` | Context length to (re)load with |
| `lmstudioCode.gpuOffload` | `max` | GPU offload for `lms load` |
| `lmstudioCode.mcpServers` | `{}` | MCP servers to expose to the agent (in addition to auto-discovered ones) |

## MCP servers

The agent can call tools from [MCP (Model Context Protocol)](https://modelcontextprotocol.io) servers — browser automation, databases, issue trackers, docs, and more. OpenCode runs the servers; this extension just gathers them from wherever you've configured them and hands them over.

### Where servers come from

Servers are merged from these sources, in increasing precedence (a later source wins on a name collision):

| # | Source | Format | Top-level key |
| --- | --- | --- | --- |
| 1 | `.mcp.json` at your workspace root | **Claude Code** project format | `mcpServers` |
| 2 | `.vscode/mcp.json` in your workspace | **VS Code** workspace format | `servers` |
| 3 | VS Code's user-level `mcp` setting | **VS Code** user format | `servers` |
| 4 | `lmstudioCode.mcpServers` (VS Code settings) | bare map of name → server | _(the map itself)_ |

If you already use MCP with Claude Code or VS Code Copilot, those servers work here with **nothing to re-enter**. Use `lmstudioCode.mcpServers` to add a server just for LM Studio Code, or to override a discovered one.

### Setting up a `.mcp.json` (shareable, per project)

Create `.mcp.json` at your project root — the same file Claude Code uses, so it's safe to commit and share with your team:

```jsonc
{
  "mcpServers": {
    // local (stdio) server — runs a command, talks over stdin/stdout
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    // local server with a working dir and env var
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "LOG_LEVEL": "info" }
    },
    // remote (http/sse) server, with a token pulled from the environment
    "docs": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    },
    // defined but off — won't be started
    "staging": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "enabled": false
    }
  }
}
```

A `.vscode/mcp.json` is identical except the top-level key is `servers` instead of `mcpServers` (VS Code's convention) — both are supported.

### What's supported

| Field | Applies to | Notes |
| --- | --- | --- |
| `command` | local (stdio) | Executable name or path (e.g. `npx`, `uvx`, an absolute path). |
| `args` | local (stdio) | Array of arguments passed to `command`. |
| `env` | local (stdio) | Environment variables for the server process. |
| `type` | both | `"http"` / `"sse"` mark a remote server; `"stdio"` / `"local"` a local one. Inferred from the fields when omitted (a `url` ⇒ remote, a `command` ⇒ local). |
| `url` | remote (http/sse) | The server endpoint. |
| `headers` | remote (http/sse) | HTTP headers, e.g. an `Authorization` token. |
| `enabled` | both | Set `false` to keep a server defined but not started. |

- **`${VAR}` references** in `env` values, `headers`, and `url` are resolved from the environment before the server launches — keep secrets in your environment, not in the file.
- **Transports:** local (stdio) and remote (http/sse). Both the Claude Code field shape (`command` + `args`) and the VS Code shape are accepted and normalized for you.

### Checking status — the `/mcp` command

Type **`/mcp`** in the chat to list your configured servers and their live status:

- 🟢 **connected** — running and its tools are available
- 🟡 **disabled** — defined but `"enabled": false`
- 🔴 **failed** — couldn't start/connect; the reason is shown (a bad server never blocks the chat)

Each row shows the transport (local/remote) and the command or URL it was configured with.

### Notes

- **Applying changes.** Edits to `lmstudioCode.mcpServers` (or VS Code's `mcp` setting) restart the agent automatically. Edits to the `.mcp.json` / `.vscode/mcp.json` files apply on the next **LM Studio Code: Restart OpenCode Server** (or a window reload).
- **Mind the context window.** Each MCP server adds its tool schemas to every request. Local models have far less context than cloud ones (OpenCode's own system prompt + built-in tools already use ~11k tokens), so enable only the servers you need and raise `lmstudioCode.minContextLength` if tools start crowding out the conversation.
- **`npx`/`uvx` on `PATH`.** Local servers launched with `npx`/`uvx` need Node and those tools on `PATH`. The extension augments `PATH` with common install locations (Homebrew, `~/.local/bin`, nvm/fnm, bun, cargo), but if a server shows as **failed**, check **LM Studio Code: Show Logs**.

## How it works

```
VS Code webview (chat UI)
        │  postMessage
        ▼
Extension host (bridge)
        │  HTTP + SSE  (raw fetch)
        ▼
opencode serve   ──OpenAI /v1──▶  LM Studio (local model)
   (headless, config injected via OPENCODE_CONFIG_CONTENT)
```

The LM Studio provider is injected into OpenCode at launch via the
`OPENCODE_CONFIG_CONTENT` environment variable — **nothing is written to your
workspace or global config.** Discovered LM Studio models are declared in the
provider's `models` map (OpenCode requires this for custom OpenAI-compatible
providers).

## Develop from source

```bash
npm install
npm run bundle:opencode      # fetch the pinned OpenCode binary into bin/ for your platform
npm run compile              # type-check + bundle (extension + webview)
# then press F5 in VS Code to launch the Extension Development Host
npm run package:vsix:bundled # build a platform .vsix with the binary embedded
```

The OpenCode binary is fetched at build time (pinned by `opencodeVersion` in
`package.json`) and is never committed — `bin/` is git-ignored. Bump that field
to upgrade the bundled OpenCode. F5 also resolves the binary from `bin/`, so run
`bundle:opencode` once before launching the dev host.

## License

MIT
