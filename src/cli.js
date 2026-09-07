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
 *   2) Mode ponctuel : générer rapidement un seul mockup, une galerie ou
 *      un carrousel sans écrire de config.
 *        node src/cli.js hero --url https://exemple.fr --name exemple --template desktop
 *        node src/cli.js gallery --base-url https://exemple.fr --name exemple --pages /,/contact,/equipe
 *        node src/cli.js carousel --base-url https://exemple.fr --name exemple --pages /,/contact
 *
 * Les trois variantes (hero / gallery / carousel) suivent exactement le même
 * traitement — capturer chaque page, l'habiller, l'écrire — et ne diffèrent
 * que par leurs valeurs par défaut et le nom du fichier produit. Elles sont
 * donc décrites dans la table `VARIANTS` et exécutées par `generate()`.
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
const { captureScreenshot } = require('./capture');
const { composeMockup } = require('./compose');
const { FRAMES } = require('./frames');
const { sleep, ensureDir, slugify, toInt, splitList } = require('./util');

const DEFAULTS = { delayMs: 3000, retries: 3, retryBaseDelayMs: 5000 };

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
 * Les 3 variantes de sortie. `compose` donne les valeurs par défaut passées
 * à composeMockup ; elles restent surchargeables depuis la config ou la CLI.
 */
const VARIANTS = {
  hero: {
    description: 'mockup principal encadré, pour le haut d\'une page projet',
    template: 'desktop',
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
 * `{ path, label?, scrollTo? }`. `scrollTo` défini ici ne vaut que pour cette
 * page et l'emporte sur le `scrollTo` du bloc.
 */
function normalizePage(pageDef) {
  if (typeof pageDef === 'string') return { path: pageDef, label: pageDef };
  return { path: pageDef.path, label: pageDef.label || pageDef.path, scrollTo: pageDef.scrollTo };
}

/**
 * Génère une variante complète : capture chaque page, l'habille, l'écrit.
 * Utilisée aussi bien par les commandes ponctuelles que par le mode batch.
 *
 * @param {'hero'|'gallery'|'carousel'} kind variante (voir VARIANTS)
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
    console.log(`→ [${kind}] capture ${url} (${template}, ${viewport.width}x${viewport.height})`);

    const screenshot = await captureScreenshot({
      url,
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      fullPage: viewport.fullPage,
      hideSelectors: opts.hideSelectors,
      scrollTo: page.scrollTo ?? opts.scrollTo,
      waitAfterScrollMs: opts.waitAfterScrollMs,
      retries: opts.retries,
      retryBaseDelayMs: opts.retryBaseDelayMs,
    });

    const mockup = await composeMockup({
      screenshot,
      template,
      outputWidth: viewport.width,
      frameOptions: opts.frameOptions ?? {},
      background: opts.background ?? variant.compose.background,
      padding: opts.padding ?? variant.compose.padding,
      shadow: opts.shadow ?? variant.compose.shadow,
    });

    const outPath = path.join(opts.outDir, variant.fileName({ slug, template, label: slugify(page.label) }));
    await fs.writeFile(outPath, mockup);
    console.log(`  ✔ ${outPath}`);
    produced.push(outPath);

    if (index < pages.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  return produced;
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

    // `hero` cible une page unique (`path`), les autres une liste (`pages`).
    const pages = kind === 'hero' ? [step.path ?? '/'] : step.pages;
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
        scrollTo: step.scrollTo ?? project.scrollTo,
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
  return cmd
    .requiredOption('-n, --name <name>', 'nom du projet (utilisé pour les noms de fichiers)')
    .option('-t, --template <template>', `gabarit (${FRAMES.join(' | ')})`, VARIANTS[kind].template)
    .option('-w, --width <px>', 'largeur du viewport (défaut: selon le gabarit)', toInt)
    .option('--height <px>', 'hauteur du viewport (défaut: selon le gabarit)', toInt)
    .option('-b, --background <color>', 'couleur de fond (hex) ou "transparent"')
    .option('--padding <px>', 'marge autour du mockup en px', toInt)
    .option('--hide <selectors>', 'sélecteurs CSS à masquer avant capture, séparés par des virgules')
    .option('--scroll <px|selector>', 'défiler avant capture : un nombre de pixels ou un sélecteur CSS', parseScroll)
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
