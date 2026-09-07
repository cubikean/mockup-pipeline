/**
 * capture.js
 * -----------------------------------------------------------------------
 * Capture d'écran automatisée d'une page web via Playwright (Chromium).
 * -----------------------------------------------------------------------
 */
const { chromium } = require('playwright');
const { sleep } = require('./util');

/**
 * @typedef {Object} CaptureOptions
 * @property {string} url            URL à capturer
 * @property {number} [width=1440]   largeur du viewport
 * @property {number} [height=900]   hauteur du viewport
 * @property {number} [deviceScaleFactor=2]  facteur de résolution (2 = "retina")
 * @property {boolean} [fullPage=false]      capturer toute la page (scroll) au lieu du seul viewport
 * @property {number} [waitAfterLoadMs=5000]  délai supplémentaire après chargement (animations, lazy-load)
 * @property {string[]} [hideSelectors=[]]   sélecteurs CSS à masquer avant capture (ex: bannières cookies)
 * @property {number} [timeoutMs=30000]      timeout de navigation
 * @property {number} [retries=3]            nombre de tentatives en cas d'échec (429, 5xx, timeout...)
 * @property {number} [retryBaseDelayMs=5000] délai de base avant nouvelle tentative (doublé à chaque échec)
 */

/**
 * Prend une capture d'écran d'une URL et retourne un Buffer PNG.
 * Réessaie automatiquement (backoff exponentiel) en cas de 429 ("Too Many
 * Requests"), d'erreur serveur (5xx) ou de timeout réseau — utile quand le
 * site cible limite le débit de requêtes venant d'un même client.
 * @param {CaptureOptions} options
 * @returns {Promise<Buffer>}
 */
async function captureScreenshot(options) {
  const {
    url,
    width = 1440,
    height = 900,
    deviceScaleFactor = 2,
    fullPage = true,
    waitAfterLoadMs = 5000,
    hideSelectors = ["cmplz-cookiebanner-container", "cmplz-cookiebanner", ".cmplz-cookiebanner"],
    timeoutMs = 30000,
    retries = 3,
    retryBaseDelayMs = 5000,
  } = options;

  // PLAYWRIGHT_CHROMIUM_PATH permet de forcer un binaire Chromium précis
  // (utile dans certains environnements sandboxés/CI où le Chromium fourni
  // par `npx playwright install` n'est pas au chemin par défaut).
  const launchOpts = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOpts);
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor,
    });
    const page = await context.newPage();

    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        let response;
        try {
          response = await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
        } catch {
          // Certains sites ne deviennent jamais "networkidle" (polling, websockets...).
          response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
        }

        const status = response ? response.status() : null;
        if (status === 429) {
          throw new Error(`HTTP 429 Too Many Requests sur ${url} — le site limite le débit de requêtes`);
        }
        if (status && status >= 500) {
          throw new Error(`HTTP ${status} sur ${url}`);
        }

        if (waitAfterLoadMs > 0) {
          await page.waitForTimeout(waitAfterLoadMs);
        }

        for (const selector of hideSelectors) {
          await page
            .locator(selector)
            .evaluateAll((els) => els.forEach((el) => (el.style.display = 'none')))
            .catch(() => {});
        }

        const buffer = await page.screenshot({ type: 'png', fullPage });
        await context.close();
        return buffer;
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          const backoff = retryBaseDelayMs * 2 ** (attempt - 1);
          console.warn(
            `  ⚠ tentative ${attempt}/${retries} échouée pour ${url} (${err.message}) — nouvel essai dans ${Math.round(
              backoff / 1000
            )}s`
          );
          await sleep(backoff);
        }
      }
    }
    await context.close().catch(() => {});
    throw lastError;
  } finally {
    await browser.close();
  }
}



module.exports = { captureScreenshot };
