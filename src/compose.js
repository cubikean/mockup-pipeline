/**
 * compose.js
 * -----------------------------------------------------------------------
 * Assemble une capture d'écran (Buffer PNG) avec un cadre (frames.js) pour
 * produire l'image de mockup finale, avec fond et ombre portée optionnels.
 * -----------------------------------------------------------------------
 */
const sharp = require('sharp');
const { getFrame, roundedRectPath } = require('./frames');

/** Réglages de l'ombre portée. */
const SHADOW = {
  blur: 24,
  offsetY: 24,
  /** Hauteur ajoutée sous le mockup pour que l'ombre décalée ne soit pas rognée. */
  extraHeight: 30,
  color: { r: 15, g: 15, b: 20 },
};

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** Rasterise un markup SVG en PNG. */
const rasterize = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

/**
 * Canvas vierge de la taille donnée, sur lequel des calques sont composés.
 * @param {number} width
 * @param {number} height
 * @param {{r:number,g:number,b:number,alpha:number}} background
 * @param {Array<object>} layers calques `composite()` de Sharp
 */
const composeLayers = (width, height, background, layers) =>
  sharp({ create: { width, height, channels: 4, background } })
    .composite(layers)
    .png()
    .toBuffer();

/**
 * @typedef {Object} ComposeOptions
 * @property {Buffer} screenshot          buffer PNG de la capture
 * @property {'browser'|'desktop'|'mobile'} template  gabarit à utiliser
 * @property {number} [outputWidth=1600]  largeur cible de la zone d'écran dans le mockup
 * @property {object} [frameOptions={}]   options passées au générateur de frame (couleurs...)
 * @property {number} [padding=120]       marge (px) ajoutée autour du mockup avant export
 * @property {string} [background='transparent']  couleur de fond ('transparent' ou hex)
 * @property {boolean} [shadow=true]      ajouter une ombre portée douce sous le mockup
 */

/**
 * @param {ComposeOptions} opts
 * @returns {Promise<Buffer>} image finale au format PNG
 */
async function composeMockup(opts) {
  const {
    screenshot,
    template,
    outputWidth = 1600,
    frameOptions = {},
    background = 'transparent',
    shadow = true,
    padding = 120,
  } = opts;

  const meta = await sharp(screenshot).metadata();
  const srcRatio = meta.height / meta.width;
  const screenHeight = Math.round(outputWidth * srcRatio);

  const frame = getFrame(template, outputWidth, screenHeight, frameOptions);

  // 1. Redimensionne la capture pour remplir exactement la zone d'écran du cadre
  let screenLayer = await sharp(screenshot)
    .resize(frame.screenRect.width, frame.screenRect.height, { fit: 'cover', position: 'top' })
    .png()
    .toBuffer();

  // 1bis. Masque la capture avec les MÊMES rayons d'angle que la zone d'écran
  // du cadre (frame.screenRadius). Sans ça, une capture a des coins droits par
  // nature : si le rayon du cadre est grand par rapport à l'épaisseur du bezel,
  // le coin carré de la capture dépasse visuellement du contour arrondi. Ce
  // masque élimine le problème quel que soit le réglage bezel/radius passé via
  // frameOptions.
  if (frame.screenRadius) {
    const { width, height } = frame.screenRect;
    const maskPath = roundedRectPath(0, 0, width, height, frame.screenRadius);
    const mask = await rasterize(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${maskPath}" fill="#fff"/></svg>`
    );
    screenLayer = await sharp(screenLayer).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  }

  // 2. Empile capture (dessous) + cadre (dessus) sur un canvas transparent.
  //    Certains gabarits (ex: mobile) ont en plus un élément posé SUR l'écran
  //    (pastille caméra) : ce calque passe AU-DESSUS de la capture, contrairement
  //    au cadre qui est percé à l'emplacement de l'écran.
  const layers = [
    { input: screenLayer, left: frame.screenRect.x, top: frame.screenRect.y },
    { input: await rasterize(frame.svg), left: 0, top: 0 },
  ];
  if (frame.overlaySvg) {
    layers.push({ input: await rasterize(frame.overlaySvg), left: 0, top: 0 });
  }

  // Les dimensions sont suivies au fil des étapes plutôt que relues via
  // metadata() : le canvas de départ fixe la taille, chaque étape ne fait
  // que l'agrandir de façon connue.
  let width = frame.width;
  let height = frame.height;
  let mockup = await composeLayers(width, height, TRANSPARENT, layers);

  // 3. Ombre portée douce (optionnelle) : silhouette floutée semi-transparente
  if (shadow) {
    const silhouette = await sharp(mockup)
      .ensureAlpha()
      .extractChannel('alpha')
      .toColourspace('b-w')
      .blur(SHADOW.blur)
      .toBuffer();

    const shadowLayer = await composeLayers(width, height, { ...SHADOW.color, alpha: 0 }, [
      { input: silhouette, blend: 'dest-in' },
    ]);

    height += SHADOW.extraHeight;
    mockup = await composeLayers(width, height, TRANSPARENT, [
      { input: shadowLayer, left: 0, top: SHADOW.offsetY, blend: 'over' },
      { input: mockup, left: 0, top: 0, blend: 'over' },
    ]);
  }

  // 4. Marge + fond final
  if (padding > 0 || background !== 'transparent') {
    const bg = background === 'transparent' ? TRANSPARENT : hexToRgba(background);
    mockup = await composeLayers(width + padding * 2, height + padding * 2, bg, [
      { input: mockup, left: padding, top: padding },
    ]);
  }

  return mockup;
}

/** Convertit '#rgb' ou '#rrggbb' en objet couleur Sharp opaque. */
function hexToRgba(hex) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
    alpha: 1,
  };
}

module.exports = { composeMockup };
