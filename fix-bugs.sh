#!/bin/bash

# Quick bug fix workflow script
# This script generates a bug report and provides instructions for Claude Code
# Usage: ./fix-bugs.sh

echo "════════════════════════════════════════════════════════════════"
echo "  CertiFried Utility Bot - Bug Fix Helper"
echo "════════════════════════════════════════════════════════════════"
echo ""

cd "$(dirname "$0")" || exit 1

# Generate bug report
echo "🔍 Scanning for open bugs..."
./scripts/export-bugs.sh

if [ $? -ne 0 ]; then
    echo ""
    echo "❌ Failed to generate bug report"
    exit 1
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Next Steps"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "1. Open Claude Code in this directory"
echo ""
echo "2. Copy and paste this command into Claude:"
echo ""
LATEST_REPORT=$(ls -t bugs-report-*.md 2>/dev/null | head -1)
if [ -n "$LATEST_REPORT" ]; then
    echo "   Read $LATEST_REPORT and fix all bugs listed"
else
    echo "   (No report file found)"
fi
echo ""
echo "3. Claude will:"
echo "   - Read the bug report"
echo "   - Analyze each bug"
echo "   - Implement fixes in priority order"
echo "   - Test the changes"
echo ""
echo "4. After Claude fixes bugs, update their status with:"
echo "   /manage-bugs update-status id:<bug-id> status:fixed"
echo ""
echo "════════════════════════════════════════════════════════════════"
