const playwright = require("playwright-core");
const logger = require("./logger");

let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }
  
  // If the browser is not connected, reset it to null to force re-launch
  if (browser) {
    logger.warn("[BrowserManager] Browser was disconnected. Attempting to relaunch.");
    browser = null;
  }

  try {
    logger.info("[BrowserManager] Initializing new persistent browser instance...");
    browser = await playwright.chromium.launchPersistentContext("./user-data-dir", {
      headless: true,
      executablePath: process.env.CHROME_EXECUTABLE_PATH, // Make sure to set this in your .env
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process", // Might help on low-resource systems
        "--disable-gpu"
      ],
    });
    browser.on("close", () => {
      logger.warn("[BrowserManager] Persistent browser instance was closed unexpectedly.");
      browser = null; // Reset browser instance on close
    });
    logger.info("[BrowserManager] New browser instance launched successfully.");
    return browser;
  } catch (e) {
    logger.error("[BrowserManager] FATAL: Could not launch browser:", e);
    return null;
  }
}

async function gracefulShutdown() {
  if (browser) {
    logger.info("[BrowserManager] Gracefully shutting down persistent browser...");
    await browser.close();
    browser = null;
  }
}

module.exports = { getBrowser, gracefulShutdown };