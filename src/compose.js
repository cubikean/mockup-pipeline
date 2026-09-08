/**
 * compose.js
 * -----------------------------------------------------------------------
 * Assemble une capture d'écran (Buffer PNG) avec un cadre (frames.js) pour
 * produire l'image de mockup finale, avec fond et ombre portée optionnels.
 *
 * Deux entrées :
 *   - `composeMockup()` pour une capture isolée ;
 *   - `createComposer()` quand une même page produit plusieurs images de
 *     dimensions identiques (les frames d'un GIF). Le cadre, le masque
 *     d'écran et l'ombre ne dépendent que de la taille de la capture : ils
 *     sont calculés une fois, puis réutilisés pour chaque image.
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
  const { screenshot, ...rest } = opts;
  const meta = await sharp(screenshot).metadata();
  const compose = await createComposer({ ...rest, sourceWidth: meta.width, sourceHeight: meta.height });
  return compose(screenshot);
}

/**
 * Prépare l'habillage pour des captures d'une taille donnée et retourne une
 * fonction `(screenshot) => Promise<Buffer>` à appeler pour chaque capture.
 *
 * Tout ce qui ne dépend que de la taille — cadre rasterisé, masque d'angles,
 * ombre portée — est calculé ici, une seule fois. Sur une séquence de
 * plusieurs dizaines d'images (GIF), c'est l'essentiel du coût : d'une image
 * à l'autre, seule la capture change.
 *
 * @param {Omit<ComposeOptions,'screenshot'> & {sourceWidth:number, sourceHeight:number}} opts
 * @returns {Promise<(screenshot: Buffer) => Promise<Buffer>>}
 */
async function createComposer(opts) {
  const {
    template,
    sourceWidth,
    sourceHeight,
    outputWidth = 1600,
    frameOptions = {},
    background = 'transparent',
    shadow = true,
    padding = 120,
  } = opts;

  const screenHeight = Math.round(outputWidth * (sourceHeight / sourceWidth));
  const frame = getFrame(template, outputWidth, screenHeight, frameOptions);
  const { width: screenW, height: screenH } = frame.screenRect;

  // Masque d'angles : une capture a des coins droits par nature. Si le rayon
  // du cadre est grand par rapport à l'épaisseur du bezel, le coin carré de la
  // capture dépasse visuellement du contour arrondi. Ce masque emploie les
  // MÊMES rayons que la zone d'écran du cadre (frame.screenRadius), quel que
  // soit le réglage bezel/radius passé via frameOptions.
  const screenMask = frame.screenRadius
    ? await rasterize(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${screenW}" height="${screenH}"><path d="${roundedRectPath(
          0,
          0,
          screenW,
          screenH,
          frame.screenRadius
        )}" fill="#fff"/></svg>`
      )
    : null;

  // Le cadre est percé à l'emplacement de l'écran : il passe AU-DESSUS de la
  // capture. Certains gabarits (ex: mobile) ont en plus un élément posé SUR
  // l'écran (pastille caméra), c'est le calque `overlaySvg`.
  const frameLayer = await rasterize(frame.svg);
  const overlayLayer = frame.overlaySvg ? await rasterize(frame.overlaySvg) : null;

  /** Empile capture (dessous) + cadre + overlay sur un canvas transparent. */
  const stack = (screenLayer) => {
    const layers = [
      { input: screenLayer, left: frame.screenRect.x, top: frame.screenRect.y },
      { input: frameLayer, left: 0, top: 0 },
    ];
    if (overlayLayer) layers.push({ input: overlayLayer, left: 0, top: 0 });
    return composeLayers(frame.width, frame.height, TRANSPARENT, layers);
  };

  // Ombre portée : silhouette floutée du mockup. La capture étant opaque et
  // entièrement contenue dans le cadre, cette silhouette ne dépend pas de la
  // capture — un aplat opaque suffit à la calculer.
  const shadowLayer = shadow ? await buildShadow(stack, screenW, screenH, frame) : null;

  // Mockup, ombre décalée et marge tiennent dans un seul canvas : les
  // dimensions sont connues d'avance, une seule passe Sharp suffit.
  const extraHeight = shadow ? SHADOW.extraHeight : 0;
  const canvasWidth = frame.width + padding * 2;
  const canvasHeight = frame.height + extraHeight + padding * 2;
  const bg = background === 'transparent' ? TRANSPARENT : hexToRgba(background);
  const bare = padding === 0 && background === 'transparent' && !shadow;

  return async function compose(screenshot) {
    // Redimensionne la capture pour remplir exactement la zone d'écran du cadre.
    let screenLayer = await sharp(screenshot)
      .resize(screenW, screenH, { fit: 'cover', position: 'top' })
      .png()
      .toBuffer();

    if (screenMask) {
      screenLayer = await sharp(screenLayer).composite([{ input: screenMask, blend: 'dest-in' }]).png().toBuffer();
    }

    const mockup = await stack(screenLayer);
    if (bare) return mockup;

    const layers = [];
    if (shadowLayer) {
      layers.push({ input: shadowLayer, left: padding, top: padding + SHADOW.offsetY, blend: 'over' });
    }
    layers.push({ input: mockup, left: padding, top: padding, blend: 'over' });
    return composeLayers(canvasWidth, canvasHeight, bg, layers);
  };
}

/**
 * Silhouette floutée semi-transparente du mockup, à poser sous celui-ci.
 * Calculée sur un écran opaque de la bonne taille : seule l'alpha compte.
 */
async function buildShadow(stack, screenW, screenH, frame) {
  const opaqueScreen = await sharp({
    create: { width: screenW, height: screenH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();

  const silhouette = await sharp(await stack(opaqueScreen))
    .ensureAlpha()
    .extractChannel('alpha')
    .toColourspace('b-w')
    .blur(SHADOW.blur)
    .toBuffer();

  return composeLayers(frame.width, frame.height, { ...SHADOW.color, alpha: 0 }, [
    { input: silhouette, blend: 'dest-in' },
  ]);
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

module.exports = { composeMockup, createComposer };
