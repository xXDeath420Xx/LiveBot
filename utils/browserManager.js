const { chromium } = require('playwright');
let browser = null;
let launchPromise = null;

const getBrowser = async () => {
    if (browser && browser.isConnected()) return browser;
    if (launchPromise) return await launchPromise;
    try {
        console.log('[BrowserManager] Initiating new PLAYWRIGHT browser launch...');
        launchPromise = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        browser = await launchPromise;
        console.log('[BrowserManager] Playwright browser launched successfully.');
        launchPromise = null;
        browser.on('disconnected', () => {
            console.error('[BrowserManager] Browser disconnected unexpectedly.');
            browser = null;
        });
        return browser;
    } catch (error) {
        console.error('[BrowserManager] FATAL: Could not launch Playwright browser:', error);
        browser = null;
        launchPromise = null;
        return null;
    }
};
const closeBrowser = async () => {
    if (launchPromise) await launchPromise;
    if (browser) {
        await browser.close().catch(e => {});
        browser = null;
    }
};
module.exports = { getBrowser, closeBrowser };