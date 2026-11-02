# Phantom FX

A multi-user forex trading platform built with Next.js, TypeScript and Prisma.

Every client gets a **demo account** (virtual $10,000) and a **live account** (funded through admin-approved deposits).

## Features

- **Trading terminal**: FX prices for 10 major pairs, from **two feeds running at once** — a tick-level simulated tape with session volatility and correlated crosses for demo accounts, a real provider (Yahoo Finance, or Twelve Data with a key) for live accounts; candlestick charts (1m–1d) per feed, market/limit/stop orders, stop loss / take profit, leverage from 1:10 to 1:500, margin, free margin, equity and margin level
- **Risk engine**: fills pending orders, triggers SL/TP, auto stop-out at a 50% margin level (worst position closed first), negative balance protection
- **Wallet**: deposit and withdrawal requests (M-Pesa, bank transfer, card, USDT) with a full transaction ledger
- **History**: closed trades, order history, ledger, win rate
- **Admin panel**: approve/reject deposits and withdrawals, manage clients (suspend, adjust balance), monitor open positions and house exposure, force-close positions, edit spreads/commission/lot limits, audit log

## Quick start

Requirements: Node.js 20+.

```bash
npm install
cp .env.example .env      # then set AUTH_SECRET and ADMIN_PASSWORD
npm run setup             # creates the SQLite DB, seeds instruments + admin user
npm run dev               # http://localhost:3000
```

Sign in as the admin with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`, or register a new client at `/register`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build / server |
| `npm test` | Unit tests (trading math) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run setup` | `prisma db push` + seed |

## Configuration

See `.env.example`. Key settings:

- `DEMO_FEED` / `LIVE_FEED`: **two feeds run at the same time.** Demo accounts are priced by one (default `simulated`), live accounts by a real provider (default `yahoo`; `twelvedata` needs a key). The slot that answers is chosen by the account's type, resolved server-side from the database — a query parameter can never select a feed, and the display path never prices a trade. `DEMO_WIN_RATE` (e.g. `0.6`) only steers the demo slot's own tape so about 60 % of demo trades reach take-profit; it selects no provider and the live slot cannot be steered at all (a steering call on it throws).
- `PRICE_FEED`: **legacy.** It is only a per-slot default for slots that do not set `DEMO_FEED`/`LIVE_FEED`, and it logs a deprecation warning. It does **not** merge the two slots any more.
- `LIVE_FEED_ON_FAILURE` / `LIVE_ALLOW_SIMULATED`: what a live slot does when its provider dies. Default is `pause` — nothing trades and the UI says why; held SL/TP, stop-out **and a client's own close** still run in the intermediate `degraded` state. A live slot shows simulated marks only if you set `LIVE_ALLOW_SIMULATED=true` (or inherit them from `PRICE_FEED=simulated`): that slot boots `running` and does take orders — deliberately, loudly marked `simulatedMarks: true`, never quietly. A slot that *fell back* after a provider failure is held at `degraded`.
- `ENFORCE_MARKET_HOURS`: reject orders while the FX market is closed (Sun 22:00 – Fri 22:00 UTC). Applies to real-provider slots; the simulated tape has no session. `false` does **not** make prices move over a weekend — Yahoo keeps quoting Friday's close, so the live chart goes flat. Market-age staleness independent of this switch is the one open money-path gap (A-10, `DUAL_FEED_GUIDE.md` §4 step 7).
- `DEMO_BALANCE`: starting balance for demo accounts.

Full operator guide: **[`DUAL_FEED_GUIDE.md`](DUAL_FEED_GUIDE.md)** (env contract, feed states, how to
verify the two tapes, the Twelve Data free-tier arithmetic). Architecture and rationale:
**[`DUAL_FEED_DESIGN.md`](DUAL_FEED_DESIGN.md)**.

## Production notes

This is a working trading platform, but it is **not ready to take real client money yet**:

- **Execution**: the platform is the counterparty for all trades (B-book). Hedging to a liquidity provider (e.g. via FIX/bridge) is not implemented.
- **Payments**: deposits/withdrawals are manual requests that an admin approves. No payment gateway (M-Pesa Daraja, Stripe, etc.) is connected yet.
- **Compliance**: you need a forex broker license (e.g. CMA in Kenya), KYC/AML checks and segregated client funds before you can accept real deposits.
- **Infrastructure**: use Postgres (change the `provider` in `prisma/schema.prisma`) and run a **single** app instance. The price feed, trading engine and account locks run in memory, inside one process.
- **Market data**: Yahoo Finance is unofficial and rate-limited. Use a licensed feed for production.
- **Accounts**: there is no email verification, password reset or 2FA yet.
