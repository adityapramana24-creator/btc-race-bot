// Washout + momentum bot for make.fun btc-race-24h-20261115-0828.
//
// The bot trades one symbol (CBBTC vs USDC) on 1-minute bars, long only, through
// the agent-fun/bars-replay/v1 protocol: the harness sends hello once, then one
// batch per minute, and this bot answers every batch with exactly one reply.
//
// What the dev window taught us (24h, 1,440 bars, BTC -4% overall, 1-minute
// returns essentially uncorrelated, round-trip cost ~43 bps at full size on the
// ~$640k median pool depth):
//   - Fast trend-following (EMA crosses, Donchian breakouts) whipsaws and loses:
//     every variant tested lost $12-$205 on dev.
//   - Dip-buying without confirmation also loses: it catches falling knives.
//   - What works is buying a genuine washout: after a 2% fall over 2 hours, the
//     next 60 minutes mean-revert (mean +1.4% forward return in the dev data),
//     enough to clear the round-trip cost. The edge is stable for lookbacks of
//     90-150 bars, drops of 2.0-2.5% and holds of 45-90 bars.
//   - Sharp 30-minute rises (+1%) also carry short-lived momentum (mean +0.5%
//     over the next 30 minutes), which covers up-trending windows where no
//     washout ever appears.
//
// Strategy (one position at a time, full size on signal legs):
//   1. DIP leg: when the close first drops 2% below the close 120 bars ago
//      (edge trigger: true now, false on the previous bar), buy with all cash
//      and sell 60 bars later. A 60-bar cooldown after every exit stops the bot
//      re-buying into the same falling move.
//   2. MOMENTUM leg: when the close first rises 1% above the close 30 bars ago,
//      buy with all cash and sell 30 bars later (momentum decays fast: longer
//      holds tested worse). Shares the position slot and the cooldown with the
//      dip leg, so the two legs never stack.
//   3. FALLBACK leg: if no order has ever filled by bar 1200, buy 25% of cash
//      and sell 60 bars later, so the entry still meets the 1-trade guardrail
//      on a window too calm for either signal leg. It never fires on the dev
//      window (both signal legs trade there).
//
// Exits are time-based only. Trailing stops, take-profits, RSI filters and
// Bollinger filters were all tested on dev and rejected: each one either cut
// the winning recovery short or filtered it out entirely.
//
// Determinism: every decision is a pure function of the closes seen so far
// (float64 arithmetic, IEEE 754, no wall clock, no randomness, no environment).
// Position state is taken from the fills each batch reports, so a rejected
// order never desyncs the bot: an exit whose sell is rejected is simply sent
// again on the next bar while its time is up.
//
// Costs: each order caps slippage at 100 bps past the close it was decided on,
// so a fill into a liquidity gap is refused rather than filled for nothing.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Dip leg: buy when the close first falls this far below the close DIP_BARS ago. */
const DIP_BARS = 120;
const DIP_DROP = 0.02;
/** Bars to hold a dip-leg position. */
const DIP_HOLD_BARS = 60;

/** Momentum leg: buy when the close first rises this far above the close MOM_BARS ago. */
const MOM_BARS = 30;
const MOM_RISE = 0.01;
/** Bars to hold a momentum-leg position. */
const MOM_HOLD_BARS = 30;

/** Bars to wait after an exit before a signal leg may enter again. */
const COOLDOWN_BARS = 60;

/** Fallback leg: if nothing ever filled by this bar, buy FALLBACK_FRACTION of cash. */
const FALLBACK_BAR = 1200;
const FALLBACK_FRACTION_NUM = 1n;
const FALLBACK_FRACTION_DEN = 4n;
/** Bars to hold a fallback-leg position. */
const FALLBACK_HOLD_BARS = 60;

/** Max slippage per order, in bps past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

type Mode = 'dip' | 'mom' | 'fallback';

function holdBars(mode: Mode): number {
  if (mode === 'dip') return DIP_HOLD_BARS;
  if (mode === 'mom') return MOM_HOLD_BARS;
  return FALLBACK_HOLD_BARS;
}

/** Closes by batch seq (a missing bar repeats the last close, so indices stay aligned). */
const closes: number[] = [];
let lastClose: number | null = null;

/** Filled trades so far (buys + sells). */
let fills = 0;
/** Seq the current position's buy filled on, and which leg opened it. */
let entrySeq = -1;
let mode: Mode | null = null;
/** The leg of the buy order most recently sent (confirmed on its fill). */
let pendingMode: Mode | null = null;
/** Seq the last exit's sell filled on (-1e9 = never). */
let lastExitSeq = -1_000_000_000;

/** The close `bars` back from seq, or null when not enough history exists yet. */
function closeBack(seq: number, bars: number): number | null {
  const i = seq - bars;
  return i < 0 || closes[i] === undefined ? null : closes[i]!;
}

/** True when the dip condition holds at this seq (a 2% fall over DIP_BARS). */
function dipHolds(seq: number): boolean {
  const now = closes[seq];
  const then = closeBack(seq, DIP_BARS);
  return now !== undefined && then !== null && now < then * (1 - DIP_DROP);
}

/** True when the momentum condition holds at this seq (a 1% rise over MOM_BARS). */
function momHolds(seq: number): boolean {
  const now = closes[seq];
  const then = closeBack(seq, MOM_BARS);
  return now !== undefined && then !== null && now > then * (1 + MOM_RISE);
}

function buyAll(state: BarsState, symbol: string, leg: Mode): BuyInput | null {
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  let spend = state.cash;
  const room = state.weightRoom(symbol);
  if (room < spend) spend = room;
  if (spend < minNotional) return null;
  pendingMode = leg;
  return { side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function buyFraction(state: BarsState, symbol: string, leg: Mode): BuyInput | null {
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  let spend = (state.cash * FALLBACK_FRACTION_NUM) / FALLBACK_FRACTION_DEN;
  const room = state.weightRoom(symbol);
  if (room < spend) spend = room;
  if (spend < minNotional) return null;
  pendingMode = leg;
  return { side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

await runBars({
  onBatch(state, batch: Batch) {
    const symbol = state.hello.symbols[0]!.symbol;
    const seq = state.seq;

    // Fold this batch's fills into position state before deciding.
    for (const f of batch.fills) {
      if (f.symbol !== symbol || f.status !== 'filled') continue;
      fills++;
      if (f.side === 'buy') {
        entrySeq = seq;
        mode = pendingMode ?? 'dip';
        pendingMode = null;
      } else {
        lastExitSeq = seq;
        mode = null;
        entrySeq = -1;
      }
    }

    // Record this batch's close (repeat the last one when this minute has no
    // bar, so indices stay aligned with seq; nothing is recorded before the
    // first bar, and the guards below refuse to trade on no history).
    for (const bar of batch.bars) {
      if (bar.symbol === symbol) lastClose = Number(bar.c);
    }
    if (lastClose !== null) closes[seq] = lastClose;
    if (closes[seq] === undefined) return [];

    const held = state.positions.get(symbol);

    // Holding: sell the whole position once its hold has expired. A rejected
    // sell is retried on the next bar because the time condition still holds.
    if (held !== undefined) {
      const leg = mode ?? 'dip';
      if (seq - entrySeq >= holdBars(leg)) {
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: a stale mode (e.g. a buy rejected after its leg was set) clears here.
    mode = null;
    if (state.warmingUp) return [];
    if (seq - lastExitSeq < COOLDOWN_BARS) return [];

    // Signal legs, edge-triggered: the condition must hold now and not on the
    // previous bar, so each washout (or surge) is bought exactly once.
    const dipEdge = dipHolds(seq) && !dipHolds(seq - 1);
    const momEdge = momHolds(seq) && !momHolds(seq - 1);
    if (dipEdge) {
      const order = buyAll(state, symbol, 'dip');
      return order === null ? [] : [order];
    }
    if (momEdge) {
      const order = buyAll(state, symbol, 'mom');
      return order === null ? [] : [order];
    }

    // Fallback: guarantee at least one trade on a window too calm for signals.
    if (fills === 0 && seq >= FALLBACK_BAR) {
      const order = buyFraction(state, symbol, 'fallback');
      return order === null ? [] : [order];
    }
    return [];
  },
});
