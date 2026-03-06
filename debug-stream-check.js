import { getBrowser, closeBrowser } from './utils/browserManager.js';
import logger from './utils/logger.js';

async function debugYouTube(username) {
    console.log(`\n=== Debugging YouTube for: ${username} ===`);
    let browser = null;

    try {
        browser = await getBrowser();
        const page = await browser.newPage();

        // Try username format
        let url = `https://www.youtube.com/@${username}/live`;
        console.log(`Trying URL: ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        console.log(`Final URL: ${page.url()}`);
        console.log(`Page title: ${await page.title()}`);

        // Check for live badge
        const liveBadge = await page.locator('span.ytp-live-badge').isVisible({ timeout: 5000 }).catch(() => false);
        console.log(`Live badge visible: ${liveBadge}`);

        // Try to find ANY live indicators
        const pageContent = await page.content();
        const hasLiveText = pageContent.includes('LIVE') || pageContent.includes('live');
        console.log(`Page contains 'LIVE' text: ${hasLiveText}`);

        // Save screenshot
        await page.screenshot({ path: '/root/youtube-debug.png' });
        console.log('Screenshot saved to /root/youtube-debug.png');

    } catch (error) {
        console.error(`Error: ${error.message}`);
    } finally {
        if (browser) await closeBrowser(browser);
    }
}

async function debugTrovo(username) {
    console.log(`\n=== Debugging Trovo for: ${username} ===`);
    let browser = null;

    try {
        browser = await getBrowser();
        const page = await browser.newPage();

        const url = `https://trovo.live/s/${username}`;
        console.log(`Trying URL: ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        console.log(`Final URL: ${page.url()}`);
        console.log(`Page title: ${await page.title()}`);

        // Check for live indicator
        const liveIndicator = await page.locator('.live-indicator-ctn').isVisible({ timeout: 5000 }).catch(() => false);
        console.log(`Live indicator (.live-indicator-ctn) visible: ${liveIndicator}`);

        // Try alternative selectors
        const liveStatus = await page.locator('[class*="live"]').count();
        console.log(`Elements with 'live' in class: ${liveStatus}`);

        // Check page content
        const pageContent = await page.content();
        const hasLiveText = pageContent.includes('LIVE') || pageContent.toLowerCase().includes('streaming');
        console.log(`Page contains LIVE/streaming text: ${hasLiveText}`);

        // Save screenshot
        await page.screenshot({ path: '/root/trovo-debug.png' });
        console.log('Screenshot saved to /root/trovo-debug.png');

    } catch (error) {
        console.error(`Error: ${error.message}`);
    } finally {
        if (browser) await closeBrowser(browser);
    }
}

// Run both
await debugYouTube('xXDeath420Xx');
await debugTrovo('xXDeath420Xx');

console.log('\n=== Debug complete ===');
process.exit(0);
