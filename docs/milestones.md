# Milestones

Each milestone ends with a **Done when** line that is checked by running the thing, not by reading
code. Issues live under the matching GitHub milestone; the owner picks the next one.

## M0 — Bootstrap

- Public repo, MIT license, secret scanning + push protection.
- Design documents: `CLAUDE.md`, `docs/architecture.md`, `docs/decisions.md`, this file,
  `docs/venues/binance.md`, `docs/venues/upcoming.md`.
- GitHub milestones M1–M4 and the M1 issue backlog.

**Done when** the M0 design PR is merged and the M1 issues exist.

## M1 — Read-only monitor (Binance)

Thirteen issues, in dependency order:

1. Workspace scaffold, tooling and CI.
2. Core: domain types, decimal rules and UI protocol.
3. DB: SQLite + Drizzle — accounts and fills.
4. Adapter: `ExchangeAdapter` read interface and transport.
5. Secrets: keychain-backed `SecretStore`.
6. Binance: instruments, credential check and REST snapshot.
7. Binance: private user-data streams with resync.
8. Binance: public price streams for held instruments.
9. CLI: `keys add | list | remove`.
10. Server: account sessions, state store, REST + WS on loopback.
11. Web: shell, accounts bar, spot holdings, futures positions, open orders.
12. Binance: spot fills ledger and average cost.
13. CLI: `doctor`.

**Done when**, with one live read-only key and one Demo key added via the CLI, the dashboard shows
for both accounts: spot balances (value in USDT, average cost where the ledger covers the holding,
"—" otherwise), futures positions (size, entry, mark, liquidation, uPnL, leverage, margin mode) and
open orders including conditional orders; a position opened in the Binance app appears within 2 s
without a refresh; cutting the network shows `down` plus stale badges and recovers through a
resync.

## M2 — Trading on Binance Demo

- OrderRouter + `order_intents` table (validate → persist intent → send → reconcile).
- Spot and futures market/limit orders, amend, cancel, cancel-all.
- Partial close (25 / 50 / 75 / 100 %), close-all.
- Leverage, margin mode, TP/SL place and cancel (futures via the Algo API).
- Confirmation modal with estimated notional and fee.

**Done when** every action works end-to-end from the UI on Demo, the server refuses every order
action on a `live` account, and a test proves that an injected unknown outcome (503) leads to
`queryOrder` reconciliation, never a second order.

## M3 — Live trading

- `accounts.trading_enabled`, toggled only by `bun run cli -- accounts enable-trading <label>` with
  a typed confirmation; never from the UI or the API.
- `docs/live-checklist.md`: the steps before the first real-money order.

**Done when** the checklist has been executed once with a minimum-notional live order.

## M4 — Bybit

- `packages/bybit` implementing the same `ExchangeAdapter`.

**Done when** `packages/bybit` passes the same adapter contract tests as Binance and both venues
appear side by side in the dashboard.

## Later

- Hyperliquid, Aster and Lighter adapters (`docs/venues/upcoming.md`).
- Deployment behind Cloudflare Access.
