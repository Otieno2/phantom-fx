# Current Issues & Debugging Steps

## Issue #1: Node Modules Installation Problem ❌

### Symptoms:
- Commands like `prisma`, `tsx`, `next`, `vitest` not found in PATH
- Error: `'next' is not recognized as an internal or external command`
- npm install seems to complete but packages don't work properly

### Root Cause:
Likely one of:
1. npm/node PATH configuration issue on Windows
2. Package installation interrupted or corrupted
3. OneDrive sync conflict (project is in OneDrive folder)

### Solutions to Try:

#### Solution 1: Use npx prefix (Quick fix)
Instead of running commands directly, prefix with `npx`:
```powershell
npx prisma db push
npx tsx prisma/seed.ts  
npx next dev
npx vitest run
```

#### Solution 2: Move project out of OneDrive
OneDrive can cause file locking issues with node_modules:
```powershell
# Move to C:\projects\ or similar
xcopy /E /I "C:\Users\INFINITY\OneDrive\Desktop\phantom-fx" "C:\projects\phantom-fx"
cd C:\projects\phantom-fx
npm install
```

#### Solution 3: Clean reinstall with different npm registry
```powershell
# Clear npm cache
npm cache clean --force

# Delete node_modules (this may take time in OneDrive)
Remove-Item -Recurse -Force node_modules
Remove-Item -Force package-lock.json

# Try with different registry or flags
npm install --registry https://registry.npmjs.org/
# OR
npm install --legacy-peer-deps
# OR  
npm ci  # Clean install from lock file
```

#### Solution 4: Check npm/node installation
```powershell
node --version  # Should be v20+
npm --version   # Should be v9+
npm config get prefix  # Check npm global path
```

If node/npm not found, reinstall Node.js from nodejs.org

### Workaround Used:
Created `prisma/seed.js` (JavaScript version) and ran directly with `node prisma/seed.js` ✅

---

## Issue #2: Next.js Module Not Found ❌

### Error:
```
Error: Cannot find module '../server/lib/utils'
Require stack:
- C:\Users\INFINITY\OneDrive\Desktop\phantom-fx\node_modules\next\dist\bin\next
```

### Analysis:
- This suggests Next.js installation is incomplete
- The node_modules/next package is missing internal dependencies
- Could be related to OneDrive sync or interrupted npm install

### Solution:
Need to properly reinstall Next.js:
```powershell
npm install next@^16.4.0 --force
# OR if still failing
npm install next@latest --force
```

### Alternative:
Check if Next.js build is needed first:
```powershell
npm run build  # This runs: prisma generate && next build
```

---

## Issue #3: Slow File Operations ⚠️

### Symptoms:
- `Remove-Item node_modules` times out after 60 seconds
- npm install takes very long
- File operations hang

### Cause:
OneDrive sync locking files in node_modules (thousands of files)

### Solutions:

#### Option A: Exclude node_modules from OneDrive
```powershell
# Mark node_modules as "Free up space" in OneDrive
# Or add to OneDrive exclusions (requires OneDrive settings)
attrib +U node_modules /S /D
```

#### Option B: Use CMD instead of PowerShell for file operations
```cmd
rd /s /q node_modules
del package-lock.json
npm install
```

#### Option C: Move project (recommended)
Move to a non-OneDrive location like `C:\projects\`

---

## Successfully Completed ✅

1. **Database Setup**: ✅ 
   - Created SQLite database at `prisma/dev.db`
   - Schema pushed successfully
   - Seed data inserted (10 instruments, admin user)

2. **Environment Config**: ✅
   - `.env` file created with AUTH_SECRET
   - Admin credentials set

3. **Unit Tests**: ✅
   - All 12 trading math tests passing
   - Running via: `node node_modules/vitest/vitest.mjs run`

---

## Blocked Tests ❌

Cannot proceed with these until dev server starts:

1. Authentication flow (register/login/logout)
2. Trading endpoints (orders, positions)
3. Wallet functionality
4. Admin panel
5. UI testing

---

## Manual Testing Ready

Once you resolve the installation and get `npm run dev` working, you can:

1. Access the app at `http://localhost:3000`
2. Follow the detailed steps in `TESTING_GUIDE.md`
3. Test each feature systematically
4. Document bugs as you find them

---

## Immediate Next Steps

**Option A - Fix Installation (Recommended if you want to continue in OneDrive)**:
```powershell
# 1. Close any apps that might be locking files (VS Code, File Explorer, etc.)
# 2. Temporarily pause OneDrive sync
# 3. Clean reinstall
Remove-Item -Recurse -Force node_modules -ErrorAction Continue
Remove-Item -Force package-lock.json -ErrorAction Continue  
npm cache clean --force
npm install
```

**Option B - Move Project (Fastest solution)**:
```powershell
# 1. Copy project to local drive
xcopy /E /I "C:\Users\INFINITY\OneDrive\Desktop\phantom-fx" "C:\Dev\phantom-fx"
cd C:\Dev\phantom-fx
# 2. Fresh install
npm install
# 3. Start dev server
npm run dev
```

**Option C - Use npx Workaround**:
```powershell
# Try starting dev server with npx
npx next dev
```

---

## For Your Information

### Database Contents:
- **Users**: 1 admin user (admin@phantomfx.local)
- **Accounts**: 2 (admin's demo account with $10k, live account with $0)
- **Instruments**: 10 FX pairs configured
- **Transactions**: 1 initial demo deposit

### Environment:
- Node.js: v24.15.0 (latest)
- Package manager: npm
- OS: Windows
- Database: SQLite (prisma/dev.db)
- Dev server should run on: http://localhost:3000

### Quick Diagnostic Commands:
```powershell
# Check what's installed
npm list --depth=0

# Check Next.js specifically
npm list next

# Try running Next.js directly
npx next info

# Check if binaries exist
Test-Path node_modules\.bin\next.cmd
Test-Path node_modules\.bin\next

# Try global install as last resort (not recommended for project)
npm install -g next
```
