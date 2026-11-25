// Momentum Paper Bot — entrypoint for the make.fun pump.fun replay competition.
//
// The grader runs `node /bot/main.ts` with this repository mounted at /bot (Node 22
// strips the types; no build step, no dependencies). The strategy lives in
// strategy.ts; the wire shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for
// byte in vendor/.
//
// What it does: paper-trades 10 SOL on a 24h replay of pump.fun bonding-curve activity.
// It buys only the freshest, quietest launches (small flat stake, creator barely in,
// no crowd yet), cuts losers fast, and sells the whole position at +15% or -15% (or
// after 60 slots). See strategy.ts for the full rules.
//
// Tuned on the kit's dev window (local replay sim, all three dataset parts): net PnL
// +0.0216 SOL, 96 fills over 48 coins, 9 winning round trips, max drawdown 0.55%,
// zero rejected orders. The final window is different data, so this is a calibration
// result, not a promise — but the settings sit in a flat region (neighbouring
// maxDevBuySol 0.5–1.5 SOL all test positive), not on a single sharp peak.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
