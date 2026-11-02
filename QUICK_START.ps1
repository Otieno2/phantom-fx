# Phantom FX - Quick Start Script
# This script will move your project to a local directory and start the dev server

Write-Host "=== Phantom FX Quick Start ===" -ForegroundColor Cyan
Write-Host ""

# Define paths
$sourceDir = "C:\Users\INFINITY\OneDrive\Desktop\phantom-fx"
$targetDir = "C:\Dev\phantom-fx"

# Check if target directory exists
if (Test-Path $targetDir) {
    Write-Host "Warning: Target directory already exists at $targetDir" -ForegroundColor Yellow
    $response = Read-Host "Do you want to delete it and start fresh? (yes/no)"
    if ($response -eq "yes") {
        Write-Host "Removing existing directory..." -ForegroundColor Yellow
        Remove-Item -Path $targetDir -Recurse -Force
    } else {
        Write-Host "Using existing directory..." -ForegroundColor Yellow
        Set-Location $targetDir
        Write-Host "Current location: $targetDir" -ForegroundColor Green
        
        # Skip copy, just install and run
        Write-Host ""
        Write-Host "Installing dependencies (this may take a few minutes)..." -ForegroundColor Cyan
        npm install
        
        Write-Host ""
        Write-Host "Starting development server..." -ForegroundColor Cyan
        Write-Host "Server will be available at: http://localhost:3000" -ForegroundColor Green
        Write-Host "Login with: admin@phantomfx.local / ChangeMe123!" -ForegroundColor Green
        Write-Host ""
        npm run dev
        exit
    }
}

# Create target directory
Write-Host "Creating directory: $targetDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

# Copy project files (excluding node_modules)
Write-Host "Copying project files (this may take a moment)..." -ForegroundColor Cyan

# Copy all files except node_modules and .next
robocopy $sourceDir $targetDir /E /XD "node_modules" ".next" /XF "*.log" /NFL /NDL /NJH /NJS /nc /ns /np

# Verify .env file was copied
if (!(Test-Path "$targetDir\.env")) {
    Write-Host "Copying .env file..." -ForegroundColor Cyan
    Copy-Item "$sourceDir\.env" "$targetDir\.env"
}

# Navigate to new directory
Set-Location $targetDir
Write-Host "Moved to: $targetDir" -ForegroundColor Green

# Install dependencies
Write-Host ""
Write-Host "Installing dependencies (this will be much faster outside OneDrive)..." -ForegroundColor Cyan
npm install

# Check if installation was successful
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "=== Installation Complete ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "Starting development server..." -ForegroundColor Cyan
    Write-Host "Server will be available at: http://localhost:3000" -ForegroundColor Green
    Write-Host ""
    Write-Host "Login credentials:" -ForegroundColor Yellow
    Write-Host "  Email: admin@phantomfx.local" -ForegroundColor White
    Write-Host "  Password: ChangeMe123!" -ForegroundColor White
    Write-Host ""
    Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Gray
    Write-Host ""
    
    # Start the dev server
    npm run dev
} else {
    Write-Host ""
    Write-Host "Installation failed. Please check the error messages above." -ForegroundColor Red
    Write-Host "You can try running 'npm install' manually in: $targetDir" -ForegroundColor Yellow
}
