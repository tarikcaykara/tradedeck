# Upcoming venues — Bybit V5, Hyperliquid, Aster, Lighter

**Researched 2026-10-20 — re-verify before implementing.** Nothing here was run against a venue.
Every claim carries a source URL or is marked UNVERIFIED; `[INFERENCE]` marks a conclusion no doc
states. Each venue becomes its own package (`packages/<venue>`) behind the `ExchangeAdapter` of
`docs/architecture.md` §5.

## Bybit V5 (M4)

Docs: https://bybit-exchange.github.io/docs/v5/intro

**Auth**
- HMAC (system-generated) or RSA (self-generated public key). Headers `X-BAPI-API-KEY`,
  `X-BAPI-TIMESTAMP`, `X-BAPI-SIGN`, `X-BAPI-RECV-WINDOW` (default 5000); signed string
  `timestamp + apiKey + recvWindow + (queryString | jsonBody)`.
  https://bybit-exchange.github.io/docs/v5/guide
- Permissions are per key and separable. `GET /v5/user/query-api` returns `permissions`
  (`ContractTrade: [Order, Position]`, `Spot: [SpotTrade]`, `Wallet: [… Withdraw]`), `readOnly` and
  `ips` — a trade-only key is possible; `Withdraw` is listed for the master account only.
  https://bybit-exchange.github.io/docs/v5/user/apikey-info
- `deadlineDay` / `expiredAt` apply only to keys with no IP bound (same page); the exact expiry
  length is UNVERIFIED.
- US and mainland-China IPs get 403 (guide URL above).

**Read**
- Balances `GET /v5/account/wallet-balance?accountType=UNIFIED`
  (https://bybit-exchange.github.io/docs/v5/account/wallet-balance); `availableToWithdraw` is
  deprecated for UNIFIED.
- Positions `GET /v5/position/list` (path UNVERIFIED — only `/v5/position/closed-pnl` was
  confirmed); open orders `GET /v5/order/realtime`; fills `GET /v5/execution/list`; closed PnL
  `GET /v5/position/closed-pnl`; funding payments `GET /v5/account/transaction-log` rows with
  `type=SETTLEMENT` (https://bybit-exchange.github.io/docs/v5/account/transaction-log).

**Trade**
- `POST /v5/order/create`, `/amend`, `/cancel`, `/cancel-all`, `/create-batch`, `/amend-batch`,
  `/cancel-batch`. https://bybit-exchange.github.io/docs/v5/order/create-order,
  https://bybit-exchange.github.io/docs/v5/order/cancel-all
- Types `Market` | `Limit`; `timeInForce` `GTC | IOC | FOK | PostOnly`; TP/SL via `takeProfit` /
  `stopLoss` with `tpslMode` `Full | Partial` (limit TP/SL too); conditional via `triggerPrice`,
  `triggerDirection`, `triggerBy`; spot `orderFilter` `Order | tpslOrder | StopOrder`; flags
  `reduceOnly`, `closeOnTrigger`, `slippageToleranceType`.
- Trailing stop sits on the position object, probably set via `/v5/position/trading-stop`
  (UNVERIFIED).
- No close-position endpoint: `qty="0"` + `reduceOnly=true` + `closeOnTrigger=true` closes up to
  `maxMktOrderQty`, or send a plain reduce-only order.
- Cancel-all on `linear`/`inverse` needs one of `symbol`, `baseCoin`, `settleCoin`; at most 500
  orders per call, picked at random.
- Batch limits: spot 10, linear 20, inverse 20, option 5.
  https://bybit-exchange.github.io/docs/v5/order/batch-place

**Streams**
- Private `wss://stream.bybit.com/v5/private`; auth `{"op":"auth","args":[key, expires, sig]}` with
  sig = HMAC of `GET/realtime{expires}`; `{"op":"ping"}` every 20 s.
  https://bybit-exchange.github.io/docs/v5/ws/connect
- Topics `order`, `execution`, `position`, `wallet`, each suffixable `.spot | .linear | .inverse |
  .option` (`position` has no `.spot`).
  https://bybit-exchange.github.io/docs/v5/websocket/private/order,
  https://bybit-exchange.github.io/docs/v5/websocket/private/execution,
  https://bybit-exchange.github.io/docs/v5/websocket/private/position — `wallet` UNVERIFIED.
- WS order entry `wss://stream.bybit.com/v5/trade` (`order.create | amend | cancel` and batch
  variants), with its own `auth` op.
  https://bybit-exchange.github.io/docs/v5/websocket/trade/guideline

**Testnet / demo**
- Testnet `https://api-testnet.bybit.com`,
  `wss://stream-testnet.bybit.com/v5/{public/linear | public/spot | private | trade}`.
- Demo trading `https://api-demo.bybit.com`, `wss://stream-demo.bybit.com` — private streams only,
  no WS Trade. https://bybit-exchange.github.io/docs/v5/demo

**SDK** — community `bybit-api` 4.8.2 (MIT, TS, REST + WS)
https://www.npmjs.com/package/bybit-api; Bybit also lists an official `bybit.js.api`
(https://bybit-exchange.github.io/docs/v5/guide). Not used (`docs/decisions.md`).

**Quirks**
- Every call needs `category` (`spot | linear | inverse | option`); the account is Unified
  (`accountType=UNIFIED`): per-coin balances plus account-wide USD totals, which do not apply to
  isolated margin.
- Hedge mode: `positionIdx` 0 one-way, 1 hedge buy, 2 hedge sell — required in hedge mode; switch
  via `POST /v5/position/switch-mode` (0 merged, 3 both sides), per symbol or per settle coin;
  default one-way. https://bybit-exchange.github.io/docs/v5/position/position-mode
- Spot market-buy `qty` is in quote currency by default (`marketUnit` changes it).
- Order acks are asynchronous — confirm over WS.
- Regional domains differ (`api.bybit.eu`, `.tr`, …).

## Hyperliquid (later)

Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint

**Auth**
- No API keys: every action is wallet-signed (the Python SDK is the signing reference).
- **Agent (API) wallet:** approved by the master wallet via `approveAgent`; it can act "without
  having withdrawal permissions" (https://app.hyperliquid.xyz/API). Limit 1 unnamed + up to 3 named
  (partly UNVERIFIED). Agents are pruned on re-registration, expiry, or when the account has no
  funds — never reuse an agent address.
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
- Info requests use the real account address, not the agent's (same page). Subaccounts and vaults
  have no key: master or agent signs with `vaultAddress`.
- No IP restriction concept documented (UNVERIFIED).

**Read** — `POST https://api.hyperliquid.xyz/info`: `clearinghouseState` (perp balances and
positions, optional `dex`), `spotClearinghouseState`, `openOrders`, `frontendOpenOrders`,
`userFills`, `userFillsByTime`, `orderStatus`, `userFunding`, `userNonFundingLedgerUpdates`,
`meta`, `metaAndAssetCtxs`, `spotMeta`.
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals,
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot,
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint

**Trade** — `POST /exchange` actions `order` (batched `orders[]`), `cancel`, `cancelByCloid`,
`modify`, `batchModify`, `scheduleCancel`, `updateLeverage`.
- Order fields `a` (asset), `b`, `p`, `s`, `r` (reduceOnly), `t`, `c` (cloid); `t` is `limit` with
  tif `Alo | Ioc | Gtc` or `trigger` with `{ isMarket, triggerPx, tpsl: "tp" | "sl" }`; `grouping`
  `na | normalTpsl | positionTpsl`.
- `scheduleCancel` is a dead-man switch: at least 5 s ahead, at most 10 triggers per day.
- `[INFERENCE]` no true market order (IOC limit at an aggressive price), no cancel-all (`openOrders`
  then batched `cancel`), no close-position (reduce-only IOC).
- TWAP exists (`twapStates` subscription); trailing stop via API UNVERIFIED.
- Limits: 1200 weight/min per IP; address limits (1 request per 1 USDC traded, 10k initial buffer);
  1000 open orders by default; max 10 WS connections.
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits

**Streams** — `wss://api.hyperliquid.xyz/ws`, no auth (subscriptions keyed by `user`);
`{"method":"subscribe","subscription":{…}}`; private-relevant types `orderUpdates`, `userFills`,
`userEvents` (channel `"user"`), `userFundings`, `clearinghouseState`, `openOrders`, `spotState`,
`allDexsClearinghouseState`, `webData3`, `userNonFundingLedgerUpdates`; the first message is a
snapshot with `isSnapshot: true`.
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions

**Testnet** — `https://api.hyperliquid-testnet.xyz`, `wss://api.hyperliquid-testnet.xyz/ws`; signed
actions use `hyperliquidChain: "Testnet"`.
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api,
https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket

**SDK** — community `@nktkas/hyperliquid` 0.33.3 (MIT; valibot, decimal.js, @noble/hashes)
https://www.npmjs.com/package/@nktkas/hyperliquid; the official SDK is Python only.

**Quirks**
- Asset index: perp = index into `meta.universe`; spot = `10000 + index` into `spotMeta.universe`;
  HIP-3 builder dexes (`xyz:TSLA`) pass `dex` and are isolated-only.
- Price: at most 5 significant figures and at most `MAX_DECIMALS − szDecimals` decimals (6 perps,
  8 spot); integer prices always valid. Size rounds to `szDecimals`.
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size —
  this is why `PriceRule` has a `sigfig` kind.
- Minimum order $10.
- Nonce: ms timestamp per signer; the 100 highest are kept; must lie in (T − 2 d, T + 1 d) and be
  unused — one agent wallet per process or subaccount plus an atomic counter.
- `f: false` / `a: false` must be omitted from the signed action. Side `B`/`A`; sizes in base
  units; numbers are strings; `szi` is signed; `cloid` is 128-bit hex; HTTP 200 can carry
  per-order `error` statuses.

## Aster (perp DEX, later)

Docs repo: https://github.com/asterdex/api-docs

**Auth**
- V1 (HMAC, `X-MBX-APIKEY`) is legacy; new V1 key creation stopped 2026-03-25. **V3 is
  recommended.** https://github.com/asterdex/api-docs/blob/master/README.md
- V3 is EIP-712 signed by an agent wallet: domain `{ name: "AsterSignTransaction", version: "1",
  chainId: 1666 }`, primary type `Message { msg: string }`; `msg` is the urlencoded params; requests
  carry `user` (main wallet), `signer` (agent), `nonce` (µs timestamp), `signature`.
  https://raw.githubusercontent.com/asterdex/api-docs/master/V3(Recommended)/EN/aster-finance-futures-api-v3.md
  The overview describes it as "Keccak hash, ECDSA" — verify the payload against the example code.
- Agent permissions are separable: `canPerpTrade` and `canWithdraw` are separate booleans, and
  `ipWhitelist` is required when `canWithdraw=true` — a trade-only credential is possible.
- From 2026-09-01 authenticated V3 endpoints reject (`-5050`) until the main wallet has deposited.
  https://raw.githubusercontent.com/asterdex/api-docs/master/CHANGELOG.md

**Read** (futures V3, Binance-style): `GET /fapi/v3/balance`, `/fapi/v3/account`,
`/fapi/v3/positionRisk`, `/fapi/v3/openOrders` (path from memory), `/allOrders`, `/order`,
`/fapi/v3/userTrades`, `/fapi/v3/income`. Spot V3 at `https://sapi.asterdex.com`
(`GET /api/v3/account`, `POST /api/v3/order`).
https://raw.githubusercontent.com/asterdex/api-docs/master/V3(Recommended)/EN/aster-finance-spot-api-v3.md

**Trade**: `POST | PUT | DELETE /fapi/v3/order`, `/fapi/v3/batchOrders` (5 per request),
`DELETE /fapi/v3/allOpenOrders`, `POST /fapi/v3/countdownCancelAll`, `POST /fapi/v3/positionSide/dual`,
`POST /fapi/v3/leverage`, `POST /fapi/v3/noop`, `POST /fapi/v3/chase`. Types `LIMIT, MARKET, STOP,
STOP_MARKET, TAKE_PROFIT, TAKE_PROFIT_MARKET, TRAILING_STOP_MARKET`; TIF `GTC, IOC, FOK, GTX`;
`reduceOnly` not allowed in hedge mode; `closePosition=true` with `*_MARKET` stops; trailing via
`callbackRate` + `activationPrice`; modify LIMIT only; spot does not support FOK (`-1115`).

**Streams**: Binance-style listenKey — `POST | PUT | DELETE /fapi/v3/listenKey`, then
`wss://fstream.asterdex.com/ws/<listenKey>`; key valid 60 min, connection 24 h; `ACCOUNT_UPDATE`
(balances `B`, positions `P`) and `ORDER_TRADE_UPDATE` (`o`); order events are not guaranteed in
order — sort by `E`. Spot WS `wss://sstream.asterdex.com`.

**Testnet**: `https://fapi.asterdex-testnet.com`, `wss://fstream.asterdex-testnet.com` (the doc
also names `fstream5.asterdex-testnet.com`); agents at https://www.asterdex-testnet.com/en/api-wallet.
https://raw.githubusercontent.com/asterdex/api-docs/master/V3(Recommended)/EN/aster-finance-futures-api-testnet.md

**SDK**: no official TS SDK found (UNVERIFIED); sign EIP-712 with viem/ethers.

**Quirks**: schema close to Binance (filters, enums, `positionSide` `BOTH | LONG | SHORT`, HTTP
429/418) but wallet auth with a µs nonce valid ±60 s (last 100 kept per agent), `/fapi/v3` and
`/api/v3` paths, extra `user`/`signer`/`nonce`/`signature` params, extra endpoints (chase, guarded
cancel `DELETE /fapi/v3/guardedCancelOrder`, `/guardedBatchOrders`, builder, noop). A 503 means
unknown, not failed. Base URL conflict: `fapi.asterdex.com` in prose vs `fapi3.asterdex.com` in
code examples — verify.

## Lighter (perp + spot DEX, zk rollup, later)

Docs: https://apidocs.lighter.xyz/docs/get-started

**Auth**
- Orders are signed by an **API key** — a keypair separate from the Ethereum key, custom-signed
  (not EIP-712), registered once via `ChangePubKey` with the L1 wallet signature. Each key is bound
  to one account index; key index 4–254 (0–3 reserved, 255 = "all" for queries).
  https://apidocs.lighter.xyz/docs/api-keys
- An API key can trade, cancel, modify, set leverage and make secure withdrawals to the owner's own
  L1 address; fast withdrawals or transfers to another L1 owner need an L1 signature — it can trade
  but not drain funds. Read-only tokens (`ro:…`) exist.
- Auth tokens last up to 8 h (`Authorization` header or WS `"auth"`). No IP whitelist documented
  (UNVERIFIED).

**Read** (`/api/v1/…`, https://apidocs.lighter.xyz/llms.txt): `account?by=index&value=` (public),
`accountActiveOrders`, `accountInactiveOrders`, `accountOrders` (auth), `trades`,
`positionFunding`, `export`, `pnl`, `orderBookDetails`, `orderBooks`, `nextNonce`,
`accountLimits`.

**Trade** — signed transactions via `POST /api/v1/sendTx` / `sendTxBatch` (batch 50; the WS doc
says 15 — verify). https://apidocs.lighter.xyz/docs/trading
- Tx types: create, modify (`SignModifyOrder`), cancel, `SignCancelAllOrders`, `SignUpdateLeverage`,
  `SignCreateGroupedOrders`.
- Order types limit(0), market(1), stop-loss(2), stop-loss-limit(3), take-profit(4),
  take-profit-limit(5), TWAP(6); TIF IOC(0), GTT(1), post-only(2); `reduceOnly`; OTO/OCO/OTOCO;
  self-trade modes.
- Cancel-all modes: immediate(0), scheduled(1), abort(2); market index 255 = all markets.
- Trailing stop not seen (UNVERIFIED). `[INFERENCE]` close position = reduce-only market order.
- Taker `price` is the worst acceptable price; `code: 200` means accepted, not executed.

**Streams** — `wss://mainnet.zklighter.elliot.ai/stream`; subscribe
`{"type":"subscribe","channel":"<ch>/<account>","auth":"<token>"}`; channels `account_all`,
`account_all_orders`, `account_all_positions`, `account_all_trades`, `account_all_assets`,
`account_orders/{market}/{acct}`, `account_market`, `account_stats`, `account_tx`, `notification`;
ping (`{"type":"ping"}`) or any message every 2 min; transactions can also go over WS
(`jsonapi/sendtx`). https://apidocs.lighter.xyz/docs/websocket-reference

**Testnet** — `https://testnet.zklighter.elliot.ai`, `wss://testnet.zklighter.elliot.ai/stream`;
chain ID 300 (testnet) vs 304 (mainnet); a wrong chain ID is rejected.
https://apidocs.lighter.xyz/docs/environments

**SDK** — the official signer is Go (`elliottech/lighter-go`); TypeScript must load a WASM signer
built with `GOOS=js GOARCH=wasm go build` plus the matching `wasm_exec.js` (Node 22+, Go 1.23+);
pass an empty URL to `CreateClient` so the WASM does no networking.
https://apidocs.lighter.xyz/docs/quickstart-typescript. `elliottech/lighter-ts` is a UI-free state
store and WS pipeline, not a trading client. https://github.com/elliottech/lighter-ts

**Quirks** (https://apidocs.lighter.xyz/docs/core-concepts)
- Account index is an integer: master accounts count up from 0, sub-accounts and pools down from
  2^48 − 2. API key index 4–254.
- Nonce per API key, strictly +1 unless `SkipNonce=1`; some rejections consume the nonce, some do
  not — never blindly re-sign after an unknown outcome; use `nextNonce`.
- Transactions queue per key behind a "speed bump" (Standard tier: taker 300 ms, post-only 0 ms) —
  one key per workload.
- Prices and sizes are integers scaled by `price_decimals` / `size_decimals` from
  `orderBookDetails`. `clientOrderIndex` is uint48, unique across markets. Expiry 5 min – 30 days
  in ms, 0 for IOC.
- A sequencer-rejected order can still return code 200. Restricted regions get read-only WS via
  `?readonly=true`.

## Adapter-interface synthesis

How these venues shape the single `ExchangeAdapter` (`docs/architecture.md` §5):

1. **Credential kinds** — a discriminated union: `hmac` (Binance, Bybit, Aster V1), `ed25519`
   (Binance), `rsa` (Bybit), `evm_agent { user, signer, privateKey }` (Hyperliquid agent wallet with
   optional `vaultAddress`; Aster V3 EIP-712), `zk_api_key { accountIndex, apiKeyIndex, privateKey,
   chainId }` (Lighter), and possibly a read-only token (Lighter `ro:`). Withdraw-capable
   credentials are refused wherever the venue reports permissions (Binance `apiRestrictions`, Bybit
   `/v5/user/query-api`); agent-wallet and API-key venues are trade-only by construction.
2. **Instrument metadata** — `PriceRule` / `QtyRule` as data: Binance and Aster use
   `PRICE_FILTER` / `LOT_SIZE` / `MIN_NOTIONAL` (tick); Hyperliquid uses significant figures
   (`sigfig`); Lighter uses integer scaling (decimals → tick and step). Venue-specific references
   (Bybit `category`, Hyperliquid asset index + `szDecimals`, Lighter `market_id`) stay inside the
   venue package.
3. **Order model** — normalized status set new / partially filled / filled / canceled / rejected /
   expired / triggered; `venueOrderId` is opaque. Client ids differ: Binance, Bybit and Aster 36
   chars; Hyperliquid 128-bit hex `cloid`; Lighter uint48 — `clientOrderId` generation becomes
   per-adapter when the second id format arrives. Batches can partially succeed (Hyperliquid, Bybit,
   Aster), so results are per order. An accepted ack is not execution (Lighter, Bybit async, Aster
   503) — hence `OrderAck` plus `queryOrder` reconciliation.
4. **Position model** — size, entry, mark, liquidation, uPnL, leverage, margin mode,
   `positionSide`. Binance and Bybit have hedge mode (Bybit per symbol or settle coin); Hyperliquid
   and Lighter are net-only. The adapter routes `positionIdx` / `positionSide` and rejects
   reduce-only where hedge mode forbids it.
5. **Balance model** — Bybit UTA is per-coin plus account-wide equity; Hyperliquid has separate perp
   and spot clearinghouses (plus HIP-3 dexes); Lighter has per-account collateral plus spot assets.
   Hence `Balance.scope: 'spot' | 'derivs' | 'unified'`.
6. **Streaming model** — `onOrder`, `onFill`, `onPosition`, `onBalance` (funding payments arrive as
   balance changes until a dedicated handler is needed). Close-all and cancel-all are built from
   REST/stream state plus per-order cancels where the venue lacks them, driven by
   `KindCapabilities`.
