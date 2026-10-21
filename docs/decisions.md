# Decisions

Lightweight ADR log, newest last. Add an entry when a decision is made or reversed; never edit an
old entry's decision — supersede it with a new one.

## 2026-10-20 — Separate public repo, independent of mirror

**Context:** The owner's journal tool `mirror` forbids exchange account keys and order execution by
design; a trading terminal needs both.

**Decision:** tradedeck is its own public, MIT-licensed repo with no code or data shared with mirror.

**Consequences:** mirror's rules stay intact; patterns may be copied (approach, not files), never
imported.

## 2026-10-20 — Local-first single server process on loopback

**Context:** One user, one machine, credentials that can trade.

**Decision:** One Bun process (`apps/server`) bound to `127.0.0.1` holds credentials, venue sessions
and state; the browser is a view. Deployment is deferred.

**Consequences:** No in-app auth; a Host/Origin loopback guard replaces it. Any future deployment
adds an edge gate first.

## 2026-10-20 — Own venue adapters over raw HTTP/WS

**Context:** ccxt counts swap amounts in contracts rather than base units, routes TP/SL through
exchange-specific params, and its Bun compatibility is unverified. `binance-connector-js` bumps
majors almost monthly (futures 33 → 39 in three months), pulls in axios + ws, may carry stale
testnet constants, and its Bun compatibility is unverified.

**Decision:** Each venue is a package implementing one `ExchangeAdapter` over `fetch` and
`WebSocket`, with no exchange SDK.

**Consequences:** More code per venue, but exact control over units, signing, reconnects and
errors; adapters are testable with injected `fetch` and a fake WS server.

## 2026-10-20 — Credentials in the OS keychain, entered only via the CLI

**Context:** Keys that can trade must not leak through files, logs, the browser or chat.

**Decision:** `Bun.secrets` (experimental since 1.2.21) behind a `SecretStore` interface; keys are
entered only through a CLI hidden prompt; for Ed25519 the CLI generates the keypair in memory and
prints only the public key.

**Consequences:** Keychain access may prompt on macOS; headless Linux needs another `SecretStore`
implementation before any server deployment.

## 2026-10-20 — Binance key type and permission policy

**Context:** Binance recommends Ed25519 and calls HMAC deprecated. Unrestricted system-generated
(HMAC) keys are read-only; self-generated Ed25519/RSA keys may enable trading without an IP
whitelist; withdrawals always require one.

**Decision:** Ed25519 by default, `--kind hmac` as a fallback; any key reporting withdrawal
permission is refused at `keys add`.

**Consequences:** Trading keys work without a static IP; an IP whitelist is still recommended when
the user has one.

## 2026-10-20 — Decimal strings and data-driven price/qty rules

**Context:** Venue prices and sizes overflow JS-number precision, and venues disagree on rules
(tick and step on Binance/Bybit, significant figures on Hyperliquid).

**Decision:** Decimal strings at every boundary, `decimal.js` inside; `PriceRule`/`QtyRule` are
serializable data on `Instrument`, applied by pure core functions; quantity always rounds down.

**Consequences:** One rounding implementation shared by server and UI; a new venue adds a rule kind,
not a code path.

## 2026-10-20 — Phasing: read → Demo trading → live trading → Bybit

**Context:** You cannot safely close what you cannot see, and the first real-money order should
follow a flow already proven elsewhere.

**Decision:** M1 read-only monitor, M2 trading on Binance Demo only, M3 live trading behind a
per-account CLI flag, M4 Bybit.

**Consequences:** Trading code ships with the server refusing `live` accounts until M3.

## 2026-10-20 — Binance private streams

**Context:** Spot user data via REST `listenKey` is deprecated since 2025-04-07; the USDⓈ-M private
WebSocket moved to a `/private` path.

**Decision:** Spot via WS API `userDataStream.subscribe.signature` (works with any key type, no
session logon); futures via `POST /fapi/v1/listenKey` on
`wss://fstream.binance.com/private/ws/<listenKey>` with `PUT` keepalive and a reconnect before 24 h.

**Consequences:** Two stream implementations in one adapter, each with its own resync path.

## 2026-10-20 — Server → UI over one WebSocket

**Context:** Balances, positions, orders and mark prices change many times per second.

**Decision:** One `/ws` pushing a full snapshot on connect and after every resync, then typed
deltas; Zod protocol schemas in core; a Zustand store with selectors in the web app.

**Consequences:** No polling and no TanStack Query until a polled REST need appears.

## 2026-10-20 — Own fills ledger in SQLite

**Context:** Binance keeps futures trade and income history for only 3 months and offers no spot
average-cost endpoint.

**Decision:** Fills are pulled into a local `fills` table keyed by venue trade id; average cost is
computed in core from it.

**Consequences:** Average cost is shown only where the ledger covers the whole holding; otherwise
"—".

## 2026-10-20 — Terminal-composed bulk actions

**Context:** Binance has no close-all endpoint and cancels all open orders per symbol only; other
venues differ again.

**Decision:** Close-all and cancel-all are composed by the terminal from current state, driven by
each adapter's `KindCapabilities` flags.

**Consequences:** Results are reported per position or symbol, and partial success is a normal
outcome the UI must show.

## 2026-10-21 — Claude merges its own PRs once CI is green

**Context:** Until now only the owner merged, so every finished issue waited for him. On
2026-10-21 the owner gave Claude standing permission to merge PRs.

**Decision:** Claude squash-merges a PR once its CI `gate` check is green. The PR title is the
commit subject. `master` still takes no direct commits, and the owner still chooses the issues.

**Consequences:**
- No approval is recorded. Claude opens PRs as the owner's GitHub account, and GitHub does not let
  an account approve its own PR.
- `master` has no branch protection, so only this rule enforces the green-CI condition.
- The owner's review moves to the plan before the work and to `master` after the merge.
