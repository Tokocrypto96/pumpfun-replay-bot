// Momentum Paper Bot — a paper-trading bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). It paper-trades 10 SOL of house money over a 24h replay.
//
// Idea, in one paragraph: most pump.fun curves bleed out slowly, so the bot only ever
// buys the freshest launches, and only the quiet ones — a launch whose creator barely
// bought in, whose creator has not sold, and that no crowd has piled into yet. It buys
// small (one flat stake per coin), cuts losers fast (stop-loss, short time limit), and
// when a coin does run, it banks half at a modest take-profit and lets the rest ride
// behind a trailing stop, so the rare coin that runs to completion is not sold at the
// first pop. A tiny probe lane keeps the run above the competition's coin/fill bar
// when the strict entry filter goes quiet.
//
// Tuning notes (dev window, local replay sim): the partial take-profit + ride looked
// good on paper but measured worse than selling the whole position at +15% — runners
// on this data mean-revert, they do not keep running — so the shipped default sells
// all at +15% (tpPart 1) and the ride lane stays as an option, not the default. The
// single strongest filter is maxDevBuySol: launches where the creator bought more
// than ~1.25 SOL at creation are dumps in waiting. The probe lane is paced over the
// whole 24h day (paceSecs 86400), not the first hours: aggressive early pacing was
// measured to burn ~0.03 SOL in useless probe fees.
//
// Everything here is a pure function of the batches the harness sends: no clock, no
// randomness, no environment, no I/O — so the two graded executions produce
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Oldest age (slots since CreateEvent) at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys (SOL) in the create slot: at most this. */
  maxDevBuySol: number;
  /** Trades seen before entry, at least this many. */
  minTrades: number;
  /** Distinct non-creator buyers seen before entry: at least this many... */
  minBuyers: number;
  /** ...and at most this many (a launch crowded by many wallets is a dump in waiting). */
  maxBuyers: number;
  /** SOL sold by others / SOL bought, at most this share. */
  maxSellRatio: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Exit when the position is worth this much under its cost (fraction). */
  stopLoss: number;
  /** First take-profit: sell tpPart of the position once it is worth this much over cost. */
  takeProfit: number;
  /** Share of the position sold at the first take-profit. */
  tpPart: number;
  /** After the first take-profit, the rest exits when it falls this far under its peak value. */
  rideTrail: number;
  /** Exit the whole position after this many slots held (phase 0: before any take-profit). */
  holdSlots: number;
  /** Exit the remainder after this many slots held (phase 1: after the take-profit). */
  rideHoldSlots: number;
  /** Exit at once when the creator sells. */
  exitOnDevSell: boolean;
  /** Guardrail pacing: the run must clear 20 coins with round trips of 0.01 SOL. When the
   * bot's own fills or coins lag targetFills / targetCoins scaled by the share of paceSecs
   * elapsed (block time since the first batch), it opens tiny probe round trips until it
   * is back on pace. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.1,
  minBuySol: 0.01,
  minRealSol: 1,
  maxRealSol: 30,
  maxDevBuySol: 1.25,
  minTrades: 3,
  minBuyers: 0,
  maxBuyers: 2,
  maxSellRatio: 10,
  skipDevSold: true,
  buySlipBps: 10_000,
  stopLoss: 0.15,
  takeProfit: 0.15,
  tpPart: 1,
  rideTrail: 0.25,
  holdSlots: 60,
  rideHoldSlots: 5000,
  exitOnDevSell: true,
  targetCoins: 21,
  targetFills: 42,
  paceSecs: 86_400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fee the bot assumes when valuing a position: 95 bps protocol + 30 bps creator. */
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Launch {
  created: number;
  creator: string;
  devBuySol: number;
  devSold: boolean;
  buyers: Set<string>;
  buySol: number;
  sellSol: number;
  trades: number;
  decided: boolean;
}

interface Open {
  opened: number;
  peakValue: number;
  /** 0 = full position, 1 = remainder after the first take-profit. */
  phase: 0 | 1;
  /** Some buy of this position filled. */
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const launches = new Map<Pubkey, Launch>();
  const open = new Map<Pubkey, Open>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const launchOf = (mint: Pubkey): Launch => {
    let l = launches.get(mint);
    if (l === undefined) {
      l = { created: -1, creator: '', devBuySol: 0, devSold: false, buyers: new Set(), buySol: 0, sellSol: 0, trades: 0, decided: false };
      launches.set(mint, l);
    }
    return l;
  };

  /** Mark-to-market value of a whole position in SOL, curve and tx fees deducted. */
  const valueOf = (state: BotState, mint: Pubkey): { value: number; cost: number; tokens: bigint } | null => {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined || curve === undefined) return null;
    const vq = Number(curve.virtual_quote_reserves);
    const vt = Number(curve.virtual_token_reserves);
    const tokens = Number(pos.token_amount);
    const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / LAMPORTS;
    return { value, cost: Number(pos.cost_lamports) / LAMPORTS, tokens: pos.token_amount };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const l = launchOf(e.mint);
          l.created = e.slot;
          l.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const l = launchOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          l.trades++;
          if (e.is_buy) {
            l.buySol += sol;
            if (e.user !== l.creator) l.buyers.add(e.user);
            else if (e.slot === l.created) l.devBuySol += sol;
          } else {
            l.sellSol += sol;
            if (e.user === l.creator) l.devSold = true;
          }
          traded.add(e.mint);
        }
      }
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: losers are cut, winners bank half and ride, stale positions go.
      for (const [mint, h] of open) {
        const v = valueOf(state, mint);
        const curve = state.curves.get(mint);
        if (v === null) {
          // No position yet: the buy is still in flight, or it never landed. Drop the
          // record only once nothing is pending for the mint any more.
          if (!pendingByMint.has(mint)) open.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        if (v.value > h.peakValue) h.peakValue = v.value;
        const l = launches.get(mint);
        let exit = false;
        let part = 1;
        if (p.exitOnDevSell && l !== undefined && l.devSold) {
          exit = true;
        } else if (h.phase === 0) {
          if (v.value < v.cost * (1 - p.stopLoss)) exit = true;
          else if (v.value >= v.cost * (1 + p.takeProfit)) {
            exit = true;
            part = p.tpPart;
            h.phase = 1;
          } else if (now - h.opened > p.holdSlots) exit = true;
        } else {
          if (v.value < h.peakValue * (1 - p.rideTrail)) exit = true;
          else if (now - h.opened > p.rideHoldSlots) exit = true;
        }
        if (!exit) continue;
        // A sell already in flight: wait for it instead of doubling up.
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        const amount = part >= 1 ? v.tokens : (v.tokens * BigInt(Math.floor(part * 1000))) / 1000n;
        orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: fresh, quiet launches only, one flat stake each.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
        const l = launches.get(mint);
        if (l === undefined || l.decided) continue;
        if (l.created < 0 || now - l.created < p.minAge || now - l.created > p.maxAge) {
          if (l.created >= 0 && now - l.created > p.maxAge) l.decided = true;
          continue;
        }
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        if (p.skipDevSold && l.devSold) {
          l.decided = true;
          continue;
        }
        if (l.devBuySol > p.maxDevBuySol) {
          l.decided = true;
          continue;
        }
        if (l.trades < p.minTrades || l.buyers.size < p.minBuyers || l.buyers.size > p.maxBuyers) continue;
        if (l.buySol > 0 && l.sellSol / l.buySol > p.maxSellRatio) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(p.stakeSol, capSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        l.decided = true;
        open.set(mint, { opened: now, peakValue: 0, phase: 0, filled: false });
        free -= amount + tx;
        slotsLeft -= 1;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
