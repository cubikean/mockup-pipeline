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
const { sleep } = require('./util');

const program = new Command();

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function slugify(str) {
  return str
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'accueil';
}

/**
 * Capture une URL puis la compose dans un cadre. Fonction bas niveau
 * partagée par le mode "hero" (une image) et le mode "carousel" (une série
 * d'images encadrées, une par page — typiquement pour un carrousel mobile
 * en bas de page projet).
 */
async function captureAndFrame({ url, template, viewport, background, padding, frameOptions, retries, retryBaseDelayMs }) {
  const screenshot = await captureScreenshot({
    url,
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor ?? (template === 'mobile' ? 3 : 2),
    fullPage: false,
    retries,
    retryBaseDelayMs,
  });

  return composeMockup({
    screenshot,
    template,
    outputWidth: viewport.width,
    background: background ?? 'transparent',
    padding: padding ?? 120,
    frameOptions: frameOptions ?? {},
  });
}

/**
 * Génère le mockup "hero" (visuel principal, encadré) d'un projet.
 */
async function generateHero({ url, name, template, viewport, background, padding, frameOptions, outDir, retries, retryBaseDelayMs }) {
  console.log(`→ [hero] capture ${url} (${template}, ${viewport.width}x${viewport.height})`);
  const mockup = await captureAndFrame({ url, template, viewport, background, padding, frameOptions, retries, retryBaseDelayMs });

  await ensureDir(outDir);
  const outPath = path.join(outDir, `${slugify(name)}-hero-${template}.png`);
  await fs.writeFile(outPath, mockup);
  console.log(`  ✔ ${outPath}`);
  return outPath;
}

/**
 * Génère une série de mockups encadrés (typiquement gabarit "mobile"), un
 * par page listée — pensé pour le carrousel en bas des pages projet.
 * `delayMs` espace chaque capture pour ne pas déclencher de rate-limit
 * (429) côté site cible.
 */
async function generateCarousel({
  baseUrl,
  name,
  template,
  viewport,
  background,
  padding,
  frameOptions,
  pages,
  outDir,
  delayMs = 3000,
  retries,
  retryBaseDelayMs,
}) {
  await ensureDir(outDir);
  const results = [];
  for (let i = 0; i < pages.length; i++) {
    const pageDef = pages[i];
    const pagePath = typeof pageDef === 'string' ? pageDef : pageDef.path;
    const label = typeof pageDef === 'string' ? pagePath : pageDef.label || pagePath;
    const url = new URL(pagePath, baseUrl).toString();

    console.log(`→ [carousel] capture ${url} (${template}, ${viewport.width}x${viewport.height})`);
    const mockup = await captureAndFrame({ url, template, viewport, background, padding, frameOptions, retries, retryBaseDelayMs });

    const outPath = path.join(outDir, `${slugify(name)}-carousel-${slugify(label)}.png`);
    await fs.writeFile(outPath, mockup);
    console.log(`  ✔ ${outPath}`);
    results.push(outPath);

    if (i < pages.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return results;
}

/**
 * Génère la galerie de captures "brutes" (habillage léger, sans pied ni
 * marge) pour plusieurs pages d'un même projet. `delayMs` espace chaque
 * capture (voir generateCarousel).
 */
async function generateGallery({ baseUrl, name, template, viewport, pages, outDir, delayMs = 3000, retries, retryBaseDelayMs }) {
  await ensureDir(outDir);
  const results = [];
  for (let i = 0; i < pages.length; i++) {
    const pageDef = pages[i];
    const pagePath = typeof pageDef === 'string' ? pageDef : pageDef.path;
    const label = typeof pageDef === 'string' ? pagePath : pageDef.label || pagePath;
    const url = new URL(pagePath, baseUrl).toString();

    console.log(`→ [gallery] capture ${url}`);
    const screenshot = await captureScreenshot({
      url,
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 2,
      fullPage: viewport.fullPage ?? false,
      retries,
      retryBaseDelayMs,
    });

    const mockup = await composeMockup({
      screenshot,
      template: template ?? 'browser',
      outputWidth: viewport.width,
      background: 'transparent',
      padding: 0,
      shadow: false,
    });

    const outPath = path.join(outDir, `${slugify(name)}-${slugify(label)}.png`);
    await fs.writeFile(outPath, mockup);
    console.log(`  ✔ ${outPath}`);
    results.push(outPath);

    if (i < pages.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return results;
}

/**
 * Traite un projet complet (hero + gallery + carousel). `delayMs` espace
 * aussi les 3 étapes entre elles, pour rester cohérent avec le
 * ralentissement appliqué à l'intérieur de chaque étape.
 */
async function runProject(project, globalOutDir, { delayMs = 3000, retries = 3, retryBaseDelayMs = 5000 } = {}) {
  const outDir = path.join(globalOutDir, slugify(project.name));
  const produced = [];
  const projectDelay = project.delayMs ?? delayMs;
  const projectRetries = project.retries ?? retries;
  const projectRetryDelay = project.retryBaseDelayMs ?? retryBaseDelayMs;

  if (project.hero) {
    const url = new URL(project.hero.path ?? '/', project.baseUrl).toString();
    produced.push(
      await generateHero({
        url,
        name: project.name,
        template: project.hero.template ?? 'desktop',
        viewport: project.hero.viewport ?? { width: 1440, height: 900 },
        background: project.hero.background,
        padding: project.hero.padding,
        frameOptions: project.hero.frameOptions,
        outDir,
        retries: projectRetries,
        retryBaseDelayMs: projectRetryDelay,
      })
    );
  }

  if (project.gallery && project.gallery.pages?.length) {
    if (produced.length && projectDelay > 0) await sleep(projectDelay);
    produced.push(
      ...(await generateGallery({
        baseUrl: project.baseUrl,
        name: project.name,
        template: project.gallery.template ?? 'browser',
        viewport: project.gallery.viewport ?? { width: 1280, height: 800 },
        pages: project.gallery.pages,
        outDir,
        delayMs: project.gallery.delayMs ?? projectDelay,
        retries: projectRetries,
        retryBaseDelayMs: projectRetryDelay,
      }))
    );
  }

  if (project.carousel && project.carousel.pages?.length) {
    if (produced.length && projectDelay > 0) await sleep(projectDelay);
    produced.push(
      ...(await generateCarousel({
        baseUrl: project.baseUrl,
        name: project.name,
        template: project.carousel.template ?? 'mobile',
        viewport: project.carousel.viewport ?? { width: 390, height: 844, deviceScaleFactor: 3 },
        background: project.carousel.background,
        padding: project.carousel.padding,
        frameOptions: project.carousel.frameOptions,
        pages: project.carousel.pages,
        outDir,
        delayMs: project.carousel.delayMs ?? projectDelay,
        retries: projectRetries,
        retryBaseDelayMs: projectRetryDelay,
      }))
    );
  }

  return produced;
}

program.name('mockup-pipeline').description('Génère automatiquement des mockups de sites web (capture + habillage device).');

program
  .command('batch')
  .description('Traite un lot de projets décrits dans un fichier JSON de config')
  .requiredOption('-c, --config <path>', 'chemin du fichier de config JSON')
  .option('-d, --delay <ms>', 'délai entre chaque capture et chaque projet (anti rate-limit / 429)', '3000')
  .action(async (opts) => {
    const configRaw = await fs.readFile(path.resolve(opts.config), 'utf-8');
    const config = JSON.parse(configRaw);
    const outDir = path.resolve(config.outputDir ?? 'output');
    const delayMs = config.delayMs ?? Number(opts.delay);
    const retries = config.retries ?? 3;
    const retryBaseDelayMs = config.retryBaseDelayMs ?? 5000;

    for (let i = 0; i < config.projects.length; i++) {
      const project = config.projects[i];
      console.log(`\n=== Projet: ${project.name} ===`);
      await runProject(project, outDir, { delayMs, retries, retryBaseDelayMs });
      if (i < config.projects.length - 1 && delayMs > 0) {
        console.log(`… pause de ${Math.round(delayMs / 1000)}s avant le projet suivant`);
        await sleep(delayMs);
      }
    }
    console.log('\nTerminé.');
  });

program
  .command('hero')
  .description('Génère un seul mockup "hero" encadré pour une URL')
  .requiredOption('-u, --url <url>', 'URL à capturer')
  .requiredOption('-n, --name <name>', 'nom du projet (utilisé pour le nom de fichier)')
  .option('-t, --template <template>', `gabarit (${FRAMES.join(' | ')})`, 'desktop')
  .option('-w, --width <width>', 'largeur du viewport (défaut: 1440 desktop/browser, 390 mobile)')
  .option('--height <height>', 'hauteur du viewport (défaut: 900 desktop/browser, 844 mobile)')
  .option('-b, --background <color>', 'couleur de fond (hex) ou "transparent"', 'transparent')
  .option('-p, --padding <padding>', 'marge autour du mockup en px', '120')
  .option('-o, --out <dir>', 'dossier de sortie', 'output')
  .option('--retries <n>', 'tentatives en cas de 429/erreur réseau', '3')
  .option('--retry-delay <ms>', 'délai de base entre tentatives (doublé à chaque échec)', '5000')
  .action(async (opts) => {
    const isMobile = opts.template === 'mobile';
    const width = Number(opts.width ?? (isMobile ? 390 : 1440));
    const height = Number(opts.height ?? (isMobile ? 844 : 900));
    await generateHero({
      url: opts.url,
      name: opts.name,
      template: opts.template,
      viewport: { width, height, deviceScaleFactor: isMobile ? 3 : 2 },
      background: opts.background,
      padding: Number(opts.padding),
      outDir: path.resolve(opts.out),
      retries: Number(opts.retries),
      retryBaseDelayMs: Number(opts.retryDelay),
    });
  });

program
  .command('gallery')
  .description('Génère une série de captures (habillage léger) pour plusieurs pages')
  .requiredOption('-u, --base-url <url>', 'URL de base du site')
  .requiredOption('-n, --name <name>', 'nom du projet')
  .requiredOption('-p, --pages <pages>', 'chemins séparés par des virgules, ex: /,/contact,/equipe')
  .option('-t, --template <template>', `gabarit (${FRAMES.join(' | ')})`, 'browser')
  .option('-w, --width <width>', 'largeur du viewport', '1280')
  .option('--height <height>', 'hauteur du viewport', '800')
  .option('-o, --out <dir>', 'dossier de sortie', 'output')
  .option('-d, --delay <ms>', 'délai entre chaque page (anti rate-limit / 429)', '3000')
  .option('--retries <n>', 'tentatives en cas de 429/erreur réseau', '3')
  .option('--retry-delay <ms>', 'délai de base entre tentatives (doublé à chaque échec)', '5000')
  .action(async (opts) => {
    await generateGallery({
      baseUrl: opts.baseUrl,
      name: opts.name,
      template: opts.template,
      viewport: { width: Number(opts.width), height: Number(opts.height) },
      pages: opts.pages.split(',').map((p) => p.trim()),
      outDir: path.resolve(path.join(opts.out, slugify(opts.name))),
      delayMs: Number(opts.delay),
      retries: Number(opts.retries),
      retryBaseDelayMs: Number(opts.retryDelay),
    });
  });

program
  .command('carousel')
  .description('Génère une série de mockups encadrés (défaut: gabarit mobile), un par page — pour un carrousel de projet')
  .requiredOption('-u, --base-url <url>', 'URL de base du site')
  .requiredOption('-n, --name <name>', 'nom du projet')
  .requiredOption('-p, --pages <pages>', 'chemins séparés par des virgules, ex: /,/contact,/equipe')
  .option('-t, --template <template>', `gabarit (${FRAMES.join(' | ')})`, 'mobile')
  .option('-w, --width <width>', 'largeur du viewport', '390')
  .option('--height <height>', 'hauteur du viewport', '844')
  .option('-b, --background <color>', 'couleur de fond (hex) ou "transparent"', 'transparent')
  .option('--padding <padding>', 'marge autour de chaque mockup en px', '100')
  .option('-o, --out <dir>', 'dossier de sortie', 'output')
  .option('-d, --delay <ms>', 'délai entre chaque page (anti rate-limit / 429)', '3000')
  .option('--retries <n>', 'tentatives en cas de 429/erreur réseau', '3')
  .option('--retry-delay <ms>', 'délai de base entre tentatives (doublé à chaque échec)', '5000')
  .action(async (opts) => {
    await generateCarousel({
      baseUrl: opts.baseUrl,
      name: opts.name,
      template: opts.template,
      viewport: { width: Number(opts.width), height: Number(opts.height), deviceScaleFactor: opts.template === 'mobile' ? 3 : 2 },
      background: opts.background,
      padding: Number(opts.padding),
      pages: opts.pages.split(',').map((p) => p.trim()),
      outDir: path.resolve(path.join(opts.out, slugify(opts.name))),
      delayMs: Number(opts.delay),
      retries: Number(opts.retries),
      retryBaseDelayMs: Number(opts.retryDelay),
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('Erreur:', err.message);
  process.exit(1);
});
