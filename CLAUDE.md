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
  steps, memo?, memoAuto? }` (`memo` 0.1–5, **une décimale**, absent si 0 ;
  `memoAuto: true` = score écrit par le scoring automatique, effacé par un
  réglage manuel aux étoiles — qui passe par un `confirm` d'avertissement).
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
  jamais masqué ni compté), pas au nom de section. Même logique pour le
  **préambule** : avant la première section, un bloc sans le moindre accord
  (métadonnées de PDF : titre, crédits, accordage) n'est ni masqué ni
  compté — attention, les deux parseurs rendent le texte pur en `row` à
  accords vides, pas en `text`. Partout dans la chanson, la **notation**
  n'est ni masquée ni comptée : tablature (`|` + tirets), ligne commençant
  par `|` (grille de mesures, légende de tab), ligne sans aucune lettre
  (séparateurs `****`, comptages), comptage de temps (« x2 », « 1 e & a » —
  au moins un chiffre), ligne entière entre parenthèses (« (Repeat to
  Fade) » — même avec accords accolés par l'alignement PDF), ligne ouvrant
  sur `[` ou portant un crochet échappé `\[…\]` (exports UG : « \[Chorus\]
  (play loud) », accords inline et leurs fragments), étiquette de section
  en texte (mot de structure + « : » : « Verse 1: », « Outro: (…) »), et
  consigne de jeu sans accords finissant par « : » — la condition d'accords
  de cette dernière règle protège une parole chantée en « … : ».
- Scoring automatique : la révision est « pipelinée » — un bouton « Révéler »
  pour la première unité, puis chaque ✓ Savais / ✗ Savais pas juge la
  dernière unité révélée ET révèle la suivante ; la session ne finit qu'une
  fois la dernière unité jugée (`judged >= toJudge`, `toJudge` exclut le
  contexte d'un départ aléatoire). Chaque réponse fait un pas d'EMA
  (`emaStep`, α dérivé du nombre d'unités : une session complète pèse ~50 %),
  valeur non arrondie gardée dans `memoLiveRef` pendant la session — seul
  `song.memo` est arrondi (une décimale, jamais 0). Clavier : → savais,
  ← savais pas, Espace/Entrée/↓ = première révélation seulement.
- Tirages pondérés : 🎲 Jouer `2^memo` (les mieux connues), 🎓 Réviser
  `2^(5−memo)` (les moins connues, révision lancée à l'ouverture) —
  toujours sur `filtered` (recherche + tags + liste active).
- Mode Quiz (bouton ❓ de la liste) : tirage **uniforme** d'une chanson de
  `filtered` (décision utilisateur — pas de pondération), puis d'une unité
  (`reviseMode === "quiz"`, contexte visible avant l'unité tirée) ; Révéler
  → Savais/Savais pas (même EMA) → chanson suivante, ■ Stop → score de la
  partie. La partie (`quiz {asked, correct}`) survit aux `openSong` ; le
  ré-armement passe par `pendingQuizRef` + nonce `quizQ` (obligatoire quand
  le hasard retombe sur la même chanson) ; les chansons sans paroles
  croisées en route vont dans `quizDeadRef`.
- Lancement du quiz : ❓ ouvre d'abord un popup de vivier — « Toutes » ou
  « Les moins connues » avec un seuil d'étoiles (`quizScope`, `quizMax` ;
  note ≤ seuil, une chanson non notée compte pour 0 donc toujours dedans).
  Le vivier retenu est **figé en ids** dans `quizPoolRef` au démarrage :
  répondre juste fait monter le score, mais la chanson ne doit pas quitter
  la partie en cours de route. Choix gardé en état (non persisté) : pas de
  nouveau champ dans `carnet:v4`, donc pas de signature de sauvegarde touchée.
- Fin de quiz : le popup de score porte un dépliant « Détail » — une ligne
  par chanson jouée, `avant → après` (vert si le score monte, rouge s'il
  descend, « — » si la chanson n'était pas notée) et le nombre de bonnes
  réponses. Alimenté par `quizStatsRef` (id → ligne), où `avant` est le
  score au **premier** passage de la chanson : tirée deux fois, elle ne
  raconte qu'un seul mouvement. `applyAuto` renvoie `{ before, after }`
  pour cela.
- Fin de session : popup de **score** (informatif, ajustement possible),
  une seule apparition par session (`memoPromptedRef`, réarmé par
  `startRevise`), seulement si `judged > 0`, jamais en quiz.
