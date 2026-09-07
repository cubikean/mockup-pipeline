/**
 * compose.js
 * -----------------------------------------------------------------------
 * Assemble une capture d'écran (Buffer PNG) avec un cadre (frames.js) pour
 * produire l'image de mockup finale, avec fond et ombre portée optionnels.
 * -----------------------------------------------------------------------
 */
const sharp = require('sharp');
const { getFrame, roundedRectPath } = require('./frames');

/**
 * @typedef {Object} ComposeOptions
 * @property {Buffer} screenshot          buffer PNG de la capture
 * @property {'browser'|'desktop'|'mobile'} template  gabarit à utiliser
 * @property {number} [outputWidth=1600]  largeur cible de la zone d'écran dans le mockup
 * @property {object} [frameOptions={}]   options passées au générateur de frame (couleurs...)
 * @property {{width:number,height:number}|null} [padding=null] marge autour du mockup (fond)
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
  let resizedScreenshot = await sharp(screenshot)
    .resize(frame.screenRect.width, frame.screenRect.height, { fit: 'cover', position: 'top' })
    .png()
    .toBuffer();

  // 1bis. Masque le screenshot avec les MÊMES rayons d'angle que la zone
  // d'écran du cadre (frame.screenRadius). Sans ça, un screenshot a des
  // coins droits par nature : si le rayon du cadre est grand par rapport à
  // l'épaisseur du bezel, le coin carré du screenshot dépasse visuellement
  // du contour arrondi du cadre. Ce masque élimine le problème quel que
  // soit le réglage bezel/radius passé via frameOptions.
  if (frame.screenRadius) {
    const maskPath = roundedRectPath(0, 0, frame.screenRect.width, frame.screenRect.height, frame.screenRadius);
    const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.screenRect.width}" height="${frame.screenRect.height}"><path d="${maskPath}" fill="#fff"/></svg>`;
    const maskBuffer = await sharp(Buffer.from(maskSvg)).png().toBuffer();
    resizedScreenshot = await sharp(resizedScreenshot)
      .composite([{ input: maskBuffer, blend: 'dest-in' }])
      .png()
      .toBuffer();
  }

  // 2. Rasterise le cadre SVG (avec trou transparent) en PNG à la bonne taille
  const frameBuffer = await sharp(Buffer.from(frame.svg)).png().toBuffer();

  // 2bis. Certains gabarits (ex: mobile) ont un élément posé SUR l'écran
  // (pastille caméra) : ce calque doit passer AU-DESSUS de la capture,
  // contrairement au cadre qui passe en-dessous de la zone d'écran.
  const layers = [
    { input: resizedScreenshot, left: frame.screenRect.x, top: frame.screenRect.y },
    { input: frameBuffer, left: 0, top: 0 },
  ];
  if (frame.overlaySvg) {
    const overlayBuffer = await sharp(Buffer.from(frame.overlaySvg)).png().toBuffer();
    layers.push({ input: overlayBuffer, left: 0, top: 0 });
  }

  // 3. Empile capture (dessous) + cadre (dessus) + overlay éventuel sur un canvas transparent
  let mockup = sharp({
    create: {
      width: frame.width,
      height: frame.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(layers);

  let mockupBuffer = await mockup.png().toBuffer();

  // 4. Ombre portée douce (optionnelle) : silhouette floutée noire semi-transparente
  if (shadow) {
    const shadowMeta = await sharp(mockupBuffer).metadata();
    const shadowLayer = await sharp(mockupBuffer)
      .ensureAlpha()
      .extractChannel('alpha')
      .toColourspace('b-w')
      .blur(24)
      .toBuffer();

    const shadowRgba = await sharp({
      create: {
        width: shadowMeta.width,
        height: shadowMeta.height,
        channels: 4,
        background: { r: 15, g: 15, b: 20, alpha: 0 },
      },
    })
      .composite([{ input: shadowLayer, blend: 'dest-in' }])
      .png()
      .toBuffer();

    mockupBuffer = await sharp({
      create: {
        width: shadowMeta.width,
        height: shadowMeta.height + 30,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: shadowRgba, left: 0, top: 24, blend: 'over' },
        { input: mockupBuffer, left: 0, top: 0, blend: 'over' },
      ])
      .png()
      .toBuffer();
  }

  // 5. Marge + fond final
  if (padding > 0 || background !== 'transparent') {
    const finalMeta = await sharp(mockupBuffer).metadata();
    const bg =
      background === 'transparent'
        ? { r: 0, g: 0, b: 0, alpha: 0 }
        : hexToRgba(background);

    mockupBuffer = await sharp({
      create: {
        width: finalMeta.width + padding * 2,
        height: finalMeta.height + padding * 2,
        channels: 4,
        background: bg,
      },
    })
      .composite([{ input: mockupBuffer, left: padding, top: padding }])
      .png()
      .toBuffer();
  }

  return mockupBuffer;
}

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
