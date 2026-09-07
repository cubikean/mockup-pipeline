/**
 * frames.js
 * -----------------------------------------------------------------------
 * Définit les gabarits ("frames") d'habillage des captures d'écran :
 *   - browser : fenêtre de navigateur (barre du haut avec pastilles + barre d'adresse)
 *   - desktop : moniteur générique sur pied (type mockup "écran de bureau")
 *   - mobile  : coque de téléphone générique
 *
 * Chaque frame est généré en SVG à la volée, à la taille demandée, puis
 * rasterisé en PNG par Sharp (voir compose.js). Le principe est toujours
 * le même : on dessine le "cadre" (bezel) sous forme d'anneau avec un trou
 * (fill-rule="evenodd") à l'endroit exact où la capture d'écran vient se
 * loger — cette zone reste donc transparente et laisse voir le screenshot
 * placé en dessous. Le screenshot lui-même est aussi masqué avec les mêmes
 * rayons d'angle (`screenRadius`, voir compose.js) pour qu'il ne dépasse
 * jamais du contour arrondi du cadre, quels que soient `bezel`/`radius`.
 *
 * PERSONNALISATION (frameOptions) : chaque fonction ci-dessous lit ses
 * réglages depuis `opts` avec un fallback par défaut (`opts.xxx ?? valeur`).
 * Tout ce qui a un fallback `opts.xxx ?? ...` est overridable en passant
 * `frameOptions: { xxx: valeur }` dans la config ou le code appelant — voir
 * le README, section "Personnaliser les cadres", pour la liste par gabarit.
 *
 * Toutes les formes sont volontairement génériques (pas de silhouette ni
 * de design copiant un produit de marque précis) : un simple moniteur, une
 * simple fenêtre de navigateur, un simple contour de téléphone.
 * -----------------------------------------------------------------------
 */

/**
 * @typedef {Object} CornerRadii
 * @property {number} [tl] rayon coin haut-gauche
 * @property {number} [tr] rayon coin haut-droit
 * @property {number} [br] rayon coin bas-droit
 * @property {number} [bl] rayon coin bas-gauche
 */

/**
 * @typedef {Object} FrameLayout
 * @property {number} width       largeur totale de l'image finale (px)
 * @property {number} height      hauteur totale de l'image finale (px)
 * @property {{x:number,y:number,width:number,height:number}} screenRect
 *           zone (en px, coin haut-gauche) où doit être insérée la capture
 * @property {number|CornerRadii} screenRadius
 *           rayon(s) d'angle à appliquer AU SCREENSHOT LUI-MÊME (masque),
 *           pour qu'il suive le contour arrondi du cadre sans jamais
 *           dépasser dessus — un nombre = 4 coins identiques.
 * @property {string} svg         markup SVG du cadre (avec trou transparent)
 * @property {string} [overlaySvg] calque optionnel à composer PAR-DESSUS le
 *           screenshot (ex: pastille caméra qui repose sur l'écran)
 */

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/**
 * Avertit si `frameOptions` contient une clé que le gabarit ne reconnaît
 * pas (ex: `bezelColor` passé au gabarit "mobile", qui attend `bodyColor`).
 * Sans ce garde-fou, une clé mal nommée est silencieusement ignorée — le
 * mockup se génère quand même, juste sans le changement attendu, ce qui
 * est difficile à diagnostiquer.
 */
function warnUnknownOptions(templateName, opts, allowedKeys) {
  const unknown = Object.keys(opts).filter((k) => !allowedKeys.includes(k));
  if (unknown.length) {
    console.warn(
      `  ⚠ frameOptions: clé(s) inconnue(s) pour le gabarit "${templateName}": ${unknown.join(', ')}. Options valides: ${allowedKeys.join(', ')}.`
    );
  }
}

function normalizeRadii(r, maxW, maxH) {
  const obj = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r || {};
  const cap = Math.min(maxW, maxH) / 2;
  return {
    tl: clamp(obj.tl ?? 0, 0, cap),
    tr: clamp(obj.tr ?? 0, 0, cap),
    br: clamp(obj.br ?? 0, 0, cap),
    bl: clamp(obj.bl ?? 0, 0, cap),
  };
}

/**
 * Construit un chemin SVG de rectangle à coins arrondis, chaque coin
 * pouvant avoir un rayon différent. Utilisé à la fois pour dessiner les
 * cadres (anneau extérieur/intérieur) et pour masquer le screenshot avec
 * les mêmes rayons que la zone d'écran (voir compose.js).
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number|CornerRadii} radii
 */
function roundedRectPath(x, y, w, h, radii) {
  const { tl, tr, br, bl } = normalizeRadii(radii, w, h);
  return [
    `M${x + tl},${y}`,
    `H${x + w - tr}`,
    tr ? `A${tr},${tr} 0 0 1 ${x + w},${y + tr}` : '',
    `V${y + h - br}`,
    br ? `A${br},${br} 0 0 1 ${x + w - br},${y + h}` : '',
    `H${x + bl}`,
    bl ? `A${bl},${bl} 0 0 1 ${x},${y + h - bl}` : '',
    `V${y + tl}`,
    tl ? `A${tl},${tl} 0 0 1 ${x + tl},${y}` : '',
    'Z',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Fenêtre de navigateur : barre supérieure avec pastilles + barre d'adresse.
 * Seuls les 2 coins BAS de l'écran suivent l'arrondi de la fenêtre (les 2
 * coins HAUT sont sous la barre, donc restent droits).
 *
 * frameOptions disponibles : topBar, radius, chromeColor, borderColor.
 * @param {number} screenWidth largeur voulue de la capture insérée
 * @param {number} screenHeight hauteur voulue de la capture insérée
 * @returns {FrameLayout}
 */
function browserFrame(screenWidth, screenHeight, opts = {}) {
  warnUnknownOptions('browser', opts, ['topBar', 'radius', 'chromeColor', 'borderColor']);
  const topBar = opts.topBar ?? Math.round(screenWidth * 0.045);
  const radius = opts.radius ?? Math.round(screenWidth * 0.012);
  const bg = opts.chromeColor ?? '#e6e7eb';
  const border = opts.borderColor ?? '#d0d1d6';
  const dotColors = ['#ff5f57', '#febc2e', '#28c840'];

  const width = screenWidth;
  const height = screenHeight + topBar;
  const screenRect = { x: 0, y: topBar, width: screenWidth, height: screenHeight };
  const screenRadius = { tl: 0, tr: 0, bl: radius, br: radius };

  const dotR = Math.max(4, Math.round(topBar * 0.16));
  const dotGap = dotR * 2.6;
  const dotStartX = Math.round(topBar * 0.55);
  const dotY = Math.round(topBar / 2);

  const addressBarX = dotStartX + dotGap * 3;
  const addressBarW = Math.round(width * 0.42);
  const addressBarH = Math.round(topBar * 0.42);
  const addressBarY = Math.round((topBar - addressBarH) / 2);

  const dots = dotColors
    .map((c, i) => `<circle cx="${dotStartX + i * dotGap}" cy="${dotY}" r="${dotR}" fill="${c}"/>`)
    .join('');

  const outerClip = roundedRectPath(0, 0, width, height, radius);

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <clipPath id="outer">
      <path d="${outerClip}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#outer)">
    <rect x="0" y="0" width="${width}" height="${topBar}" fill="${bg}"/>
    <path d="${outerClip}" fill="none" stroke="${border}" stroke-width="2"/>
    ${dots}
    <rect x="${addressBarX}" y="${addressBarY}" width="${addressBarW}" height="${addressBarH}" rx="${addressBarH / 2}" fill="#ffffff" stroke="${border}" stroke-width="1.5"/>
  </g>
</svg>`.trim();

  return { width, height, screenRect, screenRadius, svg };
}

/**
 * Moniteur générique sur pied (mockup "bureau"). Le cadre entoure l'écran
 * sur les 4 côtés (anneau avec trou), un pied est ajouté sous le moniteur.
 *
 * frameOptions disponibles : bezel, radius, bezelColor, standColor, baseColor.
 */
function desktopFrame(screenWidth, screenHeight, opts = {}) {
  warnUnknownOptions('desktop', opts, ['bezel', 'radius', 'bezelColor', 'standColor', 'baseColor']);
  const bezel = opts.bezel ?? Math.round(screenWidth * 0.018);
  const radius = opts.radius ?? Math.round(screenWidth * 0.02);
  const bezelColor = opts.bezelColor ?? '#1c1d20';
  const standColor = opts.standColor ?? '#3a3b3f';
  const baseColor = opts.baseColor ?? '#2a2b2e';

  const outerWidth = screenWidth + bezel * 2;
  const outerHeight = screenHeight + bezel * 2;
  const neckHeight = Math.round(outerHeight * 0.09);
  const neckWidth = Math.round(outerWidth * 0.09);
  const baseWidth = Math.round(outerWidth * 0.32);
  const baseHeight = Math.round(outerHeight * 0.035);
  const gap = Math.round(outerHeight * 0.02);

  const width = outerWidth;
  const height = outerHeight + gap + neckHeight + baseHeight;
  const screenRect = { x: bezel, y: bezel, width: screenWidth, height: screenHeight };

  // Rayon intérieur géométriquement cohérent avec le rayon extérieur : une
  // bordure (bezel) d'épaisseur uniforme, y compris dans les coins, donne
  // innerRadius = radius - bezel (jamais négatif). C'est ce qui évite que
  // le screenshot ressorte du coin arrondi (l'ancien calcul, moins strict,
  // provoquait exactement ce défaut avec un bezel fin et un radius large).
  const innerRadius = Math.max(0, radius - bezel);
  const screenRadius = innerRadius;

  const neckX = Math.round((width - neckWidth) / 2);
  const neckY = outerHeight + gap;
  const baseX = Math.round((width - baseWidth) / 2);
  const baseY = neckY + neckHeight;

  const outerPath = roundedRectPath(0, 0, outerWidth, outerHeight, radius);
  const innerPath = roundedRectPath(bezel, bezel, screenWidth, screenHeight, innerRadius);

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <path d="${outerPath} ${innerPath}" fill="${bezelColor}" fill-rule="evenodd"/>
  <rect x="${neckX}" y="${neckY}" width="${neckWidth}" height="${neckHeight}" fill="${standColor}"/>
  <rect x="${baseX}" y="${baseY}" width="${baseWidth}" height="${baseHeight}" rx="${baseHeight / 2}" fill="${baseColor}"/>
</svg>`.trim();

  return { width, height, screenRect, screenRadius, svg };
}

/**
 * Coque de téléphone générique "écran bord à bord" : fin cadre métallique
 * uniforme, boutons latéraux qui dépassent légèrement du corps, et une
 * pastille caméra posée sur l'écran (comme sur un smartphone récent).
 * Conçue pour un écran capturé en format portrait (voir README).
 *
 * frameOptions disponibles : bezel, radius, bodyColor, bodyColorLight,
 * buttonColor, cutoutColor.
 *
 * Retourne en plus `overlaySvg` : un calque à composer PAR-DESSUS la
 * capture d'écran (la pastille caméra doit apparaître sur le screenshot,
 * pas seulement dans le cadre — voir compose.js).
 */
function mobileFrame(screenWidth, screenHeight, opts = {}) {
  warnUnknownOptions('mobile', opts, ['bezel', 'radius', 'bodyColor', 'bodyColorLight', 'buttonColor', 'cutoutColor']);
  const bezel = opts.bezel ?? Math.max(10, Math.round(screenWidth * 0.028));
  const radius = opts.radius ?? Math.round(screenWidth * 0.14);
  const bodyColor = opts.bodyColor ?? '#2b2c30';
  const bodyColorLight = opts.bodyColorLight ?? '#48494e';
  const buttonColor = opts.buttonColor ?? '#1a1b1e';
  const cutoutColor = opts.cutoutColor ?? '#0a0a0c';

  const buttonProtrusion = Math.max(4, Math.round(screenWidth * 0.012));
  const width = screenWidth + bezel * 2 + buttonProtrusion * 2;
  const height = screenHeight + bezel * 2;
  const bodyX = buttonProtrusion;
  const bodyWidth = screenWidth + bezel * 2;
  const screenRect = { x: bodyX + bezel, y: bezel, width: screenWidth, height: screenHeight };

  // Même logique que desktopFrame : rayon intérieur = rayon extérieur -
  // épaisseur du bezel, pour un anneau d'épaisseur uniforme (voir plus haut).
  const innerRadius = Math.max(0, radius - bezel);
  const screenRadius = innerRadius;

  const outerPath = roundedRectPath(bodyX, 0, bodyWidth, height, radius);
  const innerPath = roundedRectPath(bodyX + bezel, bezel, screenWidth, screenHeight, innerRadius);

  // Boutons latéraux : 2 courts à gauche (volume), 1 plus long à droite (power)
  const btnW = buttonProtrusion + 3;
  const volTopY = Math.round(height * 0.16);
  const volBtnH = Math.round(height * 0.06);
  const volGap = Math.round(height * 0.025);
  const powerY = Math.round(height * 0.2);
  const powerH = Math.round(height * 0.1);

  const leftButtons = `
    <rect x="0" y="${volTopY}" width="${btnW}" height="${volBtnH}" rx="3" fill="${buttonColor}"/>
    <rect x="0" y="${volTopY + volBtnH + volGap}" width="${btnW}" height="${volBtnH}" rx="3" fill="${buttonColor}"/>`;
  const rightButtons = `
    <rect x="${width - btnW}" y="${powerY}" width="${btnW}" height="${powerH}" rx="3" fill="${buttonColor}"/>`;

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bodyColorLight}"/>
      <stop offset="0.5" stop-color="${bodyColor}"/>
      <stop offset="1" stop-color="${bodyColorLight}"/>
    </linearGradient>
  </defs>
  <path d="${outerPath} ${innerPath}" fill="url(#metal)" fill-rule="evenodd"/>
  ${leftButtons}
  ${rightButtons}
</svg>`.trim();

  // Pastille caméra : posée sur l'écran, donc dessinée en overlay séparé
  const pillW = Math.round(screenWidth * 0.28);
  const pillH = Math.round(bezel * 1.5);
  const pillX = screenRect.x + Math.round((screenWidth - pillW) / 2);
  const pillY = screenRect.y + Math.round(bezel * 0.9);

  const overlaySvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${cutoutColor}"/>
</svg>`.trim();

  return { width, height, screenRect, screenRadius, svg, overlaySvg };
}

const FRAMES = {
  browser: browserFrame,
  desktop: desktopFrame,
  mobile: mobileFrame,
};

/**
 * @param {'browser'|'desktop'|'mobile'} name
 * @param {number} screenWidth
 * @param {number} screenHeight
 * @param {object} opts options spécifiques au gabarit (couleurs, épaisseurs, rayons...)
 * @returns {FrameLayout}
 */
function getFrame(name, screenWidth, screenHeight, opts = {}) {
  const fn = FRAMES[name];
  if (!fn) {
    throw new Error(`Frame inconnue: "${name}". Disponibles: ${Object.keys(FRAMES).join(', ')}`);
  }
  return fn(clamp(screenWidth, 100, 8000), clamp(screenHeight, 100, 8000), opts);
}

module.exports = { getFrame, FRAMES: Object.keys(FRAMES), roundedRectPath };
