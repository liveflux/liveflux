# create-liveflux

Scaffold [Liveflux](https://liveflux.bpdm.dev) into your project. Pick a framework
binding and a transport adapter; get `@liveflux/core` plus the right packages
installed and a typed, reconnect-safe client wired up.

```bash
pnpm create liveflux@latest
# or: npm create liveflux@latest · yarn create liveflux · bun create liveflux
```

## What it does

1. Asks which **framework binding** (React, or vanilla/core) and **transport
   adapter** (`ws`, `phoenix`) you want, and whether to use TypeScript.
2. Installs `@liveflux/core` + the chosen adapter + the chosen binding with your
   package manager (auto-detected).
3. Generates a `liveflux` client module and a ready-to-adapt usage example.

## Every choice is explicit

There is **no `--yes` / `--skip` / defaults mode** — each option is chosen on
purpose, interactively or via flags. Options that aren't released yet (e.g.
`gql-ws`, Vue) are shown but cannot be selected, and passing them as flags is a
hard error. One registry drives the prompts and the flag parser, so no input
path can select something unavailable.

## Non-interactive

Pass every choice explicitly (missing any is an error, never a default):

```bash
pnpm create liveflux@latest --framework react --adapter ws --typescript
```

| Flag | Values |
| --- | --- |
| `-f, --framework` | `react`, `vanilla` |
| `-a, --adapter` | `ws`, `phoenix` |
| `--typescript` / `--no-typescript` | — |
| `--dir <path>` | target project (default `.`) |
| `--force` | overwrite existing generated files |
| `-h, --help` · `-v, --version` | — |

## License

[MIT](../../LICENSE) © [Bhavin P. Devamorari](https://bpdm.dev)
