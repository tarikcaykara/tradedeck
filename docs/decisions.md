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

## 2026-10-21 — Owner reviews PRs that touch money, keys or core

**Context:** Later the same day, the owner narrowed the permission above. What matters most is the
money path — spot buys and sells; opening, closing and editing futures positions — and the keys
that can trade. A PR there that Claude both writes and merges has no second reader.

**Decision:** Supersedes "Claude merges its own PRs once CI is green" for PRs that touch
`packages/core`, keys, the order path, the fills ledger, the live-trading flag, the
loopback/Host/Origin guard or the hard rules (exact list in `CLAUDE.md`, Workflow): the owner
reviews and merges those. Every PR first gets a review pass by an agent that did not write it.

**Consequences:**
- Most of M1 — core, request signing, secrets, `keys`, the credential check, the fills ledger, the
  server guard — lands through owner review; the public price feed, the read-only UI and `doctor`
  usually do not.
- The reviewer-agent pass catches what it can before the owner reads the PR; it does not replace
  his review.

## 2026-10-22 — Strict Zod schemas define the core types

**Context:** Hand-written interfaces next to Zod schemas drift apart. `decimal.js` accepts strings
such as `1e5`, `NaN` and `.5`, so "a decimal string" needs one definition. A credential spread into
a delta by mistake would otherwise ride along to the browser unnoticed.

**Decision:** Every domain and protocol type in `packages/core` is `z.infer` of a `z.strictObject`
schema; decimal strings match `^-?\d+(\.\d+)?$`. Internal decimal arithmetic uses a cloned
`decimal.js` constructor with 64 significant digits, never the global one.

**Consequences:**
- An unknown key is a validation error, not silently dropped. Server and web ship from one repo, so
  there is no version skew to tolerate.
- An adapter must convert a venue value in exponent notation to plain decimal before it crosses a
  boundary.

## 2026-10-23 — Adapter transport: query-signed REST, no retries, stable-reset backoff

**Context:** M1 issue 4 (#5) adds the shared transport under every venue adapter. Only Binance signs
in the query string today; Bybit signs in headers, Hyperliquid and Lighter sign with a wallet or a
WASM signer (`docs/venues/upcoming.md`). Order requests have unknown outcomes on timeouts and 5xx
(hard rule 5), and Binance requires backing off after a 429.

**Decision:**
- The REST client implements the query-signed scheme only. Venue constants (base URL, API-key
  header, server-time fetcher) are parameters, and the package names no venue. Bybit's header
  scheme is added with Bybit (M4); there is no signing-scheme abstraction until then.
- The transport never retries a request; the caller decides.
- Every request has a timeout (default 10 s) surfaced as error kind `timeout`, distinct from a
  rejection, so a hung venue cannot keep an account `connecting` and the M2 OrderRouter can tell an
  unknown outcome from a refusal.
- The socket backoff resets only after a connection stayed open for `stableAfterMs` (default 30 s),
  not on the first message: a private user-data stream is legitimately silent, and detecting a
  silently dead stream belongs to the resync (M1 issue 7).

**Consequences:**
- Venue packages own retries, `-1021` resyncs (`ServerClock.invalidate()`) and response schemas.
- A socket that keeps connecting and dropping keeps backing off up to the cap.
- A second signing scheme means a second client or an abstraction then, not now.

## 2026-10-23 — Binance REST adapter: loud decode failures, one `-1021` retry, Demo-only recordings

**Context:** M1 issue 6 (#7) maps Binance REST responses to the domain. Binance adds fields and
enum values over time; a terminal that silently drops an open order it cannot map misleads the
user. Tests replay recorded responses (hard rule 9), and the repo is public.

**Decision:**
- Venue responses are parsed with loose Zod objects (unknown fields ignored). An unknown enum value
  or a shape mismatch is a `VenueError` of kind `decode` naming the endpoint and field: the
  snapshot fails and the account shows `down`, instead of dropping the item. Instruments are the
  exception: a symbol whose rules are unusable is left out, because it cannot be traded anyway.
- `-1021` (timestamp outside `recvWindow`) resyncs the server clock and retries the request
  exactly once. It is a definite rejection before processing; no other error is retried.
- Recordings come only from Binance Demo, through `bun run record:binance`. It sends exactly the
  adapter's endpoint table, takes the key from hidden prompts and never stores it, drops the auth
  params and headers, scrubs identifying values (`uid`, `accountAlias`, `apiKey`, …) and trims
  per-symbol lists. A test guards every committed recording.
- Futures time-in-force `GTD` gets its own domain value `gtd`; `RPI` maps to `post_only`.

**Consequences:**
- A new Binance enum value takes an account `down` until the mapping is extended; the error names
  the value.
- The live credential check (`/sapi`) has no recording: Demo does not serve `/sapi`, and live is
  never called. Its test uses Binance's documented response shape.
- Re-recording after a Binance change is one owner-run command.

## 2026-10-24 — Binance Demo keys report no withdrawal permission

**Context:** Hard rule 2 refuses a credential whose venue reports withdrawal permission. On live,
Binance reports the key's own permissions through `/sapi/v1/account/apiRestrictions`. Demo serves
no `/sapi`, so the Demo check reads the spot `account` and futures `accountConfig`. The Demo
recording (2026-10-24) shows `canWithdraw: true` in both. The Demo key form offers only Reading,
Spot & Margin and Futures, never withdrawals, so the flag describes the account, not the key.
Mapping it through would refuse every Demo key at `keys add`.

**Decision:** On `demo`, Binance `verifyCredential()` reports `canWithdraw: false`. The live
mapping is unchanged: a live key reporting `enableWithdrawals`, or missing it, is still refused.

**Consequences:**
- Demo keys can be added; Demo funds are not real, and a Demo key cannot withdraw.
- If Binance ever adds a withdrawal permission to Demo keys, or serves `/sapi` on Demo, this
  decision is revisited and Demo reads the key's own permissions.

## 2026-10-29 — Binance user-data streams: subscribe owns snapshot and resync, REST re-reads for positions, transport heartbeat

**Context:** M1 issue 7 (#8) adds the private streams. Architecture §6 asks for a snapshot that
replaces state after every disconnect, but `AccountHandlers` had no way to deliver one, and
opening the streams after a separate `fetchSnapshot()` leaves a gap in which events are lost.
Binance futures `ACCOUNT_UPDATE` carries no mark price, liquidation price or leverage, so a
position updated from it alone would show a stale liquidation price after a fill. The decision of
2026-10-23 left detecting a silently dead stream to this issue.

**Decision:**
- `subscribe()` owns the snapshot: it opens the streams first, buffers their events, snapshots
  once all are up, emits it through a new `onSnapshot` handler, applies the buffer in `E` order,
  then goes `live`. Every drop or undecodable event repeats this (`resyncing`); three consecutive
  failures are `down`. A new `onError` handler reports recovered failures for logs. Session start
  is `subscribe()` alone.
- Futures positions and balances are re-read over REST (`positionRisk` + `symbolConfig` per
  symbol, `/fapi/v3/balance`) whenever an event names them, mapped exactly like the snapshot.
  Order and fill events are mapped from the stream.
- The transport socket detects a dead connection: a heartbeat pings every 15 s and terminates a
  connection that sent nothing for a whole interval. `reconnect()` lets the venue code replace a
  connection; timers are injectable, so 30 min keepalives and 23 h rotations are tested on a
  manual clock.
- Both streams rotate at 23 h, before Binance's 24 h cut. `DELETE /fapi/v1/listenKey` is never
  sent: `POST` returns the account's one active key, shared by every connection on the account.
- Spot `balanceUpdate` is ignored: `outboundAccountPosition` follows every balance change with
  absolute values.

**Consequences:**
- About 15 request weight per futures position change, against 2400 a minute.
- A brief resync once a day per account.
- The store (#11) receives a snapshot through `subscribe()` and drops events older than the state
  they would overwrite (`Order.updatedAt` and `Position.updatedAt` are venue times).
- A healthy connection that never answered pings would be dropped every 30 s. The #8 Demo
  session (2026-10-30) kept both connections up for the whole ~20-minute recording with no
  resync, through event-free stretches of several minutes on each stream. The heartbeat counts
  any inbound frame, so this shows only that every 15 s window received one; Binance's documented
  server pings (spot: every 20 s) cannot fill every window alone, so pongs answering ours are
  likely but were not logged.

## 2026-10-31 — Stable Drizzle, migrations on open, first-write-wins fills

**Context:** M1 issue 3 (#4) adds the database. Drizzle's npm `latest` is `drizzle-orm` 0.45 /
`drizzle-kit` 0.31; 1.0 is a release candidate with a different migration folder format. Both the
server and the CLI open the database, and a venue sync re-reads overlapping trade pages.

**Decision:**
- `drizzle-orm` 0.45 and `drizzle-kit` 0.31, not the 1.0 RC. `drizzle-kit` is a devDependency of
  `packages/db`: Bun's isolated linker puts its binary only there.
- `openDb()` applies pending migrations on every open; there is no separate migrate command. A
  failed migration closes the handle and throws, so nothing runs on a half-migrated database.
- Every `fills` write goes through `insertFills()`, `ON CONFLICT DO NOTHING` on
  `(account_id, instrument_id, venue_trade_id)`: the first write wins.

**Consequences:**
- Moving to Drizzle 1.0 means running drizzle-kit's one-time migration folder upgrade.
- A fill the venue later corrected would keep its first version; venue trades are immutable, so
  none is expected.
- No `busy_timeout`: a CLI write while the server writes can fail with `SQLITE_BUSY`. #10/#11
  revisit this if it shows up.
