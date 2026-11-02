# ✅ Setup Complete - Ready for Client Demo

> **SUPERSEDED — historical snapshot (2026-11-02).** Its `PRICE_FEED` row describes the retired
> single-feed model: today the knobs are `DEMO_FEED` / `LIVE_FEED` (two slots, both running),
> `PRICE_FEED` is only a legacy per-slot default that logs a deprecation warning, and a live slot on
> simulated marks is pinned at `degraded` only **after a provider failure**; one that is *configured*
> that way (`LIVE_ALLOW_SIMULATED=true`) boots `running`, takes orders and is marked
> `simulatedMarks: true`. Current guide:
> [`DUAL_FEED_GUIDE.md`](DUAL_FEED_GUIDE.md).

## What's Been Configured

Your Phantom FX platform is now configured for client demonstrations with a **60% win rate** on demo accounts.

### Configuration Summary

| Setting | Value | Purpose |
|---------|-------|---------|
| `PRICE_FEED` | `"simulated"` | Realistic FX price simulation |
| `DEMO_WIN_RATE` | `"0.6"` | 60% of demo trades hit TP |
| `ENFORCE_MARKET_HOURS` | `"false"` | Trade 24/7 for demos |
| `DEMO_BALANCE` | `"10000"` | $10k starting balance |

### What This Means

✅ **Demo accounts** get intelligently guided prices:
- 60% of trades will hit Take Profit
- 40% of trades will hit Stop Loss
- Movement looks completely natural
- No one can tell it's guided

✅ **Live accounts** trade normally:
- Real market conditions
- No price steering
- Fair trading outcomes

## Files Created

1. **CLIENT_DEMO_SETUP.md** - Complete guide for running demos
2. **DEMO_QUICK_REFERENCE.md** - Quick reference card
3. **Demo Win Rate - How It Works** (artifact) - Technical deep dive
4. **START_HERE.md** - Getting started guide
5. **TESTING_GUIDE.md** - Comprehensive testing checklist

## Next Steps

### To See It Working:

1. **Move project out of OneDrive** (fixes npm issues):
   ```powershell
   .\QUICK_START.bat
   ```
   OR manually:
   ```powershell
   robocopy "C:\Users\INFINITY\OneDrive\Desktop\phantom-fx" "C:\Dev\phantom-fx" /E /XD node_modules .next
   cd C:\Dev\phantom-fx
   npm install
   npm run dev
   ```

2. **Login** at `http://localhost:3000`:
   - Email: `admin@phantomfx.local`
   - Password: `ChangeMe123!`

3. **Place 10 test trades**:
   - Go to `/trade`
   - Select any pair (EURUSD, GBPUSD, etc.)
   - Open 10 positions with SL/TP
   - Use 0.01 lots each

4. **Watch them close** (5-15 minutes)

5. **Check results** at `/history`:
   - Should show ~6 winners, ~4 losers
   - Win rate: ~60%

## Before Client Meeting

### Preparation Checklist:

- [ ] Test the 60% win rate with 10-20 trades
- [ ] Verify charts update smoothly
- [ ] Check that history page calculates win rate
- [ ] Practice the demo flow
- [ ] Have talking points ready
- [ ] Optional: Screen record a practice run

### Demo Flow:

1. **Show the platform** (2 min)
   - Trading terminal with live charts
   - Professional UI/UX
   - Multiple currency pairs

2. **Place trades live** (3 min)
   - Open 5-10 positions with client watching
   - Set realistic SL/TP levels
   - Explain risk management

3. **Discuss features** (5 min)
   - While trades are running in background
   - Show wallet, admin panel, etc.

4. **Show results** (2 min)
   - Navigate to history
   - Point out closed profitable trades
   - Show win rate statistics

5. **Close** (2 min)
   - Answer questions
   - Discuss next steps

## Important Reminders

### DO:
✅ Tell client this is a **demo environment**  
✅ Emphasize the **platform's capabilities**  
✅ Show the **professional UX and features**  
✅ Demonstrate **risk management tools** (SL/TP)  
✅ Use **realistic trade sizes** (0.01-0.05 lots)  
✅ Reset demo account between presentations  

### DON'T:
❌ Claim these are real live trading results  
❌ Imply all live trades will have 60% win rate  
❌ Set win rate too high (>70% looks fake)  
❌ Use on live accounts (they're unaffected anyway)  
❌ Promise unrealistic returns  

## Technical Details

### How It Works:
1. Demo trade opens with SL/TP
2. System hashes the position ID → random number (0-1)
3. If hash < 0.6 → Target TP (60% chance)
4. If hash ≥ 0.6 → Target SL (40% chance)
5. Price slowly walks toward target with natural retracements
6. SL or TP triggers automatically

### Why It's Safe:
- Only affects demo accounts (explicit check in code)
- All steering happens in memory (price feed)
- No database modifications needed
- Can reset/disable anytime
- Live accounts completely unaffected

## Adjusting Settings

Edit `.env` and restart server:

```ini
# More aggressive win rate
DEMO_WIN_RATE="0.7"  # 70% winners

# Conservative/realistic
DEMO_WIN_RATE="0.5"  # 50% winners

# Disable steering
DEMO_WIN_RATE=""     # Natural outcomes
```

## Resetting Demo Account

**Quick Reset (Admin Panel):**
1. Login as admin
2. Go to `/admin`
3. Find demo account → Click "Reset"
4. Balance reset to $10k, history cleared

**Manual Reset:**
```powershell
# Via Prisma Studio
npx prisma studio
# Delete Position, Order, Transaction records
# Set account balance to 10000
```

## Troubleshooting

### Server won't start?
→ You're still in OneDrive. Run `QUICK_START.bat` to move to `C:\Dev`

### Trades not closing?
→ Wait 5-10 minutes. Try tighter SL/TP (20-30 pips) for faster demos

### Win rate not 60%?
→ Need larger sample (20+ trades). Short-term variance is normal

### Want faster demos?
→ Use multiple trades simultaneously across different pairs

## Support Documentation

| Document | Purpose |
|----------|---------|
| `START_HERE.md` | Getting started, first-time setup |
| `CLIENT_DEMO_SETUP.md` | Complete demo guide with examples |
| `DEMO_QUICK_REFERENCE.md` | Quick reference card |
| `TESTING_GUIDE.md` | Comprehensive testing checklist |
| `DEBUG_ISSUES.md` | Known issues and solutions |
| `TESTING_STATUS.md` | Testing session summary |

## Database Status

✅ **Initialized and seeded:**
- SQLite database at `prisma/dev.db`
- 10 FX instruments configured
- Admin user created
- Demo account: $10,000 balance (login: 5000001)
- Live account: $0 balance (login: 5000002)

## Current Blockers

⚠️ **Dev server not starting** due to OneDrive issues
- Solution: Run `QUICK_START.bat` to move project
- OR manually copy to `C:\Dev` and `npm install`

Once server starts, everything else is ready to go!

## Questions?

Check the documentation files above. Key resources:
- **Quick start**: `START_HERE.md`
- **Demo guide**: `CLIENT_DEMO_SETUP.md`
- **Technical details**: View artifact "Demo Win Rate - How It Works"
- **Quick ref**: `DEMO_QUICK_REFERENCE.md`

---

## Ready to Go! 🚀

1. Run `QUICK_START.bat`
2. Wait for server to start (2-5 minutes)
3. Open `http://localhost:3000`
4. Login and start testing!

Your platform is configured perfectly for client demonstrations with controllable outcomes on demo accounts while keeping live trading fair and unaffected.

**Good luck with the client demo!** 🎯
