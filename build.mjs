// Assemble le site statique dans dist/ :
//  - site/            → copié tel quel à la racine (page d'accueil, artefacts HTML purs)
//  - artifacts/<nom>/ → chaque dossier contenant un main.jsx est bundlé par esbuild
//                       vers dist/<nom>/app.js ; son index.html est copié à côté.
//  - artifacts/<nom>/pwa.json → l'artefact devient installable et utilisable hors
//                       connexion : librairies copiées dans vendor/, manifeste,
//                       icônes et service worker générés ici (voir buildPwa).
import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { versesIcon, vuIcon } from "./build/png.mjs";

const DIST = "dist";
const sha8 = (data) => createHash("sha256").update(data).digest("hex").slice(0, 8);
const fmt = (n) => `${(n / 1024).toFixed(0)} Ko`;

// Trois tailles suffisent : Android puise dans le manifeste (et masque l'icône
// dans un cercle, d'où « maskable »), iOS lit apple-touch-icon.
const ICONS = [
  { file: "icon-192.png", size: 192, purpose: "any maskable" },
  { file: "icon-512.png", size: 512, purpose: "any maskable" },
  { file: "apple-touch-icon.png", size: 180, purpose: null },
];

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await cp("site", DIST, { recursive: true });

const artifactsDir = "artifacts";
let names = [];
try {
  names = await readdir(artifactsDir);
} catch {
  names = [];
}

for (const name of names) {
  const dir = path.join(artifactsDir, name);
  if (!(await stat(dir)).isDirectory()) continue;
  const entry = path.join(dir, "main.jsx");
  try {
    await stat(entry);
  } catch {
    continue; // pas d'entrée JSX : dossier ignoré
  }
  const out = path.join(DIST, name);
  await mkdir(out, { recursive: true });
  await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "iife",
    jsx: "automatic",
    outfile: path.join(out, "app.js"),
    logLevel: "info",
  });
  // Le HTML référence app.js?v=<hash du contenu> : le cache navigateur ne
  // peut plus servir un vieux JS avec un HTML plus récent (GitHub Pages
  // met les fichiers en cache ~10 min).
  const js = await readFile(path.join(out, "app.js"));
  const v = sha8(js);
  const html = (await readFile(path.join(dir, "index.html"), "utf8"))
    .replace(/\.\/app\.js/g, `./app.js?v=${v}`);
  await writeFile(path.join(out, "index.html"), html);
  console.log(`✓ artefact « ${name} » → ${out}/ (v=${v})`);

  const pwa = await readJson(path.join(dir, "pwa.json"));
  if (pwa) await buildPwa({ slug: name, dir, out, pwa, appVersion: v });
}

console.log("Build terminé → dist/");

/* ------------------------------------------------------------------ */

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${file} illisible : ${e.message}`);
  }
}

/** Rend un artefact installable et utilisable hors connexion :
 *  - copie les librairies runtime de node_modules vers dist/<slug>/vendor/,
 *    pour que l'app ne dépende plus d'aucun CDN ;
 *  - dessine les icônes (aucun binaire dans le dépôt) et écrit le manifeste ;
 *  - instancie sw.template.js avec la liste exacte des fichiers à précacher et
 *    un nom de cache dérivé de leur contenu — un déploiement invalide donc
 *    l'ancien cache tout seul. */
async function buildPwa({ slug, dir, out, pwa, appVersion }) {
  const template = await readFile(path.join(dir, "sw.template.js"), "utf8");
  const fingerprint = [appVersion, template];

  const vendor = [];
  for (const [file, source] of Object.entries(pwa.vendor || {})) {
    const from = path.join("node_modules", source);
    let bytes;
    try {
      bytes = await readFile(from);
    } catch {
      throw new Error(`${slug}/pwa.json : ${from} est introuvable — la dépendance manque dans package.json ?`);
    }
    await mkdir(path.join(out, "vendor"), { recursive: true });
    await writeFile(path.join(out, "vendor", file), bytes);
    vendor.push({ url: `./vendor/${file}`, bytes: bytes.length });
    fingerprint.push(sha8(bytes));
  }

    // Motif de l'icône, choisi par pwa.json ; « vu » par défaut, pour que les
  // artefacts déjà publiés gardent exactement la leur.
  const draw = pwa.icon === "verses" ? versesIcon : vuIcon;
  const icons = [];
  for (const icon of ICONS) {
    const png = draw(icon.size, { background: pwa.background, accent: pwa.accent, dim: pwa.accent_dim });
    await writeFile(path.join(out, icon.file), png);
    fingerprint.push(sha8(png));
    if (icon.purpose) {
      icons.push({ src: `./${icon.file}`, sizes: `${icon.size}x${icon.size}`, type: "image/png", purpose: icon.purpose });
    }
  }

  const manifest = {
    name: pwa.name,
    short_name: pwa.short_name,
    description: pwa.description,
    lang: "fr",
    // Pas de start_url par défaut : le navigateur retombe alors sur l'URL du
    // document au moment de l'installation, fragment compris. C'est ce qui permet
    // à « Sur l'écran d'accueil » d'embarquer les données d'une URL de partage
    // (#v=1&data=… pour le Carnet) — déclarer start_url ici les remplacerait par
    // une page vide. À ne renseigner que pour un artefact sans état dans l'URL.
    ...(pwa.start_url ? { start_url: pwa.start_url } : {}),
    scope: "./",
    display: "standalone",
    orientation: "portrait",
    background_color: pwa.background,
    theme_color: pwa.background,
    icons,
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(path.join(out, "manifest.webmanifest"), manifestJson);
  fingerprint.push(sha8(manifestJson));

  // La coquille : petite, précachée à l'installation, suffisante pour démarrer
  // l'app et lire le carnet sans réseau.
  const shell = ["./", "./index.html", `./app.js?v=${appVersion}`, "./manifest.webmanifest",
    ...ICONS.map((i) => `./${i.file}`)];
  const prefix = `${slug}-v`;
  const version = sha8(fingerprint.join("|"));
  const sw = template
    .replace(/__NAME__/g, pwa.name)
    .replace(/__CACHE_PREFIX__/g, prefix)
    .replace(/__CACHE__/g, prefix + version)
    .replace(/__SHELL__/g, JSON.stringify(shell))
    .replace(/__VENDOR__/g, JSON.stringify(vendor))
    .replace(/__FONTS__/g, JSON.stringify(pwa.fonts || null));
  if (/__[A-Z_]+__/.test(sw)) throw new Error(`${slug}/sw.template.js : marqueur non remplacé`);
  await writeFile(path.join(out, "sw.js"), sw);

  const total = vendor.reduce((sum, e) => sum + e.bytes, 0);
  console.log(`  ↳ hors ligne : cache ${prefix}${version}, coquille ${shell.length} fichiers, ` +
    `librairies ${vendor.length} (${fmt(total)})`);
}
