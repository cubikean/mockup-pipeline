/**
 * capture.js
 * -----------------------------------------------------------------------
 * Capture d'écran automatisée d'une page web via Playwright (Chromium).
 * -----------------------------------------------------------------------
 */
const { chromium } = require('playwright');
const { sleep } = require('./util');

/**
 * Bannières de consentement masquées par défaut (Complianz et tarteaucitron,
 * les deux CMP les plus courants sur les sites WordPress francophones).
 * Surchargeable via `hideSelectors` — voir la config de projet.
 *
 * Ce sont des sélecteurs CSS : le préfixe `#`/`.` est obligatoire. Sans lui,
 * l'entrée est interprétée comme un nom de balise et ne matche jamais rien.
 */
const DEFAULT_HIDE_SELECTORS = [
  '#cmplz-cookiebanner-container',
  '.cmplz-cookiebanner',
  '#tarteaucitronAlertBig',
  '.tarteaucitronAlertBig',
];

/**
 * @typedef {Object} CaptureOptions
 * @property {string} url            URL à capturer
 * @property {number} [width=1440]   largeur du viewport
 * @property {number} [height=900]   hauteur du viewport
 * @property {number} [deviceScaleFactor=2]  facteur de résolution (2 = "retina")
 * @property {boolean} [fullPage=false]      capturer toute la page (scroll) au lieu du seul viewport
 * @property {number} [waitAfterLoadMs=5000]  délai supplémentaire après chargement (animations, lazy-load)
 * @property {string[]} [hideSelectors]      sélecteurs CSS à masquer avant capture (défaut: DEFAULT_HIDE_SELECTORS)
 * @property {number|string} [scrollTo]      position de défilement avant capture :
 *           un nombre = pixels depuis le haut de la page ; une chaîne = sélecteur
 *           CSS de l'élément à amener en haut du viewport.
 * @property {number} [waitAfterScrollMs=1000] délai après défilement (lazy-load, animations au scroll)
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
    fullPage = false,
    waitAfterLoadMs = 5000,
    hideSelectors = DEFAULT_HIDE_SELECTORS,
    scrollTo,
    waitAfterScrollMs = 1000,
    timeoutMs = 30000,
    retries = 3,
    retryBaseDelayMs = 5000,
  } = options;

  // Une capture pleine page fait défiler la page de haut en bas : la position
  // de défilement demandée n'aurait aucun effet visible sur le résultat.
  if (scrollTo != null && fullPage) {
    console.warn('  ⚠ scrollTo est ignoré avec fullPage: true (la page entière est capturée)');
  }

  // PLAYWRIGHT_CHROMIUM_PATH permet de forcer un binaire Chromium précis
  // (utile dans certains environnements sandboxés/CI où le Chromium fourni
  // par `npx playwright install` n'est pas au chemin par défaut).
  const launchOpts = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  // `browser.close()` ferme aussi contextes et pages : un seul finally suffit.
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
        return await attemptCapture(page, {
          url,
          fullPage,
          waitAfterLoadMs,
          hideSelectors,
          scrollTo,
          waitAfterScrollMs,
          timeoutMs,
        });
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
    throw lastError;
  } finally {
    await browser.close();
  }
}

/**
 * Une tentative de capture sur une page déjà ouverte. Toute erreur remonte
 * telle quelle à la boucle de retry de `captureScreenshot`.
 * @returns {Promise<Buffer>}
 */
async function attemptCapture(page, { url, fullPage, waitAfterLoadMs, hideSelectors, scrollTo, waitAfterScrollMs, timeoutMs }) {
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

  if (scrollTo != null && !fullPage) {
    await applyScroll(page, scrollTo);
    // Le défilement déclenche souvent du lazy-load et des animations d'entrée :
    // capturer immédiatement donnerait des images ou des blocs encore vides.
    if (waitAfterScrollMs > 0) {
      await page.waitForTimeout(waitAfterScrollMs);
    }
  }

  return page.screenshot({ type: 'png', fullPage });
}

/**
 * Amène la page à la position de défilement demandée.
 *   - nombre : pixels depuis le haut de la page
 *   - chaîne : sélecteur CSS de l'élément à amener en haut du viewport
 *
 * Le défilement est forcé en `instant` : un site qui déclare
 * `scroll-behavior: smooth` animerait le déplacement, et la capture partirait
 * pendant l'animation, à une position intermédiaire imprévisible.
 *
 * Un sélecteur sans correspondance n'interrompt pas la capture : mieux vaut un
 * visuel non défilé qu'un lot entier qui échoue à cause d'une page atypique.
 * @param {import('playwright').Page} page
 * @param {number|string} scrollTo
 */
async function applyScroll(page, scrollTo) {
  if (typeof scrollTo === 'number') {
    await page.evaluate((top) => window.scrollTo({ top, left: 0, behavior: 'instant' }), scrollTo);
    return;
  }

  const target = page.locator(scrollTo).first();
  if ((await target.count()) === 0) {
    console.warn(`  ⚠ scrollTo: aucun élément ne correspond au sélecteur "${scrollTo}" — capture sans défilement`);
    return;
  }
  await target.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
}

module.exports = { captureScreenshot, DEFAULT_HIDE_SELECTORS };
