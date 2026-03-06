import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('audit-import-ready.json', 'utf8'));
const done = JSON.parse(readFileSync('audit-image-reasons.json', 'utf8'));
const doneImages = new Set(done.entries.map(e => e.image));

const rows = data.rows.filter(r => r.evidence && r.evidence.includes('certifriedmultitool.com/evidence/'));
const remaining = [];

for (const r of rows) {
  const imgs = r.evidence.split(' | ').filter(u => u.includes('/evidence/')).map(u => u.split('/evidence/')[1]);
  const unreviewed = imgs.filter(i => !doneImages.has(i));
  if (unreviewed.length > 0) {
    remaining.push({ user_id: r.user_id, username: r.username, reason: r.reason, images: unreviewed });
  }
}

console.log(`Remaining entries to review: ${remaining.length}`);
remaining.forEach((r, i) => console.log(`${i + 1}. ${r.user_id} | ${r.username} | images: ${r.images.join(', ')}`));
