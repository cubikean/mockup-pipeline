/**
 * gif.js
 * -----------------------------------------------------------------------
 * Encodage d'une série d'images (Buffers PNG) en un GIF animé.
 *
 * Sharp sait lire un GIF animé mais pas en fabriquer un à partir d'images
 * séparées : l'encodage passe donc par `gifenc` (quantification + LZW), Sharp
 * restant chargé du redimensionnement et de la lecture des pixels.
 * -----------------------------------------------------------------------
 */
const sharp = require('sharp');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

/** Un GIF n'a que 256 couleurs par palette : c'est le maximum utile. */
const MAX_COLORS = 256;

/** Nombre de pixels échantillonnés (toutes images confondues) pour la palette. */
const PALETTE_SAMPLE_PIXELS = 400_000;

/**
 * @typedef {Object} GifOptions
 * @property {number} [maxWidth=900]   largeur maximale du GIF (les images plus
 *           larges sont réduites) — un GIF de mockup en pleine résolution
 *           pèserait plusieurs dizaines de Mo
 * @property {number} [delayMs=80]     durée d'affichage de chaque image
 * @property {number} [colors=256]     taille de la palette (2 à 256)
 * @property {number} [loop=0]         nombre de boucles, 0 = infini
 * @property {boolean} [transparent=false] conserver la transparence (alpha
 *           binaire : un pixel est opaque ou totalement transparent)
 */

/**
 * Collecteur d'images à encoder en GIF.
 *
 * Les images sont conservées en PNG à la taille finale (quelques centaines de
 * Ko chacune) plutôt qu'en pixels bruts : une séquence de plusieurs dizaines
 * de mockups en RGBA tiendrait sinon des centaines de Mo en mémoire.
 *
 * @param {GifOptions} [options]
 * @returns {{add: (png: Buffer, index?: number) => Promise<void>, encode: () => Promise<Buffer>, size: () => number}}
 */
function createGifBuilder(options = {}) {
  const { maxWidth = 900, delayMs = 80, colors = MAX_COLORS, loop = 0, transparent = false } = options;
  // Indexé plutôt qu'empilé : une tentative de capture rejouée après échec
  // réécrit les mêmes positions au lieu d'ajouter des doublons.
  const frames = [];
  let size = null;

  /** Réduit l'image à la largeur cible et mémorise la taille commune. */
  async function add(png, index = frames.length) {
    const resized = await sharp(png)
      .resize({ width: maxWidth, withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });

    size ??= { width: resized.info.width, height: resized.info.height };
    frames[index] = resized.data;
  }

  async function encode() {
    const present = frames.filter(Boolean);
    if (!present.length) throw new Error('Aucune image à encoder en GIF');

    const { width, height } = size;
    const format = transparent ? 'rgba4444' : 'rgb565';
    const palette = quantize(await samplePixels(present), clampColors(colors), { format });
    // gifenc place la couleur transparente en fin de palette : on la repère
    // par son alpha plutôt que de supposer un index.
    const transparentIndex = transparent ? palette.findIndex((c) => c.length > 3 && c[3] < 128) : -1;

    const gif = GIFEncoder();
    for (const [index, png] of present.entries()) {
      const pixels = await toRgba(png);
      gif.writeFrame(applyPalette(pixels, palette, format), width, height, {
        // Palette commune : elle n'est écrite qu'une fois, avec la 1re image.
        palette: index === 0 ? palette : undefined,
        delay: delayMs,
        repeat: index === 0 ? loop : undefined,
        transparent: transparentIndex >= 0,
        transparentIndex: Math.max(0, transparentIndex),
        // Chaque image est complète : on efface la précédente, sinon les zones
        // transparentes laisseraient apparaître l'image d'avant.
        dispose: transparentIndex >= 0 ? 2 : -1,
      });
    }
    gif.finish();
    return Buffer.from(gif.bytes());
  }

  return { add, encode, size: () => frames.filter(Boolean).length };
}

/**
 * Pixels servant à construire la palette commune : un échantillon régulier de
 * CHAQUE image. Quantifier sur la seule première image raterait les couleurs
 * des sections traversées ensuite (le défilement en fait apparaître de
 * nouvelles) ; quantifier tous les pixels de toutes les images coûterait cher
 * pour un gain nul.
 * @returns {Promise<Uint8ClampedArray>}
 */
async function samplePixels(frames) {
  const budget = Math.max(1, Math.round(PALETTE_SAMPLE_PIXELS / frames.length));
  const chunks = [];

  for (const png of frames) {
    const pixels = await toRgba(png);
    const total = pixels.length / 4;
    // Un pas pair tombe vite en phase avec la largeur (paire) de l'image et
    // rééchantillonne alors les mêmes colonnes ; un pas impair balaye toute
    // la surface.
    let stride = Math.max(1, Math.floor(total / budget));
    if (stride > 1 && stride % 2 === 0) stride += 1;

    const sample = new Uint8ClampedArray(Math.ceil(total / stride) * 4);
    for (let i = 0, out = 0; i < total; i += stride, out += 4) {
      sample.set(pixels.subarray(i * 4, i * 4 + 4), out);
    }
    chunks.push(sample);
  }

  return new Uint8ClampedArray(Buffer.concat(chunks.map(Buffer.from)));
}

/** Pixels RGBA bruts d'une image PNG. */
async function toRgba(png) {
  const data = await sharp(png).ensureAlpha().raw().toBuffer();
  return new Uint8ClampedArray(data);
}

const clampColors = (n) => Math.min(Math.max(Math.round(n), 2), MAX_COLORS);

module.exports = { createGifBuilder };
