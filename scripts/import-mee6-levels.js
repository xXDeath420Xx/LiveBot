import 'dotenv/config';
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../utils/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GUILD_ID = process.argv[2] || '1469931133981687873';
const OUT_DIR = join(__dirname, 'migration-data', GUILD_ID === '1469931133981687873' ? 'forsaken-warriors' : GUILD_ID);
const HEADFUL = process.argv.includes('--headful');
const DRY_RUN = process.argv.includes('--dry-run');
const USE_EDGE = process.argv.includes('--edge');

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

function log(...a) { console.log('[mee6-import]', ...a); }

async function scrape() {
  const launchOpts = { headless: !HEADFUL };
  if (USE_EDGE) launchOpts.channel = 'msedge';

  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' });
  const page = await ctx.newPage();
  const url = `https://mee6.xyz/en/leaderboard/${GUILD_ID}`;
  log('navigating to', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const dumpHtml = await page.content();
  writeFileSync(join(OUT_DIR, `mee6-page-source-${Date.now()}.html`), dumpHtml);

  const data = await page.evaluate(() => {
    const tryWindowData = () => {
      try {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const m = s.textContent && s.textContent.match(/__NEXT_DATA__\s*=\s*({[\s\S]+?})\s*[<;]/);
          if (m) {
            const parsed = JSON.parse(m[1]);
            return parsed;
          }
        }
        if (typeof window !== 'undefined' && window.__NEXT_DATA__) return window.__NEXT_DATA__;
      } catch {}
      return null;
    };
    const nextData = tryWindowData();

    const rows = [];
    const all = document.querySelectorAll('a[href^="/en/leaderboard/"]:not([href$="' + location.pathname.split('/').pop() + '"]), .leaderboard-user, [class*="leaderboard"][class*="row"], [class*="LeaderboardRow"], [class*="player"]');
    document.querySelectorAll('img[src*="/avatars/"], img[src*="cdn.discordapp.com/avatars"]').forEach(img => {
      const m = img.src.match(/\/avatars\/(\d{15,21})\//);
      if (!m) return;
      const userId = m[1];
      let row = img.closest('div, li, tr, a');
      while (row && row.parentElement && row.textContent && row.textContent.length < 4) row = row.parentElement;
      const text = (row?.textContent || '').replace(/\s+/g, ' ').trim();
      const lvlMatch = text.match(/(?:LVL|Level|LV)[\s:]*([0-9]+)/i) || text.match(/\b([0-9]+)\b\s*(?:LVL|Level|LV)/i);
      const xpMatch = text.match(/([\d,\.]+)\s*\/\s*([\d,\.]+)\s*XP/i) || text.match(/([\d,\.]+)\s*XP/i);
      const usernameNode = row?.querySelector('[class*="username"], [class*="name"], strong, b, h2, h3');
      let username = usernameNode?.textContent?.trim() || null;
      if (!username) {
        const parts = text.split(/\s{2,}|\|/).map(s => s.trim()).filter(Boolean);
        username = parts[0] || null;
      }
      const level = lvlMatch ? parseInt(lvlMatch[1], 10) : null;
      const xp = xpMatch ? parseInt(xpMatch[1].replace(/[,\.]/g, ''), 10) : null;
      rows.push({ user_id: userId, username, level, xp, raw_text: text.slice(0, 200) });
    });

    return { nextData: nextData ? '(captured separately)' : null, rows, html_chunk: document.body.innerHTML.slice(0, 5000) };
  });

  const nextDataRaw = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent : null;
  });

  if (nextDataRaw) {
    try {
      const parsed = JSON.parse(nextDataRaw);
      const players = parsed?.props?.pageProps?.leaderboard?.players;
      if (Array.isArray(players) && players.length) {
        log(`__NEXT_DATA__ exposed ${players.length} players — using that as authoritative source`);
        const fromNext = players.map(p => ({
          user_id: String(p.id),
          username: p.username || p.global_name || p.name || null,
          discriminator: p.discriminator || null,
          avatar: p.avatar || null,
          level: typeof p.level === 'number' ? p.level : null,
          xp: typeof p.xp === 'number' ? p.xp : null,
          message_count: typeof p.message_count === 'number' ? p.message_count : null,
          detail_xp: p.detail_xp || null,
        }));
        writeFileSync(join(OUT_DIR, 'mee6-nextdata-raw.json'), JSON.stringify(parsed, null, 2));
        await browser.close();
        return fromNext;
      }
    } catch (e) {
      log('failed to parse __NEXT_DATA__:', e.message);
    }
  }

  await browser.close();

  const seen = new Set();
  const dedup = data.rows.filter(r => {
    if (seen.has(r.user_id)) return false;
    seen.add(r.user_id);
    return r.user_id && r.username;
  });
  return dedup;
}

async function upsertLevels(players) {
  if (DRY_RUN) {
    log(`DRY RUN: would upsert ${players.length} rows into user_levels for guild ${GUILD_ID}`);
    return { inserted: 0, skipped: players.length };
  }
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const p of players) {
    if (!p.user_id || (p.xp == null && p.level == null)) {
      skipped++;
      continue;
    }
    const xp = p.xp ?? 0;
    const level = p.level ?? 0;
    const [existing] = await pool.execute(
      'SELECT id, xp, level FROM user_levels WHERE guild_id = ? AND user_id = ? LIMIT 1',
      [GUILD_ID, p.user_id]
    );
    if (existing.length === 0) {
      await pool.execute(
        'INSERT INTO user_levels (guild_id, user_id, xp, level, last_message_timestamp) VALUES (?, ?, ?, ?, NOW())',
        [GUILD_ID, p.user_id, xp, level]
      );
      inserted++;
    } else {
      const cur = existing[0];
      if (xp > cur.xp) {
        await pool.execute(
          'UPDATE user_levels SET xp = ?, level = ? WHERE id = ?',
          [xp, level, cur.id]
        );
        updated++;
      } else {
        skipped++;
      }
    }
  }
  return { inserted, updated, skipped };
}

(async () => {
  try {
    log(`scraping MEE6 leaderboard for guild ${GUILD_ID} (${HEADFUL ? 'headful' : 'headless'}${USE_EDGE ? ', Edge' : ''}${DRY_RUN ? ', DRY-RUN' : ''})`);
    const players = await scrape();
    if (!players.length) {
      log('NO PLAYERS scraped — aborting before any DB writes. Check the saved HTML dump in:', OUT_DIR);
      process.exit(2);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = join(OUT_DIR, `mee6-leaderboard-${stamp}.json`);
    writeFileSync(out, JSON.stringify({ guild_id: GUILD_ID, scraped_at: new Date().toISOString(), count: players.length, players }, null, 2));
    log(`scraped ${players.length} players → ${out}`);

    const result = await upsertLevels(players);
    log('user_levels result:', result);
    log('done.');
  } catch (e) {
    console.error('[mee6-import] FAIL', e.stack || e);
    process.exit(1);
  } finally {
    if (pool && pool.end) await pool.end();
  }
})();
