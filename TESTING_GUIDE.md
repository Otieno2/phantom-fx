# Phantom FX Testing & Debugging Guide

## Setup Status ✅

- [x] Database initialized (SQLite at `prisma/dev.db`)
- [x] Seed data created:
  - 10 FX instruments (EURUSD, GBPUSD, etc.)
  - Admin user: `admin@phantomfx.local` / `ChangeMe123!`
- [x] Unit tests passing (12/12 trading math tests)
- [ ] Dev server running (requires proper npm installation)

## Current Issues Found

### 1. Node Modules Installation Issue
**Problem**: Some packages (tsx, next, vitest) are not properly installed or have PATH issues.

**Solution**: Run a fresh installation:
```powershell
# Clean and reinstall (may take time)
rm -r node_modules, package-lock.json
npm install
```

**Alternative**: If npm install keeps failing, try:
```powershell
npm cache clean --force
npm install --legacy-peer-deps
```

## Testing Checklist

### Phase 1: Environment & Build ✅
- [x] Dependencies installed
- [x] Database schema created
- [x] Seed data populated
- [x] Unit tests pass (`npm test`)
- [ ] TypeScript compilation (`npm run typecheck`)
- [ ] Linting (`npm run lint`)
- [ ] Dev server starts (`npm run dev`)

### Phase 2: Authentication Flow
Test endpoints and UI for user authentication:

#### API Tests (use Postman, curl, or similar):

1. **Register New User** 
   ```
   POST http://localhost:3000/api/auth/register
   Body: {
     "email": "test@example.com",
     "name": "Test User",
     "password": "Test123!",
     "phone": "+254712345678",
     "country": "KE"
   }
   ```
   Expected: 201 Created, creates demo + live accounts

2. **Login**
   ```
   POST http://localhost:3000/api/auth/login
   Body: {
     "email": "test@example.com",
     "password": "Test123!"
   }
   ```
   Expected: 200 OK, sets session cookie

3. **Get Current User**
   ```
   GET http://localhost:3000/api/auth/me
   ```
   Expected: Returns user object with accounts

4. **Logout**
   ```
   POST http://localhost:3000/api/auth/logout
   ```
   Expected: 200 OK, clears session

#### UI Tests:
- Navigate to `/register` - form should work
- Navigate to `/login` - form should work
- After login, should redirect to `/trade`
- Check that session persists on page refresh

### Phase 3: Trading Functionality

#### Get Live Prices
```
GET http://localhost:3000/api/candles?symbol=EURUSD&timeframe=1h&limit=100
```
Expected: Returns candlestick data

#### Place Market Order
```
POST http://localhost:3000/api/orders
Body: {
  "accountId": "<your-demo-account-id>",
  "symbol": "EURUSD",
  "side": "BUY",
  "type": "MARKET",
  "volume": 0.01,
  "stopLoss": null,
  "takeProfit": null
}
```
Expected: 201 Created, order filled immediately, position opened

#### Place Limit Order
```
POST http://localhost:3000/api/orders
Body: {
  "accountId": "<your-demo-account-id>",
  "symbol": "EURUSD",
  "side": "BUY",
  "type": "LIMIT",
  "volume": 0.01,
  "price": 1.05000,
  "stopLoss": 1.04000,
  "takeProfit": 1.06000
}
```
Expected: 201 Created, status=PENDING

#### Get Positions
```
GET http://localhost:3000/api/positions?accountId=<account-id>
```
Expected: Returns open positions with P&L

#### Close Position
```
DELETE http://localhost:3000/api/positions/<position-id>
```
Expected: Position closed, P&L realized

#### UI Trading Tests:
- Navigate to `/trade`
- Select instrument from dropdown
- Chart should load with candlesticks
- Place various order types (market, limit, stop)
- Verify orders appear in orders panel
- Verify positions show real-time P&L
- Test SL/TP triggers (may need to wait for price movement)
- Test position closure

### Phase 4: Wallet & Transactions

#### Request Deposit
```
POST http://localhost:3000/api/accounts/<live-account-id>/deposit
Body: {
  "amount": 1000,
  "method": "M-PESA",
  "reference": "ABC123"
}
```
Expected: Transaction created with status=PENDING

#### Request Withdrawal
```
POST http://localhost:3000/api/accounts/<live-account-id>/withdraw
Body: {
  "amount": 500,
  "method": "Bank Transfer",
  "reference": "BANK456"
}
```
Expected: Transaction created with status=PENDING

#### Get Transaction History
```
GET http://localhost:3000/api/accounts/<account-id>/history
```
Expected: Returns all transactions for account

#### UI Wallet Tests:
- Navigate to `/wallet`
- Verify both demo and live accounts displayed
- Submit deposit request
- Submit withdrawal request
- Check transaction ledger

### Phase 5: Admin Panel

Login as admin (`admin@phantomfx.local` / `ChangeMe123!`)

#### Admin Dashboard Tests:
Navigate to `/admin` and verify:
- Overview shows total clients, deposits, withdrawals, PnL
- List of all users with accounts
- Open positions across all accounts
- Pending deposit/withdrawal requests

#### Approve/Reject Transactions
```
PATCH http://localhost:3000/api/admin/transactions/<transaction-id>
Body: {
  "status": "COMPLETED" | "REJECTED",
  "note": "Optional reason"
}
```

#### Adjust Account Balance
```
POST http://localhost:3000/api/admin/accounts/<account-id>/adjust
Body: {
  "amount": 500,
  "note": "Bonus credit"
}
```

#### Force Close Position
```
POST http://localhost:3000/api/admin/positions/<position-id>/close
Body: {
  "reason": "Admin closure"
}
```

#### Manage Instruments
```
GET http://localhost:3000/api/admin/instruments
PATCH http://localhost:3000/api/admin/instruments/<symbol>
Body: {
  "spreadPips": 2.0,
  "enabled": true
}
```

#### Audit Log
```
GET http://localhost:3000/api/admin/audit
```
Expected: Returns all admin actions with timestamps

### Phase 6: Risk Engine Testing

#### Margin Call Scenario
1. Open position with max leverage (1:500)
2. Let price move against you
3. Verify margin level decreases
4. When margin level hits 50%, worst position should auto-close (stop-out)

#### Stop Loss Trigger
1. Open position with stop loss
2. Wait for price to hit SL
3. Verify position closes at SL price

#### Take Profit Trigger
1. Open position with take profit
2. Wait for price to hit TP
3. Verify position closes at TP price

#### Negative Balance Protection
1. Create scenario where loss would exceed balance
2. Verify balance cannot go below 0

### Phase 7: Edge Cases & Bugs

#### Things to Test:
- [ ] Multiple simultaneous orders
- [ ] Orders during market closed hours (if ENFORCE_MARKET_HOURS=true)
- [ ] Invalid lot sizes (too small/large)
- [ ] Invalid stop loss placement (too close to market)
- [ ] Concurrent position modifications
- [ ] Session expiration
- [ ] Rate limiting on API endpoints
- [ ] SQL injection attempts in inputs
- [ ] XSS attempts in text fields
- [ ] Price feed failure — **per slot**: kill Yahoo and verify the **demo** slot falls back to its own simulation while the **live** slot goes `degraded` (SL/TP and stop-out still execute on last-known marks, new orders refused with HTTP 503) and then `paused` (nothing executes). A live slot must **never** silently start simulating: that only happens with `LIVE_ALLOW_SIMULATED=true`, and even then it stays `degraded` and every payload says `simulatedMarks: true`. See `DUAL_FEED_GUIDE.md` §3.
- [ ] Two tapes at once: one browser tab on the demo account, one on the live account — different prices, same instant, and `/api/prices?account=<id>` reports `feedKey`/`mode`/`state` for the slot that answered.

## Common Bugs to Watch For

1. **Race Conditions**: Multiple orders from same account simultaneously
2. **Margin Calculation**: Ensure margin is correctly reserved/released
3. **Price Precision**: Rounding errors in profit calculations
4. **Session Management**: Cookie expiration, concurrent logins
5. **WebSocket Issues**: Chart not updating in real-time
6. **Order Matching**: Pending orders not triggering at correct prices
7. **Account Locking**: Concurrent trades on same account

## Debugging Tools

### Check Database Directly
```powershell
node node_modules/prisma/build/index.js studio
# Opens Prisma Studio at http://localhost:5555
```

### View Logs
The app logs to console. Check the terminal where `npm run dev` is running.

### TypeScript Errors
```powershell
npm run typecheck
```

### Linting
```powershell
npm run lint
```

## Performance Testing

### Load Test Scenarios:
1. 100 users placing orders simultaneously
2. 1000 open positions with real-time P&L updates
3. Price feed updates every second for 10 instruments

### Tools:
- Artillery.io for load testing
- Chrome DevTools for client performance
- Node.js profiler for server bottlenecks

## Security Audit Checklist

- [ ] SQL injection protection (Prisma handles this)
- [ ] XSS protection in user inputs
- [ ] CSRF tokens (if applicable)
- [ ] Rate limiting on auth endpoints
- [ ] Password strength requirements
- [ ] Session security (httpOnly, secure cookies)
- [ ] Authorization checks on all admin endpoints
- [ ] Input validation on all endpoints
- [ ] Audit logging for sensitive operations

## Next Steps

Once the dev server is running successfully:

1. Follow the testing checklist phase by phase
2. Document any bugs found in a `BUGS.md` file
3. Fix bugs as they're discovered
4. Re-run tests after fixes
5. Add additional test coverage where gaps are found

## Notes

- Database is at: `prisma/dev.db` (SQLite)
- Admin credentials: `admin@phantomfx.local` / `ChangeMe123!`
- Demo accounts start with $10,000
- Default leverage is 1:100
- Market hours enforcement can be toggled in `.env`
