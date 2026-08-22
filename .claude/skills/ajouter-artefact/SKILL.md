---
name: ajouter-artefact
description: Publier un nouvel artefact sur le site GitHub Pages de ce dépôt (https://invoxiaehu.github.io/artefacts-/) à partir d'un code fourni ou collé dans la conversation — composant React/JSX, page HTML, mini-app JS. Utiliser dès que l'utilisateur colle du code (ou pointe un fichier) et demande de l'« ajouter », le « publier », le « mettre en ligne », « en faire une page », « créer l'artefact » ou « le partager », même sans le mot « artefact ». Couvre tout le cycle - intégration du code tel quel, entrée sur la page d'accueil, build esbuild, test navigateur, push sur main et vérification du déploiement Pages.
---

# Ajouter un artefact au site

## Comment ce dépôt fonctionne

Le push sur `main` déclenche `.github/workflows/deploy.yml` : `npm ci`, `npm run build`
(→ `build.mjs`), puis déploiement de `dist/` sur GitHub Pages. Le build :

- copie `site/` tel quel à la racine de `dist/` (accueil + artefacts HTML purs) ;
- pour chaque dossier `artifacts/<slug>/` contenant un `main.jsx`, bundle avec esbuild
  vers `dist/<slug>/app.js` (minifié, JSX automatique) et copie son `index.html` à côté.

URLs publiques : `https://invoxiaehu.github.io/artefacts-/` et `…/artefacts-/<slug>/`.
`dist/` et `node_modules/` sont gitignorés — ne jamais les commiter.

## 1. Qualifier le code collé

- Choisis un **slug** court en kebab-case sans accents (ex. `lemot`, `pomodoro`).
  C'est le nom du dossier ET le segment d'URL.
- **React/JSX** (le code contient du JSX, des hooks, un `export default`) →
  dossier `artifacts/<slug>/`.
- **HTML/CSS/JS pur** (page autonome) → `site/<slug>/index.html`, rien à builder.
- Si le code importe des paquets autres que `react`/`react-dom`, ajoute-les aux
  `dependencies` de `package.json` (ils seront bundlés par esbuild). S'il dépend d'un
  chargement CDN au runtime, garde-le : Pages n'a pas de CSP restrictive.

## 2. Intégrer le code VERBATIM

Le code collé est l'œuvre de l'utilisateur : recopie-le **à l'identique**, sans le
reformater, le « corriger » ni le tronquer. Un mot de dictionnaire perdu ou une regex
réécrite sont des bugs silencieux. Pour un gros fichier, écris-le en plusieurs blocs
avec des heredocs **quotés** (`cat >> fichier <<'EOF'`) : le quoting protège les
backticks, `${…}` des template literals et les backslashes. Choisis un marqueur EOF
qui n'apparaît pas dans le code. Après coup, contrôle la taille (`wc -c`) et quelques
points sensibles (`grep`) plutôt que de te fier à ta mémoire.

### Cas React : trois fichiers dans `artifacts/<slug>/`

`MonComposant.jsx` — le code collé, tel quel (le nom de fichier doit correspondre à
l'import du `main.jsx`).

`main.jsx` :

```jsx
import { createRoot } from "react-dom/client";
import MonComposant from "./MonComposant.jsx";

createRoot(document.getElementById("root")).render(<MonComposant />);
```

`index.html` — adapte `<title>`, la description et la langue au sujet :

```html
<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Titre de l'artefact</title>
  <meta name="description" content="Une phrase de description." />
  <style>
    html, body { margin: 0; padding: 0; min-height: 100%; }
    #root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="./app.js"></script>
</body>
</html>
```

Donne à `body` le fond attendu par le composant (évite un flash blanc au chargement).

### Chemins relatifs, toujours

Le site vit sous le sous-chemin `/artefacts-/` : toute URL absolue commençant par `/`
casse en production alors qu'elle marche en local. Écris `./app.js`, `./lemot/`,
`../` — jamais `/app.js`.

## 3. Référencer l'artefact

- **`site/index.html`** : ajoute un `<li>` dans la liste, sur le modèle des entrées
  existantes (titre + description d'une ligne, lien `./​<slug>/`).
- **`README.md`** : ajoute une ligne au tableau « Artefacts ».

## 4. Builder et tester avant de pousser

Un push qui casse le déploiement coûte un aller-retour CI ; valide tout localement :

```bash
npm install        # la première fois dans le conteneur
npm run build      # doit créer dist/<slug>/ sans erreur
python3 -m http.server 8123 -d dist &
```

Puis un smoke test navigateur avec Playwright (Chromium préinstallé —
`executablePath: "/opt/pw-browsers/chromium"`, ne lance pas `playwright install`) :
charge `http://localhost:8123/<slug>/`, collecte `pageerror` et les erreurs console,
interagis brièvement si c'est interactif (une saisie, un clic), prends un screenshot
et envoie-le à l'utilisateur (SendUserFile). Deux échecs de ressources sont normaux
dans le conteneur et n'existent pas en prod : les Google Fonts (bloquées par le proxy)
et `favicon.ico`. Toute autre erreur JS doit être comprise avant de pousser.

## 5. Pousser et vérifier le déploiement

Commite en français (message clair : quel artefact, ce qu'il fait) et pousse
**directement sur `main`** — c'est la convention voulue de ce dépôt (Pages déploie
`main`) : ne crée pas de PR pour un ajout d'artefact, sauf demande contraire.

Le push déclenche le workflow « Build & Deploy GitHub Pages ». Attends qu'il soit
vert (outils GitHub Actions, ou à défaut poll HTTP), puis vérifie les URLs publiques :

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
  https://invoxiaehu.github.io/artefacts-/<slug>/ \
  https://invoxiaehu.github.io/artefacts-/<slug>/app.js
```

Compare le sha256 du `app.js` déployé à celui de `dist/<slug>/app.js` local : s'ils
sont identiques, ce qui est en ligne est exactement ce qui a été testé. Termine en
donnant à l'utilisateur l'URL publique de l'artefact et celle de l'accueil.

## Pièges connus

- Le déploiement met parfois ~1-2 min après le vert du workflow ; re-curl avant de
  conclure à un échec (le cache Pages peut aussi servir l'ancienne version un moment).
- Si le run échoue dans `configure-pages`, vérifie dans Settings → Pages que la
  source est « GitHub Actions » (le workflow tente l'activation automatique).
- Un artefact HTML pur dans `site/` ne passe pas par esbuild : pas de JSX ni
  d'`import` nu dedans — tout doit tourner tel quel dans le navigateur.
- N'oublie pas l'entrée d'accueil : un artefact non listé est introuvable.
