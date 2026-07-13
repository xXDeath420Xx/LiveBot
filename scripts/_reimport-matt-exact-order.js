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

    // Use same viewport as user's monitor
    console.log('Launching browser at 2560x1440...');
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 2560, height: 1440 });

    console.log('Navigating to RecoCards...');
    await page.goto(RECO_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('mat-card.example-card', { timeout: 15000 });

    // Scroll to load everything
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

    console.log('Extracting cards with column assignments...');
    const signatures = await page.evaluate(() => {
        const cards = document.querySelectorAll('mat-card.example-card');

        // Figure out which column each card belongs to by checking its parent .col element
        // RecoCards structure: .row > .col > span > card1 > mat-card
        const cols = document.querySelectorAll('.col.justify-content-center');
        const colCards = [];

        for (let colIdx = 0; colIdx < cols.length; colIdx++) {
            const colElement = cols[colIdx];
            const cardsInCol = colElement.querySelectorAll('mat-card.example-card');
            for (let posInCol = 0; posInCol < cardsInCol.length; posInCol++) {
                const card = cardsInCol[posInCol];
                const name = card.querySelector('mat-card-title, .mat-card-title')?.textContent?.trim() || '';
                const contentEl = card.querySelector('mat-card-content, .mat-card-content');
                const content = contentEl?.textContent?.trim() || '';
                const allImgs = Array.from(card.querySelectorAll('img'))
                    .map(i => i.src).filter(s => s && !s.includes('avatar') && s.startsWith('http'));

                let likes = 0;
                const likeBtn = Array.from(card.querySelectorAll('button')).find(b => b.textContent?.includes('like'));
                if (likeBtn) { const m = likeBtn.textContent.match(/(\d+)/); if (m) likes = parseInt(m[1]); }

                let fontColor = null, fontFamily = null, fontSize = null;
                if (contentEl) {
                    const styledDiv = contentEl.querySelector('div[style]');
                    const target = styledDiv || contentEl;
                    const cs = getComputedStyle(target);
                    const color = target.style.color || cs.color;
                    if (color && color !== 'rgb(31, 41, 55)' && color !== 'rgba(0, 0, 0, 0.87)') fontColor = color;
                    const ff = target.style.fontFamily || cs.fontFamily;
                    if (ff) {
                        const primary = ff.split(',')[0].replace(/["']/g, '').trim();
                        if (primary && !['Muli', 'Helvetica Neue', 'Roboto', 'sans-serif'].includes(primary)) fontFamily = primary;
                    }
                    const fs = parseInt(target.style.fontSize || cs.fontSize);
                    if (fs && fs !== 14 && fs !== 16) fontSize = fs;
                }

                let rotation = null;
                const style = card.getAttribute('style') || '';
                const rotMatch = style.match(/rotate\((-?[\d.]+)deg\)/);
                if (rotMatch && rotMatch[1] !== '0') rotation = parseFloat(rotMatch[1]);

                colCards.push({
                    column: colIdx,
                    positionInColumn: posInCol,
                    name,
                    content: content.substring(0, 5000),
                    image: allImgs[0] || null,
                    likes, fontColor, fontFamily, fontSize, rotation,
                });
            }
        }

        return { colCount: cols.length, cards: colCards };
    });

    const { colCount, cards } = signatures;
    console.log(`Found ${cards.length} cards across ${colCount} columns`);

    // Now interleave: read left-to-right by taking one card from each column in round-robin
    // Column 0 position 0, Column 1 position 0, Column 2 position 0, Column 3 position 0,
    // Column 0 position 1, Column 1 position 1, etc.
    const columns = [];
    for (let c = 0; c < colCount; c++) {
        columns.push(cards.filter(card => card.column === c).sort((a, b) => a.positionInColumn - b.positionInColumn));
    }

    // Find the max cards in any column
    const maxInCol = Math.max(...columns.map(c => c.length));

    // Interleave: row by row, left to right
    const orderedCards = [];
    for (let row = 0; row < maxInCol; row++) {
        for (let col = 0; col < colCount; col++) {
            if (row < columns[col].length) {
                orderedCards.push(columns[col][row]);
            }
        }
    }

    console.log(`\nInterleaved reading order (${orderedCards.length} cards):`);
    orderedCards.forEach((s, i) => {
        console.log(`  ${i + 1}. [col${s.column}:${s.positionInColumn}] ${s.name}`);
    });

    // Delete and re-insert
    await pool.execute('DELETE FROM birthday_card_signatures WHERE card_id = ?', [CARD_ID]);
    console.log('\nCleared existing signatures');

    for (let i = 0; i < orderedCards.length; i++) {
        const sig = orderedCards[i];
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

    console.log(`Inserted ${orderedCards.length} signatures in exact interleaved column order`);
    await browser.close();
    await pool.end();
    console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
