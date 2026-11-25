[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Tokocrypto96/pumpfun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Tokocrypto96/pumpfun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Momentum Paper Bot

A paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Best net PnL wins.

## Strategy

Most pump.fun curves bleed out slowly, so the bot only ever buys the freshest launches — and only the quiet ones:

- **Entry (fresh-launch sniper):** within 3 slots of creation, real SOL reserve 1–30 SOL, at least 3 trades seen, at most 2 distinct non-creator buyers (a crowded launch is a dump in waiting), creator bought at most 1.25 SOL at launch, creator has not sold, sell pressure low. One flat 0.1 SOL stake per coin (capped at 1% of the real reserve).
- **Exits:** sell everything at +15% take-profit or −15% stop-loss, or after 60 slots held; exit at once if the creator sells. A partial take-profit + trailing-stop ride lane is built in (`tpPart`, `rideTrail`) but defaults to sell-all — on the dev window, runners mean-revert instead of running.
- **Risk limits:** max 5 open positions, one entry per coin, no shorts, no leverage. A tiny 0.01 SOL probe lane, paced over the full 24 h day, keeps the run above the competition's 20-coin bar if the strict filter goes quiet.

## Local test (dev window)

Run against the kit's dev dataset with the local replay sim (see the kit's `baselines/pilot/momentum/tools/sim.ts` — the bot itself never imports it):

- Net PnL **+0.0216 SOL**, 96 fills over 48 coins, 48 round trips, 9 wins
- Max drawdown **0.55%** (limit 50%), zero rejected orders
- Deterministic: two runs produce identical action logs

The final window is different data, so this is a calibration result, not a promise. The settings sit in a flat region — neighbouring `maxDevBuySol` 0.5–1.5 SOL all test positive — not on a single sharp peak.

## Run

The grader runs `node /bot/main.ts` (Node 22.18+ strips the types; no build step, no dependencies, no network). `main.ts` is the entrypoint, `strategy.ts` holds the bot, `vendor/makefun-bot.ts` is the kit's SDK shim vendored byte for byte.

## License

MIT — see [LICENSE](LICENSE).
