import dotenv from 'dotenv';
dotenv.config();
import mysql from 'mysql2/promise';
import puppeteer from 'puppeteer';

const CARD_ID = 4;
const RECO_URL = 'https://recocards.com/board/happy-birthday-matt-142014991945';

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });

    console.log('Launching browser at 1440x900...');
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    console.log('Navigating to RecoCards...');
    await page.goto(RECO_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('mat-card.example-card', { timeout: 15000 });

    // Scroll to load all cards
    await page.evaluate(async () => {
        let lastHeight = 0;
        for (let i = 0; i < 50; i++) {
            window.scrollBy(0, 2000);
            await new Promise(r => setTimeout(r, 300));
            if (document.body.scrollHeight === lastHeight && i > 10) break;
            lastHeight = document.body.scrollHeight;
        }
        window.scrollTo(0, 0);
    });
    await new Promise(r => setTimeout(r, 3000));

    console.log('Extracting cards with visual positions...');
    const signatures = await page.evaluate(() => {
        const cards = document.querySelectorAll('mat-card.example-card');
        const results = [];

        for (const card of cards) {
            const rect = card.getBoundingClientRect();
            const name = card.querySelector('mat-card-title, .mat-card-title')?.textContent?.trim() || '';
            const contentEl = card.querySelector('mat-card-content, .mat-card-content');
            const content = contentEl?.textContent?.trim() || '';
            const allImgs = Array.from(card.querySelectorAll('img'))
                .map(i => i.src)
                .filter(s => s && !s.includes('avatar') && s.startsWith('http'));

            // Likes
            let likes = 0;
            const likeBtn = Array.from(card.querySelectorAll('button')).find(b => b.textContent?.includes('like'));
            if (likeBtn) {
                const m = likeBtn.textContent.match(/(\d+)/);
                if (m) likes = parseInt(m[1]);
            }

            // Font extraction
            let fontColor = null, fontFamily = null, fontSize = null;
            if (contentEl) {
                const styledDiv = contentEl.querySelector('div[style]');
                const target = styledDiv || contentEl;
                const cs = getComputedStyle(target);
                const color = target.style.color || cs.color;
                if (color && color !== 'rgb(31, 41, 55)' && color !== 'rgba(0, 0, 0, 0.87)') fontColor = color;
                const ff = target.style.fontFamily || cs.fontFamily;
                if (ff) {
                    const parts = ff.split(',');
                    const primary = parts[0].replace(/["']/g, '').trim();
                    if (primary && !['Muli', 'Helvetica Neue', 'Roboto', 'sans-serif'].includes(primary)) fontFamily = primary;
                }
                const fs = parseInt(target.style.fontSize || cs.fontSize);
                if (fs && fs !== 14 && fs !== 16) fontSize = fs;
            }

            // Rotation
            let rotation = null;
            const style = card.getAttribute('style') || '';
            const rotMatch = style.match(/rotate\((-?[\d.]+)deg\)/);
            if (rotMatch && rotMatch[1] !== '0') rotation = parseFloat(rotMatch[1]);

            results.push({
                name,
                content: content.substring(0, 5000),
                image: allImgs[0] || null,
                likes,
                fontColor, fontFamily, fontSize, rotation,
                // Visual position for sorting
                visualTop: Math.round(rect.top),
                visualLeft: Math.round(rect.left),
            });
        }

        return results.filter(s => s.name || s.content.length > 5);
    });

    console.log(`Extracted ${signatures.length} cards with positions`);

    // Sort by visual reading order: top-to-bottom rows, left-to-right within each row
    // Group cards into rows (cards within 100px vertical distance are in the same row)
    signatures.sort((a, b) => {
        const rowA = Math.floor(a.visualTop / 100);
        const rowB = Math.floor(b.visualTop / 100);
        if (rowA !== rowB) return rowA - rowB;
        return a.visualLeft - b.visualLeft;
    });

    // Log the reading order
    console.log('\nVisual reading order:');
    signatures.forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.name} (top:${s.visualTop} left:${s.visualLeft})`);
    });

    // Delete existing and re-insert in visual order
    await pool.execute('DELETE FROM birthday_card_signatures WHERE card_id = ?', [CARD_ID]);
    console.log('\nCleared existing signatures');

    for (let i = 0; i < signatures.length; i++) {
        const sig = signatures[i];
        let hexColor = sig.fontColor;
        if (hexColor && hexColor.startsWith('rgb')) {
            const m = hexColor.match(/\d+/g);
            if (m && m.length >= 3) hexColor = '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
        }

        await pool.execute(
            `INSERT INTO birthday_card_signatures
             (card_id, signer_user_id, signer_username, message, gif_url, likes, font_color, font_family, font_size, rotation)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [CARD_ID, `recocard_${i}`, sig.name || 'Anonymous', sig.content || '(no message)',
             sig.image, sig.likes || 0, hexColor || null, sig.fontFamily || null,
             sig.fontSize || null, sig.rotation || null]
        );
    }

    console.log(`Inserted ${signatures.length} signatures in visual reading order`);

    const [check] = await pool.execute('SELECT COUNT(*) as c FROM birthday_card_signatures WHERE card_id = ?', [CARD_ID]);
    console.log(`Verified: ${check[0].c} signatures`);

    await browser.close();
    await pool.end();
    console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
