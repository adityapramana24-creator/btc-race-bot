# btc-race-bot

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/adityapramana24-creator/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/adityapramana24-creator/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

A BTC trading bot for make.fun's `btc-race-24h-20261115-0828` bounty. It trades
Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, long only,
starting from 1,000 USDC of paper money, through the
`agent-fun/bars-replay/v1` protocol (Node 22, `node /bot/main.ts`).

## Strategy

Two signal legs share one position slot, plus a fallback leg:

- **Dip (mean reversion):** when the close first falls 2% below the close 120
  bars ago, buy with all cash and sell 60 bars later. On the dev window, a 2%
  two-hour washout is followed by a strong hourly bounce (mean +1.4% over the
  next 60 minutes), enough to clear the ~43 bps full-size round-trip cost.
- **Momentum:** when the close first rises 1% above the close 30 bars ago, buy
  with all cash and sell 30 bars later. This covers up-trending windows where
  no washout appears.
- **Cooldown:** 60 bars after every exit before a signal leg may enter again,
  so the bot never re-buys into the same falling (or surging) move.
- **Fallback:** if no order has ever filled by bar 1200, buy 25% of cash and
  sell 60 bars later, so the entry still meets the 1-trade guardrail on a
  window too calm for either signal leg.

Exits are time-based only. Trailing stops, take-profits, RSI filters and
Bollinger filters were all tested on the dev window and rejected: each either
cut the winning recovery short or filtered it out. Fast trend-following (EMA
crosses, Donchian breakouts) was also tested and loses on this data.

## Layout

- `main.ts` — the entrypoint: the strategy, written against the SDK shim.
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's TypeScript SDK
  shim (`sdk/makefun-bars.ts`).

Deterministic: every decision is a pure function of the closes seen so far (no
wall clock, no randomness, no environment). Position state comes from the fills
each batch reports, so a rejected order never desyncs the bot.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this-repo> --driver process
```

## Local grade

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this-repo> --driver process
```

License: MIT (see `LICENSE`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=5435dmkf&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
