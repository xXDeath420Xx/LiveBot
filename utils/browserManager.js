// utils/browserManager.js (Simplified and Corrected)
const { chromium } = require('playwright'); // Use the standard playwright library

let browser = null;
let launchPromise = null;

const getBrowser = async () => {
    if (browser && browser.isConnected()) return browser;
    if (launchPromise) return await launchPromise;

    try {
        console.log('[BrowserManager] Initiating local browser for TikTok...');
        
        launchPromise = chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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
    if (launchPromise) await launchPromise;
    if (browser) {
        await browser.close().catch(e => {});
        browser = null;
        console.log('[BrowserManager] Browser closed successfully.');
    }
};

module.exports = { getBrowser, closeBrowser };