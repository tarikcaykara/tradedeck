# CLAUDE.md — tradedeck

Local-first, open-source multi-exchange trading terminal: monitor spot balances and futures
positions and trade from one screen. Binance first; more CEXes and perp DEXes behind the same
adapter interface.

The owner communicates in Turkish and expects Turkish replies; everything in the repo — code,
comments, docs, UI copy, commits, issues — is English.

## Read first

- `docs/architecture.md` before any structural change (new package, new dependency edge, new
  table, protocol change).
- `docs/venues/<venue>.md` before touching that venue's adapter.
- `docs/decisions.md` for why things are the way they are; add an entry when you change one.
- `docs/milestones.md` for what belongs to which milestone.

## Scope

Every order originates from an explicit user action in the UI. No automated strategies, bots,
signals or scheduled orders are part of any planned milestone (M0–M4).

## Hard rules

1. Credentials exist only in `apps/server` / `apps/cli` process memory and the OS keychain via
   `@tradedeck/secrets`. Never in SQLite, logs, `.env`, the browser, `__recordings__/`, issues,
   or chat. Keys are entered only through the CLI hidden prompt.
2. A credential whose venue reports withdrawal permission is refused at `keys add`.
3. `apps/server` binds `127.0.0.1` only and rejects any request whose `Host` or `Origin` is not on
   the loopback allowlist (`docs/architecture.md` §Process model).
4. Prices, quantities and money are decimal strings at every boundary and `decimal.js` inside;
   never JS-number arithmetic on them. Order quantity always rounds DOWN to the step size.
5. Every order action goes through the server's OrderRouter: validate → persist intent → send →
   reconcile. An unknown outcome (timeout / 5xx / "unknown error") is resolved with
   `queryOrder(clientOrderId)`; never re-sent blindly.
6. Reduce/close orders can never open or grow a position: one-way mode sends `reduceOnly`; hedge
   mode (where `reduceOnly` is not accepted) sends the position's own `positionSide` with the
   opposite order side (`LONG` + `SELL`, `SHORT` + `BUY`).
7. Trading on a `live` account is impossible until M3's CLI-only per-account flag enables it. In
   M2 the server refuses every order action on a `live` account.
8. `packages/core/src` imports nothing from `bun`, `bun:*`, `node:*`; no I/O; the clock is
   injected.
9. Development and tests never call live venue endpoints. Adapters are tested with injected
   `fetch`, scrubbed recordings and a local fake WS server; live smoke runs only on Demo.
10. Never commit to `master`. Branch `<type>/<issue>-<slug>` → PR → reviewer-agent pass → green CI
    → squash merge. A PR that touches money, keys or `packages/core` is merged only by the owner
    (Workflow, owner-review PRs); Claude merges every other PR.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime / package manager | Bun 1.4.x (workspaces) |
| Language | TypeScript strict + `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, explicit `.ts` import extensions |
| Server | Hono 4 + `@hono/bun` for WebSocket (`hono/bun` is deprecated) |
| Web | React 19 + Vite 8 + Tailwind v4 + shadcn/ui |
| Client state | Zustand (state pushed over the WebSocket) |
| Database | SQLite via `bun:sqlite` + Drizzle (`drizzle-orm/bun-sqlite`) + drizzle-kit |
| Validation | Zod at every boundary |
| Decimals | decimal.js |
| CLI | `@clack/prompts` |
| Lint / format | Biome |
| Tests | `bun test` |

Not used: ccxt, `binance-connector-js`, TanStack Query (until a polled REST need appears), any
desktop shell (Tauri/Electron). See `docs/decisions.md`.

## Repository layout

npm scope `@tradedeck/*`:

```
apps/server      @tradedeck/server   credentials, venue sessions, state store, OrderRouter (M2), API
apps/web         @tradedeck/web      React UI; talks only to apps/server
apps/cli         @tradedeck/cli      keys add|list|remove, doctor
packages/core    @tradedeck/core     pure: domain types, decimal rules, PnL, avg cost, protocol schemas
packages/adapter @tradedeck/adapter  ExchangeAdapter interface, capabilities, transport
packages/binance @tradedeck/binance  Binance spot + USDⓈ-M adapter (live + demo)
packages/db      @tradedeck/db       Drizzle schema, migrations, client
packages/secrets @tradedeck/secrets  SecretStore interface + keychain implementation
```

## Import direction

One-way, enforced by `test/workspace.test.ts` (since M1 issue 1) from the declared
`package.json` dependencies — an undeclared edge cannot be imported by accident:

```
packages/core     → (nothing)
packages/adapter  → core
packages/binance  → adapter, core
packages/db       → core (types only)
packages/secrets  → core (types only)
apps/server       → core, adapter, binance, db, secrets
apps/cli          → core, adapter, binance, db, secrets
apps/web          → core
```

`apps/web` reaching `adapter`, `binance`, `db` or `secrets` is forbidden: the browser never holds
a credential or talks to a venue. Each later venue is its own package (`packages/bybit`,
`packages/hyperliquid`, …) with the same edges as `packages/binance`.

## Commands

`check`, `typecheck` and `test` exist since M1 issue 1 (#2); `cli` lands with #10 and `dev` with
#12, together with the code they run.

```bash
bun install
bun run dev                      # server + Vite dev server
bun run cli -- <cmd>             # keys add|list|remove, doctor
bun run check && bun run typecheck && bun test   # the gate — green before every commit
```

## Workflow

- `gh` runs as the repo owner: prefix every call with `GH_TOKEN="$(gh auth token -u tarikcaykara)"`
  (the active gh account is a different one). Never ask for, store or handle credentials.
- One issue at a time, chosen by the owner. Issue → branch `<type>/<issue>-<slug>` → PR →
  reviewer-agent pass → green CI → squash merge with the PR title as the commit subject.
- Reviewer-agent pass: before a PR is merged or handed to the owner, an agent that did not write
  the change reviews its diff. Claude fixes or answers every finding and summarises the review in
  the PR body.
- Owner-review PRs: Claude never merges a PR that touches any of
  - `packages/core`: domain types, decimal rules, PnL, average cost, protocol schemas;
  - keys: `packages/secrets`, credential handling in `apps/server` and `apps/cli`, the CLI `keys`
    commands, request signing, and `verifyCredential()` / `CredentialReport` (every permission
    field, not only hard rule 2);
  - the order path: placing, editing, cancelling or closing an order; leverage, margin mode, TP/SL;
    close-all and cancel-all; `order_intents` persistence and reconciliation — in the adapter, the
    OrderRouter, `packages/db` or the UI;
  - the fills ledger: its schema, ingestion, deduplication and the coverage rule for average cost;
  - the live-trading flag (hard rule 7) or the server's loopback/Host/Origin guard (hard rule 3);
  - the hard rules or this list.

  Such a PR's body opens with `Owner review: <item>`. Claude stops once CI is green and the review
  is done, tells the owner, and the owner reviews and merges.
- Conventional Commits; one logical change per commit; no `Co-Authored-By` trailers.
- Update `README.md`, `CLAUDE.md` and `docs/` in the same PR as any behaviour change.
