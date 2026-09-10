# SAGA

SAGA is a local-first reverse proxy that sits in front of any AI gateway or provider endpoint. Clients point at SAGA; SAGA forwards upstream untouched and tees the traffic into SQLite; a React dashboard reads it back live. It is gateway-agnostic — Kiro Gateway is one example upstream, not the only one. SAGA never patches, forks, or injects middleware into a gateway: integration is HTTP in, HTTP out.

```
client (Claude Code, curl, any AI client)
        |
        v
  SAGA proxy  127.0.0.1:8787   (capture, redact, tee — forward first)
        |
        v
  any upstream: Kiro Gateway / Anthropic / OpenAI / LiteLLM / ...
        |
        +---> SQLite (redacted events)
                |
                v
          WebSocket fan-out --> React dashboard  127.0.0.1:8788
```

## Features

- **Session replay** — reconstruct any conversation turn by turn
- **Request inspector** — full request/response detail, headers, SSE frames
- **Agent correlation** — parent/child tool-call trees across multi-step agents
- **Token and cost provenance** — every figure is labeled `upstream-reported`, `gateway-computed`, or `saga-estimated`; numbers without a source render as n/a, never as an invention
- **Retention and redaction** — configurable retention tiers; bearer tokens, JWTs, API keys, and cookies are scrubbed before anything touches disk

## Security posture

> **Read this before exposing SAGA to any network.**

- The read API, WebSocket, and SQL endpoint have **no authentication**.
- The SQL endpoint executes **arbitrary SQL** against the capture database.
- SAGA binds **loopback (127.0.0.1) explicitly** — never point it at a network interface or expose it behind a reverse proxy without adding your own authentication layer.
- The capture database is **plaintext SQLite on disk**. Treat it with the same care as the credentials passing through it.

## Prerequisites

- **Bun ≥ 1.2** (required runtime — `bun:sqlite`, `Bun.serve`, and `Bun.CryptoHasher` are load-bearing)
- **Node ≥ 20**
- **npm** (package manager for workspace bootstrap)

## Setup

### Linux / macOS

```sh
git clone https://github.com/your-org/saga.git
cd saga
npm install
bun run build        # production build
bun run start        # start collector (proxy + read API + WebSocket)
```

For development (watch mode):

```sh
bun run dev          # collector in watch mode
bun run dev:web      # dashboard dev server (separate terminal)
```

### Windows

```powershell
git clone https://github.com/your-org/saga.git
cd saga
npm install
bun run build
bun run start
```

For development:

```powershell
bun run dev          # collector in watch mode
bun run dev:web      # dashboard dev server (separate terminal)
```

Point any AI client at `http://127.0.0.1:8787` instead of its usual base URL:

```powershell
# PowerShell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8787"
```

```sh
# bash / zsh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

The default upstream is `http://127.0.0.1:8000`. Override it and other settings with environment variables:

| Variable | Default | Description |
|---|---|---|
| `SAGA_UPSTREAM` | `http://127.0.0.1:8000` | Upstream gateway or provider URL |
| `SAGA_PROXY_PORT` | `8787` | Proxy listen port |
| `SAGA_API_PORT` | `8788` | Read API / WebSocket / dashboard port |
| `SAGA_DB` | `saga.db` | SQLite database path |
| `SAGA_QUEUE_CAP` | — | Capture queue capacity |
| `SAGA_UI_DIR` | — | Path to built dashboard (served at `/`) |
| `SAGA_OTLP_ENDPOINT` | — | OTLP/HTTP trace export endpoint |
| `SAGA_PLUGIN` | — | Module path whose default export receives the collector handle |

## No live gateway?

Replay the hand-authored corpus through the proxy:

```sh
bun tools/corpus/src/serve-replay.ts 8999
# then in another terminal:
SAGA_UPSTREAM=http://127.0.0.1:8999 bun run start
# seed history:
bun tools/corpus/src/seed.ts
```

## Repo map

| Package | Purpose |
|---|---|
| `packages/contracts` | Frozen schemas: `NormalizedEvent`, read API types, adapter interface |
| `packages/capture` + `packages/adapters` | Proxy, tee, SSE observer, provider normalization |
| `packages/redact` + `packages/store` | Fail-closed secret scrubbing; SQLite (STRICT, WAL, FTS5) |
| `packages/api` + `packages/analytics` | Read API, WebSocket fan-out, query interface |
| `packages/ui` + `apps/web` | Design system and dashboard pages |
| `apps/collector` | Composition entry point (proxy + writer + API in one Bun process) |
| `tools/corpus` | Hand-authored fixtures, replay upstream, performance benchmark |

## Contributing

Pull requests are welcome. Please open an issue first for significant changes. All contributions must preserve the two non-negotiable rules: never modify an upstream gateway, and never block the response path.

## License

MIT
