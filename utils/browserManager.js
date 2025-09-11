const { chromium } = require('playwright');

let browser = null;
let launchPromise = null;

// Determine browser launch arguments based on environment variables
const getLaunchArgs = () => {
    const args = ['--disable-dev-shm-usage']; // Generally safe and recommended

    // --no-sandbox is a security risk if the browser navigates to untrusted content.
    // Only enable if explicitly allowed and understood, e.g., in controlled container environments.
    if (process.env.PLAYWRIGHT_NO_SANDBOX === 'true') {
        args.push('--no-sandbox', '--disable-setuid-sandbox');
    }
    return args;
};

const getBrowser = async () => {
    if (browser && browser.isConnected()) return browser;
    if (launchPromise) return await launchPromise;

    try {
        console.log('[BrowserManager] Initiating local browser for TikTok...');
        
        // Make headless mode configurable via environment variable
        const isHeadless = process.env.PLAYWRIGHT_HEADLESS !== 'false'; // Default to true

        launchPromise = chromium.launch({
            headless: isHeadless,
            args: getLaunchArgs()
        });

        browser = await launchPromise;
        console.log('[BrowserManager] Local browser launched successfully.');
        launchPromise = null;

        browser.on('disconnected', () => {
            console.error('[BrowserManager] Browser disconnected unexpectedly.');
            browser = null;
        });
        return browser;
    } catch (error) {
        console.error('[BrowserManager] FATAL: Could not launch browser:', error);
        browser = null;
        launchPromise = null;
        return null;
    }
};

const closeBrowser = async () => {
    // If a launch is in progress, wait for it to complete before attempting to close.
    if (launchPromise) await launchPromise;
    if (browser) {
        await browser.close().catch(e => {
            console.warn('[BrowserManager] Error closing browser gracefully:', e);
        });
        browser = null;
        console.log('[BrowserManager] Browser closed successfully.');
    }
};

module.exports = { getBrowser, closeBrowser };