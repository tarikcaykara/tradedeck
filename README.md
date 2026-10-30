# tradedeck

Local-first, open-source multi-exchange trading terminal: monitor spot balances and futures
positions and trade from one screen. Binance first; more CEXes and perp DEXes behind the same
adapter interface.

**Status:** M1 in progress — workspace, tooling, the core domain model, the venue adapter
interface with its signed REST and WebSocket transport, and the Binance adapter (instruments,
credential check, account snapshot, private user-data streams with resync); nothing user-facing
runs yet.

## Safety model

- **Keys stay local.** API keys live only in the local server process and the OS keychain. They
  are entered through a CLI hidden prompt — never through the browser — and are never written to
  the database, logs or files.
- **Withdraw-enabled keys are refused.** A key whose exchange reports withdrawal permission is
  rejected when it is added.
- **Demo first.** Trading ships against Binance Demo before any real-money account can place an
  order.
- **Live trading is opt-in per account.** It is enabled only from the CLI, per account, with a
  typed confirmation — never from the UI.
- **Loopback only.** The server binds `127.0.0.1` and rejects requests whose `Host` or `Origin` is
  not local.

## Documentation

- [Architecture](docs/architecture.md) — processes, packages, domain model, adapter interface.
- [Milestones](docs/milestones.md) — M1 read-only monitor → M2 Demo trading → M3 live trading → M4
  Bybit.
- [Decisions](docs/decisions.md) — why things are the way they are.
- Venue notes: [Binance](docs/venues/binance.md), [upcoming venues](docs/venues/upcoming.md).

## License

[MIT](LICENSE)
