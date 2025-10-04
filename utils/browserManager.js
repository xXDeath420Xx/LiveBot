const playwright = require('playwright-core');

let browserContext = null;

async function getBrowser() {
    if (browserContext && browserContext.browser() && browserContext.browser().isConnected()) {
        return browserContext;
    }
    try {
        console.log('[BrowserManager] Initializing new persistent browser instance...');
        browserContext = await playwright.chromium.launchPersistentContext('./user-data-dir', {
            headless: true,
            executablePath: process.env.CHROME_EXECUTABLE_PATH, // Make sure to set this in your .env
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // Might help on low-resource systems
                '--disable-gpu'
            ],
        });
        browserContext.on('close', () => {
            console.log('[BrowserManager] Persistent browser context closed.');
            browserContext = null; // Reset browser instance on close
        });
        console.log('[BrowserManager] New browser instance launched successfully.');
        return browserContext;
    } catch (e) {
        console.error('[BrowserManager] FATAL: Could not launch browser:', e);
        browserContext = null;
        return null;
    }
}

async function closeBrowser() {
    // This function is now a no-op because we want to keep the browser persistent.
}

async function gracefulShutdown() {
    if (browserContext) {
        console.log('[BrowserManager] Gracefully shutting down persistent browser...');
        await browserContext.close();
        browserContext = null;
    }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

module.exports = { getBrowser, closeBrowser };
