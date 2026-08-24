# CLAUDE.md

Site GitHub Pages personnel hébergeant des mini-apps (« artefacts »).
Publié sur https://invoxiaehu.github.io/artefacts-/ — chaque artefact vit
sous `artifacts/<slug>/` et est servi sur `/artefacts-/<slug>/`.
La cible d'usage prioritaire est **l'iPhone** (PWA installée sur l'écran
d'accueil, 375 px de large) : toute décision d'UI se juge d'abord là.

## Structure et build

- `artifacts/<slug>/` : `main.jsx` (point d'entrée) + le composant + `index.html`.
  React 19, JSX pur, pas de router ni Tailwind — le CSS vit dans une chaîne
  `const CSS` scopée par une classe racine.
- `site/index.html` : page d'accueil — tout nouvel artefact doit y être référencé à la main.
- `build.mjs` (`npm run build`) : esbuild bundle chaque artefact vers
  `dist/<slug>/app.js` (iife, minifié) et réécrit `index.html` avec
  `app.js?v=<sha256[0:8]>` (cache-busting).
- Déploiement : push sur `main` → workflow `deploy.yml` → `npm ci && npm run build`
  → **force-push de `dist/` sur la branche `gh-pages`**. Propagation : 1 à 4 minutes.
- La skill locale `ajouter-artefact` décrit la publication d'un nouvel artefact.

## Standard commun à tous les artefacts — mode avion (PWA)

Tout artefact du dépôt doit fonctionner hors ligne et s'installer sur
l'écran d'accueil. Le modèle est `carnet-accords` :

- `pwa.json` à côté du code (nom, couleurs, librairies vendor, polices) :
  sa présence déclenche `buildPwa` dans `build.mjs` — copie des librairies
  dans `dist/<slug>/vendor/`, icônes PNG dessinées au build,
  `manifest.webmanifest` **volontairement sans `start_url`** (pour que
  « Sur l'écran d'accueil » embarque le fragment `#data=…`), et
  instanciation de `sw.template.js` (nom de cache dérivé du contenu :
  un déploiement invalide l'ancien cache tout seul).
- `main.jsx` installe deux shims avant le rendu : `window.storage`
  (localStorage préfixé `<slug>:`, API async get/set/remove) et
  `window.offline` (état du service worker : shell/vendor en cache,
  `warm()`, `update()`, `waiting`). Absents dans un aperçu d'artefact —
  toujours tester leur existence.
- La page Réglages de l'app expose les sections « Mode avion »
  (préparer le cache, état) et « Mise à jour » (version `?v=` affichée,
  installer la version en attente ou recharger en contournant le cache).
- **À faire** : « Le Mot » (`artifacts/lemot/`) n'est pas encore à ce
  standard (pas de `pwa.json` ni de service worker) — mise à niveau prévue,
  ne pas l'entreprendre sans demande explicite.

## Livraison

- Travailler sur une branche `claude/…`. Après chaque merge, **repartir de
  main** : `git fetch origin main && git checkout -B <branche> origin/main`
  (le force-push est sûr tant que la branche ne contient que de l'historique mergé).
- Commit + push, PR prête (pas de brouillon), **merge direct** — c'est le
  fonctionnement demandé par le propriétaire du dépôt. Messages de commit,
  PRs et échanges en français.
- Vérifier le déploiement en pollant la page publiée jusqu'à voir le
  **hash exact** `app.js?v=<sha8>` produit par le build local. Ne jamais
  vérifier par grep de contenu : esbuild échappe les accents (`\xE9`) et
  un mot peut déjà exister dans l'ancien bundle.
- Montrer des captures d'écran (viewport 375×812) pour toute évolution
  d'UI ; pour un choix visuel, proposer plusieurs variantes rendues dans
  la vraie app avant de trancher.

## Tests locaux

- `npm ci` d'abord (node_modules absent au démarrage de session), puis
  `npm run build` et servir `dist/` (`python3 -m http.server 8123 -d dist`).
- Playwright : module global `/opt/node22/lib/node_modules/playwright`,
  Chromium dans `/opt/pw-browsers/` (passer `executablePath`). Viewport
  375×812. Collecter les `pageerror`.
- Pièges connus :
  - `text-transform: uppercase` — comparer les textes en majuscules ;
  - dans le Carnet, l'`innerText` d'une `.row` entremêle accords et
    paroles — extraire les spans `.ly` ;
  - `addInitScript` rejoue à **chaque** navigation/reload — garder le seed
    localStorage derrière `if (!localStorage.getItem(...))` ;
  - laisser ~200 ms après un clic avant d'inspecter le DOM.

## Carnet d'accords (`artifacts/carnet-accords/`)

Tout vit dans `Carnet.jsx` (parseur PDF, moteur d'accords, diagrammes SVG,
CSS, composants) — modifications ciblées, pas de découpage en fichiers.

### Persistance — les invariants

- `carnet:v4` : `{ songs, showChords, size, speed, sort, sortDir, barOpen,
  instrument, theme, listFilter }`. Chanson : `{ id, title, artist, body,
  steps, memo? }` (`memo` 1–5 absent si 0).
- Les **ids de chansons sont régénérés à chaque import** : tags (`tags:v1`)
  et listes (`lists:v1`) sont ancrés par `songKey` (titre|artiste
  normalisés) et suivent un renommage via `moveTags`/`moveLists`.
- `normalizeLibrary` est le seul point de passage des imports (URL,
  fichier, collage) : **tout nouveau champ de chanson doit y être
  préservé**, sinon il est silencieusement perdu au premier transfert.
- URL de partage (`#v=1&data=…`) : songs + réglages, **sans** tags ni
  listes. Sauvegarde fichier : `backupJson { songs, tags, lists }` — sa
  signature pilote le point ambre « dirty » ; en changer le format change
  la signature.

### Design system

- Palette en variables sur `.cb` (`--bg`, `--panel`, `--amber`, `--hot`…)
  + voiles translucides de l'accent `--acc-soft/faint/glow` — **jamais de
  rgba d'accent codé en dur**.
- Thème clair = `.cb.light` : gris très pâle, panneaux blancs, accent
  cobalt. Les couleurs de tags (pastels pensés pour le sombre) passent par
  `tagInk()` en clair (resaturées, luminosité plafonnée).
- Repli du menu par grille `0fr/1fr` (pas de `max-height` figé). Budget
  largeur de la barre du haut : ~342 px utilisés à 375 px — prudence avant
  d'y ajouter une icône.

### Doctrine UX (choix validés par l'utilisateur)

- Barre du haut de la chanson : actions globales fréquentes en boutons
  icônes (🎲 jouer, 🎓 réviser, ♯ accords, 🎼 diagrammes, ▶/⏸ défilement),
  état actif = fond ambre. Menu dépliant : uniquement le par-chanson
  (tags, listes, note « Appris », tonalité, Modifier, Supprimer). Réglages
  rares dans ⚙. Contrôles contextuels flottants (pilule Vitesse visible
  seulement pendant le défilement).
- Note affichée « vide » plutôt que zéro quand une chanson n'est pas notée.

### Révision et tirages

- Unités typées par section : refrain/pré-refrain (`sectionKind`) =
  une unité révélée d'un bloc ; couplets, ponts, sans étiquette = ligne à
  ligne. L'instrumental se détecte **au contenu** (bloc sans paroles →
  jamais masqué ni compté), pas au nom de section.
- Tirages pondérés : 🎲 Jouer `2^memo` (les mieux connues), 🎓 Réviser
  `2^(5−memo)` (les moins connues, révision lancée à l'ouverture) —
  toujours sur `filtered` (recherche + tags + liste active).
- Fin de session : popup de note, une seule apparition par session
  (`memoPromptedRef`, réarmé par `startRevise`).
