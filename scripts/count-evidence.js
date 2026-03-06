import { readFileSync, readdirSync } from 'fs';

const rows = JSON.parse(readFileSync('audit-import-ready.json', 'utf8')).rows;
const withImg = rows.filter(r => r.evidence && r.evidence.includes('certifriedmultitool.com/evidence/'));
const noImg = rows.filter(r => !r.evidence || !r.evidence.includes('certifriedmultitool.com/evidence/'));

console.log(`Total: ${rows.length} | With images: ${withImg.length} | Without: ${noImg.length}`);

// Collect unique image files referenced
const allFiles = new Set();
withImg.forEach(r => r.evidence.split(' | ').filter(u => u.includes('/evidence/')).forEach(u => allFiles.add(u.split('/evidence/')[1])));
console.log(`Unique image files referenced: ${allFiles.size}`);

// Actual files on disk
const diskFiles = readdirSync('dashboard/public/evidence');
console.log(`Files on disk: ${diskFiles.length}`);

// Group by message ID (images from same message share prefix)
const messageGroups = new Map();
for (const f of [...allFiles]) {
    const msgId = f.split('_')[0];
    if (!messageGroups.has(msgId)) messageGroups.set(msgId, []);
    messageGroups.get(msgId).push(f);
}
console.log(`Unique messages with images: ${messageGroups.size}`);

// Print entries with images for processing
console.log('\n--- Entries with images (for Claude vision) ---');
withImg.forEach(r => {
    const imgs = r.evidence.split(' | ').filter(u => u.includes('/evidence/')).map(u => u.split('/evidence/')[1]);
    console.log(`${r.user_id} | ${r.username} | ${r.reason} | images: ${imgs.join(', ')}`);
});
