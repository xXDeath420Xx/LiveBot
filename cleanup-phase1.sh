#!/bin/bash
# CertiFried Announcer - Safe Cleanup Script Phase 1
# This script removes test files, one-time scripts, and redundant documentation
# Phase 1 focuses on definitely-safe deletions

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

DRY_RUN=false
if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=true
    echo "🔍 DRY RUN MODE - No files will be deleted"
    echo ""
fi

delete_file() {
    local file="$1"
    if [[ -f "$file" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            echo "Would delete: $file"
        else
            rm "$file"
            echo "✓ Deleted: $file"
        fi
    fi
}

delete_dir() {
    local dir="$1"
    if [[ -d "$dir" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            echo "Would delete directory: $dir"
        else
            rm -rf "$dir"
            echo "✓ Deleted directory: $dir"
        fi
    fi
}

echo "========================================="
echo "CertiFried Announcer Cleanup - Phase 1"
echo "========================================="
echo ""

# Create backup timestamp
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
echo "Backup timestamp: $BACKUP_DATE"
echo ""

# Phase 1: Test Files (21 files, ~380KB)
echo "📋 Phase 1a: Removing test files..."
delete_file "automated-comprehensive-test.js"
delete_file "automated-discord-tester.js"
delete_file "automated-test-suite.js"
delete_file "comprehensive-bot-test.js"
delete_file "comprehensive-command-category-tests.js"
delete_file "comprehensive-command-test.js"
delete_file "comprehensive-dashboard-test.js"
delete_file "comprehensive-e2e-test.js"
delete_file "comprehensive-system-test.js"
delete_file "full-automation-suite.js"
delete_file "interactive-command-test.js"
delete_file "interactive-command-tester.js"
delete_file "music-dashboard-tests.js"
delete_file "test-api-integrations.js"
delete_file "test-api-simple.js"
delete_file "test-dashboard-pages.js"
delete_file "test-fixes.js"
delete_file "test-platform-support.js"
delete_file "test-realtime-systems.js"
delete_file "test-stream-checker.js"
delete_file "test-user-linker.js"
delete_file "ultimate-comprehensive-test.js"
echo ""

# Phase 1b: Fix/Migration Scripts (16 files)
echo "📋 Phase 1b: Removing one-time fix/migration scripts..."
delete_file "check-bot-guilds.js"
delete_file "check-command-status.js"
delete_file "check-guilds-table.js"
delete_file "check-results.js"
delete_file "check-schemas.js"
delete_file "check-uptime-data.js"
delete_file "fix-all-ts-errors.js"
delete_file "fix-database-schemas.js"
delete_file "fix-existing-uptime.js"
delete_file "fix-final-errors.js"
delete_file "fix-realtime-errors.js"
delete_file "fix-remaining-errors.js"
delete_file "fix-specific-errors.js"
delete_file "fix-typescript-errors.js"
delete_file "fix-variable-references.js"
delete_file "run-migration.js"
echo ""

# Phase 1c: One-time shell scripts (6 files)
echo "📋 Phase 1c: Removing one-time shell scripts..."
delete_file "batch-fix.sh"
delete_file "final-cleanup.sh"
delete_file "fix-comma-operators.sh"
delete_file "fix-error-refs.sh"
delete_file "revert-interface-comments.sh"
delete_file "verify-linter-fixes.sh"
echo ""

# Phase 1d: Python scripts (3 files)
echo "📋 Phase 1d: Removing Python fix scripts..."
delete_file "comprehensive-fix.py"
delete_file "fix-error-variable-refs.py"
delete_file "fix_all_errors.py"
echo ""

# Phase 1e: Redundant Markdown Documentation
echo "📋 Phase 1e: Removing redundant documentation..."

# Test Reports
delete_file "COMMAND_TEST_REPORT.md"
delete_file "COMPREHENSIVE_COMMAND_TEST_SUMMARY.md"
delete_file "COMPREHENSIVE_DASHBOARD_TEST_REPORT.md"
delete_file "COMPREHENSIVE_E2E_TEST_RESULTS.md"
delete_file "COMPREHENSIVE_TEST_REPORT.md"
delete_file "DASHBOARD_TESTING_COMPLETE.md"
delete_file "DASHBOARD_TEST_RESULTS.md"
delete_file "DASHBOARD_TEST_SUMMARY.md"
delete_file "FINAL_TEST_REPORT.md"
delete_file "FINAL_TEST_RESULTS.md"
delete_file "TEST_EXECUTIVE_SUMMARY.md"
delete_file "TEST_RESULTS_COMPREHENSIVE.md"
delete_file "TESTING_COMPLETE.txt"
delete_file "TESTING_SESSION_REPORT.md"

# Session/Completion Reports
delete_file "ERROR_FIX_SESSION_COMPLETE.md"
delete_file "EVENT_CONVERSION_COMPLETE.md"
delete_file "HANDLER_CONVERSION_SUMMARY.md"
delete_file "LIVE_TESTING_COMPLETE.md"
delete_file "MANAGE_PARTIALS_COMPLETE.md"
delete_file "SESSION_COMPLETE.md"
delete_file "SESSION_COMPLETE_SUMMARY.md"
delete_file "SESSION_PROGRESS_SUMMARY.md"
delete_file "TEST_FIXES_COMPLETE.md"
delete_file "ULTIMATE_TEST_COMPLETE.md"
delete_file "UPTIME_FIX_COMPLETE.md"

# Dashboard/Website Reports
delete_file "DASHBOARD_AUDIT_REPORT.md"
delete_file "DASHBOARD_AUDIT_SUMMARY.md"
delete_file "DASHBOARD_CACHING_IMPLEMENTATION.md"
delete_file "PARTIAL_CREATION_INSTRUCTIONS.md"
delete_file "PHASE_1_AND_2_COMPLETE_SUMMARY.md"
delete_file "PHASE_1_COMPLETION_REPORT.md"
delete_file "PHASE_2_WEBSITE_REWRITE_COMPLETE.md"
delete_file "WEBSITE_MODERNIZATION_COMPLETE.md"
delete_file "WEBSITE_MODERNIZATION_PROGRESS.md"
delete_file "WEBSITE_REWRITE_PROGRESS.md"

# Implementation Plans (keep some essential ones)
delete_file "COMPLETE_REWRITE_PROJECT_PLAN.md"
delete_file "DASHBOARD_ENHANCEMENT_PLAN.md"
delete_file "IMPLEMENTATION_PLAN.md"
delete_file "INTELLIGENT_SYSTEMS_IMPLEMENTATION.md"
delete_file "PRIORITY_ACTION_PLAN.md"
delete_file "PRODUCTION_READINESS_PLAN.md"

# Feature/Enhancement Reports
delete_file "AI_DJ_FEATURE_GUIDE.md"
delete_file "AI_DJ_INTEGRATION_PLAN.md"
delete_file "AI_ERROR_MONITOR_SAFEGUARDS.md"
delete_file "API_INTEGRATION_STATUS_REPORT.md"
delete_file "BOT_ENHANCEMENT_SUMMARY.md"
delete_file "COMMAND_TESTING_SUMMARY.md"
delete_file "COMPREHENSIVE_BOT_ANALYSIS.md"
delete_file "CORRECTED_ANALYSIS.md"
delete_file "FEATURE_COMPARISON.md"
delete_file "FINAL_FEATURE_AUDIT.md"
delete_file "FINAL_LINTER_FIX_REPORT.md"
delete_file "JAVASCRIPT_CLEANUP_REPORT.md"
delete_file "LINTER_FIX_SUMMARY.md"
delete_file "LOGGER_ENHANCEMENTS_SUMMARY.md"
delete_file "MANUAL_TEST_CHECKLIST.md"
delete_file "REALTIME_SYSTEMS_OPTIMIZATION_REPORT.md"
delete_file "TYPESCRIPT_COMPILATION_SUMMARY.md"
delete_file "UPDATE_SUMMARY.md"
delete_file "README_MODAL_FIX.md"

# Test Result JSON files
delete_file "COMMAND_TEST_REPORT.json"
delete_file "DASHBOARD_TEST_RESULTS.json"
delete_file "E2E_TEST_REPORT.json"
delete_file "INTERACTIVE_TEST_REPORT.json"
delete_file "REALTIME_TEST_REPORT.json"
delete_file "test-results-comprehensive.json"

echo ""

# Phase 1f: Duplicate files in root (7 files)
echo "📋 Phase 1f: Removing duplicate utility files from root..."
delete_file "api_checks.js"
delete_file "browserManager.js"
delete_file "cache.js"
delete_file "dashboard-cache.js"
delete_file "kick-api.js"
delete_file "logger.js"
delete_file "tls-manager.js"
echo ""

# Phase 1g: Empty files
echo "📋 Phase 1g: Removing empty/minimal files..."
delete_file "dashboard/status-server.js"
echo ""

# Phase 1h: Old backup directories
echo "📋 Phase 1h: Removing old backup directories..."
delete_dir "backups/js-cleanup-1761743020627"
echo ""

echo "========================================="
echo "Phase 1 Cleanup Complete!"
echo "========================================="
echo ""
echo "Files removed:"
echo "  - 21 test files"
echo "  - 16 fix/migration scripts"
echo "  - 6 shell scripts"
echo "  - 3 Python scripts"
echo "  - 60+ markdown documentation files"
echo "  - 6 JSON test result files"
echo "  - 7 duplicate utility files"
echo "  - Empty/minimal files"
echo "  - Old backup directories"
echo ""
echo "Estimated space saved: ~2-3 MB"
echo ""
if [[ "$DRY_RUN" == true ]]; then
    echo "This was a DRY RUN. Run without --dry-run to actually delete files."
else
    echo "✅ Cleanup complete!"
fi
