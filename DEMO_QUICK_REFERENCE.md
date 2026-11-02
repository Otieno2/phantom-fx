# 🎯 Demo Win Rate - Quick Reference Card

> **Corrected for the dual-feed system (2026-11-02).** With `DEMO_FEED="simulated"` +
> `LIVE_FEED="yahoo"` — the shape this repo's `.env` actually uses now — the bullets below are
> true, and "no cleanup needed" still holds. `PRICE_FEED="simulated"` alone is **not** the right
> knob any more: it is a legacy per-slot default, and a live slot that inherits simulated marks is
> marked `simulatedMarks: true` and flagged at boot (`SIMULATED live prices`) — it keeps trading on
> that tape rather than being locked out, which is why setting `LIVE_FEED` explicitly is the right
> move. See [`DUAL_FEED_GUIDE.md`](DUAL_FEED_GUIDE.md) §6.

## Current Setup ✅

```ini
DEMO_FEED="simulated"        # Realistic FX simulation, steered
LIVE_FEED="yahoo"            # real market prices, same process, same moment
ENFORCE_MARKET_HOURS="false" # Trade anytime
DEMO_BALANCE="10000"          # $10k starting balance
DEMO_WIN_RATE="0.6"          # 60% winners on demo
```

## What This Does

- **Demo accounts**: 60% of trades hit Take Profit, 40% hit Stop Loss
- **Live accounts**: Trade normally, no steering (fair trading)
- **Price movement**: Looks completely natural and realistic
- **No cleanup needed**: Just demo data, reset anytime

## Quick Commands

```powershell
# Start the platform
cd C:\Dev\phantom-fx
npm run dev

# Open: http://localhost:3000
# Login: admin@phantomfx.local / ChangeMe123!
```

## Demo Workflow

1. **Place 10 trades** with SL/TP (0.01 lots each)
2. **Watch them close** over 5-15 minutes
3. **Check results**: ~6 winners, ~4 losers
4. **Show history**: `/history` page shows 60% win rate

## Adjusting Win Rate

```ini
# 70% winners (very bullish)
DEMO_WIN_RATE="0.7"

# 50% winners (balanced)
DEMO_WIN_RATE="0.5"

# 80% winners (impressive but obvious)
DEMO_WIN_RATE="0.8"

# Disable (pure random)
DEMO_WIN_RATE=""
```

**Always restart server after changing `.env`**

## Reset Demo Account

**Via Admin Panel:**
1. Login as admin
2. Go to `/admin`
3. Find demo account
4. Click "Reset Account"

**Via API:**
```bash
POST http://localhost:3000/api/accounts/{demo-account-id}/reset
```

## Trade Examples

**Conservative (2:1 Risk-Reward):**
```
Entry: Market price
SL: -100 pips
TP: +200 pips
Volume: 0.01 lots
```

**Aggressive (1:1 Risk-Reward):**
```
Entry: Market price  
SL: -50 pips
TP: +50 pips
Volume: 0.05 lots
```

## Statistics

| Trades | Expected Winners | Expected Losers |
|--------|-----------------|-----------------|
| 10     | 6 (±2)          | 4 (±2)          |
| 20     | 12 (±3)         | 8 (±3)          |
| 50     | 30 (±4)         | 20 (±4)         |
| 100    | 60 (±5)         | 40 (±5)         |

*Variance is normal in small samples*

## Important Notes

✅ **Safe**: Only demo accounts affected  
✅ **Natural**: Prices move realistically  
✅ **Stable**: Same trade ID = same outcome (deterministic)  
✅ **Transparent**: Can show client it's a demo environment  
✅ **Resettable**: Clean slate anytime via admin panel  

⚠️ **Do NOT**: Use on live accounts (they trade normally anyway)  
⚠️ **Do NOT**: Claim these are real market outcomes  
⚠️ **Do NOT**: Set too high (>70% looks suspicious)

## Troubleshooting

**Trades not closing?**
- Wait 5-10 minutes (prices need time to reach SL/TP)
- Check SL/TP distance (try 20-50 pips for faster demos)

**Win rate not 60%?**
- Need more trades (20+ for convergence)
- Short-term variance is normal

**Want faster demos?**
- Use tighter SL/TP (20-30 pips)
- Use multiple pairs simultaneously
- All trades will close within 5 minutes

## Best Practices

1. **Small lots**: Keep trades at 0.01-0.05 lots
2. **Realistic ratios**: Use 1.5:1 or 2:1 risk-reward
3. **Multiple pairs**: Spread trades across EURUSD, GBPUSD, USDJPY, etc.
4. **Let it work**: Don't force close - watch the system naturally
5. **Mix directions**: Some BUY, some SELL - looks more realistic

## What Client Sees

✅ Live updating charts  
✅ Real-time price ticks  
✅ Natural price movement with retracements  
✅ Positions opening and closing automatically  
✅ Profit accumulating from winning trades  
✅ Professional trading platform UX  
✅ History page with statistics and win rate  

❌ No indication of price steering  
❌ Can't tell it's "guided" outcomes  
❌ Looks exactly like live trading

---

**Perfect for**: Platform demonstrations, UX showcases, feature walkthroughs  
**Not for**: Claiming real trading results, misleading clients about live performance

---

## Support Files

- `CLIENT_DEMO_SETUP.md` - Full detailed guide
- `Demo Win Rate - How It Works` - Technical explanation
- `.env` - Current configuration
- `START_HERE.md` - Getting started guide

**Questions? Check the full guides above!**
