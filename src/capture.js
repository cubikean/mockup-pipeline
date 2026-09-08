/**
 * capture.js
 * -----------------------------------------------------------------------
 * Capture d'écran automatisée d'une page web via Playwright (Chromium).
 *
 * Deux modes :
 *   - `captureScreenshot()` : une image fixe, éventuellement après défilement ;
 *   - `captureScrollSequence()` : une série d'images entre deux positions de
 *     défilement, pour en faire un GIF animé (voir gif.js).
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
  const { fullPage = false, scrollTo, waitAfterScrollMs = 1000 } = options;

  // Une capture pleine page fait défiler la page de haut en bas : la position
  // de défilement demandée n'aurait aucun effet visible sur le résultat.
  if (scrollTo != null && fullPage) {
    console.warn('  ⚠ scrollTo est ignoré avec fullPage: true (la page entière est capturée)');
  }

  return withPage(options, (page) =>
    attempt(options, async () => {
      await openPage(page, options);

      if (scrollTo != null && !fullPage) {
        await applyScroll(page, scrollTo);
        // Le défilement déclenche souvent du lazy-load et des animations
        // d'entrée : capturer immédiatement donnerait des images ou des blocs
        // encore vides.
        await page.waitForTimeout(waitAfterScrollMs);
      }

      return page.screenshot({ type: 'png', fullPage });
    })
  );
}

/**
 * @typedef {CaptureOptions & Object} ScrollSequenceOptions
 * @property {number|string} [scrollFrom=0] position de départ (px ou sélecteur CSS)
 * @property {number|string} [scrollTo]     position d'arrivée (px ou sélecteur CSS) ;
 *           par défaut le bas de la page
 * @property {number} [frames=36]           nombre d'images à capturer
 * @property {'linear'|'ease-in-out'} [easing='ease-in-out'] répartition des positions
 * @property {number} [frameSettleMs=40]    délai avant chaque image (rendu du défilement)
 */

/**
 * Capture une série d'images entre deux positions de défilement d'une même
 * page. Chaque image est passée à `onFrame` dès qu'elle est prête plutôt que
 * d'être accumulée : une séquence de plusieurs dizaines de captures "retina"
 * tiendrait sinon plusieurs centaines de Mo en mémoire.
 *
 * `onFrame` reçoit l'index de l'image : une tentative rejouée après échec
 * repart de zéro, et le consommateur doit indexer plutôt qu'empiler s'il ne
 * veut pas se retrouver avec des doublons.
 *
 * @param {ScrollSequenceOptions} options
 * @param {(frame: Buffer, index: number, total: number) => Promise<void>} onFrame
 * @returns {Promise<{from:number, to:number, frames:number}>} positions réellement utilisées
 */
async function captureScrollSequence(options, onFrame) {
  const {
    scrollFrom = 0,
    scrollTo,
    frames = 36,
    easing = 'ease-in-out',
    waitAfterScrollMs = 1000,
    frameSettleMs = 40,
  } = options;

  return withPage(options, (page) =>
    attempt(options, async () => {
      await openPage(page, options);

      const maxScroll = await page.evaluate(
        () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      );
      const from = clamp(await resolveScrollPosition(page, scrollFrom), 0, maxScroll);
      // Sans position d'arrivée, on descend jusqu'en bas de la page.
      const to = clamp(scrollTo == null ? maxScroll : await resolveScrollPosition(page, scrollTo), 0, maxScroll);

      // Un site qui charge ses images au défilement montrerait des blocs vides
      // pendant l'animation : on parcourt une fois la plage pour tout déclencher,
      // puis on revient au point de départ.
      await primeLazyLoading(page, from, to);
      await scrollToPixels(page, from);
      await page.waitForTimeout(waitAfterScrollMs);

      const positions = interpolate(from, to, frames, easing);
      for (const [index, top] of positions.entries()) {
        await scrollToPixels(page, top);
        if (frameSettleMs > 0) await page.waitForTimeout(frameSettleMs);
        await onFrame(await page.screenshot({ type: 'png' }), index, positions.length);
      }

      return { from, to, frames: positions.length };
    })
  );
}

/**
 * Ouvre un navigateur, exécute `fn(page)`, puis referme tout.
 * `browser.close()` ferme aussi contextes et pages : un seul finally suffit.
 */
async function withPage({ width = 1440, height = 900, deviceScaleFactor = 2 }, fn) {
  // PLAYWRIGHT_CHROMIUM_PATH permet de forcer un binaire Chromium précis
  // (utile dans certains environnements sandboxés/CI où le Chromium fourni
  // par `npx playwright install` n'est pas au chemin par défaut).
  const launchOpts = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOpts);
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
    return await fn(await context.newPage());
  } finally {
    await browser.close();
  }
}

/**
 * Rejoue `fn` en espaçant les tentatives (backoff exponentiel) tant qu'elle
 * échoue. Toute erreur de la dernière tentative remonte telle quelle.
 */
async function attempt({ url, retries = 3, retryBaseDelayMs = 5000 }, fn) {
  let lastError;
  for (let n = 1; n <= retries; n++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (n < retries) {
        const backoff = retryBaseDelayMs * 2 ** (n - 1);
        console.warn(
          `  ⚠ tentative ${n}/${retries} échouée pour ${url} (${err.message}) — nouvel essai dans ${Math.round(
            backoff / 1000
          )}s`
        );
        await sleep(backoff);
      }
    }
  }
  throw lastError;
}

/**
 * Charge l'URL et prépare la page : attente des contenus différés puis
 * masquage des bannières. Toute erreur remonte à la boucle de `attempt`.
 */
async function openPage(page, { url, waitAfterLoadMs = 5000, hideSelectors = DEFAULT_HIDE_SELECTORS, timeoutMs = 30000 }) {
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
    await scrollToPixels(page, scrollTo);
    return;
  }

  const target = page.locator(scrollTo).first();
  if ((await target.count()) === 0) {
    console.warn(`  ⚠ scrollTo: aucun élément ne correspond au sélecteur "${scrollTo}" — capture sans défilement`);
    return;
  }
  await target.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
}

/**
 * Traduit une valeur `scrollTo` en pixels depuis le haut de la page. Une
 * séquence animée a besoin d'un nombre pour interpoler les positions
 * intermédiaires, là où une capture fixe peut se contenter d'un
 * `scrollIntoView`.
 *
 * Un sélecteur sans correspondance retombe sur le haut de page, avec un
 * avertissement : cohérent avec `applyScroll`.
 * @returns {Promise<number>}
 */
async function resolveScrollPosition(page, value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;

  const target = page.locator(value).first();
  if ((await target.count()) === 0) {
    console.warn(`  ⚠ aucun élément ne correspond au sélecteur "${value}" — position ramenée au haut de page`);
    return 0;
  }
  return target.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
}

/** Défilement instantané à une position absolue, en pixels. */
const scrollToPixels = (page, top) =>
  page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), Math.round(top));

/**
 * Parcourt la plage à capturer par grands pas pour déclencher lazy-load et
 * animations d'apparition avant la capture de la séquence.
 */
async function primeLazyLoading(page, from, to) {
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    await scrollToPixels(page, from + ((to - from) * i) / steps);
    await page.waitForTimeout(120);
  }
}

/**
 * Positions successives entre `from` et `to`.
 *   - `linear` : vitesse constante
 *   - `ease-in-out` : démarrage et arrêt progressifs, ce qui laisse le temps
 *     de lire le haut et le bas de la séquence — plus lisible en boucle.
 * @returns {number[]}
 */
function interpolate(from, to, frames, easing) {
  const count = Math.max(2, Math.round(frames));
  const ease = easing === 'linear' ? (t) => t : (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  return Array.from({ length: count }, (_, i) => from + (to - from) * ease(i / (count - 1)));
}

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

module.exports = { captureScreenshot, captureScrollSequence, DEFAULT_HIDE_SELECTORS };
