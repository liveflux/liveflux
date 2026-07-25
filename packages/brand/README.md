# @liveflux/brand

The **single source of truth** for Liveflux's visual design — colour, typography,
spacing, radius, elevation and motion — shared verbatim by the docs, the
playground and the marketing site so they read as one product.

Private (not published): it exists to be consumed inside this monorepo.

## Use it

Add the workspace dependency, then import the tokens **after** Tailwind in your
app's global stylesheet:

```css
@import "tailwindcss";
@import "@liveflux/brand/tokens.css";
```

That's all — the tokens register as CSS custom properties and as Tailwind
utilities (`bg-lf-surface`, `text-lf-primary`, `border-lf-border`, `font-mono`,
…). Dark mode follows the `.dark` class (next-themes / Fumadocs).

## Architecture — two tiers

| File             | Tier | What it holds                                                        |
| ---------------- | ---- | -------------------------------------------------------------------- |
| `primitives.css` | 1    | Raw, theme-independent palette ramps + type / space / radius / motion |
| `semantic.css`   | 2    | Purpose-named, theme-aware aliases + the Tailwind `@theme` mapping    |
| `tokens.css`     | —    | Barrel that imports both                                             |

**Rule:** apps and components consume the **semantic** tokens (`--lf-primary`,
`--lf-surface`, `--lf-muted-foreground`, …), never the raw primitives. That keeps
a re-theme — or a new theme — a change to `semantic.css` alone.

## Identity

Electric **blue → indigo** accent on **cool-slate neutrals** — a realtime /
signal palette — with Inter for text and a monospace for code. The brand blue is
`--lf-blue-500` on light and `--lf-blue-400` on dark; the indigo partner drives
the gradient logo tile and the drifting top-of-page aurora (`lf-aurora-drift`).

## Token map (semantic)

- **Surfaces** — `--lf-background`, `--lf-surface`, `--lf-surface-2`, `--lf-muted`
- **Text** — `--lf-foreground`, `--lf-muted-foreground`
- **Lines** — `--lf-border`, `--lf-input`, `--lf-ring`
- **Brand** — `--lf-primary` (+ `-foreground` / `-hover` / `-subtle`), `--lf-secondary`
- **Status** — `--lf-success` / `--lf-warning` / `--lf-danger` (+ `-foreground`)
- **Motion** — `--lf-ease-out`, `--lf-ease-signal`, `--lf-duration-{fast,base,slow,aurora}`
- **Author** — `--lf-author` (the BPDM amber credit only)
