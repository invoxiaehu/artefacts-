// Assemble le site statique dans dist/ :
//  - site/            → copié tel quel à la racine (page d'accueil, artefacts HTML purs)
//  - artifacts/<nom>/ → chaque dossier contenant un main.jsx est bundlé par esbuild
//                       vers dist/<nom>/app.js ; son index.html est copié à côté.
import { build } from "esbuild";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const DIST = "dist";

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
  await cp(path.join(dir, "index.html"), path.join(out, "index.html"));
  await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "iife",
    jsx: "automatic",
    outfile: path.join(out, "app.js"),
    logLevel: "info",
  });
  console.log(`✓ artefact « ${name} » → ${out}/`);
}

console.log("Build terminé → dist/");
