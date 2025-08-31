const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

let browser = null;

const getBrowser = async () => {
    if (browser) {
        return browser;
    }
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process'
            ]
        });
        return browser;
    } catch (error) {
        console.error('[BrowserManager] Could not launch browser:', error);
        return null;
    }
};

const closeBrowser = async () => {
    if (browser) {
        await browser.close();
        browser = null;
    }
};

module.exports = { getBrowser, closeBrowser };

