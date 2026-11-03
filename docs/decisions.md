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

## 2026-11-01 — Keychain SecretStore: core's CredentialSchema on read, fixed corrupt-entry error

**Context:** M1 issue 5 (#6) stores each credential in the OS keychain as JSON and must Zod-parse
it on read. The documented import edge was `packages/secrets → core (types only)`, and a parser
error can quote part of the stored value.

**Decision:**
- `packages/secrets` imports core's `CredentialSchema` at runtime, so there is one schema and core
  stays pure. The documented edge becomes `packages/secrets → core`.
- A corrupt entry (not JSON, or not a `Credential`) throws a fixed message that names only the
  account id; the parser's own error is dropped. `set` does not validate: its argument is a typed
  in-process `Credential`.
- The store is a factory, `createKeychainSecretStore({ backend? })`, like the repo's other
  injectable components. The default backend `Bun.secrets` is resolved inside the factory, so a
  store built with a fake never evaluates it.

**Consequences:**
- A new credential kind becomes storable as soon as core's schema has it.
- A corrupt entry is repaired with `keys remove` + `keys add` (#10).
- Tests, including on the Linux CI runner, never touch `Bun.secrets`.

## 2026-11-01 — keys add refuses transfer permission; account row before keychain entry

**Context:** M1 issue 9 (#10) adds `keys add`. Binance reports two transfer permissions besides
withdrawals, `enableInternalTransfer` (master ↔ sub-account) and `permitsUniversalTransfer`;
whether either should block a key was open (`docs/venues/binance.md`, Unverified). `keys add` also
writes to two stores, SQLite and the OS keychain, that share no transaction.

**Decision:**
- Transfer permission is refused like withdrawal permission. `CredentialReport` gains
  `canTransfer`; on live it is `enableInternalTransfer || permitsUniversalTransfer`, and a missing
  flag counts as granted. Demo reports `canTransfer: false`: the Demo key form has no transfer
  permission.
- `keys add` refuses a taken label before generating a key, writes the `accounts` row first and
  the keychain entry second, and deletes the row again if the keychain write fails.
- `keys remove` deletes the keychain entry first and the row second; a missing entry is not an
  error.

**Consequences:**
- A live key needs both transfer boxes unticked. Demo keys are unaffected.
- If the rollback itself fails, an orphan row without a keychain entry remains; `keys remove`
  clears it.
- A failed keychain delete leaves the account in place, so `keys remove` can be retried.

## 2026-11-01 — Test-first acceptance tests; e2e journeys from #12; Demo smoke per milestone

**Context:** After M1 issue 9 the owner asked whether every task should start with an end-to-end
test. Most work so far is in core and the venue adapter, where integration tests with recordings
and fake sockets prove behaviour deterministically. A true end-to-end run would need a venue:
live is forbidden in development (hard rule 9), and Demo needs a credential in CI (hard rule 1)
and is network-bound and rate-limited. There is no web app before #12.

**Decision:**
- Every issue writes its acceptance criteria first as failing tests, at the lowest level that can
  prove them (unit or integration).
- From #12 on, an issue that changes a user-visible flow also adds an end-to-end journey: a
  browser drives the web app and the server against a fake venue, in CI. #12 picks the tool.
- Each implementation milestone (M1–M4) ends with a manual Demo smoke run on the owner's machine
  and Demo account: the owner does the interactive steps, Claude the non-interactive checks.

**Consequences:**
- End-to-end journeys stay few and cover user flows only; correctness below the UI stays in fast,
  deterministic tests.
- No credential ever enters CI; Demo is exercised by hand, at least once per implementation
  milestone.

## 2026-11-01 — Protected master, Dependabot with a cooldown, SHA-pinned actions

**Context:** The 2026-11-01 audit found that `master` had no protection (finding 1): hard rule 10
and the green-`gate` condition (2026-10-21) were enforced only by discipline, and Claude merges with
the owner's token. Dependabot alerts were off, the CI actions were pinned by movable tags, and the
public repo handles keys, so a compromised dependency release is the main supply-chain risk.
Rulesets are free for public repositories.

**Decision:**
- A `master` ruleset with no bypass actors: PR only, squash only, required `gate` on an
  up-to-date branch, no force-push, no deletion. Merge commits and rebase merges are off; merged
  branches are deleted. Required approvals stay 0: GitHub does not let an account approve its own
  PR, and Claude opens PRs as the owner.
- Dependabot alerts and private vulnerability reporting are on. Security updates are turned on
  once `.github/dependabot.yml` is on `master`, so their PRs follow it.
- Dependabot version updates run weekly for `bun` and `github-actions`. A release is proposed only
  after 7 days (`cooldown`), since compromised npm releases are usually pulled within days; security
  updates skip the cooldown. Minor and patch updates are grouped into `money-keys` (`decimal.js`,
  `zod`, `drizzle-orm`, `@clack/prompts`) and `other`; groups are built from name patterns because
  Dependabot's `dependency-type` grouping does not support `bun`. Majors come one by one.
- `money-keys` and every major update are owner-review; Claude merges `other` and `actions` after
  the reviewer pass and a green `gate`. Nothing auto-merges.
- CI actions are pinned by commit SHA with a version comment, which Dependabot keeps current, and
  `actions/checkout` does not persist its token.
- `@types/bun` is ignored: the Bun runtime is bumped by hand, together with the CI `bun-version`
  and `engines`.

**Consequences:**
- The 2026-10-21 consequence "only this rule enforces the green-CI condition" no longer holds:
  GitHub enforces it.
- When `master` moves, an open PR must be updated before it can merge; Dependabot rebases its own.
- A new dependency on the money, keys or ledger path must be added to `money-keys` in both
  `.github/dependabot.yml` and `CLAUDE.md`.

## 2026-11-03 — Audit hardening: `-1021` resends only a GET, redirects refused, inputs validated

**Context:** The 2026-11-01 audit (#36) found no critical or high finding, but several cheap gaps in
code that #14, #9 and #11 build on. The 2026-10-23 rule "`-1021` resyncs the server clock and
retries the request exactly once" covered every signed endpoint; M2 adds signed order endpoints,
and a resent order bypasses the OrderRouter (hard rule 5).

**Decision:**
- Supersedes the 2026-10-23 `-1021` bullet: a signed `-1021` always resyncs the server clock, but
  only a `GET` is resent, once. Any other method rejects with the `-1021` error; the next signed
  request uses the fresh offset.
- The REST client refuses every redirect (`redirect: "error"`), whatever the auth mode: a
  redirect would carry the API-key header to another origin, and no Binance endpoint redirects.
- A futures listen key must match `/^[A-Za-z0-9]{1,256}$/` before it enters a URL. A throwing
  `WebSocket` constructor gets the fixed reason `WebSocket constructor failed`, since its message
  can quote the URL.
- `ReconnectingSocket` rechecks `closed` after each `onStatus`, so a `close()` from the callback
  arms no retry and resolves no URL.
- The recordings guard fails on an empty scan and on any 64-character letters-and-digits string,
  reporting paths only.
- `keys add` and `keys remove` refuse a non-TTY stdin; `keys add` accepts labels matching
  `/^[A-Za-z0-9._-]{1,64}$/`. `keys remove` does not check the pattern, so an older label stays
  removable.

**Consequences:**
- An M2 order that meets `-1021` fails visibly; the OrderRouter decides what happens next.
- A venue that ever redirects an API call fails with `network: fetch failed (UnexpectedRedirect)`
  until the base URL is fixed.
- Scripting `keys add` or `keys remove` through a pipe is not possible; `keys list` still is.

## 2026-11-03 — `doctor`: real stream probes, Binance's exact clock window, newer database fails

**Context:** M1 issue 13 (#14) adds `doctor`. Its scope names the checks (keychain, database and
migrations, credential and withdrawal permission, clock offset within `recvWindow`, private stream
reachable), but not how each is proved. `openDb()` applies pending migrations on open, so a
"migrations current" check would always pass. `ServerClock` keeps its offset private, and the
adapter stamps signed requests with that clock, so a skewed local clock does not break signing
by itself.

**Decision:**
- The streams are proved by opening them: the spot WS API subscription and the futures listen-key
  stream, each until it is up (at most 15 s), then closed. The listen key is not deleted: `POST`
  returns the account's one active key, shared with any running server.
- The clock is read from the public time endpoints (server time minus the local midpoint). It
  passes in Binance's own acceptance window for an uncompensated timestamp,
  `−1000 ms < offset ≤ recvWindow`, rather than `|offset| ≤ recvWindow`.
- A database holding a migration from a newer build fails (`migrationStatus()` in `packages/db`).
- `doctor` refuses a key the way `keys add` does: a key that cannot read, or that allows
  withdrawals or transfers, fails, and its streams are not opened.
- Venue code stays in the venue package (`measureClockOffset`, `withinRecvWindow`,
  `probeUserStream`, and `verifyCredential`, which is now exported). The CLI orders the checks,
  judges permissions and prints the lines, behind an `AccountProbe` seam.

**Consequences:**
- For each account that passes the permissions check, a `doctor` run opens two real connections
  and extends the futures listen key by 60 min.
- A key added before a permission change on the venue is caught on the next `doctor` run.
- Switching to an older checkout after a migration is reported instead of silently running on a
  newer schema.

## 2026-11-03 — `bun audit` in the gate; advisories allowlisted by id, each with a reason

**Context:** GitHub's dependency graph does not read `bun.lock`: the SBOM lists only the 14
manifest dependencies, so Dependabot alerts miss transitive packages (#39). `bun audit` reads the
lockfile; on 2026-11-03 it reports one advisory, GHSA-67mh-4wv8-2f99 (moderate): esbuild ≤ 0.24.2's
development server (`serve`) lets any website read its responses. #11 and #12 bring Hono, React,
Vite, Tailwind and shadcn, with hundreds of transitive packages.

**Decision:**
- The `gate` job ends with `bun run audit`. It is the last step, so neither a registry outage nor
  a new advisory hides lint, type or test results.
- There is no severity threshold: `--audit-level=high` would also pass a moderate advisory in a
  runtime dependency such as `zod` or `decimal.js`. Every advisory is triaged instead (`CLAUDE.md`,
  Workflow): fix it, or ignore it by id with an entry here.
- GHSA-67mh-4wv8-2f99 is ignored:
  - The vulnerable esbuild 0.18.20 comes from `drizzle-kit` 0.31.11 → `@esbuild-kit/esm-loader` →
    `@esbuild-kit/core-utils`, which pins `esbuild ~0.18.20`, so `bun audit fix` cannot move it.
  - `drizzle-kit` is a devDependency of `packages/db`, run only by `bun run db:generate`, and
    `core-utils` calls only esbuild's `transform` / `transformSync`, never `serve`.
  - Drop the ignore once `drizzle-kit` no longer pulls in esbuild < 0.25.

**Consequences:**
- A newly published advisory turns every open PR, and the next `master` run, red until it is
  triaged.
- `bun audit` needs the npm registry; an outage fails the gate's last step.
- A stale ignore is not detected automatically; the Dependabot review of the package behind it
  checks (`CLAUDE.md`, Workflow).
