// Tiered washout bot for make.fun btc-race-24h-20261115-0828 (v2).
//
// The bot trades one symbol (CBBTC vs USDC) on 1-minute bars, long only, through
// the agent-fun/bars-replay/v1 protocol: the harness sends hello once, then one
// batch per minute, and this bot answers every batch with exactly one reply.
//
// What the dev window taught us (24h, 1,440 bars, BTC -4% overall, 1-minute
// returns essentially uncorrelated, round-trip cost ~43 bps at full size on the
// ~$640k median pool depth):
//   - Fast trend-following (EMA crosses, Donchian breakouts) whipsaws and loses.
//   - Dip-buying without confirmation also loses: it catches falling knives.
//   - What works is buying a genuine washout: after a 2% fall over 2 hours, the
//     next hours mean-revert. The dev window's one big washout (hour 17, -2.8%
//     over 2 hours, bottom at bar 1037) snapped back +5.5% to bar 1113.
//   - The v1 bot caught that washout but sold it 60 bars in (+3.4%) and lost
//     money on the smaller grind dips. This version fixes both: it scales into
//     the dip in two tranches, takes profit on the snap-back instead of selling
//     on a fixed clock, and holds the smaller dips long enough for their slow
//     recovery (180 bars), with a stop-loss as the guardrail.
//
// Strategy (one position at a time):
//   1. DIP leg (mean reversion, tiered): when the close first falls 2% below
//      the close 120 bars ago (edge trigger), buy with 40% of cash. While
//      holding, if the close falls further to 2.6% below the close 120 bars
//      ago, buy with the remaining cash: the second tranche only deploys into
//      a genuinely deepening washout, near its bottom, so the average entry
//      price is better than a single full-size buy and shallow dips risk only
//      40% of the cash.
//   2. DIP exit: take profit at +4.5% over the average entry cost (fill-based,
//      fees included); a trailing stop of 1% below the peak close, armed once
//      the peak gain reaches +3%, as a backstop if the snap-back stalls below
//      the take-profit; a stop-loss at -2% under the average entry cost; and a
//      180-bar maximum hold. Whichever triggers first sells the whole position.
//   3. MOMENTUM leg: when the close first rises 1% above the close 30 bars ago,
//      buy with all cash and sell 30 bars later (momentum decays fast). This
//      covers up-trending windows where no washout ever appears. It shares the
//      position slot and the cooldown with the dip leg, so the two never stack.
//      The -2% stop-loss applies to it too.
//   4. FALLBACK leg: if no order has ever filled by bar 1200, buy 25% of cash
//      and sell 60 bars later, so the entry still meets the 1-trade guardrail
//      on a window too calm for either signal leg. It never fires on the dev
//      window (both signal legs trade there).
//   5. COOLDOWN: 60 bars after every exit before a signal leg may enter again,
//      so the bot never re-buys into the same falling (or surging) move.
//
// Local grade on the dev window (grade-local, driver process, two runs,
// byte-identical action logs): net PnL +49.396436 USDC, 8 trades, 3 round
// trips all winning (win rate 1.0), max drawdown 1.4845%, 0 rejected,
// +47.384068 USDC at doubled fees. The washout trade is most of it (+$46.49
// net); the other two round trips are near breakeven (+$0.71, +$2.20). The
// first half of the window contributes only +$0.71, the second half +$48.69.
// Honest caveat:
// the profit is concentrated in that one washout event, and the exact dev
// number is sensitive to the sequence of the smaller dips (a 210-bar hold or a
// 2.1% dip threshold changes which dips trade and costs $30-40 on dev), so the
// dev score overstates how much of this edge is repeatable. The tiered entry
// and the take-profit are the robust parts: the take-profit is flat for any
// level between 4.5% and 5.0%, the second tranche is flat for any threshold
// between 2.5% and 2.8%, and the first tranche is flat between 35% and 45% of
// cash. What the race window pays depends on whether it holds a washout and a
// snap-back like the dev window's.
//
// Determinism: every decision is a pure function of the closes and fills seen
// so far (float64 arithmetic, IEEE 754, no wall clock, no randomness, no
// environment). Position state is taken from the fills each batch reports, so
// a rejected order never desyncs the bot: an exit whose sell is rejected is
// simply sent again on the next bar while its time is up, and a rejected
// second-tranche buy is retried while the deep-dip condition still holds.
//
// Costs: each order caps slippage at 100 bps past the close it was decided on,
// so a fill into a liquidity gap is refused rather than filled for nothing.

import { runBars, type BarsState, type Batch, type BuyInput } from './vendor/makefun-bars.ts';

/** Dip leg: buy tranche 1 when the close first falls this far below the close DIP_BARS ago. */
const DIP_BARS = 120;
const DIP_DROP = 0.02;
/** Tranche 1 size: this fraction of cash (2/5 = 40%). */
const TIER1_NUM = 2n;
const TIER1_DEN = 5n;
/** Tranche 2: while holding the dip leg, buy the rest of the cash when the close falls this far below the close DIP_BARS ago. */
const TIER2_DROP = 0.026;
/** Dip leg: take profit at this gain over the average entry cost. */
const DIP_TP = 0.045;
/** Dip leg: trailing stop, this far below the peak close since entry, armed at DIP_TRAIL_ARM gain. */
const DIP_TRAIL = 0.01;
const DIP_TRAIL_ARM = 0.03;
/** Every leg: stop-loss at this loss under the average entry cost. */
const STOP_LOSS = 0.02;
/** Dip leg: maximum bars to hold from the first fill. */
const DIP_HOLD_BARS = 180;

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
/** Seq the current position's first buy filled on, and which leg opened it. */
let entrySeq = -1;
let mode: Mode | null = null;
/** The leg of the buy order most recently sent (confirmed on its fill). */
let pendingMode: Mode | null = null;
/** Seq the last exit's sell filled on (-1e9 = never). */
let lastExitSeq = -1_000_000_000;
/** Dip leg: whether the second tranche has been sent / filled. */
let tier2Sent = false;
let tier2Done = false;
/** Highest close since the current position's entry (0 = none yet). */
let peakClose = 0;

/** The close `bars` back from seq, or null when not enough history exists yet. */
function closeBack(seq: number, bars: number): number | null {
  const i = seq - bars;
  return i < 0 || closes[i] === undefined ? null : closes[i]!;
}

/** True when the close at this seq is at least `drop` below the close DIP_BARS ago. */
function dipHolds(seq: number, drop: number): boolean {
  const now = closes[seq];
  const then = closeBack(seq, DIP_BARS);
  return now !== undefined && then !== null && now < then * (1 - drop);
}

/** True when the momentum condition holds at this seq (a 1% rise over MOM_BARS). */
function momHolds(seq: number): boolean {
  const now = closes[seq];
  const then = closeBack(seq, MOM_BARS);
  return now !== undefined && then !== null && now > then * (1 + MOM_RISE);
}

/**
 * The position's average entry price in raw price units (the same scale as a
 * bar's close), from its fill-based cost: avgPx = cost * 10^(qty+price-quote
 * scales) / qty. Null when there is no position.
 */
function avgEntryPrice(state: BarsState, symbol: string): number | null {
  const held = state.positions.get(symbol);
  if (held === undefined || held.qty === 0n) return null;
  const s = state.hello.symbols[0]!;
  const exp = s.qty_scale + s.price_scale - state.hello.capital.quote_scale;
  return (Number(held.cost) * 10 ** exp) / Number(held.qty);
}

function buyAmount(state: BarsState, symbol: string, spend: bigint, leg: Mode): BuyInput | null {
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
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
      if (f.symbol !== symbol) continue;
      if (f.side === 'buy') {
        if (f.status === 'filled') {
          fills++;
          if (mode === null) {
            // First buy of a new position.
            entrySeq = seq;
            mode = pendingMode ?? 'dip';
          } else if (mode === 'dip') {
            // A second buy while holding the dip leg is the second tranche.
            tier2Done = true;
          }
          pendingMode = null;
        } else if (mode === 'dip') {
          // A rejected buy while holding the dip leg is the second tranche:
          // allow a retry while the deep-dip condition still holds.
          tier2Sent = false;
          pendingMode = null;
        } else {
          pendingMode = null;
        }
      } else if (f.status === 'filled') {
        fills++;
        lastExitSeq = seq;
        mode = null;
        entrySeq = -1;
        tier2Sent = false;
        tier2Done = false;
        peakClose = 0;
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

    // Holding: manage the position. A rejected sell is retried on the next bar
    // because the exit condition still holds.
    if (held !== undefined) {
      const leg = mode ?? 'dip';
      const now = closes[seq]!;
      if (now > peakClose) peakClose = now;

      // Dip leg, second tranche: the dip deepened, buy the rest of the cash.
      // Sent alone this bar: an exit cannot trigger on a tranche bar (the
      // price just fell), and the buy's fill lands on the next bar.
      if (leg === 'dip' && !tier2Sent && !tier2Done && dipHolds(seq, TIER2_DROP)) {
        const order = buyAmount(state, symbol, state.cash, 'dip');
        if (order !== null) {
          tier2Sent = true;
          return [order];
        }
      }

      const avgPx = avgEntryPrice(state, symbol);
      if (avgPx !== null && avgPx > 0) {
        const gain = now / avgPx - 1;
        // Take profit (dip leg only): the snap-back paid.
        if (leg === 'dip' && gain >= DIP_TP) {
          return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        // Trailing stop (dip leg only): the snap-back stalled below the
        // take-profit after running up, so lock in most of it.
        if (leg === 'dip' && peakClose / avgPx - 1 >= DIP_TRAIL_ARM && now < peakClose * (1 - DIP_TRAIL)) {
          return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        // Stop-loss (every leg): the position is falling, cut it.
        if (gain <= -STOP_LOSS) {
          return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }

      // Maximum hold.
      if (seq - entrySeq >= holdBars(leg)) {
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: a stale mode (e.g. a buy rejected after its leg was set) clears here.
    mode = null;
    tier2Sent = false;
    tier2Done = false;
    peakClose = 0;
    if (state.warmingUp) return [];
    if (seq - lastExitSeq < COOLDOWN_BARS) return [];

    // Signal legs, edge-triggered: the condition must hold now and not on the
    // previous bar, so each washout (or surge) is bought exactly once.
    const dipEdge = dipHolds(seq, DIP_DROP) && !dipHolds(seq - 1, DIP_DROP);
    const momEdge = momHolds(seq) && !momHolds(seq - 1);
    if (dipEdge) {
      const spend = (state.cash * TIER1_NUM) / TIER1_DEN;
      const order = buyAmount(state, symbol, spend, 'dip');
      return order === null ? [] : [order];
    }
    if (momEdge) {
      const order = buyAmount(state, symbol, state.cash, 'mom');
      return order === null ? [] : [order];
    }

    // Fallback: guarantee at least one trade on a window too calm for signals.
    if (fills === 0 && seq >= FALLBACK_BAR) {
      const spend = (state.cash * FALLBACK_FRACTION_NUM) / FALLBACK_FRACTION_DEN;
      const order = buyAmount(state, symbol, spend, 'fallback');
      return order === null ? [] : [order];
    }
    return [];
  },
});
