#!/usr/bin/env node
/**
 * Safely removes duplicate JavaScript files that have TypeScript sources
 * Creates backups before removal
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = '/root/CertiFriedAnnouncer';
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups/js-cleanup-' + Date.now());
const REPORT_PATH = path.join(PROJECT_ROOT, 'scripts/duplicates-report.json');

// Check if report exists
if (!fs.existsSync(REPORT_PATH)) {
    console.error('❌ Error: duplicates-report.json not found!');
    console.error('   Run analyze-duplicates.js first');
    process.exit(1);
}

// Load report
const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));

if (report.duplicates.length === 0) {
    console.log('✅ No duplicates found! Nothing to clean up.');
    process.exit(0);
}

console.log('🧹 JavaScript Cleanup Tool');
console.log('━'.repeat(80));
console.log(`Found ${report.duplicates.length} duplicate files to remove\n`);

// Create backup directory
console.log('📦 Creating backup...');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

let removed = 0;
let failed = 0;

report.duplicates.forEach(({ js, ts }) => {
    const jsPath = path.join(PROJECT_ROOT, js);
    const backupPath = path.join(BACKUP_DIR, js);

    try {
        // Create backup subdirectory if needed
        const backupSubdir = path.dirname(backupPath);
        if (!fs.existsSync(backupSubdir)) {
            fs.mkdirSync(backupSubdir, { recursive: true });
        }

        // Copy to backup
        fs.copyFileSync(jsPath, backupPath);

        // Remove original
        fs.unlinkSync(jsPath);

        console.log(`✅ Removed: ${js}`);
        removed++;

    } catch (error) {
        console.error(`❌ Failed to remove ${js}: ${error.message}`);
        failed++;
    }
});

console.log('\n' + '━'.repeat(80));
console.log('📊 CLEANUP SUMMARY');
console.log('━'.repeat(80));
console.log(`  ✅ Files removed: ${removed}`);
console.log(`  ❌ Failed: ${failed}`);
console.log(`  📦 Backup location: ${BACKUP_DIR}`);

console.log('\n💡 Next steps:');
console.log('  1. Run: npx tsc');
console.log('  2. Run: npm run build (if configured)');
console.log('  3. Test bot: pm2 restart all');
console.log('  4. If issues occur, restore from: ' + BACKUP_DIR);

console.log('\n✅ Cleanup complete!\n');
