# 🚀 START HERE - Get Your Preview Running

## The Problem
Your project is in OneDrive which causes npm installation issues. We need to move it to a local directory.

## Quick Solution (Choose One)

### Option 1: Double-Click the Batch File (Easiest)
1. Double-click `QUICK_START.bat` in File Explorer
2. Wait for it to copy files and install dependencies
3. Browser will open at `http://localhost:3000`

### Option 2: Run PowerShell Script
1. Right-click PowerShell and "Run as Administrator"
2. Navigate to your project:
   ```powershell
   cd "C:\Users\INFINITY\OneDrive\Desktop\phantom-fx"
   ```
3. Run the script:
   ```powershell
   .\QUICK_START.ps1
   ```

### Option 3: Manual Steps (If scripts don't work)
Open PowerShell and run these commands one by one:

```powershell
# Create target directory
New-Item -ItemType Directory -Path C:\Dev\phantom-fx -Force

# Copy files (excluding node_modules)
robocopy "C:\Users\INFINITY\OneDrive\Desktop\phantom-fx" "C:\Dev\phantom-fx" /E /XD "node_modules" ".next"

# Navigate there
cd C:\Dev\phantom-fx

# Install dependencies
npm install

# Start server
npm run dev
```

## What Happens Next

1. **Project copies** from OneDrive to `C:\Dev\phantom-fx` (a few seconds)
2. **npm install runs** - installs all dependencies (2-5 minutes)
3. **Dev server starts** at `http://localhost:3000`
4. **Browser opens** showing your trading platform

## Login & Explore

Once the server starts, you can:

**Login as Admin:**
- Go to: `http://localhost:3000`
- Email: `admin@phantomfx.local`
- Password: `ChangeMe123!`

**Or Register a New User:**
- Go to: `http://localhost:3000/register`
- Create a test account

## What You'll See

### 1. Trading Terminal (`/trade`)
- Live FX prices for 10 currency pairs
- Interactive candlestick charts
- Order entry panel (market, limit, stop orders)
- Position management with real-time P&L
- Stop Loss / Take Profit controls

### 2. Wallet (`/wallet`)
- Demo account: $10,000 starting balance
- Live account: $0 balance  
- Deposit/withdrawal requests
- Transaction history ledger

### 3. Trading History (`/history`)
- Closed positions
- Order history
- Win rate statistics
- Profit/loss timeline

### 4. Admin Panel (`/admin`) - Admin Users Only
- User management dashboard
- Approve/reject deposits & withdrawals
- Monitor all open positions
- Force close positions
- Adjust account balances
- Edit instrument settings (spreads, commissions)
- Audit log

## Testing Features

### Try These First:

1. **Place a Market Order**
   - Select EURUSD
   - Enter volume: 0.01 lots
   - Click BUY or SELL
   - Watch position open with real-time P&L

2. **Set Stop Loss/Take Profit**
   - Open a position
   - Click to add SL/TP levels
   - Watch them trigger when price moves

3. **Request a Deposit** (Live Account)
   - Go to Wallet
   - Switch to Live Account
   - Request deposit of $1,000
   - As admin, go to Admin panel to approve it

4. **Test Admin Powers**
   - View all users and their accounts
   - See system-wide exposure
   - Approve pending transactions
   - Force close any position

## Common Issues

### "Cannot GET /" or blank page
- Make sure dev server is running
- Check terminal for errors
- Try `http://localhost:3000/trade`

### "Authentication failed"
- Check you're using correct credentials
- Email: `admin@phantomfx.local`
- Password: `ChangeMe123!`

### Port already in use
```powershell
# Kill process on port 3000
npx kill-port 3000
# Then restart
npm run dev
```

### npm install fails
```powershell
# Clear cache and retry
npm cache clean --force
npm install
```

## Next Steps

Once you've explored the UI:

1. **Read** `TESTING_GUIDE.md` for comprehensive test scenarios
2. **Check** `TESTING_STATUS.md` for what's been tested
3. **Review** database contents:
   ```powershell
   npx prisma studio
   # Opens at http://localhost:5555
   ```

## Database Info

Your database is already set up with:
- **10 FX Instruments**: EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, USDCAD, NZDUSD, EURGBP, EURJPY, GBPJPY
- **1 Admin User**: admin@phantomfx.local
- **2 Accounts**: Demo ($10,000) and Live ($0)

The database file is at: `C:\Dev\phantom-fx\prisma\dev.db` (SQLite)

## Configuration

Edit `.env` to change settings — the feed keys are documented in full in
**[`DUAL_FEED_GUIDE.md`](DUAL_FEED_GUIDE.md)**:
- `DEMO_FEED` / `LIVE_FEED`: **two feeds at once.** Demo accounts are priced by one (default `simulated`), live accounts by a real provider (default `yahoo`). The slot is chosen by the account type in the database; a URL parameter cannot select it.
- `PRICE_FEED`: legacy per-slot default only — it no longer merges the two slots, and it logs a deprecation warning.
- `ENFORCE_MARKET_HOURS`: "true" or "false". Applies to real-provider slots; the simulated tape has no session, so a weekend closes live trading and leaves demo trading alone. `false` does **not** make live prices move — over a weekend Yahoo keeps answering with the same Friday close, so you get a flat live chart (`DUAL_FEED_GUIDE.md` §4 step 7; the state machine does not yet notice that, which is open gap A-10).
- `DEMO_BALANCE`: Starting demo account balance
- `DEMO_WIN_RATE`: demo-only win targeting (use `0.6` for a 60% demo). It selects **no** provider and can never touch the live slot. You do not have to place SL/TP for steering to work: a demo trade opened without either gets synthetic stops so the tape has something to aim at (`trading.ts:158-167`).

## Stopping the Server

Press `Ctrl + C` in the terminal where `npm run dev` is running.

## Need Help?

- **Errors in browser**: Open DevTools (F12) and check Console
- **Server errors**: Check the terminal where dev server is running
- **Database issues**: Run `npx prisma studio` to view/edit data
- **Port conflicts**: Change port in `.env` with `PORT=3001`

---

## Still Having Issues?

If the scripts don't work:

1. **Close OneDrive** temporarily (right-click system tray icon > Pause syncing)
2. **Delete node_modules** in the OneDrive folder if it's huge
3. **Use only the C:\Dev copy** going forward
4. **Keep the OneDrive version** as a backup, but develop from C:\Dev

The entire project is less than 100MB without node_modules, so copying is fast. The slow part is npm install, which should take 2-5 minutes outside OneDrive vs timing out inside OneDrive.

---

**Ready? Run `QUICK_START.bat` or `QUICK_START.ps1` now!** 🚀
