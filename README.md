# btc-race-bot

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/adityapramana24-creator/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/adityapramana24-creator/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

A BTC trading bot for make.fun's `btc-race-24h-20261115-0828` bounty. It trades
Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, long only,
starting from 1,000 USDC of paper money, through the
`agent-fun/bars-replay/v1` protocol (Node 22, `node /bot/main.ts`).

Second entry, built after the first one (washout + momentum, +$15.94 on dev).
This version scales into washouts in two tranches and takes profit on the
snap-back instead of selling on a fixed clock.

## Strategy

- **Dip (mean reversion, tiered):** when the close first falls 2% below the
  close 120 bars ago, buy with 40% of cash. While holding, if the close falls
  further to 2.6% below the close 120 bars ago, buy with the remaining cash:
  the second tranche only deploys into a genuinely deepening washout, near its
  bottom, so the average entry is better than a single full-size buy and
  shallow dips risk only 40% of the cash. On the dev window, a 2% two-hour
  washout is followed by a strong bounce (the hour-17 washout snapped back
  +5.5%), enough to clear the ~43 bps full-size round-trip cost.
- **Dip exit:** take profit at +4.5% over the average entry cost (fill-based,
  fees included); a trailing stop of 1% below the peak close, armed once the
  peak gain reaches +3%; a stop-loss at -2% under the average entry cost; and
  a 180-bar maximum hold. Whichever triggers first sells the whole position.
- **Momentum:** when the close first rises 1% above the close 30 bars ago, buy
  with all cash and sell 30 bars later. This covers up-trending windows where
  no washout appears. It shares the position slot and the cooldown with the
  dip leg, so the two never stack. The -2% stop-loss applies to it too.
- **Cooldown:** 60 bars after every exit before a signal leg may enter again,
  so the bot never re-buys into the same falling (or surging) move.
- **Fallback:** if no order has ever filled by bar 1200, buy 25% of cash and
  sell 60 bars later, so the entry still meets the 1-trade guardrail on a
  window too calm for either signal leg.

Tested and rejected on the dev window: fixed 60-bar exits (sold the washout
recovery too early), deeper dip thresholds (missed the washout's first edge),
trailing stops armed early (cut slow recoveries short), and fast
trend-following (EMA crosses, Donchian breakouts), which whipsaws and loses.

## Layout

- `main.ts` — the entrypoint: the strategy, written against the SDK shim.
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's TypeScript SDK
  shim (`sdk/makefun-bars.ts`).

Deterministic: every decision is a pure function of the closes and fills seen
so far (no wall clock, no randomness, no environment). Position state comes
from the fills each batch reports, so a rejected order never desyncs the bot.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this-repo> --driver process
```

## Local grade

Dev window, `grade-local --driver process`, verified twice with byte-identical
action logs (`43ed9241…`):

- Net PnL **+49.396436 USDC** (+4.94%)
- 8 trades, 3 round trips, win rate 1.0, 0 rejected
- Max drawdown 1.4845%, guardrails met
- Net PnL at 2x fees +47.384068 USDC

The washout trade is most of it (+$46.49 net); the other two round trips are
near breakeven. See the header comment in `main.ts` for the honest caveats.

License: MIT (see `LICENSE`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=5435dmkf&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
