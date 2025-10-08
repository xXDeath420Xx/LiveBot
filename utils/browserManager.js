const playwright = require('playwright-core');
const logger = require('./logger');

/**
 * Launches a new, isolated browser instance.
 * This is more stable in a multi-process environment than a single persistent context.
 * @returns {Promise<import('playwright-core').Browser|null>}
 */
async function getBrowser() {
    try {
        const browser = await playwright.chromium.launch({
            headless: true,
            executablePath: process.env.CHROME_EXECUTABLE_PATH,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
        });
        return browser;
    } catch (e) {
        logger.error('[BrowserManager] FATAL: Could not launch browser:', e);
        return null;
    }
}

/**
 * Gracefully closes a browser instance.
 * @param {import('playwright-core').Browser} browser The browser instance to close.
 */
async function closeBrowser(browser) {
    if (browser && browser.isConnected()) {
        await browser.close();
    }
}

module.exports = { getBrowser, closeBrowser };
