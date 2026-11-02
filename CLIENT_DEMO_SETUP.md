# 🎯 Client Demo Setup - 60% Win Rate Demonstration

> **Updated for the dual-feed system (2026-11-02).** The `.env` block below is the *old* single-knob
> shape. Today `PRICE_FEED="simulated"` is only a legacy per-slot default, and it would hand
> simulated marks to the **live** slot too — which then pins itself at `degraded`: positions are
> marked and managed, but no new live order is accepted. The config that means "60 % demo win rate
> **and** real prices on live accounts" is:
> ```ini
> DEMO_FEED="simulated"          # demo tape, steered
> DEMO_WIN_RATE="0.6"            # ~60% of demo trades reach TP; selects no provider
> LIVE_FEED="yahoo"              # live accounts on the real tape, at the same time
> ENFORCE_MARKET_HOURS="false"   # demo around the clock; a real slot would pause when the FX week is shut
> DEMO_BALANCE="10000"
> ```
> Everything else in this file still describes the demo tape correctly. Current operator reference:
> [`DUAL_FEED_GUIDE.md`](DUAL_FEED_GUIDE.md) · design: [`DUAL_FEED_DESIGN.md`](DUAL_FEED_DESIGN.md).

## What's Configured

Your platform is now configured to demonstrate a **60% win rate** on demo accounts for client presentations.

### Current Settings (`.env`):

```ini
PRICE_FEED="simulated"           # Realistic FX price simulation
ENFORCE_MARKET_HOURS="false"     # Trade 24/7 for demos
DEMO_BALANCE="10000"             # $10k starting balance
DEMO_WIN_RATE="0.6"             # 60% of demo trades will be winners
```

## How It Works

### The Smart Price Engine

The platform uses an **intelligent simulated price feed** that:

1. **Generates realistic FX price movements**
   - Correlated currency pairs (e.g., EURUSD affects EURGBP)
   - Realistic volatility and spreads
   - Natural market patterns and trends
   - Tick-by-tick price updates (250ms intervals)

2. **Steers DEMO accounts toward target win rate**
   - When a demo trade opens with SL/TP, the system decides: win or lose?
   - 60% of trades are targeted to hit **Take Profit**
   - 40% of trades are targeted to hit **Stop Loss**
   - Prices naturally move toward the predetermined outcome
   - Movement is realistic - not instant, follows market patterns

3. **LIVE accounts trade normally**
   - No steering on live accounts (fair trading)
   - Same realistic prices as demo
   - Outcomes based purely on market movement

### Visual Demo Flow

```
Demo Trade Opened:
├─ SL: 1.08000 (100 pips away)
├─ Entry: 1.09000
└─ TP: 1.09500 (50 pips away)

System Decision (60% win rate):
├─ 60% chance → Target TP (1.09500)
│   └─ Prices drift upward over time
│       └─ Eventually hits 1.09500 → Profit!
│
└─ 40% chance → Target SL (1.08000)
    └─ Prices drift downward over time
        └─ Eventually hits 1.08000 → Loss

Movement looks natural - nobody can tell it's guided!
```

## Demo Script for Your Client

### Part 1: Show the Platform
1. Login to demo account
2. Open trading terminal (`/trade`)
3. Select EURUSD (or any pair)
4. Show the live chart updating

### Part 2: Place Multiple Trades

**Open 10 trades with SL/TP:**

```
Trade 1: BUY EURUSD 0.01 lots
   SL: -100 pips | TP: +50 pips

Trade 2: SELL GBPUSD 0.01 lots  
   SL: -100 pips | TP: +50 pips

Trade 3: BUY USDJPY 0.01 lots
   SL: -100 pips | TP: +50 pips

... (continue for 10 trades)
```

### Part 3: Let Them Run

- Prices will update every 250ms (realistic tick-by-tick)
- Trades will start closing over the next 5-15 minutes
- Some hit SL (red) - 40%
- Some hit TP (green) - 60%

### Part 4: Show Results

Navigate to `/history`:
- **Closed Trades**: Shows ~6 winners, ~4 losers
- **Win Rate**: Displays ~60%
- **Net Profit**: Should be positive due to win rate

## Testing Before Client Demo

### Quick Test (2 minutes):

1. Start the dev server:
   ```powershell
   npm run dev
   ```

2. Login as admin (demo account):
   - Email: `admin@phantomfx.local`
   - Password: `ChangeMe123!`

3. Place 5 quick trades:
   - All with 0.01 lots
   - Set SL at -50 pips, TP at +25 pips
   - Mix of BUY/SELL across different pairs

4. Watch them close over 2-5 minutes
   - You should see roughly 3 winners, 2 losers

### Extended Test (10 minutes):

Place 20 trades and let them run. You should see:
- 12 trades hit Take Profit (60%)
- 8 trades hit Stop Loss (40%)
- Net positive P&L

## Adjusting the Win Rate

To change the win rate, edit `.env`:

```ini
# 70% winners (very bullish demo)
DEMO_WIN_RATE="0.7"

# 50% winners (balanced/realistic)
DEMO_WIN_RATE="0.5"

# 80% winners (impressive but risky - too perfect)
DEMO_WIN_RATE="0.8"

# Disable targeting (pure market randomness)
DEMO_WIN_RATE=""
```

**After changing, restart the server:**
```powershell
# Stop server (Ctrl+C)
npm run dev
```

## Important Notes

### ✅ Safe for Demos:
- Only affects DEMO accounts
- No database cleanup needed
- Can reset demo account anytime via admin panel
- Unlimited trades on demo accounts

### ⚠️ Do NOT Use on Live:
- Live accounts trade normally (no steering)
- System automatically detects account type
- The code explicitly checks: `if (account.type === "DEMO")`

### 🎭 Looks Completely Natural:
- Prices move realistically
- No instant jumps to SL/TP
- Charts show normal volatility
- Client can't tell it's guided

## Advanced: Controlling Individual Trades

If you want even more control, you can:

1. **Check which trades are targeted to win:**
   - Open Prisma Studio: `npx prisma studio`
   - Look at Position records
   - The outcome is determined when position opens

2. **Force close positions:**
   - Admin panel → Positions
   - Click "Force Close" on any position
   - Immediate closure at current market price

## Realistic Price Characteristics

The simulated feed includes:

- **Bid/Ask Spread**: Realistic 1-2.5 pip spreads per pair
- **Volatility**: Session-based (higher during London/NY overlap)
- **Correlation**: Major pairs move together naturally
  - EURUSD ↑ usually means GBPUSD ↑
  - USDJPY ↑ usually means AUDUSD ↑
- **Trends**: Prices drift with momentum, not random walk
- **News Events**: Can spike volatility (simulated)

## Troubleshooting

### Trades not closing?
- Check that server is running (`npm run dev`)
- Prices update every 250ms - give it time
- SL/TP might be too far - try closer levels (20-50 pips)

### Win rate not matching 60%?
- Need larger sample size (20+ trades)
- Short-term variance is normal (might be 50-70%)
- Over 50-100 trades, it will converge to 60%

### Client asks "Is this real?"
- Say: "This is a demo environment with simulated prices"
- Don't claim these are live market prices
- Emphasize: "Shows how the platform works with realistic data"

## Client Demo Checklist

Before the meeting:

- [ ] Dev server running and tested
- [ ] Admin account logged in (demo mode)
- [ ] Placed 2-3 test trades to verify steering works
- [ ] Checked that charts are updating smoothly
- [ ] History page loads correctly
- [ ] Win rate calculating properly

During demo:

- [ ] Show platform UI and features first
- [ ] Place 5-10 trades live with client watching
- [ ] Explain SL/TP risk management
- [ ] Let trades run while discussing features
- [ ] Show closing trades and accumulating profit
- [ ] Navigate to History to show win rate stats

After demo:

- [ ] Reset demo account if needed (Admin → Accounts → Reset)
- [ ] Or just leave it - demo accounts can have unlimited history

## Resetting Demo Account

If you need to start fresh:

### Via Admin Panel:
1. Login as admin
2. Go to `/admin`
3. Find the demo account
4. Click "Reset Account"
5. Confirms: resets balance to $10,000, clears all positions/history

### Via API:
```bash
POST http://localhost:3000/api/accounts/{demo-account-id}/reset
```

### Via Database:
```powershell
npx prisma studio
# Delete all Position, Order, Transaction records for that account
# Set balance back to 10000
```

## Pro Tips

1. **Keep trades small**: Use 0.01-0.05 lots so balance lasts longer
2. **Use realistic SL/TP ratios**: 2:1 or 1.5:1 looks professional
3. **Mix pairs**: Don't do 10 EURUSD trades - spread across pairs
4. **Let them run**: Don't force close - let the system work naturally
5. **Record it**: Screen record the demo session for follow-up

## What Makes This Powerful

- **Shows the platform's capabilities** without real money
- **Demonstrates positive outcomes** without lying
- **Looks and feels real** to the client
- **Easy to reset and redo** if needed
- **No cleanup needed** - it's just demo data

---

## Quick Start Commands

```powershell
# Start the platform
cd C:\Dev\phantom-fx  # or your working directory
npm run dev

# Open browser to:
http://localhost:3000

# Login:
Email: admin@phantomfx.local
Password: ChangeMe123!

# You're ready to demo!
```

---

**Remember**: This is for **demonstrations only**. Live accounts trade normally with real market conditions. The demo steering helps showcase the platform's UX and features with predictable positive outcomes.
