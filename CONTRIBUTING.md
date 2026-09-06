# Contributing to SAGA

Thanks for your interest in contributing. This document covers the essentials for getting oriented, reporting issues, and submitting changes.

## Reporting bugs

Open a [GitHub issue](../../issues/new?template=bug_report.yml) and fill in the template. Include:

- What you did, what you expected, and what actually happened
- Reproduction steps (minimal is best)
- SAGA version and OS

## Proposing features

Open a [feature request issue](../../issues/new?template=feature_request.yml) before writing code. This lets us align on scope and avoid wasted effort. For larger changes, wait for a maintainer to acknowledge the proposal before opening a PR.

## Development prerequisites

| Tool | Minimum | Notes |
|------|---------|-------|
| **Bun** | 1.2 | Hard runtime requirement — `bun:sqlite` and `Bun.serve` are load-bearing, not replaceable |
| Node | 20 | Required by some tooling; Bun is still the runtime |
| npm | bundled with Node | Used for `npm install` at the workspace root |
| pnpm | any recent | Used for `pnpm -r typecheck` |

> **Bun is not just a dev tool.** The capture proxy and the store use `bun:sqlite` and `Bun.serve` directly. There is no Node-compatible shim. You must run the project with `bun`, not `node`.

## Getting started

```bash
# Install dependencies
npm install

# Typecheck all packages
pnpm -r typecheck

# Run all tests
bun test packages apps tools tests

# Lint
npx biome check .
```

## Submitting a pull request

1. Fork the repo and create a branch from `main`.
2. Make your changes. Keep commits focused — one logical change per commit.
3. Before pushing, run through the checklist below.
4. Open the PR against `main`. Fill in the description with what changed and why.

### PR checklist

- [ ] `pnpm -r typecheck` exits clean (no type errors)
- [ ] `bun test packages apps tools tests` passes
- [ ] `npx biome check .` reports no errors
- [ ] No secrets, tokens, or credentials are staged (check `git diff --cached`)
- [ ] Commit subject follows [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): short description`
  - Types: `feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `perf`, `ci`
  - Example: `fix(capture): handle chunked SSE frames correctly`

## Architecture notes

SAGA is a **thin reverse proxy** — it never modifies upstream gateways and never blocks the response path. Provider differences belong in adapters under `packages/adapters`. If you are adding a new provider, add an adapter there; do not add branching to the capture path.

See `CLAUDE.md` for the full architecture overview and constraints.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
