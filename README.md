# artefacts-

Artefacts publiés par Claude, partagés publiquement via **GitHub Pages** :
<https://invoxiaehu.github.io/artefacts-/>

## Structure

```
site/                  Pages statiques copiées telles quelles à la racine du site
  index.html           Page d'accueil (liste des artefacts)
artifacts/<nom>/       Artefacts React/JSX : main.jsx (entrée) + LeMot.jsx… + index.html
  pwa.json             Facultatif : rend l'artefact installable et utilisable hors connexion
  sw.template.js       Modèle de service worker, instancié au build
build.mjs              Assemble le site dans dist/ (copie site/, bundle chaque artefact avec esbuild)
build/png.mjs          Encodeur PNG minimal : dessine les icônes d'application au build
.github/workflows/     CI : build + déploiement GitHub Pages à chaque push sur main
```

## Ajouter un artefact

- **HTML/CSS/JS pur** : déposer un dossier dans `site/<nom>/` avec un `index.html`,
  puis ajouter un lien dans `site/index.html`.
- **React/JSX** : créer `artifacts/<nom>/` avec `main.jsx` (point d'entrée qui fait le
  `createRoot(...).render(...)`) et `index.html` (qui charge `./app.js`). Le build le
  bundle automatiquement vers `dist/<nom>/app.js`.

Puis pousser sur `main` : le workflow construit et déploie tout seul.

## Rendre un artefact installable et utilisable hors connexion

Déposer un `pwa.json` dans `artifacts/<nom>/` suffit : le build génère alors un
manifeste d'application, les icônes et un service worker (à partir du
`sw.template.js` du même dossier), et l'artefact devient installable sur l'écran
d'accueil.

```json
{
  "name": "…", "short_name": "…", "description": "…",
  "background": "#111216", "accent": "#E9B44C", "accent_dim": "#8A6B2A",
  "vendor": { "pdf.min.js": "pdfjs-dist/build/pdf.min.js" },
  "fonts": "https://fonts.googleapis.com/css2?family=…"
}
```

- `vendor` copie des fichiers de `node_modules/` vers `dist/<nom>/vendor/` : les
  librairies chargées au runtime ne dépendent plus d'un CDN, donc plus du réseau.
- Le cache est nommé d'après le contenu déployé (`<nom>-v<hash>`) : un nouveau
  déploiement invalide l'ancien tout seul, et les caches des autres artefacts —
  le site est servi depuis une seule origine — ne sont jamais touchés.
- La coquille (HTML, `app.js`, manifeste, icônes) est précachée à l'installation ;
  les librairies et les polices le sont ensuite, en tâche de fond.
- L'`index.html` de l'artefact doit déclarer `<link rel="manifest">`,
  l'`apple-touch-icon` et charger ses polices distantes par un `<link crossorigin>`
  (une réponse opaque ne peut pas entrer dans le cache).

> Sessions Claude Code : la skill locale `ajouter-artefact`
> (`.claude/skills/ajouter-artefact/SKILL.md`) décrit ce workflow de bout en bout
> (intégration d'un code collé, build, test navigateur, push, vérification Pages).

## Déploiement

`main` contient les sources ; le workflow construit `dist/` et le publie
(force-push) sur la branche générée `gh-pages`, que GitHub Pages sert. Ne pas
éditer `gh-pages` à la main : elle est réécrite à chaque déploiement.

## Développement local

```bash
npm install
npm run build
npx http-server dist   # ou : python3 -m http.server -d dist 8123
```

## Artefacts

| Artefact | Description |
|---|---|
| [`lemot/`](https://invoxiaehu.github.io/artefacts-/lemot/) | **Le Mot** — jeu de lettres quotidien en français (5 ou 6 lettres, six essais, correction à la marge façon dictée, modes mot du jour / partie libre / mot secret). |
| [`carnet-accords/`](https://invoxiaehu.github.io/artefacts-/carnet-accords/) | **Carnet d'accords** — carnet de grilles pour musiciens : import de PDF (paroles et accords alignés via pdf.js + ChordSheetJS), transposition par demi-tons, défilement automatique, sauvegarde locale et partage du carnet complet dans le fragment d'URL (`#v=1&data=`, gzip + Base64URL, sans backend). Installable sur l'écran d'accueil et utilisable sans connexion, import de PDF compris. |
