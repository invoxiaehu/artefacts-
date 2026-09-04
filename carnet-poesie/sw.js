/* Service worker de « Carnet de poésie ».
 *
 * Généré par build.mjs depuis sw.template.js : les listes de fichiers et le nom
 * du cache sont injectés au build. Ne pas éditer dist/<slug>/sw.js à la main.
 *
 * Deux niveaux de cache, parce qu'ils n'ont pas le même coût :
 *  - la coquille (HTML, app.js, manifeste, icônes) est petite : précachée à
 *    l'installation, elle suffit à démarrer l'app et à lire le carnet ;
 *  - les librairies et les polices sont lourdes : préchargées après coup, en
 *    tâche de fond ou sur demande depuis les Réglages (« Préparer le mode
 *    avion »). Un réseau capricieux ne peut donc pas faire échouer
 *    l'installation.
 */
const CACHE = "carnet-poesie-v6d404ef3";
const CACHE_PREFIX = "carnet-poesie-v";
const SHELL = ["./","./index.html","./app.js?v=3df0f09f","./manifest.webmanifest","./icon-192.png","./icon-512.png","./apple-touch-icon.png"];
const VENDOR = [];
const FONTS = "https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Barlow+Condensed:wght@500;600;700&display=swap";

const FONT_HOSTS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];
const SCOPE = new URL("./", self.location.href).pathname;

/* ------------------------------------------------------------------ */
/* Installation et activation                                          */
/* ------------------------------------------------------------------ */

self.addEventListener("install", (event) => {
  // `cache: "reload"` : on précache ce que le serveur a de plus récent, jamais
  // ce qui traîne dans le cache HTTP du navigateur.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key.startsWith(CACHE_PREFIX)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
  // Le préchargement des librairies n'est pas attendu ici : tant que
  // `waitUntil` n'est pas résolu, le worker reste « activating » et les
  // requêtes de la page attendraient. C'est la page qui le déclenche.
});

/* ------------------------------------------------------------------ */
/* Préchargement des librairies et des polices                         */
/* ------------------------------------------------------------------ */

/** Les polices Google arrivent en deux temps : une feuille CSS, puis les
 *  fichiers .woff2 qu'elle référence. Les deux passent en CORS (la feuille
 *  parce que l'index.html la demande avec `crossorigin`), donc les réponses ne
 *  sont pas opaques et peuvent entrer dans le cache. */
async function fontUrls(cache) {
  if (!FONTS) return [];
  const urls = [FONTS];
  let css = await cache.match(FONTS);
  if (!css) {
    const res = await fetch(new Request(FONTS, { mode: "cors", credentials: "omit", cache: "reload" }));
    if (!res.ok) throw new Error("feuille de polices indisponible");
    await cache.put(FONTS, res.clone());
    css = res;
  }
  const text = await css.text();
  for (const m of text.matchAll(/url\((https:\/\/[^)"']+)\)/g)) urls.push(m[1]);
  return urls;
}

let warming = null;

function warm() {
  if (!warming) {
    warming = (async () => {
      const cache = await caches.open(CACHE);
      const targets = VENDOR.map((entry) => entry.url);
      try {
        targets.push(...(await fontUrls(cache)));
      } catch { /* les polices système font l'affaire, l'app reste lisible */ }
      for (const url of targets) {
        if (await cache.match(url)) continue;
        try {
          const external = !url.startsWith("./") && new URL(url, self.location.href).origin !== self.location.origin;
          const res = await fetch(new Request(url, external ? { mode: "cors", credentials: "omit" } : { cache: "reload" }));
          if (res.ok) await cache.put(url, res);
        } catch { /* réessayable : bouton des Réglages ou prochain chargement */ }
        await broadcast();
      }
    })()
      .finally(() => { warming = null; })
      .finally(broadcast); // dernier mot : l'état final, préchargement terminé
  }
  return warming;
}

/* ------------------------------------------------------------------ */
/* État, pour la page Réglages                                         */
/* ------------------------------------------------------------------ */

async function status() {
  const cache = await caches.open(CACHE);
  const shellHits = await Promise.all(SHELL.map((url) => cache.match(url)));
  const vendorHits = await Promise.all(VENDOR.map((entry) => cache.match(entry.url)));
  const done = VENDOR.reduce((sum, entry, i) => sum + (vendorHits[i] ? entry.bytes : 0), 0);
  const total = VENDOR.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    version: CACHE.slice(CACHE_PREFIX.length),
    shell: shellHits.every(Boolean),
    vendor: { done, total, files: vendorHits.filter(Boolean).length, count: VENDOR.length },
    fonts: FONTS ? Boolean(await cache.match(FONTS)) : null,
    warming: Boolean(warming),
  };
}

async function broadcast() {
  const state = await status();
  for (const client of await self.clients.matchAll({ includeUncontrolled: true })) {
    client.postMessage({ type: "OFFLINE_STATUS", state });
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || !data.type) return;
  const answer = (promise) => {
    const port = event.ports && event.ports[0];
    event.waitUntil(promise.then((state) => { if (port) port.postMessage(state); }).catch(() => {}));
  };
  if (data.type === "SKIP_WAITING") { self.skipWaiting(); return; }
  if (data.type === "WARM") { answer(warm().then(status)); return; }
  if (data.type === "STATUS") { answer(status()); }
});

/* ------------------------------------------------------------------ */
/* Réponses aux requêtes                                               */
/* ------------------------------------------------------------------ */

function timed(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("délai dépassé")), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Navigation : réseau d'abord, cache en repli. C'est ce qui laisse vivre le
 *  rechargement anti-cache (`?maj=…`) et le bouton « Recharger la dernière
 *  version », tout en démarrant instantanément quand il n'y a pas de réseau. */
async function navigate(request) {
  try {
    const fresh = await timed(fetch(request), 3500);
    if (!fresh || !fresh.ok) throw new Error("réponse inutilisable");
    return fresh;
  } catch {
    const cache = await caches.open(CACHE);
    return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
  }
}
// La réponse fraîche n'est pas mise en cache : l'HTML du cache et le
// app.js?v=<hash> qu'il référence forment une paire cohérente, posée par
// l'installation. Un HTML plus récent qui arriverait ici pointerait vers un
// app.js encore absent du cache — donc une page blanche hors ligne. C'est
// l'installation du nouveau service worker qui remplace la paire, d'un bloc.

/** Tout le reste est immuable (app.js est versionné par un hash, les librairies
 *  et les polices sont figées) : le cache d'abord, sans jamais attendre le
 *  réseau. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.mode === "navigate") { event.respondWith(navigate(request)); return; }
  const url = new URL(request.url);
  const mine = url.origin === self.location.origin
    ? url.pathname.startsWith(SCOPE)
    : FONT_HOSTS.includes(url.origin);
  if (mine) event.respondWith(cacheFirst(request));
});
