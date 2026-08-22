# artefacts-

Artefacts publiés par Claude, partagés publiquement via **GitHub Pages** :
<https://invoxiaehu.github.io/artefacts-/>

## Structure

```
site/                  Pages statiques copiées telles quelles à la racine du site
  index.html           Page d'accueil (liste des artefacts)
artifacts/<nom>/       Artefacts React/JSX : main.jsx (entrée) + LeMot.jsx… + index.html
build.mjs              Assemble le site dans dist/ (copie site/, bundle chaque artefact avec esbuild)
.github/workflows/     CI : build + déploiement GitHub Pages à chaque push sur main
```

## Ajouter un artefact

- **HTML/CSS/JS pur** : déposer un dossier dans `site/<nom>/` avec un `index.html`,
  puis ajouter un lien dans `site/index.html`.
- **React/JSX** : créer `artifacts/<nom>/` avec `main.jsx` (point d'entrée qui fait le
  `createRoot(...).render(...)`) et `index.html` (qui charge `./app.js`). Le build le
  bundle automatiquement vers `dist/<nom>/app.js`.

Puis pousser sur `main` : le workflow construit et déploie tout seul.

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
