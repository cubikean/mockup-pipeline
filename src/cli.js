#!/usr/bin/env node
/**
 * cli.js
 * -----------------------------------------------------------------------
 * Point d'entrée du pipeline. Deux usages :
 *
 *   1) Mode batch (recommandé) : tout un lot de projets décrit dans un
 *      fichier JSON est traité en une commande.
 *        node src/cli.js batch --config config/projects.json
 *
 *   2) Mode ponctuel : générer rapidement un seul mockup, une galerie, un
 *      carrousel ou un GIF sans écrire de config.
 *        node src/cli.js hero --url https://exemple.fr --name exemple --template desktop
 *        node src/cli.js gallery --base-url https://exemple.fr --name exemple --pages /,/contact,/equipe
 *        node src/cli.js carousel --base-url https://exemple.fr --name exemple --pages /,/contact
 *        node src/cli.js gif --url https://exemple.fr --name exemple --scroll "#contact" --seconds 3
 *
 * Les variantes suivent le même traitement — capturer chaque page, l'habiller,
 * l'écrire — et ne diffèrent que par leurs valeurs par défaut et le nom du
 * fichier produit. Elles sont donc décrites dans la table `VARIANTS` et
 * exécutées par `generate()`. Seule `gif` capture plusieurs images par page
 * (une par position de défilement) et les encode en animation.
 *
 * Limiter le débit (erreurs 429 "Too Many Requests") :
 *   - `--delay <ms>` espace les captures d'un même lot (défaut 3000ms).
 *   - En cas de 429/5xx malgré tout, capture.js réessaie automatiquement
 *     avec un backoff exponentiel (voir --retries / --retry-delay).
 * -----------------------------------------------------------------------
 */
const path = require('path');
const fs = require('fs/promises');
const { Command } = require('commander');
const { captureScreenshot, captureScrollSequence } = require('./capture');
const { composeMockup, createComposer } = require('./compose');
const { createGifBuilder } = require('./gif');
const { FRAMES } = require('./frames');
const { sleep, ensureDir, slugify, toInt, toNumber, splitList } = require('./util');

const DEFAULTS = { delayMs: 3000, retries: 3, retryBaseDelayMs: 5000 };

/**
 * Réglages de la variante animée. La durée est bornée : en dessous de 2s le
 * défilement est illisible, au-delà de 5s le fichier devient trop lourd pour
 * une page portfolio (un GIF ne compresse pas d'une image à l'autre).
 */
const GIF = {
  seconds: 3,
  minSeconds: 2,
  maxSeconds: 5,
  fps: 12,
  /** Largeur maximale du GIF produit — voir gif.js. */
  maxWidth: 900,
  colors: 256,
  /** 0 = boucle infinie. */
  loop: 0,
  easing: 'ease-in-out',
};

/**
 * Viewport par défaut de chaque gabarit. Le format de capture découle du
 * gabarit choisi : un téléphone se capture en portrait, une fenêtre de
 * navigateur dans un format d'écran courant.
 */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
  browser: { width: 1280, height: 800, deviceScaleFactor: 2 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3 },
};

/**
 * Les variantes de sortie. `compose` donne les valeurs par défaut passées à
 * composeMockup ; elles restent surchargeables depuis la config ou la CLI.
 * `single: true` marque une variante qui ne vise qu'une page (`path`) quand
 * aucune liste `pages` n'est donnée.
 */
const VARIANTS = {
  hero: {
    description: 'mockup principal encadré, pour le haut d\'une page projet',
    template: 'desktop',
    single: true,
    compose: { background: 'transparent', padding: 120, shadow: true },
    fileName: ({ slug, template }) => `${slug}-hero-${template}.png`,
  },
  gallery: {
    // Rendu volontairement neutre : sans ombre ni marge, les captures d'une
    // même galerie restent homogènes et faciles à recadrer.
    description: 'captures habillées légèrement, une par page',
    template: 'browser',
    compose: { background: 'transparent', padding: 0, shadow: false },
    fileName: ({ slug, label }) => `${slug}-${label}.png`,
  },
  carousel: {
    description: 'mockups encadrés, un par page, pour un carrousel',
    template: 'mobile',
    // 100 plutôt que les 120 du hero : un mockup mobile est plus petit et
    // supporte mal une marge aussi large (valeur de l'exemple du README).
    compose: { background: 'transparent', padding: 100, shadow: true },
    fileName: ({ slug, label }) => `${slug}-carousel-${label}.png`,
  },
  gif: {
    description: 'GIF animé qui parcourt la page entre deux positions',
    template: 'browser',
    single: true,
    animated: true,
    // Fond opaque par défaut : la transparence d'un GIF est binaire, une
    // ombre portée dessus laisserait un halo dentelé (voir README).
    compose: { background: '#ffffff', padding: 60, shadow: true },
    fileName: ({ slug, label }) => `${slug}-scroll-${label}.gif`,
  },
};

/** Complète un viewport partiel avec les défauts du gabarit. */
function resolveViewport(template, viewport = {}) {
  const base = VIEWPORTS[template] ?? VIEWPORTS.desktop;
  return {
    width: viewport.width ?? base.width,
    height: viewport.height ?? base.height,
    deviceScaleFactor: viewport.deviceScaleFactor ?? base.deviceScaleFactor,
    fullPage: viewport.fullPage ?? false,
  };
}

/**
 * Une page se décrit soit par son chemin seul, soit par
 * `{ path, label?, scrollTo?, scrollFrom? }`. Les positions définies ici ne
 * valent que pour cette page et l'emportent sur celles du bloc.
 */
function normalizePage(pageDef) {
  if (typeof pageDef === 'string') return { path: pageDef, label: pageDef };
  return {
    path: pageDef.path,
    label: pageDef.label || pageDef.path,
    scrollTo: pageDef.scrollTo,
    scrollFrom: pageDef.scrollFrom,
  };
}

/**
 * Génère une variante complète : capture chaque page, l'habille, l'écrit.
 * Utilisée aussi bien par les commandes ponctuelles que par le mode batch.
 *
 * @param {'hero'|'gallery'|'carousel'|'gif'} kind variante (voir VARIANTS)
 * @param {object} opts
 * @param {string} opts.baseUrl URL de base ; chaque page est résolue contre elle
 * @param {Array<string|{path:string,label?:string}>} opts.pages pages à capturer
 * @param {number} [opts.delayMs] pause entre deux captures (anti rate-limit)
 * @returns {Promise<string[]>} chemins des fichiers produits
 */
async function generate(kind, opts) {
  const variant = VARIANTS[kind];
  const template = opts.template ?? variant.template;
  const viewport = resolveViewport(template, opts.viewport);
  const slug = slugify(opts.name);
  const delayMs = opts.delayMs ?? DEFAULTS.delayMs;
  const pages = opts.pages.map(normalizePage);

  await ensureDir(opts.outDir);
  const produced = [];

  for (const [index, page] of pages.entries()) {
    const url = new URL(page.path, opts.baseUrl).toString();

    // Options communes aux deux rendus : capture et habillage sont réglés de
    // la même façon, qu'on produise une image fixe ou une séquence.
    const request = {
      url,
      template,
      viewport,
      capture: {
        url,
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        hideSelectors: opts.hideSelectors,
        waitAfterScrollMs: opts.waitAfterScrollMs,
        retries: opts.retries,
        retryBaseDelayMs: opts.retryBaseDelayMs,
      },
      compose: {
        template,
        outputWidth: viewport.width,
        frameOptions: opts.frameOptions ?? {},
        background: opts.background ?? variant.compose.background,
        padding: opts.padding ?? variant.compose.padding,
        shadow: opts.shadow ?? variant.compose.shadow,
      },
      page,
      opts,
    };

    const output = variant.animated ? await renderGif(kind, request) : await renderStill(kind, request);

    const outPath = path.join(opts.outDir, variant.fileName({ slug, template, label: slugify(page.label) }));
    await fs.writeFile(outPath, output);
    console.log(`  ✔ ${outPath}`);
    produced.push(outPath);

    if (index < pages.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  return produced;
}

/** Une capture, habillée : le rendu des variantes hero / gallery / carousel. */
async function renderStill(kind, { url, template, viewport, capture, compose, page, opts }) {
  console.log(`→ [${kind}] capture ${url} (${template}, ${viewport.width}x${viewport.height})`);

  const screenshot = await captureScreenshot({
    ...capture,
    fullPage: viewport.fullPage,
    scrollTo: page.scrollTo ?? opts.scrollTo,
  });

  return composeMockup({ ...compose, screenshot });
}

/**
 * Rendu de la variante `gif` : une séquence de captures entre deux positions
 * de défilement, habillées puis encodées en GIF animé.
 *
 * Chaque image est habillée et ajoutée au GIF dès sa capture : garder la
 * séquence entière en mémoire à pleine résolution coûterait plusieurs
 * centaines de Mo.
 */
async function renderGif(kind, { url, template, viewport, capture, compose, page, opts }) {
  const seconds = clampSeconds(opts.seconds ?? GIF.seconds);
  const fps = opts.fps ?? GIF.fps;
  // Un GIF exprime ses délais en centièmes de seconde, et les navigateurs
  // ignorent les délais inférieurs à 20ms. Le nombre d'images est déduit du
  // délai réellement encodable, sans quoi l'animation durerait un peu plus ou
  // un peu moins que les secondes demandées.
  const frameDelayMs = Math.max(20, Math.round(1000 / fps / 10) * 10);
  const frames = Math.max(2, Math.round((seconds * 1000) / frameDelayMs));

  console.log(
    `→ [${kind}] capture ${url} (${template}, ${viewport.width}x${viewport.height}, ${frames} images sur ${seconds}s)`
  );

  const background = compose.background;

  if (viewport.fullPage) {
    console.warn('  ⚠ fullPage est sans effet sur un GIF : la séquence défile déjà dans la page');
  }
  if (background === 'transparent' && compose.shadow) {
    console.warn('  ⚠ fond transparent + ombre portée : le GIF ne gère pas la semi-transparence, l\'ombre sera dentelée');
  }

  const gif = createGifBuilder({
    maxWidth: opts.maxWidth ?? GIF.maxWidth,
    delayMs: frameDelayMs,
    colors: opts.colors ?? GIF.colors,
    loop: opts.loop ?? GIF.loop,
    // La transparence d'un GIF est binaire : elle n'est activée que si elle
    // est explicitement demandée.
    transparent: background === 'transparent',
  });

  // Toutes les images d'une séquence ont la taille du viewport : le cadre, son
  // masque et l'ombre sont préparés une seule fois pour toute la séquence.
  const composeFrame = await createComposer({
    ...compose,
    sourceWidth: viewport.width,
    sourceHeight: viewport.height,
  });

  const result = await captureScrollSequence(
    {
      ...capture,
      scrollFrom: page.scrollFrom ?? opts.scrollFrom ?? 0,
      scrollTo: page.scrollTo ?? opts.scrollTo,
      frames,
      easing: opts.easing ?? GIF.easing,
    },
    // Indexée : si une tentative échoue en cours de route, la suivante réécrit
    // les mêmes positions au lieu d'ajouter des doublons.
    async (frame, index) => {
      await gif.add(await composeFrame(frame), index);
      process.stdout.write('.');
    }
  );

  process.stdout.write('\n');
  console.log(`  défilement de ${Math.round(result.from)}px à ${Math.round(result.to)}px`);
  return gif.encode();
}

/** Borne la durée demandée et le signale plutôt que de la subir en silence. */
function clampSeconds(seconds) {
  const bounded = Math.min(Math.max(seconds, GIF.minSeconds), GIF.maxSeconds);
  if (bounded !== seconds) {
    console.warn(`  ⚠ durée ramenée à ${bounded}s (bornes: ${GIF.minSeconds}–${GIF.maxSeconds}s)`);
  }
  return bounded;
}

/**
 * Traite un projet complet du fichier de config : hero, puis gallery, puis
 * carousel, en sautant les blocs absents. `delayMs` espace aussi les étapes
 * entre elles, pour rester cohérent avec le ralentissement appliqué à
 * l'intérieur de chaque étape.
 * @returns {Promise<string[]>} chemins des fichiers produits
 */
async function runProject(project, globalOutDir, globals = {}) {
  const outDir = path.join(globalOutDir, slugify(project.name));
  const projectDelay = project.delayMs ?? globals.delayMs ?? DEFAULTS.delayMs;
  const produced = [];

  for (const kind of Object.keys(VARIANTS)) {
    const step = project[kind];
    if (!step) continue;

    // `hero` et `gif` ciblent une page unique (`path`) sauf si une liste
    // `pages` est fournie ; `gallery` et `carousel` n'ont de sens qu'en liste.
    const variant = VARIANTS[kind];
    const pages = step.pages ?? (variant.single ? [step.path ?? '/'] : null);
    if (!pages?.length) continue;

    // Pause entre deux étapes du même projet (la 1re n'attend pas).
    if (produced.length && projectDelay > 0) await sleep(projectDelay);

    produced.push(
      ...(await generate(kind, {
        baseUrl: project.baseUrl,
        name: project.name,
        pages,
        outDir,
        template: step.template,
        viewport: step.viewport,
        background: step.background,
        padding: step.padding,
        shadow: step.shadow,
        frameOptions: step.frameOptions,
        hideSelectors: step.hideSelectors ?? project.hideSelectors,
        // Pour `gif`, `scrollTo` est la position de FIN du défilement : elle ne
        // s'hérite pas du projet, où un `scrollTo` global (souvent 0) figerait
        // l'animation au lieu de la cadrer.
        scrollTo: variant.animated ? step.scrollTo : step.scrollTo ?? project.scrollTo,
        scrollFrom: step.scrollFrom,
        seconds: step.seconds,
        fps: step.fps,
        maxWidth: step.maxWidth,
        colors: step.colors,
        loop: step.loop,
        easing: step.easing,
        waitAfterScrollMs: step.waitAfterScrollMs ?? project.waitAfterScrollMs,
        delayMs: step.delayMs ?? projectDelay,
        retries: project.retries ?? globals.retries ?? DEFAULTS.retries,
        retryBaseDelayMs: project.retryBaseDelayMs ?? globals.retryBaseDelayMs ?? DEFAULTS.retryBaseDelayMs,
      }))
    );
  }

  return produced;
}

const program = new Command();
program.name('mockup-pipeline').description('Génère automatiquement des mockups de sites web (capture + habillage device).');

/**
 * `--scroll` accepte les deux formes de `scrollTo` : un nombre de pixels ou un
 * sélecteur CSS. Tout ce qui n'est pas numérique est traité comme un sélecteur.
 */
function parseScroll(value) {
  const px = Number(value);
  return Number.isFinite(px) ? px : value;
}

/**
 * Options communes aux 3 commandes ponctuelles. Les défauts de viewport ne
 * sont volontairement PAS fixés ici : laissés à undefined, ils sont déduits
 * du gabarit par `resolveViewport`, ce qui évite un `--width 390` implicite
 * sur un gabarit `browser`.
 */
function addCommonOptions(cmd, kind) {
  // Pour la variante animée, `--scroll` désigne la fin du défilement, pas la
  // position d'une capture unique.
  const scrollHelp = VARIANTS[kind].animated
    ? 'position de fin : nombre de pixels ou sélecteur CSS (défaut: bas de page)'
    : 'défiler avant capture : un nombre de pixels ou un sélecteur CSS';

  return cmd
    .requiredOption('-n, --name <name>', 'nom du projet (utilisé pour les noms de fichiers)')
    .option('-t, --template <template>', `gabarit (${FRAMES.join(' | ')})`, VARIANTS[kind].template)
    .option('-w, --width <px>', 'largeur du viewport (défaut: selon le gabarit)', toInt)
    .option('--height <px>', 'hauteur du viewport (défaut: selon le gabarit)', toInt)
    .option('-b, --background <color>', 'couleur de fond (hex) ou "transparent"')
    .option('--padding <px>', 'marge autour du mockup en px', toInt)
    .option('--hide <selectors>', 'sélecteurs CSS à masquer avant capture, séparés par des virgules')
    .option('--scroll <px|selector>', scrollHelp, parseScroll)
    .option('--scroll-wait <ms>', 'délai après défilement (lazy-load)', toInt)
    .option('-o, --out <dir>', 'dossier de sortie', 'output')
    .option('-d, --delay <ms>', 'délai entre chaque capture (anti rate-limit / 429)', toInt, DEFAULTS.delayMs)
    .option('--retries <n>', 'tentatives en cas de 429/erreur réseau', toInt, DEFAULTS.retries)
    .option('--retry-delay <ms>', 'délai de base entre tentatives (doublé à chaque échec)', toInt, DEFAULTS.retryBaseDelayMs);
}

/** Traduit les options commander en arguments de `generate()`. */
function optionsToRequest(opts, { baseUrl, pages }) {
  return {
    baseUrl,
    pages,
    name: opts.name,
    template: opts.template,
    viewport: { width: opts.width, height: opts.height },
    background: opts.background,
    padding: opts.padding,
    hideSelectors: splitList(opts.hide),
    scrollTo: opts.scroll,
    waitAfterScrollMs: opts.scrollWait,
    // Options propres à la variante `gif` (undefined ailleurs).
    scrollFrom: opts.scrollFrom,
    seconds: opts.seconds,
    fps: opts.fps,
    maxWidth: opts.maxWidth,
    easing: opts.easing,
    // Toutes les commandes écrivent dans <out>/<projet>/, comme le mode batch.
    outDir: path.resolve(opts.out, slugify(opts.name)),
    delayMs: opts.delay,
    retries: opts.retries,
    retryBaseDelayMs: opts.retryDelay,
  };
}

addCommonOptions(
  program
    .command('hero')
    .description(`Génère un ${VARIANTS.hero.description}`)
    .requiredOption('-u, --url <url>', 'URL à capturer'),
  'hero'
).action((opts) =>
  // Un chemin vide résout à l'URL fournie telle quelle (chemin et query compris).
  generate('hero', optionsToRequest(opts, { baseUrl: opts.url, pages: [''] }))
);

addCommonOptions(
  program
    .command('gif')
    .description(`Génère un ${VARIANTS.gif.description}`)
    .requiredOption('-u, --url <url>', 'URL à capturer'),
  'gif'
)
  // `--scroll` (option commune) sert ici de position de FIN : le GIF part de
  // `--scroll-from` et s'arrête sur `--scroll`.
  .option('--scroll-from <px|selector>', 'position de départ (défaut: haut de page)', parseScroll)
  .option('--seconds <s>', `durée de l'animation (${GIF.minSeconds} à ${GIF.maxSeconds}s)`, toNumber, GIF.seconds)
  .option('--fps <n>', 'images par seconde', toInt, GIF.fps)
  .option('--max-width <px>', 'largeur maximale du GIF', toInt, GIF.maxWidth)
  .option('--easing <mode>', 'répartition du défilement: linear | ease-in-out', GIF.easing)
  .action((opts) => generate('gif', optionsToRequest(opts, { baseUrl: opts.url, pages: [''] })));

for (const kind of ['gallery', 'carousel']) {
  addCommonOptions(
    program
      .command(kind)
      .description(`Génère des ${VARIANTS[kind].description}`)
      .requiredOption('-u, --base-url <url>', 'URL de base du site')
      .requiredOption('-p, --pages <pages>', 'chemins séparés par des virgules, ex: /,/contact,/equipe'),
    kind
  ).action((opts) =>
    generate(kind, optionsToRequest(opts, { baseUrl: opts.baseUrl, pages: splitList(opts.pages) }))
  );
}

program
  .command('batch')
  .description('Traite un lot de projets décrits dans un fichier JSON de config')
  .requiredOption('-c, --config <path>', 'chemin du fichier de config JSON')
  .option('-d, --delay <ms>', 'délai entre chaque capture et chaque projet (anti rate-limit / 429)', toInt, DEFAULTS.delayMs)
  .action(async (opts) => {
    const config = JSON.parse(await fs.readFile(path.resolve(opts.config), 'utf-8'));
    const outDir = path.resolve(config.outputDir ?? 'output');
    const globals = {
      delayMs: config.delayMs ?? opts.delay,
      retries: config.retries,
      retryBaseDelayMs: config.retryBaseDelayMs,
    };

    for (const [index, project] of config.projects.entries()) {
      console.log(`\n=== Projet: ${project.name} ===`);
      await runProject(project, outDir, globals);

      if (index < config.projects.length - 1 && globals.delayMs > 0) {
        console.log(`… pause de ${Math.round(globals.delayMs / 1000)}s avant le projet suivant`);
        await sleep(globals.delayMs);
      }
    }
    console.log('\nTerminé.');
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('Erreur:', err.message);
  process.exit(1);
});
