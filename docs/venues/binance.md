# Binance — spot + USDⓈ-M futures

Researched 2026-10-20. Every fact carries a source; `[INFERENCE]` marks a conclusion no doc states
directly. Re-check the **Watch list** and **Unverified** sections before each milestone that
touches this adapter.

Source shorthands: `[SC]` = spot changelog
https://developers.binance.com/en/docs/products/spot/CHANGELOG, `[FC]` = USDⓈ-M changelog
https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/change-log,
`[SDK]` = official connector https://github.com/binance/binance-connector-js (used as a source of
endpoint paths, weights and doc links only — tradedeck does not depend on it).

## Keys & permissions

- **Key types:** Ed25519 is recommended, HMAC is "deprecated", RSA (2048/4096, PKCS#1 v1.5 only)
  is supported and slower.
  https://developers.binance.com/en/docs/products/spot/faqs/api_key_types,
  https://developers.binance.com/en/docs/products/spot/testnet/general-info
- **Default permission is read-only** ("Enable Reading"); trading and futures are switched on in the
  UI; withdrawals only via the UI.
  https://developers.binance.com/en/docs/products/spot/rest-api,
  https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/quick-start
- The Futures permission cannot be enabled on a key created before the futures account existed, or
  after Portfolio Margin activation. https://www.binance.com/en/support/faq/detail/360002502072
- **IP restriction** (same FAQ):
  - unrestricted system-generated (HMAC) keys are read-only since 2023-01-30, so trading on HMAC
    needs an IPv4 whitelist;
  - self-generated Ed25519/RSA keys may enable other permissions without an IP restriction;
  - withdrawals always require an IP whitelist.
- **Permission check (verified 2026-10-20):** `GET /sapi/v1/account/apiRestrictions`
  ("Get API Key Permission", USER_DATA, weight 1). Response fields: `ipRestrict`, `createTime`,
  `enableReading`, `enableWithdrawals`, `enableInternalTransfer`, `enableMargin`, `enableFutures`,
  `permitsUniversalTransfer`, `enableVanillaOptions`, `enableFixApiTrade`, `enableFixReadOnly`,
  `enableSpotAndMarginTrading`, `enablePortfolioMarginTrading`.
  https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account#get-api-key-permission
  (fields from `[SDK]` `clients/wallet/src/rest-api/types/get-api-key-permission-response.ts`).
  `CredentialReport` mapping: `docs/architecture.md` §5.
- **Key expiry:** unverified — see Unverified.

## Signing

Source: https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md, "SIGNED Endpoint
Examples for POST /api/v3/order" (verified 2026-10-23). Implemented by the adapter transport
(`docs/architecture.md` §5, Transport).

- **Payload:** the query string concatenated with the request body, with every non-ASCII character
  percent-encoded before signing. tradedeck sends every parameter in the query and no body, so the
  payload is the transmitted query up to `&signature=`. The API key goes in the `X-MBX-APIKEY`
  header.
- **Encodings:** HMAC-SHA256 → hex. Ed25519 → base64, sent percent-encoded as the `signature`
  value (`+` → `%2B`, `/` → `%2F`, `=` → `%3D`).
- **Test vectors:** both HMAC examples of the doc (the ASCII `LTCBTC` request → `c8db5682…6b71`
  and the non-ASCII `１２３４５６` request → `e1353ec6…3ef3`) reproduce byte for byte in
  `packages/adapter/test/rest.test.ts`. The doc's Ed25519 example signature decodes to 256 bytes —
  the size of an RSA-2048 signature; an Ed25519 signature is 64 bytes — and its private key is not
  published, so RFC 8032 §7.1 TEST 2 is the Ed25519 vector instead.
- **Rate-limit responses:** 429 and 418 carry a `Retry-After` header in **seconds**; error bodies
  are `{ "code": <int>, "msg": <string> }` (same doc, "LIMITS" and "Error Codes").

## Environments

| Environment | Spot REST | Spot WS API | Spot market streams | USDⓈ-M REST | USDⓈ-M streams |
|---|---|---|---|---|---|
| `live` | `https://api.binance.com` | `wss://ws-api.binance.com:443/ws-api/v3` | `wss://stream.binance.com:9443` | `https://fapi.binance.com` | `wss://fstream.binance.com` — private `/private/ws/<listenKey>`, market under `/market` and `/public` |
| `demo` | `https://demo-api.binance.com` | `wss://demo-ws-api.binance.com/ws-api/v3` | `wss://demo-stream.binance.com` | `https://demo-fapi.binance.com` | `wss://demo-fstream.binance.com` |

- Spot Demo Mode: keys from the Demo Trading section
  (https://demo.binance.com/en/my/settings/api-management); prices and filters mirror live; the
  docs list only `/api` REST hosts.
  https://developers.binance.com/en/docs/products/spot/demo-mode/general-info
- USDⓈ-M: the docs' testnet is now Demo Trading (`demo-fapi` / `demo-fstream`); keys are created
  on demo.binance.com and are "only available via the API".
  https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info,
  https://www.binance.com/en-TR/support/faq/detail/ab78f9a1b8824cf0a106b4229c76496d
  **Demo is authoritative for futures.**
- Spot testnet (not used by tradedeck, listed for completeness): `https://testnet.binance.vision/api`,
  `wss://ws-api.testnet.binance.vision/ws-api/v3`, `wss://stream.testnet.binance.vision`; keys via
  GitHub login; data reset about monthly; only `/api`.
  https://developers.binance.com/en/docs/products/spot/testnet/general-info
- Live USDⓈ-M private/market split:
  https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Important-WebSocket-Change-Notice
- Live spot WS API host:
  https://developers.binance.com/en/docs/products/margin-trading/listen-token-data-stream

## Endpoints

Weights are request weight on the IP limit unless the cell says otherwise; values from the linked
doc via `[SDK]` doc comments, read 2026-10-20. Since 2026-04-02 successful spot order
place/cancel/cancelReplace/amend calls cost weight 0 `[SC]`. Futures order endpoints cost 0 on IP
and count against the 10 s and 1 min order counters `[FC]`.

| Purpose | Method + path | Weight | Milestone | Source |
|---|---|---|---|---|
| Key permissions → `verifyCredential` | `GET /sapi/v1/account/apiRestrictions` | 1 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account#get-api-key-permission |
| Spot server time (signing offset) | `GET /api/v3/time` | 1 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/general#time |
| Futures server time | `GET /fapi/v1/time` | 1 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#check-server-time |
| Spot instruments + filters | `GET /api/v3/exchangeInfo` | 20 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/general#exchange-info |
| Futures instruments + filters | `GET /fapi/v1/exchangeInfo` | 1 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#exchange-information |
| Futures max leverage (bracket 1 `initialLeverage`) | `GET /fapi/v1/leverageBracket` | 1 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account#notional-and-leverage-brackets |
| Spot balances (`omitZeroBalances`) | `GET /api/v3/account` | 20 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account#get-account |
| Spot open orders | `GET /api/v3/openOrders` | 6 per symbol; 80 without symbol | M1 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account#get-open-orders |
| Spot trades → fills ledger | `GET /api/v3/myTrades` | 20; 5 with `orderId` | M1 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account#my-trades |
| Futures account | `GET /fapi/v3/account` | 5 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account#account-information-v3 |
| Futures balances | `GET /fapi/v3/balance` | 5 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account#futures-account-balance-v3 |
| Futures positions | `GET /fapi/v3/positionRisk` | 5 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#position-information-v3 |
| Futures per-symbol config (leverage, margin type) | `GET /fapi/v1/symbolConfig` | 5 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account#symbol-configuration |
| Futures account config | `GET /fapi/v1/accountConfig` | 5 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account#futures-account-configuration |
| Futures position mode (one-way / hedge) | `GET /fapi/v1/positionSide/dual` | 30 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account#get-current-position-mode |
| Futures open orders | `GET /fapi/v1/openOrders` | 1 per symbol; 40 without symbol | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#current-all-open-orders |
| Futures open conditional (algo) orders | `GET /fapi/v1/openAlgoOrders` | 1 per symbol; 40 without symbol | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#current-all-algo-open-orders |
| Futures trades (last 3 months) | `GET /fapi/v1/userTrades` | 5 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#account-trade-list |
| Futures income (last 3 months; `page` removed) | `GET /fapi/v1/income` | 30 | not planned | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account#get-income-history |
| Futures user-data listenKey: start | `POST /fapi/v1/listenKey` | 1 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/user-data-streams#start-user-data-stream |
| Futures listenKey keepalive | `PUT /fapi/v1/listenKey` | 1 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/user-data-streams#keepalive-user-data-stream |
| Futures listenKey close | `DELETE /fapi/v1/listenKey` | 1 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/user-data-streams#close-user-data-stream |
| Spot user-data subscription (WS API) | `userDataStream.subscribe.signature` | 2 | M1 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/ws-api/user-data-stream#user-data-stream-subscribe-signature |
| Spot place order | `POST /api/v3/order` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade#new-order |
| Spot cancel order | `DELETE /api/v3/order` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade#delete-order |
| Spot cancel all on a symbol | `DELETE /api/v3/openOrders` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade#delete-open-orders |
| Spot query order (`queryOrder`) | `GET /api/v3/order` | 4 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account#get-order |
| Spot amend — quantity down only | `PUT /api/v3/order/amend/keepPriority` | 4 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade#order-amend-keep-priority |
| Spot amend — price change | `POST /api/v3/order/cancelReplace` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade#order-cancel-replace |
| Spot fee rate | `GET /api/v3/account/commission` | 20 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account#account-commission |
| Futures place order (LIMIT/MARKET only) | `POST /fapi/v1/order` | 1 on order counters | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#new-order |
| Futures batch place (max 5) | `POST /fapi/v1/batchOrders` | 5 on 10 s order counter | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#place-multiple-orders |
| Futures modify LIMIT order | `PUT /fapi/v1/order` | 1 on 10 s order counter | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#modify-order |
| Futures batch modify (max 5) | `PUT /fapi/v1/batchOrders` | 5 on 10 s order counter | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#modify-multiple-orders |
| Futures cancel order | `DELETE /fapi/v1/order` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#cancel-order |
| Futures batch cancel (max 5) | `DELETE /fapi/v1/batchOrders` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#cancel-multiple-orders |
| Futures cancel all on a symbol | `DELETE /fapi/v1/allOpenOrders` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#cancel-all-open-orders |
| Futures query order (`queryOrder`) | `GET /fapi/v1/order` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#query-order |
| Futures TP/SL place (Algo API) | `POST /fapi/v1/algoOrder` | 1 on 10 s order counter | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#new-algo-order |
| Futures TP/SL cancel | `DELETE /fapi/v1/algoOrder` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#cancel-algo-order |
| Futures TP/SL query | `GET /fapi/v1/algoOrder` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#query-algo-order |
| Futures cancel all TP/SL on a symbol | `DELETE /fapi/v1/algoOpenOrders` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#cancel-all-algo-open-orders |
| Futures set leverage | `POST /fapi/v1/leverage` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#change-initial-leverage |
| Futures set margin type | `POST /fapi/v1/marginType` | 1 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#change-margin-type |
| Futures fee rate | `GET /fapi/v1/commissionRate` | 20 | M2 | https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account#user-commission-rate |

Futures v3 `account`/`balance`/`positionRisk` return only symbols with a position or open order;
the config fields moved to `symbolConfig`/`accountConfig`. The v2 versions were announced
deprecated on 2024-07-24 with no date `[FC]`.

## Private streams

**Spot** — WS API `userDataStream.subscribe.signature` on the spot WS API host (`live`
`wss://ws-api.binance.com:443/ws-api/v3`, `demo` `wss://demo-ws-api.binance.com/ws-api/v3`).
- Works without `session.logon` and with any key type, HMAC included `[SC]`.
- Events carry `subscriptionId`; one session may hold several subscriptions;
  `userDataStream.unsubscribe` takes a `subscriptionId` `[SC]`. `session.logout` does not close
  `subscribe.signature` subscriptions (`[SDK]` `clients/spot/src/websocket-api/modules/user-data-stream-api.ts`).
- Events: `executionReport`, `outboundAccountPosition`, `balanceUpdate`, `listStatus`,
  `listenKeyExpired`, `serverShutdown`; `outboundAccountInfo` is deprecated.
  https://developers.binance.com/en/docs/products/spot/user-data-stream, `[SC]`
- Alternatives not chosen: `userDataStream.subscribe` after `session.logon` (Ed25519 only) `[SC]`;
  listen token `POST /sapi/v1/userListenToken` + `userDataStream.subscribe.listenToken`, token valid
  24 h, documented under Margin
  https://developers.binance.com/en/docs/products/margin-trading/listen-token-data-stream.
- Deprecated: REST `POST/PUT/DELETE /api/v3/userDataStream` and WS `userDataStream.start/ping/stop`
  (announced 2025-04-07, no removal date); `/api/v1/userDataStream` retired 2026-03-25 `[SC]`.

**USDⓈ-M futures** — REST listenKey, then `wss://fstream.binance.com/private/ws/<listenKey>`.
- `POST /fapi/v1/listenKey` creates; a key is valid 60 min; `PUT` extends it; error `-1125` means
  create a new one; a connection lives at most 24 h — reconnect before that.
  https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/user-data-streams
- Legacy `wss://fstream.binance.com/ws` and `/stream` were to be decommissioned 2026-04-23; market
  data lives under `/market` and `/public`.
  https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Important-WebSocket-Change-Notice
- Events: `ACCOUNT_UPDATE` (the `a` object carries `S` for funding-fee events since 2026-08-07),
  `ORDER_TRADE_UPDATE` (execution type `AMENDMENT` exists), `TRADE_LITE`, `ACCOUNT_CONFIG_UPDATE`,
  `MARGIN_CALL`, `STRATEGY_UPDATE`, `ALGO_UPDATE`, `listenKeyExpired`.
  `CONDITIONAL_ORDER_TRIGGER_REJECT` is deprecated since 2025-12-15 `[FC]`.
- Sequence events across types by the `E` field (event time).

## Order rules

- **Spot order types:** `LIMIT`, `MARKET`, `LIMIT_MAKER` (post-only), `STOP_LOSS`,
  `STOP_LOSS_LIMIT`, `TAKE_PROFIT`, `TAKE_PROFIT_LIMIT`; `trailingDelta` and pegged orders
  (`pegPriceType`) are supported (`[SDK]` `clients/spot/src/rest-api/modules/trade-api.ts`).
  OCO is `POST /api/v3/orderList/oco` (the older `/api/v3/order/oco` is deprecated); OTO, OTOCO,
  OPO, OPOCO also exist; cancel with `DELETE /api/v3/orderList` `[SC]`.
- **Spot amend:** `PUT /api/v3/order/amend/keepPriority` only reduces quantity (`0 < newQty <
  qty`). `POST /api/v3/order/cancelReplace` takes `cancelReplaceMode` `STOP_ON_FAILURE` or
  `ALLOW_FAILURE` and returns HTTP 409 on partial success.
  https://developers.binance.com/en/docs/products/spot/rest-api
- **Futures conditional orders moved to the Algo Service effective 2025-12-09** (`[FC]` 2025-11-10
  entry): `STOP`, `STOP_MARKET`, `TAKE_PROFIT`, `TAKE_PROFIT_MARKET`, `TRAILING_STOP_MARKET` go
  through `/fapi/v1/algoOrder`; `POST /fapi/v1/order` and `/batchOrders` reject them with `-4120`
  (`STOP_ORDER_SWITCH_ALGO`). No margin check before trigger; **untriggered algo orders cannot be
  modified**. Algo orders carry `clientAlgoId` and `closePosition`. At most 200 conditional orders
  across all symbols; the `MAX_NUM_ALGO_ORDERS` filter was removed from `exchangeInfo` on
  2025-12-29 `[FC]`.
- **Futures modify:** `PUT /fapi/v1/order`, `LIMIT` only; both `quantity` and `price` (or
  `priceMatch`) are required; `reduceOnly` there only feeds min-notional validation; fewer than
  10000 modifications per order; batch modify max 5 (`[SDK]`
  `clients/derivatives-trading-usds-futures/src/rest-api/modules/trade-api.ts`).
- **Futures flags:** `reduceOnly` cannot be sent in hedge mode; `positionSide` is `BOTH` in one-way
  mode and `LONG`/`SHORT` (required) in hedge mode; `closePosition=true` is valid only with
  `STOP_MARKET`/`TAKE_PROFIT_MARKET`, cannot be combined with `quantity` or `reduceOnly`, and
  closes the whole position on trigger. Batch place/cancel max 5. Leverage maximum is
  symbol-specific: bracket 1's `initialLeverage` (`[FC]` 2026-10-09).
- **No close-all endpoint.** `[INFERENCE]` close each position with a reduce-only `MARKET` order (hedge
  mode: `LONG` + `SELL` / `SHORT` + `BUY`). Orders with `closePosition=true`, one-way
  `reduceOnly=true`, or hedge `LONG`+`SELL` / `SHORT`+`BUY` are exempt from the `-1008` overload
  throttle.
  https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info
- **Domain type mapping** `[INFERENCE]` (confirmed against recordings in M1 issue 6):

  | Domain `Order.type` | Spot | USDⓈ-M |
  |---|---|---|
  | `market` | `MARKET` | `MARKET` |
  | `limit` | `LIMIT`; `LIMIT_MAKER` → `limit` + `post_only` | `LIMIT` |
  | `stop_market` | `STOP_LOSS` | `STOP_MARKET` (algo) |
  | `stop_limit` | `STOP_LOSS_LIMIT` | `STOP` (algo) |
  | `take_profit_market` | `TAKE_PROFIT` | `TAKE_PROFIT_MARKET` (algo) |
  | `take_profit_limit` | `TAKE_PROFIT_LIMIT` | `TAKE_PROFIT` (algo) |
  | `trailing_stop_market` | — (`trailingDelta` on stop types) | `TRAILING_STOP_MARKET` (algo) |

## Filters

- **Spot** (https://developers.binance.com/en/docs/products/spot/filters): `PRICE_FILTER`
  (`minPrice`, `maxPrice`, `tickSize`); `LOT_SIZE` and `MARKET_LOT_SIZE` (`minQty`, `maxQty`,
  `stepSize`); `NOTIONAL` (`minNotional`, `maxNotional`, `applyMinToMarket`, `applyMaxToMarket`);
  `MIN_NOTIONAL` (`applyToMarket`); `PERCENT_PRICE`, `PERCENT_PRICE_BY_SIDE`; also
  `MAX_NUM_ORDERS`, `MAX_NUM_ALGO_ORDERS`, `MAX_POSITION`, `TRAILING_DELTA`. Since 2026-05-08 the
  percent-price and notional filters use the reference price when one exists `[SC]`.
- **USDⓈ-M**
  (https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/common-definition):
  `PRICE_FILTER`, `LOT_SIZE`, `MARKET_LOT_SIZE`; `MIN_NOTIONAL` has a single `notional` field and
  uses mark price for market orders; `PERCENT_PRICE` is relative to mark price; `MAX_NUM_ORDERS`.
  The futures lot-size rule is `(qty − minQty) % stepSize`, the spot rule `qty % stepSize`.
- **Mapping to `Instrument`:** `priceRule = { kind: 'tick', tick: PRICE_FILTER.tickSize }`;
  `qtyRule.step = LOT_SIZE.stepSize`, `qtyRule.marketStep = MARKET_LOT_SIZE.stepSize`,
  `qtyRule.minQty = LOT_SIZE.minQty`; `minNotional` = spot `NOTIONAL.minNotional` (or
  `MIN_NOTIONAL`), futures `MIN_NOTIONAL.notional`.

## Rate limits & idempotency

- **Futures:** 2400 weight/min per IP; orders 1200/min and 300 per 10 s per UID; the `rateLimits`
  array in `exchangeInfo` is authoritative. WS API and REST share the order limit and the IP
  weight for order endpoints only; a WS handshake costs 5 weight.
  https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-api-general-info
- **Spot:** since 2026-04-02 successful order place/cancel/cancelReplace/order-list/amend calls
  have weight 0, and `RAW_REQUESTS` is 300,000 per 5 min `[SC]`. The per-minute `REQUEST_WEIGHT`
  value is read from `/api/v3/exchangeInfo`.
- **Bans:** limits are per IP, not per key; HTTP 418 bans escalate from 2 minutes to 3 days.
- **`recvWindow`:** default 5000 ms; spot maximum 60000; futures docs recommend ≤ 5000. Rule:
  `timestamp < serverTime + 1000 && serverTime − timestamp ≤ recvWindow`. Keep a server-time
  offset from the time endpoints.
- **Idempotency:** `newClientOrderId` on spot and futures; futures pattern
  `^[\.A-Z\:/a-z0-9_-]{1,36}$`, unique among open orders. On an unknown outcome (spot 5xx /
  `-1007`, futures 503 "Unknown error") **never retry blindly** — query by `clientOrderId` or wait
  for the user-data event. https://developers.binance.com/en/docs/products/spot/rest-api,
  https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info

## Watch list

Dated changes that already shape — or may break — this adapter:

| Date | Change | Source |
|---|---|---|
| 2024-07-24 | Futures v2 `account`/`balance`/`positionRisk` deprecated, no date; use v3 | `[FC]` |
| 2025-04-07 | Spot REST listenKey user-data deprecated; use the WS API | `[SC]` |
| 2025-12-09 | Futures conditional orders moved to the Algo API; `-4120` on `/fapi/v1/order` | `[FC]` |
| 2025-12-15 | `CONDITIONAL_ORDER_TRIGGER_REJECT` deprecated | `[FC]` |
| 2025-12-29 | `MAX_NUM_ALGO_ORDERS` removed from futures `exchangeInfo` | `[FC]` |
| 2026-03-25 | `/api/v1/userDataStream` retired | `[SC]` |
| 2026-04-02 | Successful spot order calls weight 0 | `[SC]` |
| 2026-04-23 | Legacy futures `wss://fstream.binance.com/ws` and `/stream` removal | https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Important-WebSocket-Change-Notice |
| 2026-05-08 | Spot percent-price and notional filters use the reference price | `[SC]` |
| 2026-06-30 | COIN-M ↔ UM architecture integration effective | https://developers.binance.com/legacy-docs/derivatives |
| 2026-08-07 | `ACCOUNT_UPDATE.a.S` for funding-fee events | `[FC]` |
| 2026-08-25 | `GET /fapi/v1/allOrders` `symbol` optional | `[FC]` |
| 2026-08-26 | `GET /fapi/v1/userTrades` limited to the last 3 months (was 6) | `[FC]` |
| 2026-09-10 | New income type `SPECIAL_FUNDING_FEE` | `[FC]` |
| 2026-10-09 | Max leverage = bracket 1 `initialLeverage` | `[FC]` |
| 2026-10-16 | `GET /fapi/v1/income` `page` param removed; use `startTime`/`endTime` | `[FC]` |

## Unverified

Carried from research; each item names where it gets settled.

- **Key expiry/deletion:** a Binance blog says a non-whitelisted key inactive for 30 days is
  deleted (https://www.binance.com/en/blog/security/8638066848800196896); a third-party blog says
  90 days; the 2021 validity-period announcement was marked no longer applicable on 2023-10-24
  (https://www.binance.com/en/support/announcement/detail/11e4c2f44e7a47b9b5fc0e479c0b256f).
  `doctor` (M1 issue 13) surfaces a failing credential either way.
- **Demo + `/sapi`:** the Demo docs list only `/api` hosts; whether
  `/sapi/v1/account/apiRestrictions` works on Demo is unknown — M1 issue 6.
- **Demo + self-generated Ed25519 keys:** unknown; if refused, M1 issue 9 keeps `--kind hmac` for
  Demo accounts and this file records it.
- **Demo futures stream paths:** whether `demo-fstream` uses the same `/private/ws/<listenKey>`
  path and `/market` / `/public` split as live — M1 issues 7 and 8.
- **Futures mark-price stream path** under `/market` — M1 issue 8.
- **`testnet.binancefuture.com`:** still referenced by the futures WS API doc and the SDK README;
  whether it accepts traffic is unknown. Not used — Demo is authoritative.
- **Spot `REQUEST_WEIGHT` per minute:** read from `/api/v3/exchangeInfo` at runtime.
- **`enableInternalTransfer` / `permitsUniversalTransfer`:** whether either lets funds leave the
  owner's accounts; M1 issue 9 decides whether they are refused like withdrawals.
- **`MARKET_LOT_SIZE.stepSize` of `0`:** whether it occurs, and if so whether `marketStep` falls
  back to `LOT_SIZE.stepSize` — M1 issue 6.
- **Commission endpoint response fields** (spot and futures) — M2.
- **Removal date** of the deprecated spot REST listenKey endpoints — none announced.
