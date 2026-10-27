# STINCHEZ Neural Core

Live Deriv market analysis that checks every rule of the *STINCHEZ Traders Market Analysis Guide* automatically, with a self-scanning robot, an Autopilot that trades inside strict risk limits, and an earnings dashboard.

## Run it

Requires Node.js 22.13 or newer.

```
npm install
npm run dev        # http://localhost:3200
npm run check      # typecheck + tests
```

Optional: copy `.env.example` to `.env` to enable "Log in with Deriv" (`DERIV_CLIENT_ID`) and learning strategies from websites (`ANTHROPIC_API_KEY`). Never commit `.env`.

## Deploy on Vercel

The repo is set up for Vercel (`vercel.json`): the site is served from `public/` and the server routes run as Vercel Functions in `api/` (`/api/learn`, `/api/deriv/*`, and `/oauth/*` rewritten to `/api/oauth/*`). Live market data and the analysis work with no settings at all.

To turn on the optional features, add these in **Vercel → Project → Settings → Environment Variables**, then redeploy:

| Variable | Needed for | Value |
|---|---|---|
| `SESSION_SECRET` | Log in with Deriv | Any long random text (keeps the encrypted login cookie readable across Vercel instances) |
| `DERIV_CLIENT_ID` | Log in with Deriv | Your Deriv OAuth client ID — and add `https://<your-vercel-domain>/oauth/callback` as a redirect URL in your Deriv app |
| `ANTHROPIC_API_KEY` | Learn from a website | Your Claude API key |

The Deriv login is stateless: the login-in-progress and the access token are kept in AES-256-GCM encrypted, HttpOnly, Secure cookies, never in server memory.

> **Risk warning.** Deriv's synthetic indices are generated randomly and every contract carries a built-in house margin. Nothing here guarantees profit. Start in paper or demo mode, and never trade money you can't afford to lose.

## What it does

- **Live data** from Deriv's public Options API (`wss://api.derivws.com/trading/v1/options/ws/public`). You don't need an account for this.
- **All 11 guide indicators, plus the extra ones its strategies use**: Hull MA, Stoch RSI, Aroon, A/D, MACD (dark/faded histogram colours), Chaikin volatility, KST, Connors RSI, MA, Bollinger, TSI, RSI, Double EMA, Coppock and Mass index (`public/js/indicators.js`).
- **12 strategies** from the guide: Rise/Fall ×2, Even/Odd ×3 and Over/Under ×7 (`public/js/strategies.js`). Each card shows:
  - which setup rules pass on the forming candle
  - the guide's entry trigger: FFF/RRR tick retest, OOE/EEO digit pattern, entry digit, the 00:02 countdown or the decimal match
  - the max runs and the matching Deriv contract
- **Track record**: replays the last few hours of real ticks (`public/js/backtest.js`). The setup is checked on a closed candle and the entry in the next one, so there is no look-ahead. The win rate is shown with a 95% range next to the pure-chance probability.
- **Knowledge core: learning from websites** (`src/learn.ts`, `public/js/dsl.js`):
  - Paste a link to a strategy article, forum post or PDF, or paste text such as a transcript.
  - The server fetches it (public http/https addresses only; private networks are refused) and Claude (`claude-opus-5-5`, structured output) turns its concrete rules into a small rule language built on the desk's indicators. Rules it can't express are listed rather than invented.
  - Learned strategies run like the built-in ones: live cards, a replay on real ticks, and a vote in the robot brain. Each is marked UNPROVEN, PROVEN EDGE or REJECTED based on its pooled record.
  - Setup: put `ANTHROPIC_API_KEY=...` in `packages/traders/.env` (see `.env.example`). Requests use server-side refusal fallbacks (`fallbacks: "default"`).
- **Robot memory** (`public/js/learning.js`): every READY signal on the 10 scanned markets is paper-traded on the real following ticks.
  - Results are kept per strategy in browser storage, so they survive reloads.
  - They are pooled with the replay, so the robot's trust in each strategy moves with real outcomes.
- **Risk control center** (`public/js/risk.js`, tested in `src/risk.test.ts`). Every limit defaults to "at most 2 losses":
  - **Loss-streak lock:** 2 losses in a row lock trading for a cooldown, and the robot moves off that market.
  - **2-step loss cap on recovery:** with the guide's ×1.5 martingale, a cycle risks the base stake, then 1.5×. After the 2nd loss the stake resets; there is never a 3rd, bigger attempt.
  - **Session stop-loss:** defaults to one worst-case cycle, i.e. 2 stakes (2.5 with martingale). Take-profit and max trades per session are optional, and a new session must be started by hand.
  - **Pre-trade check on every Buy:** blocks a trade that could break the stop-loss, exceeds a % of balance (default 2%), comes from a strategy proven worse than chance, or (in Strict entries mode) comes from a strategy without a proven edge. Each card says why it's blocked.
  - The panel also shows how often a run of N losses happens at the robot's live win rate, using the expected-trades and DP formulas in `learning.js`.
- **Matches / Differs**: `DIGITMATCH` / `DIGITDIFF` contracts on any digit 0–9, with fair odds of 10% / 90%.
  - The guide has no Matches/Differs rules, so three community strategies are included and labelled as such:
    - Differs on the cold digit right after it appears.
    - Matches on a hot digit that is repeating.
    - Differs on a digit missing for 40+ ticks.
  - Each picks its digit from live ticks at entry, and the replay settles each trade on that digit.
  - Digit pulse shows the match/differ rate of any digit and when it was last seen. Websites can teach Matches/Differs strategies too.
- **Strategies inspired by digitkillertool.site** (`dk-*` in `public/js/strategies.js`):
  - That site's signal formulas are behind a paid login and were not accessed. Its public page names the method (mean reversion, dynamic Over/Under barriers such as OVER 3 / UNDER 7, confidence scaling), and these strategies are our own implementations of those ideas:
    - Even/Odd fades a side running 2+ standard deviations ahead, with 3 runs at 3+ SD.
    - Over/Under backs whichever of OVER 2/3 or UNDER 6/7 lags its fair rate most (z ≤ −1.5).
    - Matches backs the "due" digit, the one at 6% or less of the last 200 ticks.
  - They're listed in the Knowledge core with their verdicts. The replay compares dynamic contracts against the average fair odds of the trades actually taken.
- **Self-scan & optimal volatility**: when the page opens, all 10 volatility indices are scanned automatically and ranked about once a second.
  - Each market gets its best trade and a smoothed signal strength, shown in the **Market radar** leaderboard.
  - The **Optimal volatility** card names the best market, the trade to take, and why.
  - A new pick must beat the current one clearly and is held for at least 15 seconds, so the pick doesn't flicker.
  - **Lock on** switches to the pick. **Voice** reads out each new pick.
- **Robot mind** (`public/js/brain.js`, `public/js/robot.js`): an animated robot core with rotating sensor rings, a radar sweep and the 10 markets orbiting it.
  - It combines every strategy, the deep analysis and each strategy's track record into a bias and a confidence for Rise/Fall, Even/Odd and Over/Under.
  - It then picks the single best action, or stands aside, and explains its reasoning in a live log.
  - **Auto-rotate** re-ranks all markets every 15/30/60 seconds and switches to the strongest one.
- **Deep analysis** (`public/js/analysis.js`):
  - Randomness tests: χ² uniformity, entropy and a parity runs test.
  - Next-digit transition map and ticks since each digit last appeared.
  - Trend strength and volatility: ADX with +DI/−DI, Supertrend and ATR volatility regime.
  - Support and resistance found from clustered swing highs and lows.
  - 1m/5m/15m trend alignment.
- **Digit pulse**: last digits, the 0–9 distribution, even/odd, over/under, streaks and guide patterns.
- **Scanner**: watches all 10 volatility indices at once.
- **Every Deriv market** (`public/js/catalog.js`): the market list is loaded live from Deriv's `active_symbols` (89 markets in October 2026), grouped by family. Each market is classed by what Deriv's `contracts_for` offers on it:
  - **All contract types:** Volatility, Jump, Daily Reset.
  - **Rise/Fall on ticks only:** Step.
  - **Rise/Fall of 5–15+ minutes:** forex, metals, stock indices, baskets.
  - **Analysis only** (Multipliers/Accumulators): Crash/Boom, Range Break, crypto.

  Strategies, replays, the robot brain and Autopilot only use a market for contracts it offers. Hidden cards say why. The radar's market selector picks which set the self-scan and Autopilot watch: digit markets (default), all tick synthetics, or all markets.
- **Grow my account** (`public/js/growth.js`): a small-account planner (e.g. $10 → $20).
  - **Inputs:** start, goal, contract, stake % of balance, daily target/stop %, trades per day, days.
  - **What it shows:** Deriv's live payout, the house margin and the break-even win rate, plus the bot's *measured* win rate on that contract once it has 30+ trades.
  - **Simulation:** 2,000 Monte Carlo runs give the chance to reach the goal, the chance to empty the account, the typical end balance and a stake ladder.
  - **Apply plan to bot** sets compounding stakes, a max stake % that allows Deriv's 0.35 minimum, the daily target/stop, 2-loss lock and contract type.
  - **Rules behind it:** stakes in "grows with balance" mode are a % of the live (or paper) balance, never below 0.35. The pre-trade check blocks stakes under 0.35 or over the balance, and explains how to fix a % cap that's too low for a small account.
  - **Paper balance:** paper trading has its own balance (default 10) that each paper trade's real-payout profit moves.
- **Bot settings** (Autopilot panel): every manual control in one place, usable without an account:
  - stake per trade, which markets to scan, recovery, stop-loss, take-profit, max trades and the loss-streak lock
  - minimum signal strength, contract types, and seconds between trades
  - a list of all strategies, each with an on/off switch and an own stake

  These are the same settings as the Risk panel, radar and strategy cards; a change in one place updates the other.
- **Real-money figures for paper trades** (`public/js/payouts.js`): Deriv quotes payouts on the public socket without a login, so each paper trade is valued with the real payout for that exact contract (e.g. Even/Odd 1.95, Differs 1.09, Matches 8.93 per 1.00).
  - Paper trading runs under its own session and loss lock with the same limits.
  - The header's **Earned today** chip shows today's net for the account in use (paper, demo or real).
- **Earnings** (`public/js/earnings.js`): every settled paper/demo/real trade is saved in browser storage. The dashboard filters by account and period and shows:
  - net P&L, win rate, return on stakes, average win/loss and worst drawdown
  - an equity curve
  - breakdowns by market, strategy, contract, and Autopilot vs manual
  - CSV export
- **Manual control:**
  - **Quick trade ticket:** any tradeable market, contract, digit/barrier, duration (ticks, or minutes where Deriv requires them) and stake. Money limits still apply.
  - **Per strategy card:** "Autopilot may trade this" and an own stake (recovery still applies).
- **Log in with Deriv** (`src/oauth.ts`): one-click OAuth 2.0 with PKCE. You sign in on Deriv's own page and click Accept.
  - The server exchanges the code and keeps the access token in memory behind an HttpOnly cookie. The page only reaches Deriv's account endpoints through a small same-origin proxy (`/api/deriv/*`).
  - Setup: register an OAuth app at developers.deriv.com with redirect URL `http://localhost:3200/oauth/callback`. Put its client ID in `DERIV_CLIENT_ID` in `.env`, or type it into the App ID box.
  - Deriv issues no refresh tokens, so log in again when the session expires.
- **Autopilot** (`public/js/autopilot.js`): every self-scan sweep it takes the strongest READY signal on any of the 10 markets that passes your filters (contract groups, minimum signal strength, seconds between trades) and the full risk pre-trade check.
  - It places one trade at a time and settles each into the risk session.
  - Mode follows the account: paper (no account), demo (confirm once), or real (type REAL to confirm).
  - It stops on session end, a lost trading connection, an account switch, the Stop button or the Esc key. The 2-loss cooldown pauses it until the lock ends.
- **Trading (optional)**: enter a Deriv app ID and a Personal Access Token with the `trade` scope.
  - The app lists your Options accounts and opens an OTP trading socket. Demo is the default.
  - Trades are placed manually from READY cards, and real-money buys must be confirmed.
  - The token is held only in the tab's memory.

## How the guide's rules were turned into checks

Some rules in the guide depend on how its chart software scales its indicators. These are interpreted as follows:

- **A/D "above 2"**: the A/D line is replaced by the volume-free Williams A/D and its 3-bar direction, because synthetic indices have no volume.
- **"Slender" Bollinger band**: the band width is below its 20-bar average.
- **TSI "0.8–0.9"**: TSI is computed as a ratio in the range −1 to 1.
- **"MACD line entering the histogram"**: the MACD line is moving toward zero from below or above, with the signal line further away from zero.

Deriv synthetic indices are generated by a random number generator. Use the track record to check whether a rule beats chance before risking money.
