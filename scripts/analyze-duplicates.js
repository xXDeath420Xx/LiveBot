#!/usr/bin/env node
/**
 * Analyzes JavaScript files to identify which are compiled outputs from TypeScript
 * and can be safely removed
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = '/root/CertiFriedAnnouncer';

// Directories to scan
const SCAN_DIRS = [
    'commands',
    'core',
    'utils',
    'handlers',
    'jobs',
    'events',
    'dashboard'
];

// Files/dirs to exclude
const EXCLUDE_PATTERNS = [
    'node_modules',
    'piper_models',
    'temp_audio',
    'dist',  // TypeScript output directory
    'migrations',  // Keep migration .js files
    'ecosystem.config.js',  // PM2 config
    'index.js',  // Root files might be intentional
    'sharding.js',
    'deploy-commands.js',
    'automated-comprehensive-test.js',
    'piper-tts.js',  // New TTS system (pure JS)
    'autoresponder-handler.js',  // New autoresponder (pure JS)
];

const results = {
    duplicates: [],
    pureJS: [],
    tsOnly: []
};

function shouldExclude(filePath) {
    return EXCLUDE_PATTERNS.some(pattern => filePath.includes(pattern));
}

function analyzeDirectory(dir) {
    const fullPath = path.join(PROJECT_ROOT, dir);

    if (!fs.existsSync(fullPath)) {
        return;
    }

    const files = fs.readdirSync(fullPath);

    files.forEach(file => {
        const filePath = path.join(fullPath, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            // Recursively analyze subdirectories
            analyzeDirectory(path.join(dir, file));
            return;
        }

        if (file.endsWith('.js')) {
            const relativePath = path.relative(PROJECT_ROOT, filePath);

            if (shouldExclude(relativePath)) {
                return;
            }

            // Check if corresponding .ts file exists
            const tsPath = filePath.replace(/\.js$/, '.ts');

            if (fs.existsSync(tsPath)) {
                results.duplicates.push({
                    js: relativePath,
                    ts: path.relative(PROJECT_ROOT, tsPath)
                });
            } else {
                results.pureJS.push(relativePath);
            }
        } else if (file.endsWith('.ts')) {
            const relativePath = path.relative(PROJECT_ROOT, filePath);
            const jsPath = filePath.replace(/\.ts$/, '.js');

            if (!fs.existsSync(jsPath)) {
                results.tsOnly.push(relativePath);
            }
        }
    });
}

// Analyze all directories
console.log('🔍 Analyzing project structure...\n');

SCAN_DIRS.forEach(dir => {
    analyzeDirectory(dir);
});

// Print results
console.log('━'.repeat(80));
console.log('📊 ANALYSIS RESULTS');
console.log('━'.repeat(80));

console.log(`\n✅ TypeScript files without JS duplicates: ${results.tsOnly.length}`);
console.log(`⚠️  JS files with TypeScript sources (duplicates): ${results.duplicates.length}`);
console.log(`📄 Pure JavaScript files (no TS source): ${results.pureJS.length}`);

if (results.duplicates.length > 0) {
    console.log('\n' + '━'.repeat(80));
    console.log('⚠️  DUPLICATE FILES TO REMOVE');
    console.log('━'.repeat(80));
    console.log('These .js files have .ts source files and can be removed:\n');

    results.duplicates.forEach(({ js, ts }) => {
        console.log(`  ❌ ${js}`);
        console.log(`     ✅ Source: ${ts}\n`);
    });
}

if (results.pureJS.length > 0) {
    console.log('\n' + '━'.repeat(80));
    console.log('📄 PURE JAVASCRIPT FILES (KEEP THESE)');
    console.log('━'.repeat(80));
    console.log('These .js files have NO .ts source and should be kept:\n');

    results.pureJS.forEach(js => {
        console.log(`  ✅ ${js}`);
    });
}

// Export results for cleanup script
fs.writeFileSync(
    path.join(PROJECT_ROOT, 'scripts/duplicates-report.json'),
    JSON.stringify(results, null, 2)
);

console.log('\n' + '━'.repeat(80));
console.log(`📝 Report saved to: scripts/duplicates-report.json`);
console.log('━'.repeat(80));

// Summary
console.log('\n📊 SUMMARY:');
console.log(`  • Total duplicates found: ${results.duplicates.length}`);
console.log(`  • Pure JS files (keep): ${results.pureJS.length}`);
console.log(`  • TS-only files: ${results.tsOnly.length}`);

if (results.duplicates.length > 0) {
    console.log('\n💡 Next step: Run cleanup script to remove duplicates');
} else {
    console.log('\n✅ No duplicates found! Project is clean.');
}

console.log('');
