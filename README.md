# mockup-pipeline

Pipeline automatisé pour générer les visuels de portfolio type cubicom.fr (mockup d'écran avec le site à l'intérieur, + galerie de captures internes), sans repasser à la main sur Photoshop/Figma à chaque nouveau projet.

Le pipeline fait deux choses, enchaînées automatiquement :

1. **Capture** — ouvre l'URL dans un vrai navigateur headless (Playwright/Chromium) et prend une capture d'écran à la résolution voulue.
2. **Habillage** — insère cette capture dans un cadre généré à la volée (moniteur, fenêtre de navigateur, ou téléphone) avec Sharp, ajoute un fond et une ombre portée, et sort une image PNG prête à l'emploi.

La variante `gif` enchaîne ces deux étapes sur plusieurs positions de
défilement d'une même page et encode le résultat en GIF animé — voir
[Export GIF animé](#export-gif-animé-gif).

Aucune image de mockup à télécharger ou à acheter : les cadres sont dessinés par le script (SVG généré en fonction de la taille de la capture), donc ça marche pour n'importe quelle résolution sans dépendre d'un template figé.

## Installation

```bash
npm install
npx playwright install chromium   # télécharge le Chromium utilisé pour les captures (une seule fois)
```

## Utilisation rapide (un site à la fois)

Mockup "hero" encadré, prêt pour le haut de la page portfolio :

```bash
node src/cli.js hero \
  --url https://exemple-client.fr \
  --name "Exemple Client" \
  --template desktop \
  --background "#f4f2ee" \
  --out output
```

`--template` accepte `desktop` (moniteur sur pied), `browser` (fenêtre de navigateur) ou `mobile` (coque de téléphone bord à bord, écran + boutons + pastille caméra — voir capture ci-dessous). En viewport portrait par défaut (390×844), pas besoin de le préciser.

![Exemple gabarit mobile](./doc/preview.png)

Galerie de captures brutes (plusieurs pages, habillage léger en fenêtre de navigateur, sans pied ni ombre — pour la section "galerie visuelle" de la page portfolio) :

```bash
node src/cli.js gallery \
  --base-url https://exemple-client.fr \
  --name "Exemple Client" \
  --pages "/,/contact,/equipe,/services" \
  --template browser \
  --out output
```

Carrousel de mockups encadrés (une image par page, gabarit `mobile` par défaut, avec ombre et marge — pour un carrousel en bas de page projet) :

```bash
node src/cli.js carousel \
  --base-url https://exemple-client.fr \
  --name "Exemple Client" \
  --pages "/,/contact,/equipe" \
  --background "#ffffff" \
  --out output
```

GIF animé qui parcourt la page (pour montrer un site en mouvement sur la page
projet, sans vidéo à héberger) :

```bash
node src/cli.js gif \
  --url https://exemple-client.fr \
  --name "Exemple Client" \
  --scroll-from 0 \
  --scroll "#contact" \
  --seconds 3 \
  --template browser \
  --out output
```

## Utilisation en lot (recommandé pour ajouter plusieurs projets d'un coup)

Tout se décrit dans un fichier JSON (voir `config/projects.example.json`) :

```json
{
  "outputDir": "output",
  "projects": [
    {
      "name": "Exemple Client",
      "baseUrl": "https://exemple-client.fr",
      "hero": {
        "path": "/",
        "template": "desktop",
        "viewport": { "width": 1440, "height": 900, "deviceScaleFactor": 2 },
        "background": "#f4f2ee",
        "padding": 140
      },
      "gallery": {
        "template": "browser",
        "viewport": { "width": 1280, "height": 800, "deviceScaleFactor": 2 },
        "scrollTo": 0,
        "pages": [
          { "path": "/", "label": "accueil" },
          { "path": "/", "label": "nos-services", "scrollTo": "#services" },
          { "path": "/contact", "label": "contact", "scrollTo": 600 }
        ]
      },
      "carousel": {
        "template": "mobile",
        "viewport": { "width": 390, "height": 844, "deviceScaleFactor": 3 },
        "background": "#ffffff",
        "padding": 100,
        "pages": [
          { "path": "/", "label": "accueil" },
          { "path": "/contact", "label": "contact" },
          { "path": "/equipe", "label": "equipe" }
        ]
      },
      "gif": {
        "path": "/",
        "template": "browser",
        "background": "#ffffff",
        "scrollFrom": 0,
        "scrollTo": "#contact",
        "seconds": 3
      }
    }
  ]
}
```

Copie ce fichier en `config/projects.json`, ajoute une entrée par projet, puis :

```bash
node src/cli.js batch --config config/projects.json
```

Chaque projet ressort dans `output/<nom-du-projet>/` avec son mockup hero, sa galerie, son carrousel mobile et son GIF. Pour ajouter les 5 prochains clients au portfolio, il suffit d'ajouter 5 blocs dans ce fichier et de relancer la commande — plus aucune manipulation manuelle. Un bloc (`hero`, `gallery`, `carousel` ou `gif`) peut être omis si un projet n'en a pas besoin.

## Capturer plus bas dans la page (`scrollTo`)

Par défaut la capture montre le haut de la page. `scrollTo` fait défiler la page
avant de déclencher la capture, ce qui permet de montrer une section précise
(une grille de services, un témoignage, une carte) plutôt que le hero du site.

Deux formes acceptées :

| Valeur | Effet |
|---|---|
| un nombre | défile de N pixels depuis le haut (`"scrollTo": 1200`) |
| un sélecteur CSS | amène cet élément en haut du viewport (`"scrollTo": "#services"`) |

Le sélecteur est plus robuste qu'une valeur en pixels : il reste juste même si
le contenu au-dessus change de hauteur.

`scrollTo` se règle à trois niveaux, du plus général au plus précis — le plus
précis l'emporte :

```json
{
  "name": "Exemple Client",
  "baseUrl": "https://exemple-client.fr",
  "scrollTo": 0,
  "gallery": {
    "scrollTo": 300,
    "pages": [
      { "path": "/", "label": "accueil" },
      { "path": "/", "label": "services", "scrollTo": "#services" },
      { "path": "/contact", "label": "contact", "scrollTo": 0 }
    ]
  }
}
```

Ici la page `accueil` hérite du `scrollTo: 300` de la galerie, `services` défile
jusqu'à l'élément `#services`, et `contact` annule le défilement avec `0`.

En ligne de commande : `--scroll 1200` ou `--scroll "#services"`.

Notes :

- Le défilement est forcé en mode instantané : un site en `scroll-behavior: smooth`
  serait sinon capturé en pleine animation, à une position imprévisible.
- Après le défilement, le script attend 1000 ms (`waitAfterScrollMs`) pour laisser
  arriver les images en lazy-load et les animations d'apparition. À augmenter sur
  un site lent.
- Un sélecteur qui ne correspond à rien produit un avertissement et une capture
  non défilée — le lot n'est pas interrompu.
- `scrollTo` est sans effet si `viewport.fullPage` vaut `true` (toute la page est
  déjà capturée) ; le script le signale.

## Export GIF animé (`gif`)

La variante `gif` capture la même page à plusieurs positions de défilement,
habille chaque image avec le gabarit choisi, et encode le tout en GIF animé
bouclé. Le résultat montre le site en mouvement sur une page portfolio, sans
vidéo à héberger ni lecteur à intégrer.

```bash
node src/cli.js gif --url https://exemple-client.fr --name "Exemple Client" \
  --scroll-from "#hero" --scroll "#contact" --seconds 4
```

Toutes les options sont facultatives : sans rien préciser, le GIF descend du
haut de la page jusqu'en bas, en 3 secondes, dans un gabarit `browser`.

| Option (config / CLI) | Défaut | Effet |
|---|---|---|
| `scrollFrom` / `--scroll-from` | `0` (haut de page) | position de départ : pixels ou sélecteur CSS |
| `scrollTo` / `--scroll` | bas de la page | position d'arrivée : pixels ou sélecteur CSS |
| `seconds` / `--seconds` | `3` | durée de l'animation, bornée entre 2 et 5s |
| `fps` / `--fps` | `12` | images par seconde |
| `easing` / `--easing` | `ease-in-out` | `ease-in-out` (départ et arrêt progressifs) ou `linear` |
| `maxWidth` / `--max-width` | `900` | largeur du GIF produit |
| `colors` (config) | `256` | taille de la palette |
| `loop` (config) | `0` | nombre de boucles, `0` = infini |

Le gabarit (`template`), le fond (`background`), la marge (`padding`) et
l'ombre (`shadow`) se règlent comme pour les autres variantes : un GIF
`mobile` sur fond blanc est un bon format pour une colonne étroite.

`scrollFrom` et `scrollTo` acceptent les deux formes décrites plus haut
(pixels ou sélecteur CSS) — un sélecteur reste préférable, il tient même si le
contenu au-dessus change de hauteur.

Notes :

- **Durée bornée à 2–5s** : en dessous le défilement est illisible, au-delà le
  fichier devient trop lourd (un GIF ne compresse rien d'une image à l'autre).
  Une valeur hors bornes est ramenée dans la plage, avec un avertissement.
- **Poids** : compter ~200 Ko à 1 Mo pour 3 secondes. Les leviers, dans
  l'ordre : `maxWidth`, `fps`, `seconds`, puis `colors` (128 ou 64 pour un site
  aux aplats simples).
- **Transparence** : celle d'un GIF est binaire (un pixel est opaque ou
  totalement transparent). Avec `"background": "transparent"`, l'ombre portée
  ressort dentelée — d'où le fond blanc par défaut sur cette variante. Le
  script le signale si les deux sont combinés.
- **Palette** : les 256 couleurs sont choisies sur un échantillon de toutes les
  images, pas seulement de la première, pour que les sections traversées en
  cours de défilement gardent leurs teintes.
- **Lazy-load** : la plage est parcourue une première fois avant la capture
  pour déclencher le chargement des images et les animations d'apparition ; la
  séquence ne montre donc pas de blocs vides.
- **En mode batch**, le `scrollTo` du niveau projet ne s'applique pas au bloc
  `gif` : c'est ici une position de fin, et un `scrollTo: 0` global figerait
  l'animation. Il se règle dans le bloc `gif` (ou par page).
- **Durée de génération** : une trentaine de captures s'enchaînent sur une page
  déjà chargée — compter quelques dizaines de secondes par GIF.

## Personnaliser les cadres

Les 3 gabarits sont dans `src/frames.js`, chacun sous forme d'une fonction qui reçoit la taille de la capture et retourne un SVG. Pour ajuster l'apparence (couleur du bezel, épaisseur, rayon des coins), passe des `frameOptions` dans la config :

```json
"hero": {
  "template": "desktop",
  "frameOptions": { "bezelColor": "#000000", "bezel": 30 }
}
```

Pour ajouter un 4ᵉ gabarit (ex: tablette), duplique une des fonctions existantes dans `frames.js`, adapte les proportions, et ajoute-la à l'objet `FRAMES` en bas du fichier — elle devient immédiatement disponible via `--template`.

## Notes pratiques

- **Mobile** : les commandes `hero`/`carousel` basculent automatiquement sur un viewport portrait (390×844, deviceScaleFactor 3) dès que `--template mobile` est utilisé — inutile de le préciser, sauf pour un autre format d'écran.
- **Résolution** : `deviceScaleFactor: 2` (2x, "retina") par défaut pour desktop/browser, `3` pour mobile — les images sortent nettes, à réduire au besoin côté CMS.
- **Cookies/bannières** : `capture.js` accepte un tableau `hideSelectors` (sélecteurs CSS à masquer avant la capture) pour retirer une bannière de consentement qui polluerait le mockup.
- **Sites lents / contenu différé** : ajuste `waitAfterLoadMs` dans `capture.js` (ou expose-le en option de config) si des éléments arrivent après le chargement initial (animations, lazy-load).
- **Fond et ombre** : `background` accepte `"transparent"` ou un hex (`"#f4f2ee"`). `padding` ajoute une marge autour du mockup avant export. Pour la galerie, l'ombre et le padding sont désactivés par défaut afin de garder des captures homogènes et facilement recadrables.

## Structure du projet

```
mockup-pipeline/
├── src/
│   ├── capture.js   # capture d'écran, fixe ou en séquence (Playwright)
│   ├── frames.js    # génération des cadres SVG (desktop / browser / mobile)
│   ├── compose.js   # assemblage capture + cadre + fond + ombre (Sharp)
│   ├── gif.js       # encodage d'une séquence en GIF animé (gifenc)
│   ├── util.js      # utilitaires partagés (slug, parsing d'options...)
│   └── cli.js       # commandes: hero / gallery / carousel / gif / batch
├── config/
│   └── projects.example.json
├── doc/
│   └── preview-mobile.png
└── output/            # images générées (créé automatiquement)
```
