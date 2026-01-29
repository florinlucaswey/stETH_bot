# TradingBot (Lido stETH Strategy)

Bot-controlled wallet strategy that stakes ETH into Lido when stETH trades at a discount, and requests/claims withdrawals when stETH trades at a premium. The dashboard is read-only + config; it never holds keys.

## What it does

- Reads stETH/WETH price from the Uniswap v3 pool.
- If discount > threshold: stake available ETH into stETH.
- If premium > threshold: request withdrawal of all stETH via Lido Withdrawal Queue.
- Claims withdrawals automatically when finalized.
- Persists request IDs locally and logs JSON events per tick.

## Requirements

- Node.js (LTS recommended)
- RPC URL for Ethereum mainnet
- Bot private key (server-side only)
- Addresses + ABIs in `src/config` and `src/abi`

## Setup

1) Install dependencies:
```
npm install
```

2) Create `.env` from the template:
```
copy .env.example .env
```
Fill at least:
- `RPC_URL`
- `BOT_PRIVATE_KEY`

3) Confirm config + ABI files:
- `src/config/lido.json` (stETH, withdrawal queue, stETH/WETH pool)
- `src/abi/steth.json`
- `src/abi/erc20.json`
- `src/abi/uniswap-v3-pool.json`
- `src/abi/withdrawal-queue.json`

## Run the bot

```
npm run bot
```

The bot logs JSON lines to stdout (events: `tick`, `decision`, `stake_sent`, `withdraw_requested`, `withdraw_claimed`, `loop_error`).

## Optional: API + dashboard

Start the API:
```
npm run bot-api
```

Start the dashboard:
```
cd eth-steth-dashboard
npm install
npm start
```

Open `http://localhost:4200/lido`.

## Config (env defaults)

- `THRESHOLD_PCT` (default `0.4`)
- `SAFETY_BUFFER_ETH` (default `0.02`)
- `MIN_TRADE_ETH` (default `0.01`)
- `MIN_TRADE_STETH` (default `0.01`)
- `LOOP_SECONDS` (default `60`)
- `COOLDOWN_MINUTES` (default `60`)
- `CONFIRMATION_CHECKS` (default `3`)
- `MIN_HOLD_HOURS` (default `1`)

## Data files

- `data/strategy-state.json`: state + request IDs
- `data/withdrawals.json`: API-visible withdrawal requests

## Safety notes

- No MetaMask or browser signing. All writes happen on the backend wallet.
- Always keep `SAFETY_BUFFER_ETH` for gas.
- Lido withdrawals are asynchronous; requests are claimed when finalized.
