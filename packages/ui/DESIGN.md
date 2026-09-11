# SAGA design system

SAGA is an instrument, not a landing page. Every pixel of chrome competes with a
number someone is trying to read at 2am. The system below exists to make the
data legible first, beautiful second — and to make the product's honesty
contract (provenance on every number) the visual signature rather than a
compliance burden.

Three rules govern everything:

1. **Chrome is neutral; color means data.** Interface chrome (nav, cards,
   borders, buttons) lives on the neutral ramp. Hue is reserved for semantics:
   status, provenance, series identity, and the single gold accent for
   interactive affordances.
2. **Certainty has a temperature.** Wire-verified data is cool and solid;
   SAGA's own guesswork is warm and marked. The provenance ramp runs
   teal (provider said so) → lime (a middleman computed it) → rose (SAGA
   estimated it), with violet + dashing for inferred structure.
3. **Color is never the only channel.** Every provenance tone pairs with a
   distinct mark shape; every status pairs with a label; inferred always
   dashes. Palettes are validated computationally for CVD separation and
   contrast — see “Validation” below.

## Color tokens

All tokens are CSS custom properties in `theme.css`, defined on `:root`
(light) and redefined under `.dark`. Components never hardcode hex.

### Neutrals

| Token | Light | Dark | Role |
|---|---|---|---|
| `--saga-canvas` | `#f5f6f8` | `#0b0c0f` | app background |
| `--saga-surface` | `#ffffff` | `#12151b` | cards, panels |
| `--saga-raised` | `#eef0f3` | `#1a1f27` | hover, wells, thumbs |
| `--saga-overlay` | `#ffffff` | `#20262f` | popovers, palette |
| `--saga-line` | `#e3e6eb` | `#262c36` | hairline borders |
| `--saga-line-strong` | `#cbd1d9` | `#333b47` | emphasized borders |
| `--saga-ink` | `#171a1f` | `#ecf0f6` | primary text |
| `--saga-ink-dim` | `#4b5563` | `#a6b1c0` | secondary text |
| `--saga-ink-faint` | `#687080` | `#7e8b9c` | micro labels (AA at 4.5:1 on surface) |

### Accent (interactive, brand)

| Token | Light | Dark |
|---|---|---|
| `--saga-accent` | `#996516` | `#f0bb4b` |
| `--saga-accent-ink` | `#ffffff` | `#1a1508` |
| `--saga-accent-soft` | `#f3ead7` | `#2a2312` |

Gold is the only chrome hue. It marks: links, primary buttons, active tab
rail, focus rings, selection, the live pulse. It is not a data color.

### Status (always dot/icon + label, never bare color)

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--saga-ok` | `#056426` | `#2e9e52` | completed clean |
| `--saga-warn` | `#a2650a` | `#efb146` | partial / degraded |
| `--saga-err` | `#bd093f` | `#fa686a` | upstream error |
| `--saga-info` | `#1666aa` | `#418ad1` | streaming / neutral info |

### Provenance (the honesty ramp — each tone owns a mark shape)

| Token | Light | Dark | Meaning | Mark |
|---|---|---|---|---|
| `--saga-prov-upstream` | `#079393` | `#46d3c7` | provider-reported | solid disc |
| `--saga-prov-gateway` | `#829417` | `#ccee6e` | middleman-computed | ring (hollow disc) |
| `--saga-prov-saga` | `#a5317c` | `#ca5b9f` | SAGA heuristic | diamond |
| `--saga-inferred` | `#573494` | `#bea6fe` | guessed structure | dashed ring / dashed border |

`--saga-thinking` shares the violet family (deeper step) — model-internal
reasoning and SAGA-internal inference both read as “not part of the visible
wire conversation”, and thinking blocks are large bordered surfaces that
cannot be confused with inferred tags.

Mixed aggregates render a three-stop gradient disc (teal→lime→rose) and say
“mixed” inline.

### Chart series (categorical, fixed order, never cycled)

| Slot | Light | Dark | Hue |
|---|---|---|---|
| 1 | `#a97e2c` | `#b8892d` | gold |
| 2 | `#067974` | `#038a7f` | teal |
| 3 | `#5a3d96` | `#6a51a4` | violet |
| 4 | `#478d4b` | `#54a058` | green |
| 5 | `#973069` | `#ab4a7d` | rose |
| 6 | `#3275b4` | `#488acb` | blue |

Past six series: fold into “other”. Latency charts use fixed semantic colors
(p95 err / p50 accent / avg info), not series slots.

### Validation

Palettes were validated with the OKLab CVD validator (Machado 2009,
severity 1.0), per theme, against the actual surfaces:

- Chart series: PASS on all gates (adjacent pairs), both themes. Dark slot 3
  sits at 2.9:1 vs surface — relief satisfied by legends + direct labels.
- Provenance: dark PASS all-pairs (worst CVD ΔE 8.9); light lands in the 6–8
  relief band (violet↔rose protan 7.4) — relief satisfied by the mandatory
  mark-shape system above.
- Status: light in relief band (warn↔ok protan 6.4), dark worst pair
  err↔ok protan 6.3 — relief satisfied by mandatory labels on every pill.
- Every text-bearing token holds ≥4.5:1 on its theme surface; mark-only
  tokens hold ≥3:1.

## Typography

- UI: **Geist Variable**, system-ui fallback. Data, ids, numbers, timestamps:
  **Geist Mono Variable** with `tabular-nums`.
- Base 13px. Scale: 10.5 (micro labels, uppercase +0.08em), 11.5 (small),
  13 (base), 14 (emphasis), 16 (section), 22 (kpi), 28 (hero).
- Numbers a human compares are always mono + tabular.

## Space, radius, elevation

- 8px grid, 4px sub-grid for dense tables. Page gutter 16px.
- Radii: 4 (marks), 6 (controls), 10 (cards), 14 (overlays).
- Elevation is surface-step first (canvas → surface → raised → overlay),
  shadow second (shadows only on floating layers: tooltips, palette, menus).
- Borders are hairlines (`--saga-line`); `line-strong` only for focus/hover
  emphasis.

## Motion

Motion tokens live in `motion.ts` and carry continuity, not decoration.
Names, not guesses:

- Durations: `--dur-1` 100ms (hover/focus), `--dur-2` 180ms (fades, underline),
  `--dur-3` 280ms (cards, palette), `--dur-4` 480ms (charts, page reveals).
- Eases: `outQuint` `cubic-bezier(0.22,1,0.36,1)` for entrances;
  `inOut` `cubic-bezier(0.65,0,0.35,1)` for moves.
- Springs (motion/react): `snap` (stiffness 560, damping 42, mass 0.9) —
  selection, small layout; `settle` (300/34/1) — shared-element drill-downs;
  `pop` (640/34/0.7) — palette/dialog entrance.
- Stagger: 18ms per row, capped at 240ms total; rows past the cap appear
  together.
- Rules: animate `transform`/`opacity` only. Numbers never tween where a
  mid-flight read could misreport — live counters snap to real values with a
  scale tick. Charts never hard-swap datasets.
- **Reduced motion is structural**: `MotionConfig reducedMotion="user"` wraps
  the app; every CSS animation sits behind
  `@media (prefers-reduced-motion: no-preference)`; 3D scenes render a static
  frame or fall back to 2D.

## 3D

3D must be the clearest way to see that data, or confined to surfaces where
no data lives. Both uses are lazy chunks, WebGL-detected, reduced-motion
aware, with a 2D path that ships first:

- **Context topography** (session detail): turns × measure lanes × volume as
  extruded ridges; falls back to the 2D growth charts.
- **Ambient field** (empty states / 404): sparse drifting points, zero data,
  frozen under reduced motion, absent without WebGL.

## Focus & keyboard

Focus is visible and designed: 2px accent ring outside a 1px surface gap
(`--focus-ring`). Everything reachable by keyboard; list surfaces keep j/k
navigation. Radix primitives keep their ARIA behavior.
