import { getBrowser, closeBrowser } from './utils/browserManager.js';

async function inspectYouTube(username) {
    console.log(`\n=== Inspecting YouTube Page Source for: ${username} ===`);
    let browser = null;

    try {
        browser = await getBrowser();
        const page = await browser.newPage();

        const url = `https://www.youtube.com/@${username}/live`;
        console.log(`Loading: ${url}`);
        await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});

        const html = await page.content();

        // Look for live stream indicators in the HTML
        const hasIsLive = html.includes('"isLive":true') || html.includes('"isLiveContent":true');
        const hasLiveBadge = html.includes('ytp-live-badge') || html.includes('BADGE_STYLE_TYPE_LIVE_NOW');
        const hasWatchUrl = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);

        console.log(`Contains "isLive":true or "isLiveContent":true: ${hasIsLive}`);
        console.log(`Contains live badge classes: ${hasLiveBadge}`);
        console.log(`Contains /watch?v= URL: ${hasWatchUrl ? hasWatchUrl[0] : 'No'}`);

        if (hasWatchUrl) {
            console.log(`Found video ID: ${hasWatchUrl[1]}`);
            console.log(`Full URL: https://www.youtube.com${hasWatchUrl[0]}`);
        }

        // Save a portion of the HTML to inspect
        const fs = await import('fs');
        await fs.promises.writeFile('/root/youtube-source.txt', html);
        console.log('Full HTML saved to /root/youtube-source.txt');

    } catch (error) {
        console.error(`Error: ${error.message}`);
    } finally {
        if (browser) await closeBrowser(browser);
    }
}

async function inspectTrovo(username) {
    console.log(`\n=== Inspecting Trovo Page Source for: ${username} ===`);
    let browser = null;

    try {
        browser = await getBrowser();
        const page = await browser.newPage();

        const url = `https://trovo.live/s/${username}`;
        console.log(`Loading: ${url}`);
        await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(3000);

        const html = await page.content();

        // Look for various live indicators
        const hasIsLive = html.includes('"is_live":true') || html.includes('"isLive":true');
        const hasLiveClass = html.includes('live-indicator');
        const hasVideoElement = html.includes('<video');
        const hasStreamData = html.includes('streamerInfo') || html.includes('channelInfo');

        console.log(`Contains "is_live":true: ${hasIsLive}`);
        console.log(`Contains live-indicator class: ${hasLiveClass}`);
        console.log(`Contains <video> element: ${hasVideoElement}`);
        console.log(`Contains stream data: ${hasStreamData}`);

        // Save HTML for inspection
        const fs = await import('fs');
        await fs.promises.writeFile('/root/trovo-source.txt', html);
        console.log('Full HTML saved to /root/trovo-source.txt');

    } catch (error) {
        console.error(`Error: ${error.message}`);
    } finally {
        if (browser) await closeBrowser(browser);
    }
}

await inspectYouTube('xXDeath420Xx');
await inspectTrovo('xXDeath420Xx');

console.log('\n=== Inspection complete ===');
process.exit(0);
