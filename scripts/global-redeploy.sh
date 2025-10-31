#!/bin/bash

###############################################################################
# CertiFried MultiTool - Global Redeploy Script
# Compiles TypeScript, deploys commands, and restarts all services
###############################################################################

set -e  # Exit on error

PROJECT_ROOT="/root/CertiFriedAnnouncer"
cd "$PROJECT_ROOT"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 CertiFried MultiTool - Global Redeploy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Step 1: Check prerequisites
echo "📋 Step 1/6: Checking prerequisites..."
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js not found"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm not found"
    exit 1
fi

if ! command -v pm2 &> /dev/null; then
    echo "❌ Error: pm2 not found"
    exit 1
fi

echo "   ✅ Node.js $(node --version)"
echo "   ✅ npm $(npm --version)"
echo "   ✅ pm2 $(pm2 --version)"
echo ""

# Step 2: Install dependencies
echo "📦 Step 2/6: Installing/updating dependencies..."
npm install --silent
echo "   ✅ Dependencies installed"
echo ""

# Step 3: Compile TypeScript
echo "🔨 Step 3/6: Compiling TypeScript..."
if [ -f "tsconfig.json" ]; then
    npx tsc
    echo "   ✅ TypeScript compiled successfully"
else
    echo "   ⚠️  No tsconfig.json found, skipping TypeScript compilation"
fi
echo ""

# Step 4: Deploy Discord commands
echo "📤 Step 4/6: Deploying Discord commands..."
if [ -f "deploy-commands.js" ]; then
    node deploy-commands.js
    echo "   ✅ Commands deployed to Discord"
else
    echo "   ⚠️  deploy-commands.js not found, skipping"
fi
echo ""

# Step 5: Restart PM2 processes
echo "🔄 Step 5/6: Restarting PM2 processes..."
pm2 restart all
sleep 3
echo "   ✅ PM2 processes restarted"
echo ""

# Step 6: Verify status
echo "📊 Step 6/6: Verifying status..."
echo ""
pm2 list
echo ""

# Check if processes are online
OFFLINE=$(pm2 jlist | grep -c '"status":"stopped"' || true)
if [ "$OFFLINE" -gt 0 ]; then
    echo "⚠️  Warning: Some processes are offline!"
    echo "   Run: pm2 logs"
else
    echo "✅ All processes are online"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Global redeploy complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 Next steps:"
echo "   • Check logs: pm2 logs"
echo "   • Monitor status: pm2 monit"
echo "   • Test commands in Discord (may take 10-60 min for global commands)"
echo ""
