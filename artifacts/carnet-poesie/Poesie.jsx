import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Le poème : des vers et des blancs                                   */
/*                                                                     */
/* Modèle volontairement plat — { type:"line", text } | { type:"blank" }. */
/* Un poème n'a pas de grille à aligner : le texte est le texte, et    */
/* l'indentation que le poète a voulue doit survivre (pre-wrap dans le */
/* CSS, aucun écrasement des espaces ici).                             */
/* ------------------------------------------------------------------ */

function parsePoem(raw) {
  const blocks = [];
  for (const source of String(raw || "").replace(/\r\n?/g, "\n").split("\n")) {
    const text = source.replace(/[ \t]+$/, "");
    if (!text.trim()) {
      // Les blancs consécutifs ne font qu'une séparation de strophe, et un
      // blanc en tête n'en est pas une.
      if (blocks.length && blocks[blocks.length - 1].type !== "blank") blocks.push({ type: "blank" });
      continue;
    }
    blocks.push({ type: "line", text });
  }
  while (blocks.length && blocks[blocks.length - 1].type === "blank") blocks.pop();
  return blocks;
}

/** Ce qui est imprimé dans un poème sans être un vers — jamais masqué,
 *  jamais compté dans la révision :
 *   — ligne sans la moindre lettre : séparateurs « * * * », filets « ——— »,
 *     numéros nus « 1. » ;
 *   — chiffre romain seul (« I », « IV. ») : numéro de partie ;
 *   — ligne entière entre parenthèses : didascalie, « (à voix basse) » ;
 *   — ligne entière entre crochets : étiquette de structure.
 *  Une vraie parole contient des lettres et ne se réduit pas à un repère. */
const notAVerse = (raw) => {
  const s = String(raw).trim();
  if (!s) return true;
  if (!/[a-zà-öø-ÿ]/i.test(s)) return true;
  if (/^[IVXLCDM]{1,6}\s*[.—–-]?$/.test(s)) return true;
  if (/^\(.*\)$/.test(s)) return true;
  if (/^\[.*\]$/.test(s)) return true;
  // Date ou lieu de composition, signé au bas du poème (« Octobre 1870. »,
  // « Bruxelles, 1873 ») : cela s'imprime, cela ne se récite pas — et sans
  // cette règle un sonnet daté compte quinze vers. Un millésime ET cinq mots
  // au plus : un vers qui porte un nombre de quatre chiffres est déjà rare,
  // un vers de cinq mots qui en porte un l'est encore davantage.
  if (/\b(1[4-9]\d\d|20\d\d)\b/.test(s) && s.split(/\s+/).length <= 5) return true;
  return false;
};

/** Un vers = une unité de révision. byBlock[i] = unité du bloc i, ou null
 *  quand le bloc ne se masque pas (blanc, repère, didascalie). */
function reviseUnitsOf(blocks) {
  const byBlock = new Array(blocks.length).fill(null);
  let count = 0;
  blocks.forEach((b, i) => {
    if (b.type !== "line" || notAVerse(b.text)) return;
    byBlock[i] = count++;
  });
  return { byBlock, count };
}

/* ------------------------------------------------------------------ */
/* Persistance                                                         */
/* ------------------------------------------------------------------ */

const KEY = "poesie:v1";
const uid = () => Math.random().toString(36).slice(2, 10);
async function loadLibrary() {
  try { const r = await window.storage.get(KEY); return r ? JSON.parse(r.value) : null; } catch { return null; }
}
async function saveLibrary(d) {
  try { await window.storage.set(KEY, JSON.stringify(d)); } catch { /* hors ligne */ }
}
async function clearLibrary() {
  try {
    if (window.storage.remove) await window.storage.remove(KEY);
    else await window.storage.set(KEY, JSON.stringify({ poems: [] }));
  } catch { /* stockage indisponible */ }
}
/** Recharge la page en contournant le cache HTTP : l'HTML revient du
 *  serveur, et comme il référence app.js?v=<hash>, le JS suit. */
const reloadFresh = (keepHash) =>
  window.location.replace(window.location.pathname + "?maj=" + Date.now() + (keepHash ? window.location.hash : ""));

/* ------------------------------------------------------------------ */
/* Partage par URL : tout le carnet tient dans le fragment             */
/* #v=1&data=<base64url(gzip(json))> — après le #, rien ne part vers   */
/* le serveur ; gzip vient des CompressionStream natifs du navigateur. */
/* ------------------------------------------------------------------ */

const SHARE_VERSION = "1";

const b64uEncode = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64uDecode = (str) => {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Valide et normalise un carnet venu de l'extérieur (URL, code collé,
 *  JSON) : on n'accepte que des poèmes exploitables, jamais de champs
 *  inconnus, et les ids sont toujours régénérés.
 *
 *  C'est LE point de passage de tous les imports : un champ de poème qui
 *  n'apparaît pas ici est perdu au premier transfert, en silence. */
function normalizeLibrary(data) {
  const src = Array.isArray(data) ? { poems: data } : data;
  const list = src && (Array.isArray(src.poems) ? src.poems : Array.isArray(src.songs) ? src.songs : null);
  if (!list) throw new Error("structure inattendue");
  const poems = list
    .filter((s) => s && typeof s.body === "string" && s.body.trim())
    .map((s) => ({
      id: uid(),
      title: String(s.title || "Sans titre").slice(0, 200),
      author: String(s.author || s.artist || "").slice(0, 120),
      body: s.body,
      // Note d'apprentissage : absente tant qu'elle vaut zéro, l'URL de
      // partage et les sauvegardes restent aussi courtes qu'avant. Une
      // décimale suffit — c'est la précision du scoring automatique, dont
      // le drapeau memoAuto doit survivre au transfert.
      ...(Number(s.memo) > 0 ? {
        memo: clampMemo(Number(s.memo)),
        ...(s.memoAuto === true ? { memoAuto: true } : {}),
      } : {}),
      // Provenance d'un import Wikisource : le texte est dans le domaine
      // public, mais la transcription est sous CC BY-SA — la source suit
      // donc le poème partout, URL de partage comprise.
      ...(s.source ? { source: String(s.source).slice(0, 300) } : {}),
    }));
  if (!poems.length) throw new Error("aucun poème exploitable");
  const lib = { poems };
  if (Number(src.size)) lib.size = Number(src.size);
  if (Number(src.speed)) lib.speed = Number(src.speed);
  // « list » accepté depuis qu'un lien emporte les listes ET leur ordre :
  // sinon celui qui reçoit le recueil le verrait rangé par titre. Sans liste
  // affichée, ce tri retombe de lui-même sur le titre (voir sortPoems).
  if (["title", "author", "memo", "list"].includes(src.sort)) lib.sort = src.sort;
  return lib;
}

async function encodeShare(library, lists) {
  if (typeof CompressionStream !== "function") {
    throw new Error("CompressionStream indisponible dans ce navigateur");
  }
  const json = JSON.stringify({
    poems: library.poems.map(({ id, ...rest }) => rest),
    size: library.size,
    speed: library.speed,
    sort: library.sort,
    // Les listes manuelles ET leur ordre voyagent dans l'URL — une
    // anthologie sans son ordre ne sert à rien. Les tags, eux, restent
    // dehors : c'est un classement personnel.
    ...(lists && (lists.defs.length || Object.keys(lists.byKey).length)
      ? { lists: { defs: lists.defs, byKey: lists.byKey, ...(lists.order && Object.keys(lists.order).length ? { order: lists.order } : {}) } }
      : {}),
  });
  const raw = new TextEncoder().encode(json);
  const packed = await gzipBytes(raw);
  const data = b64uEncode(packed);
  return { data, hash: `#v=${SHARE_VERSION}&data=${data}`, rawBytes: raw.length, packedBytes: packed.length };
}

async function decodeShareData(data) {
  const bytes = b64uDecode(data.trim());
  let jsonBytes = bytes;
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("DecompressionStream indisponible dans ce navigateur");
    }
    jsonBytes = await gunzipBytes(bytes);
  }
  const parsed = JSON.parse(new TextDecoder().decode(jsonBytes));
  const lib = normalizeLibrary(parsed);
  // Les listes arrivent à côté du carnet : normalizeLibrary ne s'occupe que
  // des poèmes et des réglages, et l'appelant décide de la fusion.
  const lists = normalizeLists(parsed && parsed.lists);
  return lists ? { ...lib, lists } : lib;
}

/** Retrouve le paramètre data dans ce qu'on lui donne : un fragment,
 *  une URL complète collée, ou le code nu. */
function extractShareData(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const m = /(?:^|[#&?])data=([A-Za-z0-9_-]+)/.exec(t);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{16,}$/.test(t)) return t;
  return null;
}

/** null si le fragment ne transporte pas de données ; jette si les
 *  données sont d'une version inconnue ou corrompues. */
async function libraryFromHash(hash) {
  const h = (hash || "").replace(/^#/, "");
  if (!/(^|&)data=/.test(h)) return null;
  const params = new URLSearchParams(h);
  const v = params.get("v") || SHARE_VERSION;
  if (v !== SHARE_VERSION) throw new Error(`lien d'une version plus récente (v=${v})`);
  const data = params.get("data");
  if (!data) return null;
  return decodeShareData(data);
}

/* ------------------------------------------------------------------ */
/* Tags : un classement personnel, propre à l'appareil                 */
/*                                                                     */
/* Ils ne voyagent PAS dans l'URL de partage — un classement est       */
/* personnel, et l'URL n'a pas à grossir pour ça — mais ils entrent    */
/* dans la sauvegarde en fichier, sinon un changement de téléphone     */
/* effacerait tout le travail de classement.                           */
/*                                                                     */
/* L'ancre d'un poème est « titre + auteur » normalisés : les ids sont */
/* régénérés à chaque import (normalizeLibrary), ils ne peuvent donc   */
/* pas servir de clé.                                                  */
/* ------------------------------------------------------------------ */

const TAGS_KEY = "tags:v1";
const normPart = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const poemKey = (poem) => (poem ? `${normPart(poem.title)}|${normPart(poem.author)}` : "");

const TAG_COLORS = ["#C08A5B", "#7FA9D5", "#86C48B", "#C8503C", "#B98BD9", "#D9B44C"];
const DEFAULT_TAGS = [
  { id: "byheart", label: "Par cœur", icon: "❦", color: "#B98BD9" },
  { id: "towork", label: "À travailler", icon: "✎", color: "#C08A5B" },
  { id: "loved", label: "Aimé", icon: "★", color: "#C8503C" },
  { id: "short", label: "Court", icon: "▪", color: "#86C48B" },
];
const freshTags = () => ({ defs: DEFAULT_TAGS.map((t) => ({ ...t })), byKey: {} });

/** Les couleurs de tags sont des pastels pensés pour le fond sombre ; en
 *  texte sur fond clair elles se délavent. Même teinte, mais foncée et
 *  resaturée — le fond translucide, lui, garde la couleur d'origine. */
function tagInk(hex, light) {
  if (!light || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return `hsl(${Math.round(h)} ${Math.round(Math.min(1, s * 1.3 + 0.15) * 100)}% ${Math.round(Math.min(l, 0.34) * 100)}%)`;
}

/** Valide un bloc de tags venu de l'extérieur (fichier de sauvegarde) : on
 *  n'accepte que des définitions exploitables, et jamais une affectation qui
 *  pointerait vers un tag inconnu. */
function normalizeTags(raw) {
  if (!raw || typeof raw !== "object") return null;
  const defs = [];
  const ids = new Set();
  for (const d of Array.isArray(raw.defs) ? raw.defs : []) {
    if (!d || typeof d !== "object") continue;
    const id = String(d.id || "").replace(/[^\w-]/g, "").slice(0, 40);
    const label = String(d.label || "").trim().slice(0, 24);
    if (!id || !label || ids.has(id)) continue;
    ids.add(id);
    defs.push({
      id, label,
      icon: String(d.icon || "●").slice(0, 4),
      color: /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : TAG_COLORS[0],
    });
  }
  const byKey = {};
  for (const [k, list] of Object.entries(raw.byKey && typeof raw.byKey === "object" ? raw.byKey : {})) {
    if (!k || !Array.isArray(list)) continue;
    const keep = [...new Set(list.filter((id) => ids.has(id)))];
    if (keep.length) byKey[k.slice(0, 200)] = keep;
  }
  return { defs, byKey };
}

/** Fusion la moins destructrice possible : les définitions inconnues
 *  s'ajoutent, les affectations s'unissent, rien n'est retiré. */
function mergeTags(prev, added) {
  if (!added) return prev;
  const defs = [...prev.defs];
  for (const d of added.defs) if (!defs.some((x) => x.id === d.id)) defs.push(d);
  const byKey = { ...prev.byKey };
  for (const [k, list] of Object.entries(added.byKey)) {
    const keep = [...new Set([...(byKey[k] || []), ...list])].filter((id) => defs.some((d) => d.id === id));
    if (keep.length) byKey[k] = keep;
  }
  return { defs, byKey };
}

/** La charge d'une sauvegarde : poèmes, tags et listes, jamais les ids
 *  (régénérés à chaque import). Une seule fonction pour que le fichier écrit
 *  et la signature comparée soient forcément d'accord. */
const backupJson = (poems, tags, lists) =>
  JSON.stringify({ poems: poems.map(({ id, ...rest }) => rest), tags, lists }, null, 1);

/** Empreinte courte, juste pour répondre à « est-ce que ça a changé depuis la
 *  dernière sauvegarde ? ». Pas de cryptographie ici. */
function signature(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const BACKUP_KEY = "backup:v1";
async function loadBackup() {
  try {
    const r = await window.storage.get(BACKUP_KEY);
    const b = r ? JSON.parse(r.value) : null;
    return b && b.sig ? { at: Number(b.at) || 0, sig: String(b.sig) } : null;
  } catch { return null; }
}
async function saveBackupMark(b) {
  try { await window.storage.set(BACKUP_KEY, JSON.stringify(b)); } catch { /* hors ligne */ }
}

async function loadTags() {
  try { const r = await window.storage.get(TAGS_KEY); return r ? normalizeTags(JSON.parse(r.value)) : null; } catch { return null; }
}
async function saveTags(t) {
  try { await window.storage.set(TAGS_KEY, JSON.stringify(t)); } catch { /* hors ligne */ }
}

/* Listes : des sous-ensembles nommés du carnet (anthologie, à dire ce
   soir…). Même mécanique que les tags : ancrées par poemKey (les ids sont
   régénérés à chaque import), mais dans l'URL de partage comme dans la
   sauvegarde en fichier. */
const LISTS_KEY = "lists:v1";
const freshLists = () => ({ defs: [], byKey: {}, order: {} });

function normalizeLists(raw) {
  if (!raw || typeof raw !== "object") return null;
  const defs = [];
  const ids = new Set();
  for (const d of Array.isArray(raw.defs) ? raw.defs : []) {
    if (!d || typeof d !== "object") continue;
    const id = String(d.id || "").replace(/[^\w-]/g, "").slice(0, 40);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    defs.push({ id, name: String(d.name || "").trim().slice(0, 40) || "Liste" });
  }
  const byKey = {};
  for (const [k, list] of Object.entries(raw.byKey && typeof raw.byKey === "object" ? raw.byKey : {})) {
    if (!k || !Array.isArray(list)) continue;
    const keep = [...new Set(list.filter((id) => ids.has(id)))];
    if (keep.length) byKey[k.slice(0, 200)] = keep;
  }
  // Ordre choisi à la main dans une liste : des poemKey, comme l'appartenance
  // — les ids de poèmes sont régénérés à chaque import, eux ne le sont pas.
  // Une liste sans entrée ici n'a pas d'ordre : elle suit le tri courant.
  const order = {};
  for (const [id, keys] of Object.entries(raw.order && typeof raw.order === "object" ? raw.order : {})) {
    if (!ids.has(id) || !Array.isArray(keys)) continue;
    const keep = [...new Set(keys.filter((k) => typeof k === "string" && k).map((k) => k.slice(0, 200)))];
    if (keep.length) order[id] = keep;
  }
  return { defs, byKey, order };
}

function mergeLists(prev, added) {
  if (!added) return prev;
  const defs = [...prev.defs];
  for (const d of added.defs) if (!defs.some((x) => x.id === d.id)) defs.push(d);
  const byKey = { ...prev.byKey };
  for (const [k, list] of Object.entries(added.byKey)) {
    const keep = [...new Set([...(byKey[k] || []), ...list])].filter((id) => defs.some((d) => d.id === id));
    if (keep.length) byKey[k] = keep;
  }
  // Un ordre déjà décidé sur cet appareil ne se fait pas réécrire par un
  // import : les poèmes apportés se rangent à la suite. Une liste inconnue
  // arrive, elle, avec son ordre intact.
  const order = { ...(prev.order || {}) };
  for (const [id, keys] of Object.entries(added.order || {})) {
    if (!defs.some((d) => d.id === id)) continue;
    order[id] = order[id] ? [...order[id], ...keys.filter((k) => !order[id].includes(k))] : [...keys];
  }
  return { defs, byKey, order };
}

async function loadLists() {
  try { const r = await window.storage.get(LISTS_KEY); return r ? normalizeLists(JSON.parse(r.value)) : null; } catch { return null; }
}
async function saveLists(l) {
  try { await window.storage.set(LISTS_KEY, JSON.stringify(l)); } catch { /* hors ligne */ }
}

const fmtBytes = (n) => (n < 1024 ? `${n} o` : `${(n / 1024).toFixed(1)} Ko`);
const mergeByTitle = (prev, added) => {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [...prev.filter((s) => !added.some((a) => norm(a.title) === norm(s.title))), ...added];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Clé de regroupement d'un auteur : casse et espaces ignorés. Assez pour
 *  réunir « VICTOR HUGO » et « Victor Hugo » sans prétendre dédoublonner
 *  « Hugo » et « Victor Hugo ». */
const authorKey = (name) => String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
/** Les filtres d'auteur partagent le réglage listFilter avec les listes
 *  manuelles : un id de liste (uid, alphanumérique) ne peut pas contenir le
 *  deux-points, donc aucune collision possible. */
const AUTHOR_PREFIX = "author:";

/** Score d'apprentissage : une décimale au plus, virgule française. */
const fmtMemo = (m) => (Math.round(Number(m) * 10) / 10).toFixed(1).replace(/\.0$/, "").replace(".", ",");
/** Jamais 0 (qui supprimerait la clé memo), jamais plus d'une décimale. */
const clampMemo = (m) => Math.min(5, Math.max(0.1, Math.round(m * 10) / 10));
/** Un pas de score : moyenne mobile exponentielle vers 5 (« savais ») ou 0
 *  (« savais pas »). α dépend du nombre de vers du poème pour qu'une session
 *  complète pèse ~50 % du score, court ou long — et qu'une seule réponse de
 *  révision au hasard pèse « un vers de ce poème ». */
const emaStep = (memo, known, units) => {
  const a = Math.min(0.5, Math.max(0.03, 1 - 0.5 ** (1 / Math.max(1, units))));
  const base = Number(memo) > 0 ? Number(memo) : 2.5;
  return base + a * ((known ? 5 : 0) - base);
};

/* ------------------------------------------------------------------ */
/* Wikisource — le seul gisement de poésie française interrogeable     */
/* depuis un navigateur                                                */
/*                                                                     */
/* L'API MediaWiki répond « Access-Control-Allow-Origin: * » dès qu'on */
/* passe origin=* : pas de backend, pas de clé, rien à héberger.       */
/* (Gallica et Gutenberg, eux, n'envoient aucun en-tête CORS ; leurs   */
/* textes sont donc hors de portée d'une page statique.)               */
/*                                                                     */
/* Une seule règle sert à tout : on demande une page, et               */
/*   — elle contient un div.poem  : c'est un poème, on l'importe ;     */
/*   — elle n'en contient pas     : c'est une page de navigation, ses  */
/*     liens internes sont le niveau suivant.                          */
/* Un recueil donne ainsi ses poèmes, une page d'homonymie ses         */
/* éditions, sans un octet de code en plus.                            */
/*                                                                     */
/* Le texte est dans le domaine public ; la transcription, elle, est   */
/* sous CC BY-SA — d'où le champ « source » gardé sur chaque poème.    */
/* ------------------------------------------------------------------ */

const WS_API = "https://fr.wikisource.org/w/api.php";
const WS_PAGE = (title) => "https://fr.wikisource.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_"));

async function wsQuery(params, ms = 15000) {
  const url = WS_API + "?" + new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  let r;
  try {
    r = await fetch(url, { signal: ctl.signal });
  } catch {
    throw new Error(ctl.signal.aborted ? "Wikisource ne répond pas" : "Pas de réseau");
  } finally {
    clearTimeout(timer);
  }
  // 429 : Wikimedia limite les requêtes. Le message doit le dire, sinon
  // l'utilisateur croit à une panne et recommence — ce qui l'aggrave.
  if (r.status === 429) throw new Error("Wikisource limite les requêtes — patientez quelques secondes");
  if (!r.ok) throw new Error(`Wikisource a répondu ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.info || "requête refusée par Wikisource");
  return j;
}

/** Recherche plein texte dans l'espace principal. Les résultats sont des
 *  titres de page : poèmes, recueils ou pages d'homonymie indifféremment —
 *  c'est wsPage qui tranche, en regardant le contenu. */
async function wsSearch(q) {
  const j = await wsQuery({ action: "query", list: "search", srsearch: q, srnamespace: "0", srlimit: "20" });
  return ((j.query && j.query.search) || []).map((r) => r.title);
}

/** Les poèmes d'une catégorie d'auteur, paginés jusqu'au bout (Victor Hugo
 *  en a plus de mille, et cmlimit plafonne à 500). */
async function wsCategory(category) {
  const out = [];
  let cont = null;
  do {
    const j = await wsQuery({
      action: "query", list: "categorymembers", cmtitle: "Catégorie:" + category,
      cmnamespace: "0", cmlimit: "500", ...(cont ? { cmcontinue: cont } : {}),
    });
    for (const m of (j.query && j.query.categorymembers) || []) out.push(m.title);
    cont = (j.continue && j.continue.cmcontinue) || null;
  } while (cont && out.length < 3000);
  return out.sort((a, b) => a.localeCompare(b, "fr"));
}

/* Deux caractères que le texte des poèmes ne contient jamais, construits
   par code pour rester lisibles dans le source. CUT sert de marque de fin
   de vers ; NBSP est l'espace insécable dont Wikisource se sert pour
   indenter. */
const CUT = String.fromCharCode(1);
const NBSP = String.fromCharCode(160);

/** Un vers, nettoyé de la mise en forme du wikitexte mais pas de son
 *  indentation : les espaces ordinaires de début et de fin viennent du
 *  balisage et s'en vont, les insécables sont le retrait voulu par le poète
 *  et deviennent des espaces normaux, que pre-wrap conservera. */
const tidyVerse = (raw) =>
  String(raw).replace(/[ \t]+$/, "").replace(/^[ \t]+/, "").split(NBSP).join(" ");

/** Les vers d'un ou plusieurs blocs div.poem.
 *
 *  Le piège, rencontré en vrai : le balisage source porte ses propres
 *  retours à la ligne, et seuls les <br> séparent les vers. On neutralise
 *  donc les premiers avant de couper sur les seconds — sans cela chaque
 *  vers arrive précédé d'un blanc, et le poème devient une suite de
 *  strophes d'un vers. */
function versesFrom(nodes) {
  const out = [];
  const push = (line) => {
    if (line.trim()) out.push(line);
    else if (out.length && out[out.length - 1] !== "") out.push(""); // séparation de strophe
  };
  for (const node of nodes) {
    const box = document.createElement("div");
    box.innerHTML = node.innerHTML.replace(/\n/g, " ").replace(/<br\s*\/?>/gi, CUT);
    for (const junk of box.querySelectorAll("sup.reference, .mw-editsection, .noprint, style, script")) junk.remove();
    for (const raw of (box.textContent || "").split(CUT)) push(tidyVerse(raw));
    // Un poème à cheval sur deux pages scannées donne plusieurs blocs : la
    // couture tombe presque toujours entre deux strophes.
    push("");
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n");
}

/** Les liens internes exploitables d'une page de navigation. Les sous-pages
 *  du titre courant l'emportent (un recueil et ses poèmes) ; à défaut, tous
 *  les liens de l'espace principal (une page d'homonymie et ses éditions). */
function linksFrom(doc, title) {
  const seen = [];
  for (const a of doc.querySelectorAll('a[href^="/wiki/"]')) {
    if (a.closest(".mw-editsection, .noprint, .navbox, sup.reference")) continue;
    let target;
    try { target = decodeURIComponent(a.getAttribute("href").slice(6).split("#")[0]); } catch { continue; }
    target = target.replace(/_/g, " ");
    if (!target || target.includes(":")) continue; // espace principal seulement
    if (target === title || /\/Texte entier$/.test(target)) continue;
    if (!seen.includes(target)) seen.push(target);
  }
  const kids = seen.filter((t) => t.startsWith(title + "/"));
  return kids.length ? kids : seen;
}

/** Une page Wikisource, résolue : soit un poème prêt à importer, soit la
 *  liste de ses enfants. Les redirections sont suivies (redirects=1) —
 *  beaucoup de titres plausibles n'en sont pas d'autres. */
async function wsPage(title) {
  const j = await wsQuery({ action: "parse", page: title, prop: "text", redirects: "1" });
  const parsed = j.parse || {};
  const resolved = parsed.title || title;
  const doc = new DOMParser().parseFromString(parsed.text || "", "text/html");
  const poems = [...doc.querySelectorAll("div.poem")];
  if (poems.length) {
    const body = versesFrom(poems);
    if (body.trim()) return { kind: "poem", title: resolved, body };
  }
  return { kind: "index", title: resolved, links: linksFrom(doc, resolved) };
}

/** Le titre d'un poème, débarrassé de son chemin de recueil : la page
 *  « Les Fleurs du mal (1861)/L'Albatros » s'appelle « L'Albatros ». */
const leafTitle = (title) => {
  const leaf = String(title).split("/").pop().trim();
  return leaf.replace(/^«\s*/, "").replace(/\s*»$/, "") || String(title);
};

/* Les catégories d'auteur de Wikisource, vérifiées une à une contre l'API.
   Écrites en toutes lettres, sans règle d'élision devinée : Wikisource
   emploie l'apostrophe typographique, et la même catégorie saisie avec une
   apostrophe droite ne renvoie rien du tout. */
const POET_CATS = [
  "Poèmes de Victor Hugo", "Poèmes d’Anna de Noailles", "Poèmes de Marceline Desbordes-Valmore",
  "Poèmes de Paul Verlaine", "Poèmes de Renée Vivien", "Poèmes de Maurice Rollinat",
  "Poèmes d’André Chénier", "Poèmes de Théodore de Banville", "Poèmes d’Émile Verhaeren",
  "Poèmes de Sully Prudhomme", "Poèmes de Pierre de Ronsard", "Poèmes de Théophile Gautier",
  "Poèmes de Leconte de Lisle", "Poèmes de Jean Moréas", "Poèmes de François Coppée",
  "Poèmes d’Alphonse de Lamartine", "Poèmes de José-Maria de Heredia",
  "Poèmes de Guillaume Apollinaire", "Poèmes de Charles Baudelaire", "Poèmes d’Alfred de Musset",
  "Poèmes de Stéphane Mallarmé", "Poèmes de Germain Nouveau", "Poèmes d’Arthur Rimbaud",
  "Poèmes de Charles Cros", "Poèmes d’Albert Samain", "Poèmes d’Émile Nelligan",
  "Poèmes de Marie Krysinska", "Poèmes de Tristan Corbière", "Poèmes de Jules Laforgue",
  "Poèmes d’Alfred de Vigny", "Poèmes d’Ephraïm Mikhaël", "Poèmes de Gérard de Nerval",
  "Poèmes de Catulle Mendès", "Poèmes de Louise Labé", "Poèmes de Joachim du Bellay",
  "Poèmes de Jean de La Fontaine", "Poèmes de Charles Péguy", "Poèmes de Max Jacob",
  "Poèmes de Clément Marot", "Poèmes de Paul Valéry", "Poèmes de François Villon",
  "Poèmes d’Alfred Jarry",
];
/** « Poèmes d’Arthur Rimbaud » donne « Arthur Rimbaud ». */
const poetName = (cat) => cat.replace(/^Po\u00e8mes d(?:e |\u2019)/, "");
/** Les poètes rangés par nom de famille — le dernier mot, particules
 *  ignorées : on cherche Baudelaire à la lettre B, pas à la lettre C. */
const POETS = POET_CATS
  .map((cat) => ({ cat, name: poetName(cat) }))
  .sort((a, b) => {
    const last = (n) => n.split(" ").filter((w) => !/^(de|du|des|la|le)$/i.test(w)).pop() || n;
    return last(a.name).localeCompare(last(b.name), "fr");
  });

/* ------------------------------------------------------------------ */
/* Étoiles                                                             */
/* ------------------------------------------------------------------ */

/** Note d'apprentissage : cinq étoiles tappables ; retaper la note courante
 *  la remet à zéro. En lecture, une valeur décimale remplit les étoiles
 *  entières qu'elle dépasse. */
function Stars({ value, onChange, big }) {
  return (
    <div className={"stars" + (big ? " big" : "")} role="radiogroup" aria-label="Note d'apprentissage">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={"star" + (n <= value ? " on" : "")}
          aria-label={`${n} sur 5`} aria-pressed={n <= value}
          onClick={() => onChange(n === value ? 0 : n)}>{n <= value ? "★" : "☆"}</button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Design system                                                       */
/*                                                                     */
/* Le carnet d'accords est un objet de scène : condensé, dense, ambre. */
/* Celui-ci est un objet de lecture — un garamond pour les vers et le  */
/* texte courant, un condensé pour le chrome, et de l'air entre les    */
/* lignes. Deux familles seulement : le service worker les précache.   */
/*                                                                     */
/* Les polices sont chargées par un <link> de l'index.html, et non par */
/* un @import ici : c'est ce qui permet au service worker de les       */
/* garder en cache pour les lectures sans réseau.                      */
/* ------------------------------------------------------------------ */

const CSS = `
.cb, .cb * { box-sizing:border-box; }
.cb { --bg:#14131A; --panel:#1C1B23; --panel2:#25242E; --line:#37353F;
  --ink:#EDE9E1; --muted:#918B99; --acc:#D8C9A3; --acc-dim:#6E6450; --hot:#C8635A;
  --ok:#71A97F; --ok-soft:rgba(113,169,127,.14);
  /* Voiles translucides de l'accent — fonds actifs, survols, surlignage.
     En variables pour que le mode clair les recolore avec son propre accent. */
  --acc-soft:rgba(216,201,163,.12); --acc-faint:rgba(216,201,163,.07); --acc-glow:rgba(216,201,163,.16);
  /* Zones réservées par le système — barre d'état, indicateur d'accueil, encoche en
     paysage. Nulles partout ailleurs, donc sans effet sur un écran ordinaire. En
     variables plutôt qu'en env() dispersés : c'est ce qui rend la mise en page
     vérifiable ailleurs que sur un iPhone. */
  --sat:env(safe-area-inset-top, 0px); --sab:env(safe-area-inset-bottom, 0px);
  --sal:env(safe-area-inset-left, 0px); --sar:env(safe-area-inset-right, 0px);
  position:absolute; inset:0; display:flex; flex-direction:column; background:var(--bg); color:var(--ink);
  padding-left:var(--sal); padding-right:var(--sar);
  font-family:'EB Garamond', Georgia, 'Times New Roman', serif; -webkit-font-smoothing:antialiased; overflow:hidden; }
/* Mode clair : un papier crème plutôt qu'un blanc d'écran, l'encre presque
   noire, et la prune en accent — de l'encre, pas du néon. */
.cb.light { --bg:#F7F5F0; --panel:#FFFDF9; --panel2:#EDE9E0; --line:#DBD5C9;
  --ink:#221F26; --muted:#6F6875; --acc:#6B4E8F; --acc-dim:#B4A2C9; --hot:#B23B31;
  --ok:#2C7A4B; --ok-soft:rgba(44,122,75,.10);
  --acc-soft:rgba(107,78,143,.10); --acc-faint:rgba(107,78,143,.06); --acc-glow:rgba(107,78,143,.14); }
.cb.light .btn.primary { color:#FFF; }
.cb.light .speedfly { background:rgba(255,253,249,.95); box-shadow:0 4px 16px rgba(0,0,0,.16); }
.cb.light .sizefly span { box-shadow:0 4px 16px rgba(0,0,0,.16); }
.cb.light .modal { background:rgba(0,0,0,.35); }
.cb button { font:inherit; color:inherit; background:none; border:none; cursor:pointer; }
/* Champs de fichier pilotés par un bouton : rendus mais invisibles. Un input en
   display:none n'ouvre pas toujours le sélecteur iOS quand on le clique par script. */
.vhide { position:absolute; width:1px; height:1px; padding:0; margin:-1px; border:0;
  overflow:hidden; clip:rect(0 0 0 0); clip-path:inset(50%); opacity:0; }
.cb :focus-visible { outline:2px solid var(--acc); outline-offset:2px; }
/* Micro-capitales : le condensé remplace le monospace du carnet d'accords —
   une police de moins à précacher, et un dessin plus proche du livre. */
.cb .mono { font-family:'Barlow Condensed', ui-sans-serif, system-ui, sans-serif; }
.top { display:flex; align-items:center; gap:10px; padding:calc(12px + var(--sat)) 16px 10px;
  border-bottom:1px solid var(--line); background:var(--panel); flex:0 0 auto; }
.brand { font-family:'Barlow Condensed'; font-weight:700; font-size:18px; letter-spacing:.09em;
  text-transform:uppercase; line-height:1; white-space:nowrap; }
.brand span { color:var(--acc); }
.spacer { flex:1; }
.iconbtn { width:34px; height:34px; border-radius:8px; border:1px solid var(--line); display:grid; place-items:center;
  color:var(--muted); background:var(--panel2); font-size:16px; }
.iconbtn:hover { color:var(--ink); border-color:var(--acc-dim); }
/* Bouton-état de la barre du haut : révision en cours, défilement. */
.iconbtn.on { color:var(--acc); border-color:var(--acc-dim); background:var(--acc-soft); }
.iconbtn:disabled { opacity:.4; cursor:default; }
/* Une barre d'emoji mêlée de glyphes typographiques : le chevron n'occupe
   qu'un tiers de son cadratin et paraît rapetissé à côté d'eux. On le remonte
   à la taille où sa tache d'encre pèse autant ; line-height:1 le garde dans
   les 34 px du bouton. */
.iconbtn.glyph { line-height:1; }
.iconbtn.glyph.back { font-size:29px; padding-bottom:3px; }
.iconbtn.glyph.next { font-size:19px; }
@media (max-width:374px) { .top { gap:8px; } }
/* Un point d'accent : le carnet a changé depuis la dernière sauvegarde. */
.iconbtn.nudge { position:relative; }
.iconbtn.nudge::after { content:''; position:absolute; top:4px; right:4px; width:6px; height:6px;
  border-radius:50%; background:var(--acc); box-shadow:0 0 0 2px var(--panel); }
/* La bibliothèque scrolle d'un seul bloc : la barre de titre défile avec les
   poèmes, seul l'en-tête (recherche, filtres, tri) reste figé en haut. */
.libscroll { flex:1; overflow-y:auto; display:flex; flex-direction:column; }
.libscroll .top { flex:0 0 auto; }
.libhead { position:sticky; top:0; z-index:10; background:var(--bg);
  padding:12px 16px 10px; border-bottom:1px solid var(--line); }
.lib { padding:12px 16px calc(150px + var(--sab)); }
.search { width:100%; padding:11px 44px 11px 13px; border-radius:10px; border:1px solid var(--line);
  background:var(--panel); color:var(--ink); font-size:16px; }
.search::placeholder { color:var(--muted); }
/* Croix de vidage : elle n'apparaît qu'une fois le champ rempli, mais sa place
   est réservée en permanence dans le padding du champ — le texte ne saute pas
   au premier caractère tapé. */
.searchwrap { position:relative; }
.searchx { position:absolute; top:50%; right:6px; transform:translateY(-50%);
  width:32px; height:32px; border-radius:8px; display:grid; place-items:center;
  color:var(--muted); font-size:13px; line-height:1; }
.searchx:hover { color:var(--ink); background:var(--acc-soft); }
/* Filtres sur une ligne : la liste (2/3) puis le menu des tags (1/3). */
.filterrow { display:flex; gap:8px; margin-top:10px; position:relative; }
.filterrow .listsel { flex:2; min-width:0; }
.filterrow .reorderbtn { flex:0 0 40px; }
.tagdd { flex:1; min-width:0; display:flex; }
.filterrow.withreorder .tagdd { flex:0 0 auto; }
.filterrow.withreorder .tagddbtn { padding-right:11px; }
.tagddbtn { width:100%; display:flex; align-items:center; gap:5px; text-align:left;
  overflow:hidden; white-space:nowrap; }
.tagddbtn > span { overflow:hidden; text-overflow:ellipsis; }
.tagddbtn .ddarrow { margin-left:auto; font-style:normal; font-size:9px; color:var(--muted); }
.tagddbtn.on { color:var(--acc); border-color:var(--acc-dim); background:var(--acc-soft); }
/* Menu déroulant des tags : multi-sélection, refermé d'un tap à côté. */
.ddback { position:fixed; inset:0; z-index:30; }
.ddpanel { position:absolute; top:calc(100% + 6px); right:0; z-index:31; min-width:200px;
  background:var(--panel); border:1px solid var(--line);
  border-radius:10px; overflow:hidden; box-shadow:0 10px 30px rgba(0,0,0,.35); }
.ddopt { display:flex; align-items:center; gap:9px; width:100%; padding:10px 12px;
  text-align:left; font-size:15px; color:var(--ink); }
.ddopt + .ddopt { border-top:1px solid var(--line); }
.ddopt b { font-family:'Barlow Condensed'; font-size:12px; letter-spacing:.06em; color:var(--muted); margin-left:auto; }
.ddopt .ddcheck { flex:0 0 14px; text-align:center; color:var(--acc); font-size:12px; }
.ddopt.on { background:var(--acc-faint); }
.ddclear { justify-content:center; color:var(--muted); font-size:14px; }
/* Palette flottante Lire / Réviser : au-dessus de la liste, effacée pendant
   le scroll pour laisser lire, revenue dès qu'il s'arrête. Deux cibles hautes
   plutôt que trois étroites : 54 px, au-dessus des 44 pt d'Apple. */
.floatbar { position:absolute; left:50%; transform:translateX(-50%);
  bottom:calc(76px + var(--sab)); z-index:6; display:flex; gap:8px; padding:8px;
  width:calc(100% - 72px); min-width:min(296px, calc(100% - 16px)); max-width:420px;
  border-radius:18px; background:var(--bg);
  border:1px solid var(--line); box-shadow:0 8px 28px rgba(0,0,0,.4); transition:opacity .3s; }
/* Le plateau prend le fond de la page, les touches montent d'un cran au-dessus :
   sans ce contraste, deux boutons voisins se fondent en un seul bloc et on ne
   voit plus où viser. Fond et bord sont écrits ici, et non hérités de .btn : le
   reset .cb button (background:none, border:none) est plus spécifique. */
.floatbar .btn { flex:1 1 0; min-width:0; min-height:54px; padding:0 8px; font-size:16.5px;
  white-space:nowrap; border-radius:12px; background:var(--panel2); border:1px solid var(--line);
  display:flex; align-items:center; justify-content:center; gap:8px; }
.floatbar .btn i { font-style:normal; font-size:23px; line-height:1; }
.floatbar.hide { opacity:0; pointer-events:none; }
.cb.light .floatbar { box-shadow:0 8px 28px rgba(0,0,0,.16); }
.cb.light .floatbar .btn { background:var(--panel); }
/* Ligne du tri : les boutons à gauche, le compteur de poèmes à droite. */
.sortrow { display:flex; align-items:center; gap:8px; margin-top:10px; min-height:24px; }
.sortrow .count { margin-left:auto; white-space:nowrap; }
.seg2.tight button { padding:8px 8px; letter-spacing:.08em; }
.count { font-family:'Barlow Condensed'; font-size:12px; letter-spacing:.16em; color:var(--muted); text-transform:uppercase; margin:0; }
.notice { position:relative; border:1px solid var(--acc-dim); background:var(--acc-faint); border-radius:10px;
  padding:11px 40px 11px 13px; font-size:15px; line-height:1.5; margin-bottom:12px; }
.noticeclose { position:absolute; top:7px; right:7px; width:26px; height:26px; border-radius:7px; display:grid;
  place-items:center; color:var(--muted); font-size:13px; line-height:1; }
.noticeclose:hover { color:var(--ink); background:var(--acc-soft); }
.card { width:100%; display:flex; align-items:stretch; border:1px solid var(--line);
  border-left:3px solid var(--line); border-radius:10px; background:var(--panel); margin-bottom:8px;
  transition:border-color .15s; overflow:hidden; }
.card:hover { border-left-color:var(--acc); }
.cardmain { flex:1; min-width:0; display:flex; align-items:center; gap:14px; padding:13px 14px; text-align:left; }
.cardmain:active { transform:scale(.996); }
.carddel { flex:0 0 auto; padding:0 13px; color:var(--muted); border-left:1px solid var(--line); font-size:14px; }
/* Réorganisation d'une liste. La poignée doit être large au doigt (44 pt
   d'Apple) et couper le défilement de page : sans touch-action:none, le
   glissé part en scroll et le code ne voit jamais rien. */
.reorderbtn { text-align:center; padding:9px 0; font-size:15px;
  background:var(--panel2); color:var(--acc); }
.reorderbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap;
  border:1px solid var(--acc-dim); background:var(--acc-soft); border-radius:10px;
  padding:10px 12px; margin-bottom:10px; font-size:14px; color:var(--muted); line-height:1.45; }
.reorderbar span { flex:1; min-width:150px; }
.reorderbar i { font-style:normal; color:var(--acc); }
.cardgrip { flex:0 0 auto; width:46px; display:grid; place-items:center; color:var(--muted);
  border-right:1px solid var(--line); background:var(--panel2);
  touch-action:none; cursor:grab; font-size:17px; }
.cardgrip i { font-style:normal; font-size:19px; line-height:1; }
.cardgrip:active { cursor:grabbing; color:var(--acc); }
.card.reordering { border-left-color:var(--acc-dim); }
.card.reordering .cardmain { opacity:.75; }
.card.dragging { border-color:var(--acc); border-left-color:var(--acc);
  background:var(--panel2); box-shadow:0 6px 18px rgba(0,0,0,.35); }
.carddel:hover { color:var(--hot); background:rgba(200,99,90,.10); }
.seg2 { display:flex; border:1px solid var(--line); border-radius:8px; background:var(--panel2); overflow:hidden; }
.seg2 button { padding:8px 13px; font-family:'Barlow Condensed'; font-size:12.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.seg2 button.on { color:var(--acc); background:var(--acc-soft); }
.seg2 .sortdir { font-style:normal; margin-left:5px; font-size:11px; }
.btn.slim { padding:8px 14px; font-size:14px; }
.card h3 { margin:0; font-family:'Barlow Condensed'; font-weight:600; font-size:21px; letter-spacing:.03em; text-transform:uppercase; line-height:1.05; }
.card p { margin:2px 0 0; font-size:14px; color:var(--muted); font-style:italic; }
.tag { font-family:'Barlow Condensed'; font-size:12px; letter-spacing:.1em; text-transform:uppercase; border:1px solid var(--line);
  color:var(--muted); border-radius:6px; padding:3px 7px; flex:0 0 auto; }
/* Tags : icône seule dans la liste, icône + nom partout où la place existe. */
.tagrow { display:flex; gap:4px; flex:0 0 auto; }
.tagdot { font-size:13px; line-height:1.15; padding:3px 5px; border-radius:6px; border:1px solid; }
.tagchip { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:8px;
  border:1px solid var(--line); background:var(--panel2); color:var(--muted); font-size:14px; }
.tagchip:hover { border-color:var(--acc-dim); }
.tagchip.on { color:var(--acc); border-color:var(--acc-dim); background:var(--acc-soft); }
.cardmemo { font-family:'Barlow Condensed'; font-size:13px; letter-spacing:.06em; color:var(--acc); flex:0 0 auto; }
.listsel { flex:1; min-width:0; padding:9px 11px; border-radius:8px; border:1px solid var(--line);
  background:var(--panel2); color:var(--ink); font-size:15px; }
.tagpick { display:flex; gap:6px; flex-wrap:wrap; width:100%; }
.tagpick.center { justify-content:center; }
.tagedit { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.tagedit input { flex:1; min-width:110px; padding:10px 12px; border-radius:9px; border:1px solid var(--line);
  background:var(--panel); color:var(--ink); font-size:16px; }
.tagedit input.tagicon { flex:0 0 54px; min-width:0; text-align:center; font-size:17px; padding:9px 4px; }
.swatches { display:flex; gap:5px; }
.swatch { width:22px; height:22px; border-radius:6px; border:1px solid rgba(0,0,0,.35); }
.swatch.on { box-shadow:0 0 0 2px var(--bg), 0 0 0 4px var(--ink); }
.empty { text-align:center; padding:44px 20px; color:var(--muted); }
.empty h2 { font-family:'Barlow Condensed'; text-transform:uppercase; letter-spacing:.1em; color:var(--ink); font-size:22px; margin:0 0 8px; }
.empty p { margin:0 0 20px; font-size:16px; line-height:1.55; }
.head { position:relative; padding:12px 16px; border-bottom:1px solid var(--line); background:var(--panel); flex:0 0 auto; }
.title { font-family:'Barlow Condensed'; font-weight:700; font-size:26px; line-height:1.05; letter-spacing:.02em; text-transform:uppercase; margin:0; padding-right:40px; }
.foldbtn { position:absolute; top:11px; right:14px; width:30px; height:30px; border-radius:8px; border:1px solid var(--line);
  background:var(--panel2); color:var(--muted); display:grid; place-items:center; font-size:10px; }
.foldbtn:hover { color:var(--acc); border-color:var(--acc-dim); }
.foldbtn i { display:block; font-style:normal; transition:transform .25s; }
.foldbtn.folded i { transform:rotate(180deg); }
/* Repli du menu par grille 0fr/1fr : la hauteur du contenu ne compte plus,
   contrairement à un max-height figé qui rognerait un menu qui grandit. */
.barwrap { display:grid; grid-template-rows:1fr; opacity:1; transition:grid-template-rows .28s ease, opacity .22s; }
.barwrap.folded { grid-template-rows:0fr; opacity:0; }
.barwrap > * { overflow:hidden; min-height:0; }
.author { font-size:15px; color:var(--muted); margin:3px 0 0; letter-spacing:.02em; font-style:italic; }
/* Nom d'auteur tapable : exactement l'allure du texte qu'il remplace, plus un
   soulignement pointillé — assez pour dire « ça se touche », pas assez pour
   faire un bouton de plus dans une barre déjà chargée. */
.authorlink { display:block; text-align:left; padding:0; font-family:inherit;
  text-decoration:underline dotted var(--line); text-underline-offset:3px; }
.authorlink:hover { color:var(--ink); text-decoration-color:var(--acc-dim); }
/* Menu du poème : des rangées label à gauche / contrôle à droite, toutes
   alignées sur la même grille — pas de flex-wrap qui zigzague. */
.menu { display:flex; flex-direction:column; gap:9px; margin-top:12px; }
.mrow { display:grid; grid-template-columns:1fr auto; align-items:center; gap:10px; }
.mlab { font-family:'Barlow Condensed'; font-size:12px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); }
.mact { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:3px; }
.stars { display:flex; gap:2px; }
.memocell { display:flex; align-items:center; gap:8px; }
.memoval { font-family:'Barlow Condensed'; font-size:14px; color:var(--acc); }
.star { font-size:21px; line-height:1; padding:3px 4px; color:var(--line); }
.star.on { color:var(--acc); }
.stars.big .star { font-size:32px; padding:5px 6px; }
.stepper { display:flex; align-items:center; border:1px solid var(--line); border-radius:8px; background:var(--panel2); overflow:hidden; }
.stepper button { width:30px; height:31px; color:var(--muted); font-size:15px; line-height:1; }
.stepper button:hover { color:var(--acc); background:var(--acc-faint); }
.stepper span { font-family:'Barlow Condensed'; font-size:12px; letter-spacing:.1em; color:var(--muted); padding:0 8px;
  text-transform:uppercase; min-width:70px; text-align:center; }
.stepper span b { color:var(--ink); font-weight:700; }
/* La feuille du poème.
   touch-action:pan-y — seul le défilement vertical reste au navigateur. Le
   pincement revient à l'app (il règle la taille du texte, pas le zoom de page)
   et l'horizontale aussi : sans cela, un glissé latéral part en navigation
   arrière du navigateur au lieu d'arriver jusqu'à nous. */
.sheet { flex:1; overflow-y:auto; touch-action:pan-y; overscroll-behavior-x:none;
  padding:24px 18px calc(120px + var(--sab)); }
.sheetinner { max-width:640px; margin:0 auto; }
/* Un vers. pre-wrap garde le retrait voulu par le poète ; le retrait négatif
   fait rentrer d'un cran la suite d'un alexandrin trop long pour l'écran, de
   sorte qu'un vers replié ne se confonde jamais avec le vers suivant. */
.verse { white-space:pre-wrap; line-height:1.62; padding-left:1.5em; text-indent:-1.5em;
  transition:filter .4s, opacity .4s; }
.masked { filter:blur(8px); opacity:.35; user-select:none; pointer-events:none; }
/* Blanc entre deux strophes. */
.gap { height:1em; }
/* Provenance, en pied de poème : le texte est du domaine public, la
   transcription de Wikisource est sous CC BY-SA — on la cite. */
.credit { margin-top:34px; padding-top:12px; border-top:1px solid var(--line);
  font-family:'Barlow Condensed'; font-size:13.5px; letter-spacing:.04em;
  color:var(--muted); }
.credit a { color:var(--muted); text-decoration:underline; text-underline-offset:3px; }
.credit a:hover { color:var(--acc); }
.revbar { position:absolute; left:0; right:0; bottom:0; z-index:4; display:flex; flex-direction:column; gap:9px;
  padding:10px 16px calc(14px + var(--sab));
  background:linear-gradient(to top, var(--bg) 72%, transparent); }
.revbar .inner { max-width:760px; margin:0 auto; width:100%; display:flex; flex-direction:column; gap:9px; }
.revprog { display:flex; align-items:center; gap:10px; font-family:'Barlow Condensed'; font-size:12px;
  letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.revprog b { color:var(--acc); }
.revtrack { flex:1; height:3px; background:var(--line); border-radius:2px; overflow:hidden; }
.revfill { height:100%; background:var(--acc); transition:width .3s; }
.revrow { display:flex; gap:8px; align-items:stretch; }
.revrow .iconbtn { width:44px; height:auto; flex:0 0 auto; }
.revmain { flex:1; padding:14px 16px; font-size:17px; min-width:0; }
/* Réponses « savais / savais pas » : vert et rouge, côte à côte à 375 px. */
.btn.know { color:var(--ok); border-color:var(--ok); background:var(--ok-soft); }
.btn.dont { color:var(--hot); border-color:var(--hot); background:none; }
.revrow .revmain.know, .revrow .revmain.dont { padding-left:6px; padding-right:6px; font-size:15px; white-space:nowrap; }
.iconbtn.stop { color:var(--hot); }
.revscore { color:var(--acc); }
.form { flex:1; overflow-y:auto; padding:18px 16px calc(40px + var(--sab)); }
.forminner { max-width:760px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
.field label { display:block; font-family:'Barlow Condensed'; font-size:12px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); margin-bottom:6px; }
.field input, .field textarea { width:100%; padding:11px 13px; border-radius:9px; border:1px solid var(--line); background:var(--panel); color:var(--ink); font-size:16px; }
/* La saisie d'un poème garde les retours à la ligne et les retraits tels
   quels : c'est le texte lui-même qu'on tape, pas un paragraphe. */
.field textarea { line-height:1.6; min-height:280px; resize:vertical;
  white-space:pre; overflow-wrap:normal; overflow-x:auto; }
.hint { font-size:15px; color:var(--muted); line-height:1.55; margin:0; }
.hint a { color:var(--acc); text-decoration:underline; text-underline-offset:2px; }
.actions { display:flex; gap:10px; padding-top:4px; flex-wrap:wrap; }
.btn { padding:11px 18px; border-radius:9px; font-family:'Barlow Condensed'; font-weight:700; font-size:15px; letter-spacing:.09em;
  text-transform:uppercase; border:1px solid var(--line); background:var(--panel2); text-align:center; }
.btn.primary { background:var(--acc); color:#17161B; border-color:var(--acc); }
.btn.ghost { color:var(--muted); background:none; }
.btn.ghost:hover { color:var(--ink); }
.btn.danger { color:var(--hot); border-color:rgba(200,99,90,.45); background:none; }
.btn:disabled { opacity:.45; cursor:default; }
.reportline { font-family:'Barlow Condensed'; font-size:13px; line-height:1.6; color:var(--muted); margin-top:6px; word-break:break-word; }
.reportline b { color:var(--acc); }
/* ---- Import depuis Wikisource ---- */
/* Fil d'Ariane : où l'on est descendu, et par où revenir. */
.wsbc { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-family:'Barlow Condensed';
  font-size:12.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.wsbc button { color:var(--acc); text-decoration:underline; text-underline-offset:3px; font-family:inherit; }
.wsbc i { font-style:normal; opacity:.6; }
.wslist { display:flex; flex-direction:column; border:1px solid var(--line); border-radius:10px;
  background:var(--panel); overflow:hidden; }
.wsrow { display:flex; align-items:center; gap:10px; width:100%; padding:12px 13px; text-align:left;
  font-size:16px; line-height:1.35; color:var(--ink); }
.wsrow + .wsrow { border-top:1px solid var(--line); }
.wsrow:hover { background:var(--acc-faint); }
.wsrow:disabled { opacity:.55; cursor:default; }
.wsrow span { flex:1; min-width:0; }
/* Chemin du recueil, sous le titre du poème : plus petit, pour que l'œil
   accroche d'abord le titre. */
.wsrow em { display:block; font-style:italic; font-size:13px; color:var(--muted);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wsrow i { font-style:normal; flex:0 0 auto; color:var(--muted); font-size:13px; }
.wsrow i.in { color:var(--ok); }
.wsprog { display:flex; align-items:center; gap:10px; font-family:'Barlow Condensed'; font-size:12.5px;
  letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
.wsprog .revtrack { max-width:220px; }
/* ---- Modales ---- */
.modal { position:absolute; inset:0; z-index:40; display:flex; align-items:center; justify-content:center;
  padding:20px; background:rgba(0,0,0,.55); }
.modalbox { width:100%; max-width:340px; max-height:100%; overflow-y:auto;
  background:var(--panel); border:1px solid var(--line);
  border-radius:14px; padding:24px 20px 20px; text-align:center;
  display:flex; flex-direction:column; align-items:center; gap:12px; }
.modalicon { font-size:34px; line-height:1; }
.modalbox h2 { font-family:'Barlow Condensed'; text-transform:uppercase; letter-spacing:.08em;
  font-size:22px; margin:0; color:var(--acc); }
.modalbox p { margin:0; font-size:15px; color:var(--muted); line-height:1.5; }
.modalscore { font-family:'Barlow Condensed'; font-weight:700; font-size:42px; line-height:1; color:var(--acc); }
.modalbox p.modalcount { font-family:'Barlow Condensed'; font-size:12px; letter-spacing:.1em;
  text-transform:uppercase; }
.seg2.wide { width:100%; }
.seg2.wide button { flex:1; }
/* Détail de fin de révision : même repli par grille 0fr/1fr que le menu. */
.qdwrap { width:100%; display:grid; grid-template-rows:1fr; opacity:1;
  transition:grid-template-rows .28s ease, opacity .22s; }
.qdwrap.folded { grid-template-rows:0fr; opacity:0; }
.qdlist { overflow:hidden; text-align:left; }
.qdrow { display:flex; align-items:center; gap:10px; padding:7px 2px; border-top:1px solid var(--line); }
.qdt { flex:1; min-width:0; }
.qdt b { display:block; font-size:15px; font-weight:600;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qdt i { font-style:normal; font-family:'Barlow Condensed'; font-size:12px; letter-spacing:.08em; color:var(--muted); }
.qdd { font-family:'Barlow Condensed'; font-size:14px; white-space:nowrap; color:var(--muted); }
.qdd b { font-weight:700; margin-left:4px; color:var(--ink); }
.qdd b.up { color:var(--ok); }
.qdd b.dn { color:var(--hot); }
/* Taille : n'existe que le temps du pincement à deux doigts. Collée en haut de
   la feuille. height:0 : la pilule apparaît et disparaît sans décaler d'un
   pixel les vers qu'on est en train de régler. */
.sizefly { position:sticky; top:0; height:0; z-index:6; display:flex; justify-content:center;
  pointer-events:none; }
.sizefly span { transform:translateY(-8px); border:1px solid var(--line); border-radius:10px;
  background:var(--panel2); box-shadow:0 4px 16px rgba(0,0,0,.45); padding:8px 14px;
  font-family:'Barlow Condensed'; font-size:12px; letter-spacing:.14em; text-transform:uppercase;
  color:var(--muted); white-space:nowrap; }
.sizefly b { color:var(--acc); font-size:14px; margin-left:8px; }
/* Vitesse : n'existe que pendant le défilement, flotte au-dessus de la feuille. */
.speedfly { position:absolute; right:12px; bottom:calc(14px + var(--sab)); z-index:4;
  border:1px solid var(--line); border-radius:10px; background:rgba(28,27,35,.94);
  box-shadow:0 4px 16px rgba(0,0,0,.45); }
.speedfly .stepper { border:none; background:none; }
@media (min-width:720px) { .sheet { padding:30px 32px calc(130px + var(--sab)); }
  .lib { padding:18px 32px calc(150px + var(--sab)); }
  .libhead { padding:12px 32px 10px; } }
@media (prefers-reduced-motion:reduce) { .cb * { transition:none !important; } }
`;

/* ------------------------------------------------------------------ */
/* Le poème à l'écran                                                  */
/* ------------------------------------------------------------------ */

/** maskFrom : en révision, numéro d'unité à partir duquel le texte est
 *  flouté ; maskUnits donne l'unité de chaque bloc (null = jamais masqué :
 *  blancs, repères, didascalies). La structure guide, le texte se mérite. */
function Sheet({ blocks, size, maskFrom, maskUnits, source }) {
  // Dernier bloc de l'unité tout juste révélée : c'est lui qu'on recentre.
  let frontierBlock = -1;
  if (maskFrom != null && maskUnits) {
    for (let i = 0; i < blocks.length; i++) if (maskUnits[i] === maskFrom - 1) frontierBlock = i;
  }
  return (
    <div className="sheetinner" style={{ fontSize: size }}>
      {blocks.map((b, i) => {
        if (b.type === "blank") return <div className="gap" key={i} />;
        const unit = maskUnits ? maskUnits[i] : null;
        const masked = maskFrom != null && unit != null && unit >= maskFrom;
        return (
          <div className={"verse" + (masked ? " masked" : "")}
            data-frontier={i === frontierBlock ? "1" : undefined} key={i}>{b.text}</div>
        );
      })}
      {source && (
        <p className="credit">
          Texte : <a href={WS_PAGE(source)} target="_blank" rel="noopener noreferrer">{source}</a>
          {" "}· Wikisource, CC BY-SA
        </p>
      )}
    </div>
  );
}

const PLACEHOLDER = `Collez ici le poème, un vers par ligne.

Une ligne vide sépare deux strophes,
et les retraits sont conservés tels quels.`;

function Editor({ draft, setDraft, onSave, onCancel, onDelete }) {
  return (
    <div className="form">
      <div className="forminner">
        <div className="field">
          <label htmlFor="t">Titre</label>
          <input id="t" value={draft.title} placeholder="Sans titre" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="a">Auteur</label>
          <input id="a" value={draft.author} placeholder="Anonyme" onChange={(e) => setDraft({ ...draft, author: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="g">Poème</label>
          <textarea id="g" value={draft.body} spellCheck={false} placeholder={PLACEHOLDER}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        </div>
        <p className="hint">
          Un vers par ligne, une ligne vide entre les strophes. Chaque vers devient une unité
          de révision — sauf les repères (« I », « * * * ») et les didascalies entre parenthèses.
        </p>
        <div className="actions">
          <button className="btn primary" onClick={onSave}>Enregistrer</button>
          <button className="btn ghost" onClick={onCancel}>Annuler</button>
          {onDelete && <button className="btn danger" onClick={onDelete}>Supprimer</button>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Transfert : sauvegarde en fichier, partage par URL, import          */
/* ------------------------------------------------------------------ */

function Transfer({ library, tags, lists, backup, dirty, onImport, onShareUrl, onSaved, onClose }) {
  const { poems } = library;
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [urlMsg, setUrlMsg] = useState("");
  const [share, setShare] = useState(null);
  const [fileMsg, setFileMsg] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const fileRef = useRef(null);
  // Le fichier de sauvegarde porte les poèmes, les tags ET les listes ;
  // l'URL de partage, elle, laisse les tags de côté — c'est elle qu'on donne
  // à quelqu'un, et un classement est personnel.
  const json = useMemo(() => backupJson(poems, tags, lists), [poems, tags, lists]);

  useEffect(() => {
    let alive = true;
    setShare(null);
    setUrlMsg("");
    if (!poems.length) { setShare({ error: "le carnet est vide" }); return; }
    (async () => {
      try {
        const s = await encodeShare(library, lists);
        const url = window.location.origin + window.location.pathname + window.location.search + s.hash;
        if (alive) setShare({ ...s, url });
      } catch (e) {
        if (alive) setShare({ error: String(e && e.message ? e.message : e) });
      }
    })();
    return () => { alive = false; };
  }, [library, lists, poems.length]);

  const doImport = async (raw) => {
    const t = String(raw == null ? text : raw).trim();
    if (!t) {
      setMsg("Rien à importer : choisissez un fichier ci-dessus, ou collez un JSON, un code compressé ou une URL de partage.");
      return;
    }
    try {
      let lib;
      let addedTags = null;
      let addedLists = null;
      if (/^[[{]/.test(t)) {
        const parsed = JSON.parse(t);
        lib = normalizeLibrary(parsed);
        addedTags = normalizeTags(parsed && parsed.tags);
        addedLists = normalizeLists(parsed && parsed.lists);
      } else {
        const data = extractShareData(t);
        if (!data) throw new Error();
        lib = await decodeShareData(data);
        addedLists = lib.lists || null; // les listes voyagent dans l'URL, les tags non
      }
      onImport(lib.poems, lib, addedTags, addedLists);
      const withTags = addedTags && (addedTags.defs.length || Object.keys(addedTags.byKey).length);
      setMsg(`${lib.poems.length} poème(s) ajouté(s)${withTags ? ", tags compris" : ""}.`);
      if (raw == null) setText("");
    } catch {
      setMsg("Texte non reconnu. Attendu : une liste JSON avec title, author et body, ou un code/URL généré par « Partager par URL ».");
    }
  };

  /** Sur iPhone, la feuille de partage d'un *fichier* propose « Enregistrer dans
   *  Fichiers », donc iCloud Drive — et elle fonctionne depuis l'app installée, là
   *  où un téléchargement classique est capricieux. Ailleurs, téléchargement. Rien
   *  d'asynchrone avant navigator.share : le geste de l'utilisateur serait perdu.
   *
   *  Nom daté et horodaté : iOS ne propose pas de remplacer un fichier, il
   *  numérote en silence — avec la date, la pile reste chronologique. */
  const saveFile = () => {
    const d = new Date();
    const p2 = (v) => String(v).padStart(2, "0");
    const name = `carnet-poesie-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      + `-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
    const file = new File([json], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      setFileMsg("");
      navigator.share({ files: [file], title: "Sauvegarde du Carnet de poésie" })
        .then(() => { onSaved(); setFileMsg("Sauvegarde transmise à Fichiers."); })
        .catch((e) => { if (e && e.name !== "AbortError") setFileMsg("Partage refusé par le navigateur — réessayez, ou passez par l'URL de partage."); });
      return;
    }
    try {
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      onSaved();
      setFileMsg(`Fichier enregistré : ${name}`);
    } catch {
      setFileMsg("Enregistrement impossible dans ce navigateur — passez par l'URL de partage.");
    }
  };

  const readFile = async (file) => {
    if (!file) return;
    setFileMsg("");
    try {
      await doImport(await file.text());
    } catch {
      setMsg("Fichier illisible.");
    }
  };

  const copyUrl = async () => {
    if (!share || share.error) return;
    onShareUrl(share.hash);
    try {
      await navigator.clipboard.writeText(share.url);
      setUrlMsg(`URL copiée (${share.url.length.toLocaleString("fr-FR")} caractères) — la barre d'adresse contient aussi vos données, la page peut être mise en favori telle quelle.`);
    } catch {
      setUrlMsg("Copie refusée par le navigateur : sélectionnez l'URL ci-dessus et copiez-la à la main. La barre d'adresse contient déjà vos données.");
    }
  };

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isMac = !isIOS && /Mac/.test(navigator.userAgent);

  const plural = (n) => (n > 1 ? "s" : "");
  const dateFmt = (t) => new Date(t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="form">
      <div className="forminner">

        {/* 1 — la sauvegarde : le geste de tous les jours */}
        <div className="field">
          <label>Sauvegarde du carnet</label>
          <p className="hint">
            {poems.length} poème{plural(poems.length)} et {tags.defs.length} tag{plural(tags.defs.length)},
            dans un fichier daté à la minute — <b>carnet-poesie-{new Date().getFullYear()}-…json</b>.{" "}
            {isIOS
              ? <>« Enregistrer » ouvre la feuille de partage : choisissez <b>Enregistrer dans Fichiers</b>, par exemple
                dans iCloud Drive. iOS ne sait pas remplacer un fichier existant — il numérote —, d'où la date dans le
                nom : la dernière sauvegarde est celle du haut, les précédentes se suppriment depuis Fichiers.</>
              : <>La date dans le nom garde la pile lisible ; les anciennes sauvegardes se suppriment à la main.</>}
          </p>
          <p className="hint" style={{ marginTop: 6, color: dirty ? "var(--acc)" : undefined }}>
            {backup
              ? <>Dernière sauvegarde : <b>{dateFmt(backup.at)}</b>{dirty ? " — le carnet a changé depuis." : " — à jour."}</>
              : poems.length > 0
                ? "Aucune sauvegarde enregistrée depuis cet appareil."
                : "Carnet vide : rien à sauvegarder pour l'instant."}
          </p>
        </div>
        <div className="actions">
          <button className="btn primary" disabled={!poems.length} onClick={saveFile}>Enregistrer</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Restaurer un fichier…</button>
        </div>
        {fileMsg && <p className="hint">{fileMsg}</p>}
        {msg && <p className="hint">{msg}</p>}

        {/* 2 — partager, ou installer sur l'écran d'accueil avec les données */}
        <div className="field">
          <label htmlFor="shareurl">Partager ou installer — tout voyage après le #</label>
          <textarea id="shareurl" readOnly style={{ minHeight: 76, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            value={share ? (share.error ? `Indisponible : ${share.error}` : share.url) : "Préparation…"}
            onFocus={(e) => e.target.select()} />
          {share && !share.error && (
            <p className="reportline">
              URL de <b>{share.url.length.toLocaleString("fr-FR")}</b> caractères (gzip {fmtBytes(share.packedBytes)})
              {share.url.length > 30000 && " — très longue : certaines messageries la tronquent"}
              {" "}· sans les tags, qui restent sur cet appareil
            </p>
          )}
        </div>
        <div className="actions">
          <button className="btn primary" disabled={!share || !!share.error} onClick={copyUrl}>Copier l'URL</button>
          <button className="btn" disabled={!share || !!share.error}
            onClick={() => window.open(share.url, "_blank", "noopener")}>Ouvrir dans une autre fenêtre</button>
        </div>
        {urlMsg && <p className="hint">{urlMsg}</p>}
        <p className="hint">
          {isIOS ? (
            <>Pour poser le carnet sur l'écran d'accueil : ouvrez cette URL dans une autre fenêtre, puis
            touchez <b>Partager</b> → <b>« Sur l'écran d'accueil »</b>. L'icône créée rouvrira le carnet avec ses poèmes.</>
          ) : isAndroid ? (
            <>Sur Android : menu <b>⋮</b> puis <b>« Ajouter à l'écran d'accueil »</b>, ou l'étoile pour les favoris.</>
          ) : (
            <>Appuyez sur <b>{isMac ? "⌘D" : "Ctrl+D"}</b> pour mettre la page en favori — les navigateurs ne
            laissent plus les sites le déclencher eux-mêmes.</>
          )}
        </p>

        {/* 3 — recevoir un carnet collé : replié, c'est rare */}
        <div className="actions">
          <button className="btn ghost" onClick={() => setPasteOpen(!pasteOpen)}>
            {pasteOpen ? "Masquer le collage" : "Coller une URL ou un code…"}
          </button>
          <button className="btn ghost" onClick={onClose}>Retour</button>
        </div>
        {pasteOpen && (
          <>
            <div className="field">
              <label htmlFor="imp">URL partagée, code compressé ou JSON</label>
              <textarea id="imp" value={text} placeholder={"https://…#v=1&data=…"}
                style={{ minHeight: 90 }} onChange={(e) => setText(e.target.value)} />
            </div>
            <div className="actions">
              <button className="btn" onClick={() => doImport()}>Importer</button>
            </div>
          </>
        )}
        <input ref={fileRef} type="file" accept=".json,application/json,text/plain"
          className="vhide" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { readFile(e.target.files && e.target.files[0]); e.target.value = ""; }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* L'auteur d'une page                                                 */
/*                                                                     */
/* Les sous-pages d'un recueil ne portent pas leur auteur ; la page du */
/* recueil, si — en catégorie (« Poèmes de Charles Baudelaire »,       */
/* « Recueils de poèmes de Victor Hugo »). On la lit donc à la racine  */
/* du chemin, une fois par recueil.                                    */
/* ------------------------------------------------------------------ */

const AUTHOR_CAT = /^(?:Recueils de )?[Pp]oèmes d(?:e |’)(.+)$/;
const authorFromCats = (cats) => {
  for (const raw of cats || []) {
    const m = AUTHOR_CAT.exec(String(raw).replace(/^Catégorie:/, "").replace(/_/g, " "));
    if (m) return m[1].trim();
  }
  return "";
};

const authorCache = new Map();
async function wsAuthorOf(title) {
  const root = String(title).split("/")[0];
  if (authorCache.has(root)) return authorCache.get(root);
  let found = "";
  try {
    const j = await wsQuery({
      action: "query", prop: "categories", titles: root,
      cllimit: "50", clshow: "!hidden", redirects: "1",
    });
    const page = ((j.query && j.query.pages) || [])[0] || {};
    found = authorFromCats((page.categories || []).map((c) => c.title));
  } catch { /* sans auteur, le poème s'ouvre quand même : cela se corrige à la main */ }
  authorCache.set(root, found);
  return found;
}

/** Le poète que ce texte mentionne, s'il en connaît un : sert à deviner
 *  l'auteur d'un résultat de recherche (« dormeur du val rimbaud »). */
function guessPoet(text) {
  const t = String(text).toLowerCase();
  for (const p of POETS) {
    const last = p.name.split(" ").pop().toLowerCase();
    if (last.length > 3 && t.includes(last)) return p.name;
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Import depuis Wikisource                                            */
/*                                                                     */
/* Une pile de niveaux : la racine (recherche + poètes), puis ce qu'on */
/* a ouvert. Toucher une entrée demande la page ; si c'est un poème on */
/* l'ajoute, sinon ses liens deviennent le niveau suivant. C'est la    */
/* même action pour « ouvrir un recueil » et pour « prendre un         */
/* poème » — l'utilisateur n'a jamais à savoir sur quoi il tape.       */
/* ------------------------------------------------------------------ */

/** Pause entre deux requêtes d'un import en série. Wikimedia répond 429
 *  bien avant qu'on s'en rende compte : on lui laisse de l'air. */
const BULK_DELAY = 600;

function WikiImport({ have, online, onAdd, onClose }) {
  const [stack, setStack] = useState([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");       // titre en cours de chargement
  const [err, setErr] = useState("");
  const [added, setAdded] = useState([]);     // titres ajoutés pendant cette visite
  const [bulk, setBulk] = useState(null);     // { done, total, running }
  const stopRef = useRef(false);
  const level = stack.length ? stack[stack.length - 1] : null;

  useEffect(() => () => { stopRef.current = true; }, []);

  const fail = (e) => setErr(String((e && e.message) || e).slice(0, 160));

  const push = (next) => { setErr(""); setStack((s) => [...s, next]); };
  const pop = () => { setErr(""); setStack((s) => s.slice(0, -1)); };

  const openPoet = async (poet) => {
    setBusy(poet.cat); setErr("");
    try {
      const items = await wsCategory(poet.cat);
      if (!items.length) throw new Error("aucun poème dans cette catégorie");
      push({ title: poet.name, author: poet.name, items });
    } catch (e) { fail(e); } finally { setBusy(""); }
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy("?"); setErr("");
    try {
      const items = await wsSearch(q);
      if (!items.length) throw new Error(`rien ne correspond à « ${q} » sur Wikisource`);
      push({ title: q, author: guessPoet(q), items, search: true });
    } catch (e) { fail(e); } finally { setBusy(""); }
  };

  /** Résout un titre et, si c'est un poème, le rend prêt à être ajouté. */
  const fetchPoem = async (title) => {
    const res = await wsPage(title);
    if (res.kind !== "poem") return res;
    const author = (level && level.author) || res.author || await wsAuthorOf(res.title);
    return {
      ...res,
      poem: { id: uid(), title: leafTitle(res.title), author, body: res.body, source: res.title },
    };
  };

  const openTitle = async (title) => {
    setBusy(title); setErr("");
    try {
      const res = await fetchPoem(title);
      if (res.kind === "poem") {
        onAdd([res.poem]);
        setAdded((a) => (a.includes(res.title) ? a : [...a, res.title]));
        return;
      }
      if (!res.links.length) throw new Error("cette page ne contient ni poème ni sommaire");
      push({ title: leafTitle(res.title), full: res.title, author: (level && level.author) || "", items: res.links });
    } catch (e) { fail(e); } finally { setBusy(""); }
  };

  /** Tout le niveau d'un coup — un recueil entier. Une requête toutes les
   *  600 ms, arrêtable, et ce qui a déjà été pris est sauté. */
  const importAll = async () => {
    if (!level) return;
    const todo = level.items.filter((t) => !isHere(t));
    if (!todo.length) return;
    stopRef.current = false;
    setErr("");
    setBulk({ done: 0, total: todo.length, running: true });
    const batch = [];
    for (let i = 0; i < todo.length; i++) {
      if (stopRef.current) break;
      if (i) await sleep(BULK_DELAY);
      try {
        const res = await fetchPoem(todo[i]);
        if (res.kind === "poem") batch.push(res.poem);
      } catch (e) {
        // Une limite de débit arrête la série : insister l'aggraverait.
        if (/limite/i.test(String((e && e.message) || ""))) { fail(e); break; }
      }
      setBulk({ done: i + 1, total: todo.length, running: true });
    }
    if (batch.length) {
      onAdd(batch);
      setAdded((a) => [...new Set([...a, ...batch.map((p) => p.source)])]);
    }
    setBulk((b) => (b ? { ...b, running: false } : null));
  };

  /** Ce titre est-il déjà au carnet ? On compare sur l'ancre titre+auteur,
   *  celle des tags et des listes — et un poème ajouté à l'instant compte. */
  const isHere = (title) => {
    if (added.includes(title)) return true;
    const key = poemKey({ title: leafTitle(title), author: (level && level.author) || "" });
    return have.has(key);
  };

  const running = Boolean(bulk && bulk.running);
  const leftToTake = level ? level.items.filter((t) => !isHere(t)).length : 0;

  return (
    <div className="form">
      <div className="forminner">
        {!level ? (
          <>
            <div className="field">
              <label htmlFor="wsq">Chercher sur Wikisource</label>
              <input id="wsq" value={query} placeholder="Un titre, un vers, un poète…"
                enterKeyHint="search" autoCapitalize="off"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }} />
            </div>
            <div className="actions">
              <button className="btn primary" disabled={!query.trim() || !!busy || !online} onClick={runSearch}>
                {busy === "?" ? "Recherche…" : "Chercher"}
              </button>
              <button className="btn ghost" onClick={onClose}>Retour</button>
            </div>
            {err && <p className="hint" style={{ color: "var(--hot)" }}>{err}</p>}
            {!online && <p className="hint">Sans réseau, Wikisource est hors de portée. Les poèmes déjà au carnet, eux, se lisent normalement.</p>}
            <div className="field">
              <label>Ou parcourir un poète</label>
              <p className="hint">
                Les textes de Wikisource sont dans le domaine public ; leur transcription est
                sous licence CC BY-SA, et la source reste attachée à chaque poème importé.
              </p>
            </div>
            <div className="wslist">
              {POETS.map((p) => (
                <button className="wsrow" key={p.cat} disabled={!!busy || !online} onClick={() => openPoet(p)}>
                  <span>{p.name}</span>
                  <i>{busy === p.cat ? "..." : "›"}</i>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="wsbc">
              <button onClick={pop}>{"‹"} Retour</button>
              <i>/</i>
              <span>{level.search ? `Recherche : ${level.title}` : level.title}</span>
            </div>
            <div className="field">
              <p className="hint">
                {level.items.length} entrée{level.items.length > 1 ? "s" : ""}
                {level.author ? <> — {level.author}</> : null}.
                {" "}Touchez pour ajouter le poème ; un recueil ouvre sa table.
              </p>
            </div>
            {err && <p className="hint" style={{ color: "var(--hot)" }}>{err}</p>}
            {level.items.length > 1 && (
              <div className="actions">
                {running ? (
                  <>
                    <span className="wsprog">
                      <span>{bulk.done} / {bulk.total}</span>
                      <span className="revtrack"><span className="revfill" style={{ display: "block", width: `${(bulk.done / bulk.total) * 100}%` }} /></span>
                    </span>
                    <button className="btn danger" onClick={() => { stopRef.current = true; }}>Arrêter</button>
                  </>
                ) : (
                  <button className="btn" disabled={!leftToTake || !!busy || !online} onClick={importAll}
                    title="Ajoute chaque poème de cette page, une requête à la fois">
                    Tout ajouter{leftToTake ? ` (${leftToTake})` : ""}
                  </button>
                )}
              </div>
            )}
            {bulk && !bulk.running && (
              <p className="hint">{bulk.done} entrée{bulk.done > 1 ? "s" : ""} parcourue{bulk.done > 1 ? "s" : ""}.</p>
            )}
            <div className="wslist">
              {level.items.map((t) => {
                const here = isHere(t);
                const path = t.includes("/") ? t.slice(0, t.lastIndexOf("/")) : "";
                return (
                  <button className="wsrow" key={t} disabled={!!busy || running || !online}
                    onClick={() => openTitle(t)}>
                    <span>
                      {leafTitle(t)}
                      {level.search && path ? <em>{path}</em> : null}
                    </span>
                    <i className={here ? "in" : ""}>
                      {busy === t ? "..." : here ? "✓" : "+"}
                    </i>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {added.length > 0 && (
          <div className="actions">
            <button className="btn primary" onClick={onClose}>
              Terminé — {added.length} poème{added.length > 1 ? "s" : ""} ajouté{added.length > 1 ? "s" : ""}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Poesie() {
  const [poems, setPoems] = useState([]);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState("lib"); // "lib" | "poem" | "edit" | "import" | "transfer" | "settings"
  const [currentId, setCurrentId] = useState(null);
  const [draft, setDraft] = useState({ title: "", author: "", body: "" });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("title");
  const [sortDir, setSortDir] = useState("asc"); // re-taper le tri actif inverse l'ordre
  const [size, setSize] = useState(19);
  const [scrolling, setScrolling] = useState(false);
  const [speed, setSpeed] = useState(3);
  const [barOpen, setBarOpen] = useState(true);
  const [theme, setTheme] = useState("light"); // "dark" | "light" — le choix persisté prime
  const [sizeFly, setSizeFly] = useState(false); // pilule de taille, le temps du pincement
  const [status, setStatus] = useState("");
  const [offline, setOffline] = useState(() => (window.offline ? window.offline.get() : null));
  const [backup, setBackup] = useState(null); // { at, sig } de la dernière sauvegarde en fichier
  const [upCheck, setUpCheck] = useState(null); // null | "busy" | "found" | "none"

  // Révision
  const [reviseMode, setReviseMode] = useState(null); // null | "seq" | "random" | "quiz"
  const [reviseStart, setReviseStart] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const [judged, setJudged] = useState(0); // unités « savais / savais pas » répondues cette session
  const [memoPrompt, setMemoPrompt] = useState(false);
  const [memoDraft, setMemoDraft] = useState(0);
  const memoPromptedRef = useRef(false); // une seule apparition par session
  const memoLiveRef = useRef(null); // score non arrondi — l'arrondi gèlerait les petits pas
  const memoBeforeRef = useRef(null);
  const pendingReviseRef = useRef(false);

  // Révision au hasard (l'ancien « quiz ») : une chanson, un vers, on enchaîne
  const [quiz, setQuiz] = useState(null); // null | { asked, correct } — survit aux changements de poème
  const [quizEnd, setQuizEnd] = useState(null);
  const [quizQ, setQuizQ] = useState(0); // nonce : re-arme même quand le hasard retombe sur le même poème
  const [quizAsk, setQuizAsk] = useState(false);
  const [quizScope, setQuizScope] = useState("all"); // "all" | "weak"
  const [quizMax, setQuizMax] = useState(3);
  const [quizDetail, setQuizDetail] = useState(false);
  const pendingQuizRef = useRef(false);
  const quizDeadRef = useRef(new Set()); // poèmes sans vers révisable croisés en route
  const quizPoolRef = useRef(null); // ids figés au départ (null = toute la sous-liste)
  const quizStatsRef = useRef(new Map()); // id → ligne du récapitulatif

  // Lecture (l'ancien « jouer »)
  const [playAsk, setPlayAsk] = useState(false);
  const [playScope, setPlayScope] = useState("all"); // "all" | "known"
  const [playMin, setPlayMin] = useState(3);
  const [playTags, setPlayTags] = useState([]);
  const [playRandom, setPlayRandom] = useState(true);
  const [queue, setQueue] = useState({ ids: [], random: false });

  // Classement
  const [tags, setTags] = useState(freshTags);
  const [tagFilter, setTagFilter] = useState([]);
  const [tagMenu, setTagMenu] = useState(false);
  const [lists, setLists] = useState(freshLists);
  const [listFilter, setListFilter] = useState(""); // id de liste, ou "author:<nom>", "" = tout
  const [reorder, setReorder] = useState(false);
  const [dragRows, setDragRows] = useState(null);
  const [dragId, setDragId] = useState(null);

  const sheetRef = useRef(null);
  const searchRef = useRef(null);
  const syncHashRef = useRef(false);
  const draggingRef = useRef(false);
  const resumeRef = useRef(null);
  const dragRef = useRef(null);
  const libScrollRef = useRef(null);
  const autoRef = useRef(0);
  const [libScrolled, setLibScrolled] = useState(false);
  const libScrollTimer = useRef(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await Promise.race([
        loadLibrary(),
        new Promise((r) => setTimeout(() => r(null), 2500)),
      ]);
      if (!alive) return;
      let carnet = data && Array.isArray(data.poems) ? data : { poems: [] };
      // Un fragment #v=1&data=… l'emporte : c'est le sens d'ouvrir un lien
      // partagé. Les poèmes locaux de même titre sont remplacés, les autres
      // conservés.
      try {
        const shared = await libraryFromHash(window.location.hash);
        if (!alive) return;
        if (shared) {
          carnet = { ...carnet, ...shared, poems: mergeByTitle(carnet.poems, shared.poems) };
          syncHashRef.current = true;
          setStatus(`${shared.poems.length} poème(s) chargé(s) depuis l'URL.`);
        }
      } catch (e) {
        setStatus("Le lien contenait des données illisibles ou incompatibles — carnet local conservé. ("
          + String(e && e.message ? e.message : e).slice(0, 120) + ")");
      }
      // Le stockage est censé porter des ids — tout ce qui entre par
      // normalizeLibrary en reçoit un. Un carnet bricolé à la main, lui,
      // pourrait en manquer : deux poèmes sans id seraient alors le même
      // poème pour toute la navigation. On les rétablit à la lecture.
      setPoems(carnet.poems.map((s) => (s && s.id ? s : { ...s, id: uid() })));
      // Tags : hors du carnet partagé, donc chargés à part. Un enregistrement
      // vide est respecté (tags tous supprimés) ; seule leur absence remet les
      // quatre tags par défaut.
      const savedTags = await loadTags();
      const savedLists = await loadLists();
      const mark = await loadBackup();
      if (!alive) return;
      if (savedTags) setTags(savedTags);
      // Les listes du lien se fusionnent avec celles de l'appareil : un ordre
      // déjà décidé ici n'est pas réécrit par le lien (mergeLists).
      const linkLists = carnet.lists || null;
      if (savedLists || linkLists) {
        setLists(linkLists ? mergeLists(savedLists || freshLists(), linkLists) : savedLists);
      }
      if (mark) setBackup(mark);
      if (carnet.size) setSize(carnet.size);
      if (carnet.speed) setSpeed(carnet.speed);
      if (["title", "author", "memo", "list"].includes(carnet.sort)) setSort(carnet.sort);
      if (carnet.sortDir === "desc") setSortDir("desc");
      if (typeof carnet.barOpen === "boolean") setBarOpen(carnet.barOpen);
      if (carnet.theme === "dark" || carnet.theme === "light") setTheme(carnet.theme);
      if (typeof carnet.listFilter === "string") setListFilter(carnet.listFilter);
      setReady(true);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { if (ready) saveLibrary({ poems, size, speed, sort, sortDir, barOpen, theme, listFilter }); },
    [poems, size, speed, sort, sortDir, barOpen, theme, listFilter, ready]);
  useEffect(() => { if (ready) saveTags(tags); }, [tags, ready]);
  useEffect(() => { if (ready) saveLists(lists); }, [lists, ready]);

  // Sur iOS, aucune page web ne peut réécrire seule dans un fichier : la
  // sauvegarde reste un geste. À défaut de l'automatiser, l'app signale qu'elle
  // est due — point d'accent sur ⇅, état détaillé dans la page Transfert.
  const currentSig = useMemo(() => signature(backupJson(poems, tags, lists)), [poems, tags, lists]);
  const dirty = ready && poems.length > 0 && (!backup || backup.sig !== currentSig);
  const markSaved = () => {
    const mark = { at: Date.now(), sig: currentSig };
    setBackup(mark);
    saveBackupMark(mark);
  };

  // Un effet ne doit rien renvoyer d'autre qu'une fonction de nettoyage.
  useEffect(() => (window.offline ? window.offline.subscribe(setOffline) : undefined), []);
  useEffect(() => { if (view === "settings" && window.offline) window.offline.refresh(); }, [view]);

  // La barre d'adresse n'est réécrite qu'une fois le partage activé
  // (ouverture d'un lien #data=… ou « Copier l'URL ») : elle reflète alors
  // le carnet en continu, et un favori pris à n'importe quel moment —
  // Ctrl+D, écran d'accueil iOS — embarque les données à jour.
  useEffect(() => {
    if (!ready || !syncHashRef.current) return;
    let alive = true;
    (async () => {
      try {
        if (!poems.length) {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
          return;
        }
        const { hash } = await encodeShare({ poems, size, speed, sort }, lists);
        if (alive && window.location.hash !== hash) window.history.replaceState(null, "", hash);
      } catch { /* barre d'adresse laissée telle quelle */ }
    })();
    return () => { alive = false; };
  }, [poems, size, speed, sort, lists, ready]);

  const shareUrl = (hash) => {
    syncHashRef.current = true;
    window.history.replaceState(null, "", hash);
  };

  /* Défilement de lecture : une vitesse constante, en pixels par seconde.
     Le doigt met la boucle en pause (draggingRef) ; arrivé en bas, on
     s'arrête plutôt que de rester collé. */
  useEffect(() => {
    if (!scrolling || view !== "poem") return;
    const el = sheetRef.current;
    if (!el) return;
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    const tick = (now) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (!draggingRef.current) {
        carry += (speed * 9 * dt) / 1000;
        const step = Math.floor(carry);
        if (step) {
          carry -= step;
          const max = el.scrollHeight - el.clientHeight;
          if (max <= 0 || el.scrollTop >= max - 1) { setScrolling(false); return; }
          el.scrollTop = Math.min(max, el.scrollTop + step);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scrolling, speed, view, size]);

  // Taille courante lisible depuis un écouteur natif, sans le réabonner à
  // chaque cran : seule la valeur au *début* du geste sert de référence.
  const sizeRef = useRef(size);
  useEffect(() => { sizeRef.current = size; }, [size]);

  // Ce que déclenchent les glissés — relu à chaque rendu pour que l'écouteur
  // natif, abonné une seule fois, appelle toujours la version fraîche.
  const swipeRef = useRef({});
  useEffect(() => {
    swipeRef.current = { back: leavePoem, next: hasNext ? openNext : null };
  });

  /* Gestes sur la feuille, tous branchés au même endroit :
      — deux doigts qui s'écartent : la taille du texte (13 → 34), le même
        réglage global que A− / A+ des Réglages ;
      — un doigt vers la droite : retour à la liste, comme le ‹ (convention
        iOS) ; vers la gauche : poème suivant, comme ⏭.
     Écouteurs natifs et non props React : React attache touchmove en passif,
     or il faut pouvoir couper le zoom de page de Safari pendant le pincement. */
  useEffect(() => {
    const el = sheetRef.current;
    if (view !== "poem" || !el) return;
    const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    let pinch = null, hide = null, swipe = null;
    const start = (e) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        swipe = { x: t.clientX, y: t.clientY, t: e.timeStamp };
        return;
      }
      swipe = null; // un deuxième doigt : ce n'est plus un glissé
      if (e.touches.length !== 2) return;
      const d = spread(e.touches);
      if (d < 24) return; // deux doigts collés : ce n'est pas encore un pincement
      pinch = { d0: d, base: sizeRef.current };
      clearTimeout(hide);
      setSizeFly(true);
    };
    const move = (e) => {
      if (swipe && e.touches.length === 1) {
        // Parti vers le bas : c'est un défilement, on ne guettera plus de glissé.
        const t = e.touches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
        if (Math.abs(dy) > 20 && Math.abs(dy) > Math.abs(dx)) swipe = null;
        return;
      }
      if (!pinch || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const next = Math.max(13, Math.min(34, Math.round(pinch.base * (spread(e.touches) / pinch.d0))));
      if (next !== sizeRef.current) setSize(next); // un rendu par cran, pas un par touchmove
    };
    const end = (e) => {
      if (swipe && e.touches.length === 0) {
        const t = e.type === "touchend" && e.changedTouches[0];
        if (!t) { swipe = null; return; } // touchcancel : le doigt n'a rien voulu dire
        const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y, dt = e.timeStamp - swipe.t;
        swipe = null;
        // Franc, horizontal et vif : sinon c'était un défilement ou une hésitation.
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2 && dt < 700) {
          const act = dx > 0 ? swipeRef.current.back : swipeRef.current.next;
          if (act) act();
        }
      }
      if (!pinch || e.touches.length >= 2) return;
      pinch = null;
      clearTimeout(hide);
      hide = setTimeout(() => setSizeFly(false), 900);
    };
    const noZoom = (e) => e.preventDefault();
    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    el.addEventListener("gesturestart", noZoom);
    el.addEventListener("gesturechange", noZoom);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("gesturestart", noZoom);
      el.removeEventListener("gesturechange", noZoom);
      clearTimeout(hide);
      setSizeFly(false);
    };
  }, [view]);

  const current = poems.find((s) => s.id === currentId) || null;
  const blocks = useMemo(() => (current ? parsePoem(current.body) : []), [current]);
  const reviseUnits = useMemo(() => reviseUnitsOf(blocks), [blocks]);
  const revealables = reviseUnits.count;
  const visibleLines = Math.min(revealables, reviseStart + revealed);
  // Unités à juger cette session : celles à partir du point de départ — en
  // départ aléatoire, le contexte déjà visible n'est pas jugé. La session ne
  // finit qu'une fois le dernier vers révélé ET jugé.
  const toJudge = Math.max(0, revealables - reviseStart);
  const reviseDone = reviseMode && reviseMode !== "quiz" && judged >= toJudge;

  const startRevise = (mode) => {
    if (!revealables) return;
    setScrolling(false);
    setReviseMode(mode);
    setReviseStart(mode === "random" ? 1 + Math.floor(Math.random() * Math.max(1, revealables - 1)) : 0);
    setRevealed(0);
    setJudged(0);
    memoLiveRef.current = null;
    memoBeforeRef.current = (current && current.memo) || null;
    memoPromptedRef.current = false;
    setMemoPrompt(false);
  };
  const revealNext = () => {
    setRevealed((r) => Math.min(r + 1, Math.max(0, revealables - reviseStart)));
  };
  /** Une réponse « savais » / « savais pas » fait faire un pas d'EMA au score
   *  du poème, écrit à chaque fois : une session interrompue a déjà compté.
   *  Le pas part de la valeur non arrondie gardée en ref. Renvoie le score
   *  affiché avant et après le pas — c'est ce que la révision récapitule. */
  const applyAuto = (known) => {
    const before = (current && current.memo) || 0;
    const next = emaStep(memoLiveRef.current ?? (current && current.memo), known, revealables);
    memoLiveRef.current = next;
    const m = clampMemo(next);
    setPoems((prev) => prev.map((s) => (s.id === currentId ? { ...s, memo: m, memoAuto: true } : s)));
    return { before, after: m };
  };
  /** Le jugement porte sur le dernier vers révélé : en révision suivie,
   *  répondre révèle du même geste le vers suivant ; en révision au hasard,
   *  il enchaîne sur le poème suivant. */
  const answer = (known) => {
    if (!reviseMode || revealed === 0) return;
    if (reviseMode === "quiz") {
      const step = applyAuto(known);
      // Récapitulatif : « avant » est le score au tout premier passage du
      // poème, « après » le plus récent — un poème tiré deux fois ne raconte
      // qu'un seul mouvement.
      const stats = quizStatsRef.current;
      const seen = stats.get(currentId);
      stats.set(currentId, {
        title: current.title,
        before: seen ? seen.before : step.before,
        after: step.after,
        asked: (seen ? seen.asked : 0) + 1,
        correct: (seen ? seen.correct : 0) + (known ? 1 : 0),
      });
      setQuiz((g) => g && { asked: g.asked + 1, correct: g.correct + (known ? 1 : 0) });
      quizNext();
      return;
    }
    if (judged >= toJudge) return;
    applyAuto(known);
    setJudged((j) => j + 1);
    revealNext();
  };

  // Le vers tout juste révélé (ou la fin du contexte en départ aléatoire) est
  // ramené au centre de l'écran.
  useEffect(() => {
    if (!reviseMode || !sheetRef.current) return;
    const el = sheetRef.current.querySelector('[data-frontier="1"]');
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    else sheetRef.current.scrollTop = 0;
  }, [reviseMode, reviseStart, revealed]);

  // Fin de session : le popup de score apparaît une seule fois (le drapeau
  // n'est réarmé que par startRevise), et seulement si on a vraiment répondu.
  useEffect(() => {
    if (reviseDone && judged > 0 && !memoPromptedRef.current) {
      memoPromptedRef.current = true;
      setMemoDraft(Math.round((current && current.memo) || 0));
      setMemoPrompt(true);
    }
  }, [reviseDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // « Réviser un autre » : la révision démarre dès que le poème tiré est
  // ouvert — sauf s'il n'a rien à réviser, auquel cas il s'ouvre normalement.
  useEffect(() => {
    if (!pendingReviseRef.current || view !== "poem") return;
    pendingReviseRef.current = false;
    if (revealables) startRevise("seq");
  }, [currentId, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Révision au hasard : la question s'arme dès que le poème tiré est ouvert —
  // contexte visible jusqu'au vers tiré, le reste masqué. Un poème sans vers
  // est écarté et on retire aussitôt. Le nonce quizQ est indispensable : quand
  // le hasard retombe sur le poème déjà ouvert, currentId ne change pas.
  useEffect(() => {
    if (!pendingQuizRef.current || view !== "poem") return;
    pendingQuizRef.current = false;
    if (!revealables) { quizDeadRef.current.add(currentId); quizNext(); return; }
    setScrolling(false);
    setReviseMode("quiz");
    setReviseStart(Math.floor(Math.random() * revealables));
    setRevealed(0);
    setJudged(0);
    memoLiveRef.current = null;
  }, [quizQ, currentId, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Au clavier : → « savais », ← « savais pas » ; Espace, Entrée ou ↓ ne
  // servent qu'à révéler le premier vers — ensuite chaque réponse révèle le
  // suivant d'elle-même.
  useEffect(() => {
    if (!reviseMode || view !== "poem") return;
    const h = (e) => {
      if (e.code === "ArrowRight") { e.preventDefault(); answer(true); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); answer(false); }
      else if ((e.code === "Space" || e.code === "Enter" || e.code === "ArrowDown") && revealed === 0) {
        e.preventDefault();
        revealNext();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [reviseMode, view, revealables, reviseStart, revealed, judged, currentId, quiz]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Auteurs du carnet, regroupés sans tenir compte de la casse ni des espaces
     et rendus dans l'orthographe la plus fréquente. Triés par nombre de
     poèmes décroissant : ceux dont on a le plus arrivent en tête de molette,
     là où le pouce tombe. */
  const authors = useMemo(() => {
    const byKey = new Map();
    for (const s of poems) {
      const name = String(s.author || "").trim();
      if (!name) continue; // « Auteur inconnu » n'est pas un auteur
      const key = authorKey(name);
      const hit = byKey.get(key);
      if (hit) {
        hit.count++;
        hit.spellings[name] = (hit.spellings[name] || 0) + 1;
      } else byKey.set(key, { key, count: 1, spellings: { [name]: 1 } });
    }
    return [...byKey.values()]
      .map((a) => ({
        key: a.key, count: a.count,
        name: Object.keys(a.spellings).reduce((best, n) => (a.spellings[n] > a.spellings[best] ? n : best)),
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "fr"));
  }, [poems]);
  /* Filtre actif : une liste manuelle, ou un auteur. Les deux vivent dans le
     même réglage persisté (listFilter), les auteurs préfixés — un id de liste
     ne contient jamais de deux-points. Tout est revalidé contre les données à
     chaque rendu : une liste supprimée, un auteur disparu du carnet retombent
     sur « Tous les poèmes » au lieu d'afficher le vide. */
  const activeList = listFilter && lists.defs.some((d) => d.id === listFilter) ? listFilter : "";
  const activeAuthor = useMemo(() => {
    if (!listFilter.startsWith(AUTHOR_PREFIX)) return "";
    const hit = authors.find((a) => a.key === authorKey(listFilter.slice(AUTHOR_PREFIX.length)));
    return hit ? hit.name : "";
  }, [listFilter, authors]);
  const activeFilter = activeAuthor ? AUTHOR_PREFIX + activeAuthor : activeList;
  const listOrder = (activeList && lists.order && lists.order[activeList]) || null;
  /* Un tri « list » hérité d'une autre liste se comporte comme un tri par
     titre (voir sortPoems) : la pastille allumée doit le dire. */
  const sortShown = sort === "list" && !listOrder ? "title" : sort;

  /* Classement, isolé pour que la liste affichée et la liste qu'on réorganise
     partent du même ordre — sinon entrer en réorganisation rebattrait les
     cartes sous les yeux de l'utilisateur. */
  const sortPoems = useCallback((list) => {
    // Ordre choisi à la main : il ne vaut que dans SA liste. Les poèmes
    // ajoutés depuis le dernier rangement ne sont pas dans le tableau — ils
    // se rangent à la fin, par titre, au lieu de disparaître.
    if (sort === "list" && listOrder) {
      const rank = new Map(listOrder.map((k, i) => [k, i]));
      const at = (x) => (rank.has(poemKey(x)) ? rank.get(poemKey(x)) : Number.MAX_SAFE_INTEGER);
      return [...list].sort((a, b) => (at(a) - at(b)) || a.title.localeCompare(b.title, "fr"));
    }
    // Tri par note, ascendant par défaut : les moins connus d'abord — l'ordre
    // de travail. Re-taper le tri actif inverse l'ordre (dir).
    const dir = sortDir === "desc" ? -1 : 1;
    if (sort === "memo") {
      return [...list].sort((a, b) =>
        dir * (((a.memo || 0) - (b.memo || 0)) || a.title.localeCompare(b.title, "fr")));
    }
    const key = sort === "author" ? (x) => (x.author || "").trim() : (x) => x.title;
    return [...list].sort((a, b) =>
      dir * (key(a).localeCompare(key(b), "fr") || a.title.localeCompare(b.title, "fr")));
  }, [sort, sortDir, listOrder]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q ? poems.filter((s) => (s.title + " " + s.author).toLowerCase().includes(q)) : poems;
    if (activeList) list = list.filter((s) => (lists.byKey[poemKey(s)] || []).includes(activeList));
    if (activeAuthor) {
      const key = authorKey(activeAuthor);
      list = list.filter((s) => authorKey(s.author || "") === key);
    }
    // Filtres cumulés : « Aimé » et « Court » donnent les courts qu'on aime.
    if (tagFilter.length) {
      list = list.filter((s) => {
        const ids = tags.byKey[poemKey(s)] || [];
        return tagFilter.every((id) => ids.includes(id));
      });
    }
    return sortPoems(list);
  }, [poems, query, tagFilter, tags, activeList, activeAuthor, lists, sortPoems]);

  /* Les poèmes de la liste affichée, sans la recherche ni les tags : c'est
     sur l'ensemble de la liste qu'on décide d'un ordre, jamais sur un
     sous-ensemble filtré — sinon l'ordre enregistré serait incomplet. */
  const listPoems = useMemo(() => {
    if (!activeList) return [];
    return sortPoems(poems.filter((x) => (lists.byKey[poemKey(x)] || []).includes(activeList)));
  }, [poems, lists, activeList, sortPoems]);

  /** Les ancres déjà au carnet — l'import s'en sert pour marquer d'un ✓ ce
   *  qu'il est inutile de reprendre. */
  const haveKeys = useMemo(() => new Set(poems.map((s) => poemKey(s))), [poems]);

  const openPoem = (id) => {
    setCurrentId(id); setView("poem"); setScrolling(false); setReviseMode(null);
    setRevealed(0); setJudged(0); setMemoPrompt(false);
    requestAnimationFrame(() => sheetRef.current && (sheetRef.current.scrollTop = 0));
  };
  // Taper un poème dans la liste : la file de lecture devient la liste telle
  // qu'elle s'affiche, dans son ordre — c'est elle que ⏭ suivra.
  const openFromList = (id) => { setQueue({ ids: filtered.map((s) => s.id), random: false }); openPoem(id); };
  const startNew = () => { setCurrentId(null); setDraft({ title: "", author: "", body: "" }); setView("edit"); };
  const startEdit = () => { setDraft({ title: current.title, author: current.author, body: current.body }); setView("edit"); };
  const save = () => {
    if (!draft.body.trim()) return;
    const title = draft.title.trim() || "Sans titre";
    if (current) {
      const renamed = { title, author: draft.author.trim() };
      moveTags(poemKey(current), poemKey(renamed));
      moveLists(poemKey(current), poemKey(renamed));
      setPoems(poems.map((s) => (s.id === current.id ? { ...s, ...renamed, body: draft.body } : s)));
    } else {
      const poem = { id: uid(), title, author: draft.author.trim(), body: draft.body };
      setPoems([...poems, poem]); setCurrentId(poem.id);
    }
    setView("poem");
  };
  const removePoem = (poem) => {
    if (!window.confirm(`Supprimer « ${poem.title} » ?`)) return false;
    setPoems((prev) => prev.filter((s) => s.id !== poem.id));
    if (currentId === poem.id) setCurrentId(null);
    return true;
  };
  const remove = () => { if (removePoem(current)) setView("lib"); };

  /* Deux intentions, deux tirages. « Lire » (à voix haute : une valeur sûre)
     double le poids d'un poème par étoile ; « Réviser » fait l'inverse, les
     non-notés en tête. Pondération douce : tout reste tirable, et un carnet
     sans note redevient un tirage uniforme. Le tirage respecte les filtres de
     la bibliothèque (recherche, tags, liste), poème courant exclu. */
  const drawPool = (base = filtered) => {
    const pool = base.filter((s) => s.id !== currentId);
    return pool.length ? pool : poems.filter((s) => s.id !== currentId);
  };
  const weightedDraw = (pool, weightOf) => {
    if (!pool.length) return null;
    let total = 0;
    const acc = pool.map((s) => (total += weightOf(s)));
    const r = Math.random() * total;
    return pool[acc.findIndex((a) => r < a)] || pool[pool.length - 1];
  };
  /* « Lire » ouvre d'abord un popup de vivier — tags exigés et, au choix,
     seulement les poèmes au-dessus d'un seuil d'étoiles — puis tire pondéré.
     Choix gardés en état simple (non persistés) : ni poesie:v1 ni la
     signature de sauvegarde ne bougent. */
  const playPool = useMemo(() => {
    let pool = filtered;
    if (playTags.length) pool = pool.filter((s) => {
      const ids = tags.byKey[poemKey(s)] || [];
      return playTags.every((t) => ids.includes(t));
    });
    if (playScope === "known") pool = pool.filter((s) => (s.memo || 0) >= playMin);
    return pool;
  }, [filtered, playTags, playScope, playMin, tags]);
  const askPlay = () => { if (filtered.length) setPlayAsk(true); };
  const startPlay = () => {
    setPlayAsk(false);
    setQueue({ ids: playPool.map((s) => s.id), random: playRandom });
    // Au hasard : le premier tirage évite le poème déjà ouvert. Dans l'ordre :
    // on entre par le haut du vivier.
    const pick = playRandom
      ? (weightedDraw(playPool.filter((s) => s.id !== currentId), (s) => 2 ** (s.memo || 0)) || playPool[0])
      : playPool[0];
    if (pick) openPoem(pick.id);
  };
  /* La file, débarrassée des poèmes supprimés entre-temps. Vide (poème ouvert
     par un import, un partage…) : on retombe sur la liste affichée, pour que
     ⏭ ait toujours un sens. */
  const queueIds = useMemo(() => {
    const base = queue.ids.length ? queue.ids : filtered.map((s) => s.id);
    return base.filter((id) => poems.some((s) => s.id === id));
  }, [queue, filtered, poems]);
  const hasNext = queueIds.some((id) => id !== currentId);
  const openNext = () => {
    if (!hasNext) return;
    if (queue.random) {
      const pick = weightedDraw(poems.filter((s) => s.id !== currentId && queueIds.includes(s.id)),
        (s) => 2 ** (s.memo || 0));
      if (pick) openPoem(pick.id);
      return;
    }
    const i = queueIds.indexOf(currentId);
    const id = queueIds[(i + 1) % queueIds.length];
    if (id && id !== currentId) openPoem(id);
  };
  // Sortie du poème : le ‹ de la barre du haut et le glissé vers la droite
  // mènent au même endroit — en révision au hasard, la session s'arrête et le
  // score s'affiche.
  const leavePoem = () => { setScrolling(false); if (quiz) stopQuiz(); else setView("lib"); };
  const openReviseRandom = () => {
    const pick = weightedDraw(drawPool(), (s) => 2 ** (5 - (s.memo || 0)));
    if (!pick) return;
    pendingReviseRef.current = true;
    setQueue({ ids: filtered.map((s) => s.id), random: false });
    openPoem(pick.id);
  };
  /* Révision au hasard : un vers au hasard d'un poème au hasard de la
     sous-liste affichée. Tirage UNIFORME — esprit jeu, contrairement aux deux
     tirages pondérés ci-dessus — en évitant de retomber sur le poème en cours
     tant que le vivier le permet. Le vivier est choisi au lancement : tout
     l'affichage, ou seulement les poèmes sous un seuil d'étoiles. Un poème
     non noté compte pour 0, donc toujours parmi les moins connus. */
  const quizPool = quizScope === "weak" ? filtered.filter((s) => (s.memo || 0) <= quizMax) : filtered;
  const quizNext = () => {
    const dead = quizDeadRef.current;
    const keep = quizPoolRef.current;
    // Vivier figé au départ : répondre juste fait monter le score, mais le
    // poème ne doit pas quitter la session en cours de route pour autant.
    const base = keep ? filtered.filter((s) => keep.has(s.id)) : filtered;
    let pool = base.filter((s) => s.id !== currentId && !dead.has(s.id));
    if (!pool.length) pool = base.filter((s) => !dead.has(s.id)); // un seul poème : la répétition est permise
    if (!pool.length) { stopQuiz(); return; }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    pendingQuizRef.current = true;
    setQuizQ((q) => q + 1);
    openPoem(pick.id);
  };
  const askQuiz = () => { if (filtered.length) setQuizAsk(true); };
  const startQuiz = () => {
    if (!quizPool.length) return;
    quizPoolRef.current = quizScope === "weak" ? new Set(quizPool.map((s) => s.id)) : null;
    quizDeadRef.current = new Set();
    quizStatsRef.current = new Map();
    setQuizAsk(false);
    setQuizEnd(null);
    setQuiz({ asked: 0, correct: 0 });
    quizNext();
  };
  const stopQuiz = () => {
    const game = quiz;
    setQuiz(null);
    setReviseMode(null);
    pendingQuizRef.current = false;
    setQuizDetail(false);
    if (game && game.asked > 0) setQuizEnd({ ...game, rows: [...quizStatsRef.current.values()] });
    else setView("lib");
  };
  const resetAll = async () => {
    if (!window.confirm("Tout effacer sur cet appareil ? Les poèmes et les réglages stockés localement seront supprimés, puis l'application rechargera sa dernière version. Copiez d'abord l'URL de partage si vous voulez pouvoir revenir en arrière.")) return;
    syncHashRef.current = false;
    setReady(false); // gèle la sauvegarde automatique pendant l'effacement
    await clearLibrary();
    reloadFresh(false);
  };

  const tagsOf = (poem) => {
    const ids = tags.byKey[poemKey(poem)] || [];
    return tags.defs.filter((d) => ids.includes(d.id));
  };
  const hasTag = (poem, id) => (tags.byKey[poemKey(poem)] || []).includes(id);
  const toggleTag = (poem, id) => setTags((t) => {
    const k = poemKey(poem);
    const cur = t.byKey[k] || [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    const byKey = { ...t.byKey };
    if (next.length) byKey[k] = next; else delete byKey[k];
    return { ...t, byKey };
  });
  /** Renommer un poème déplace son ancre : les tags suivent. */
  const moveTags = (from, to) => setTags((t) => {
    if (from === to || !t.byKey[from]) return t;
    const byKey = { ...t.byKey };
    byKey[to] = [...new Set([...(byKey[to] || []), ...byKey[from]])];
    delete byKey[from];
    return { ...t, byKey };
  });
  const inList = (poem, id) => (lists.byKey[poemKey(poem)] || []).includes(id);
  const toggleList = (poem, id) => setLists((l) => {
    const k = poemKey(poem);
    const cur = l.byKey[k] || [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    const byKey = { ...l.byKey };
    if (next.length) byKey[k] = next; else delete byKey[k];
    return { ...l, byKey };
  });
  const moveLists = (from, to) => setLists((l) => {
    if (from === to || !l.byKey[from]) return l;
    const byKey = { ...l.byKey };
    byKey[to] = [...new Set([...(byKey[to] || []), ...byKey[from]])];
    delete byKey[from];
    // Le poème renommé garde SA PLACE dans les ordres : le reléguer en fin
    // d'anthologie parce qu'on a corrigé une faute de frappe serait absurde.
    const order = {};
    for (const [id, keys] of Object.entries(l.order || {})) {
      order[id] = keys.includes(from) ? [...new Set(keys.map((k) => (k === from ? to : k)))] : keys;
    }
    return { ...l, byKey, order };
  });
  const createList = () => {
    const name = (window.prompt("Nom de la nouvelle liste :") || "").trim().slice(0, 40);
    if (!name) return;
    const id = "l" + uid();
    setLists((l) => ({ ...l, defs: [...l.defs, { id, name }] }));
    setListFilter(id);
  };
  const renameList = (id, name) => setLists((l) => ({
    ...l, defs: l.defs.map((d) => (d.id === id ? { ...d, name } : d)),
  }));
  const removeList = (id) => {
    const def = lists.defs.find((d) => d.id === id);
    if (def && !window.confirm(`Supprimer la liste « ${def.name} » ? Les poèmes eux-mêmes ne bougent pas.`)) return;
    if (listFilter === id) setListFilter("");
    setLists((l) => {
      const byKey = {};
      for (const [k, arr] of Object.entries(l.byKey)) {
        const keep = arr.filter((x) => x !== id);
        if (keep.length) byKey[k] = keep;
      }
      const order = { ...(l.order || {}) };
      delete order[id];
      return { defs: l.defs.filter((d) => d.id !== id), byKey, order };
    });
  };
  const setTagField = (id, field, value) => setTags((t) => ({
    ...t, defs: t.defs.map((d) => (d.id === id ? { ...d, [field]: value } : d)),
  }));
  const addTag = () => setTags((t) => ({
    ...t,
    defs: [...t.defs, { id: "t" + uid(), label: "Nouveau tag", icon: "●", color: TAG_COLORS[t.defs.length % TAG_COLORS.length] }],
  }));
  const removeTag = (id) => {
    const def = tags.defs.find((d) => d.id === id);
    if (def && !window.confirm(`Supprimer le tag « ${def.label} » ? Il sera retiré de tous les poèmes.`)) return;
    setTagFilter((f) => f.filter((x) => x !== id));
    setTags((t) => {
      const byKey = {};
      for (const [k, list] of Object.entries(t.byKey)) {
        const keep = list.filter((x) => x !== id);
        if (keep.length) byKey[k] = keep;
      }
      return { defs: t.defs.filter((d) => d.id !== id), byKey };
    });
  };
  const restoreDefaultTags = () => setTags((t) => mergeTags(t, { defs: DEFAULT_TAGS.map((d) => ({ ...d })), byKey: {} }));
  const missingDefaults = DEFAULT_TAGS.some((d) => !tags.defs.some((x) => x.id === d.id));

  const importLibrary = (list, settings, addedTags, addedLists) => {
    if (addedTags) setTags((t) => mergeTags(t, addedTags));
    if (addedLists) setLists((l) => mergeLists(l, addedLists));
    setPoems((prev) => mergeByTitle(prev, list));
    if (settings) {
      if (settings.size) setSize(settings.size);
      if (settings.speed) setSpeed(settings.speed);
      if (["title", "author", "memo"].includes(settings.sort)) setSort(settings.sort);
    }
  };
  /** Les poèmes rapportés de Wikisource. Même contrat que l'import de
   *  fichier : mergeByTitle, et un mot dans le bandeau de la bibliothèque. */
  const addFromWiki = (list) => {
    if (!list.length) return;
    setPoems((prev) => mergeByTitle(prev, list));
    setStatus(list.length === 1
      ? `« ${list[0].title} » ajouté au carnet.`
      : `${list.length} poèmes ajoutés au carnet.`);
  };
  const library = useMemo(() => ({ poems, size, speed, sort }), [poems, size, speed, sort]);
  // Réglage manuel : il reprend la main sur le scoring automatique, dont le
  // drapeau saute — plus d'avertissement tant qu'une révision ne l'a pas reposé.
  const setMemo = (n) => setPoems(poems.map((s) => {
    if (s.id !== current.id) return s;
    if (!n) { const { memo, memoAuto, ...rest } = s; return rest; }
    const { memoAuto, ...rest } = s;
    return { ...rest, memo: n };
  }));

  const online = !offline || offline.online !== false;
  const cached = offline && offline.shell;
  const offlineHint = !offline || !offline.supported
    ? "Indisponible ici : garder l'application en cache demande un service worker, donc une page servie en HTTPS — c'est le cas sur GitHub Pages, pas dans un aperçu d'artefact."
    : !offline.shell
      ? "Mise en cache de l'application en cours…"
      : "Prêt pour l'avion ✓ — l'application démarre et les poèmes se lisent sans réseau. Seul l'import depuis Wikisource demande une connexion.";
  const checkUpdate = async () => {
    if (!window.offline || !window.offline.check) { reloadFresh(true); return; }
    setUpCheck("busy");
    const found = await window.offline.check();
    setUpCheck(found ? "found" : "none");
  };
  const appVersion = useMemo(() => {
    const s = document.querySelector('script[src*="app.js"]');
    const m = s && /[?&]v=([0-9a-f]+)/.exec(s.getAttribute("src") || "");
    return m ? m[1] : "dev";
  }, []);

  /* ---------------------------------------------------------------- */
  /* Réorganisation d'une liste manuelle. Pointer Events plutôt que    */
  /* touch : un seul chemin de code pour le doigt et la souris, et     */
  /* setPointerCapture garde le geste même quand le doigt sort de la   */
  /* poignée. La carte au doigt n'est pas déplacée par une transformée */
  /* — c'est la LISTE qui se réordonne en direct sous elle.            */
  /* ---------------------------------------------------------------- */
  const startReorder = () => {
    if (!activeList) return;
    setDragRows(listPoems.map((x) => x.id));
    setReorder(true);
  };
  const endReorder = () => { setReorder(false); setDragRows(null); setDragId(null); };
  useEffect(() => { if (reorder && !activeList) endReorder(); }, [reorder, activeList]);

  /* Enregistré à chaque lâcher, pas sur un bouton « Valider » : un ordre à
     moitié rangé vaut mieux que rien. Le tri passe sur « Liste » du même
     coup — sans quoi le rangement n'aurait aucun effet visible. */
  const commitOrder = (ids) => {
    if (!activeList) return;
    const byId = new Map(poems.map((x) => [x.id, x]));
    const keys = ids.map((id) => byId.get(id)).filter(Boolean).map((x) => poemKey(x));
    setLists((l) => ({ ...l, order: { ...(l.order || {}), [activeList]: keys } }));
    setSort("list");
  };

  const stopDragScroll = () => { if (autoRef.current) { cancelAnimationFrame(autoRef.current); autoRef.current = 0; } };
  /* Le doigt qui s'immobilise près d'un bord doit continuer à faire défiler :
     sans boucle propre, plus aucun pointermove n'arrive et la liste se fige. */
  const dragScroll = () => {
    autoRef.current = 0;
    const box = libScrollRef.current, d = dragRef.current;
    if (!box || !d) return;
    const r = box.getBoundingClientRect();
    const EDGE = 72;
    const up = d.y - r.top, down = r.bottom - d.y;
    let step = 0;
    if (up < EDGE) step = -Math.ceil((EDGE - up) / 6);
    else if (down < EDGE) step = Math.ceil((EDGE - down) / 6);
    if (step) box.scrollTop += step;
    autoRef.current = requestAnimationFrame(dragScroll);
  };
  const onGripDown = (e, id) => {
    if (!dragRows) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* souris sans capture */ }
    dragRef.current = { pointerId: e.pointerId, y: e.clientY };
    setDragId(id);
    stopDragScroll();
    autoRef.current = requestAnimationFrame(dragScroll);
  };
  const onGripMove = (e) => {
    const d = dragRef.current;
    if (!d || !dragId || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    d.y = e.clientY;
    const box = libScrollRef.current;
    if (!box) return;
    const cards = [...box.querySelectorAll(".card")];
    // La carte survolée, par sa boîte : dans l'espace entre deux cartes on ne
    // bouge rien plutôt que d'inventer une cible.
    const over = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return d.y >= r.top && d.y <= r.bottom;
    });
    if (over < 0) return;
    const from = dragRows.indexOf(dragId);
    if (from < 0 || over === from) return;
    const next = [...dragRows];
    next.splice(over, 0, next.splice(from, 1)[0]);
    setDragRows(next);
  };
  const onGripUp = (e) => {
    const d = dragRef.current;
    if (!d || (e && e.pointerId !== d.pointerId)) return;
    dragRef.current = null;
    stopDragScroll();
    setDragId(null);
    if (dragRows) commitOrder(dragRows);
  };
  useEffect(() => stopDragScroll, []);

  // Palette flottante : effacée pendant le scroll de la liste, revenue
  // ~250 ms après le dernier mouvement.
  const onLibScroll = () => {
    setLibScrolled(true);
    clearTimeout(libScrollTimer.current);
    libScrollTimer.current = setTimeout(() => setLibScrolled(false), 250);
  };

  /* Barre de titre : en vue bibliothèque elle vit dans la zone scrollée (elle
     défile avec les poèmes, seul l'en-tête recherche/filtres/tri reste figé) ;
     dans les autres vues elle reste fixée en haut. */
  const topbar = (
      <div className="top">
        {view === "lib" ? (
          <>
            <div className="brand">Carnet de <span>poésie</span></div>
            {offline && !offline.online && <span className="tag">hors ligne</span>}
            <div className="spacer" />
            <button className="iconbtn" title="Chercher des poèmes sur Wikisource" onClick={() => setView("import")}>⤓</button>
            <button className="iconbtn" title="Saisir un poème" onClick={startNew}>＋</button>
            <button className={"iconbtn" + (dirty ? " nudge" : "")} onClick={() => setView("transfer")}
              title={dirty ? "Sauvegarde et partage — carnet modifié depuis la dernière sauvegarde" : "Sauvegarde et partage"}>⇅</button>
            <button className="iconbtn" title="Réglages" onClick={() => setView("settings")}>⚙</button>
          </>
        ) : view === "poem" ? (
          <>
            <button className="iconbtn glyph back" title="Retour" onClick={leavePoem}>‹</button>
            <div className="spacer" />
            <button className={"iconbtn" + (scrolling ? " on" : "")} aria-pressed={scrolling}
              title={scrolling ? "Arrêter le défilement" : "Défilement automatique — pour dire le poème sans les mains"}
              onClick={() => setScrolling(!scrolling)}>{scrolling ? "⏸" : "▶"}</button>
            {poems.length > 1 && (
              <button className="iconbtn glyph next" onClick={openNext} disabled={!hasNext}
                title={queue.random
                  ? "Poème suivant — tiré au hasard dans le vivier, les mieux sus sortent plus souvent"
                  : "Poème suivant — dans l'ordre de la liste"}>⏭</button>
            )}
            <button className={"iconbtn" + (reviseMode ? " on" : "")} aria-pressed={!!reviseMode} disabled={!revealables}
              title={quiz ? "Arrêter la révision — score de la session" : reviseMode ? "Quitter la révision" : "Réviser — le poème caché, révélé vers à vers"}
              onClick={() => (quiz ? stopQuiz() : reviseMode ? setReviseMode(null) : startRevise("seq"))}>🎓</button>
          </>
        ) : (
          <>
            <button className="iconbtn glyph back" title="Retour" onClick={() => { setScrolling(false); setView("lib"); }}>‹</button>
            <div className="brand" style={{ fontSize: 15, color: "var(--muted)" }}>
              {view === "edit" ? (current ? "Modifier" : "Nouveau poème")
                : view === "import" ? "Wikisource"
                  : view === "transfer" ? "Transfert" : "Réglages"}
            </div>
            <div className="spacer" />
          </>
        )}
      </div>
  );

  return (
    <div className={"cb" + (theme === "light" ? " light" : "")}>
      <style>{CSS}</style>

      {view !== "lib" && topbar}

      {view === "lib" && (
        <>
          <div className="libscroll" ref={libScrollRef} onScroll={onLibScroll}>
          {topbar}
          {/* En-tête figé : recherche, liste + tags sur une ligne, tri et
              compteur sur la suivante. Les actions vivent dans la palette
              flottante en bas. */}
          <div className="libhead">
            <div className="searchwrap">
              <input ref={searchRef} className="search" value={query} placeholder="Chercher un titre, un auteur…"
                onChange={(e) => setQuery(e.target.value)} />
              {query && (
                <button className="searchx" title="Vider la recherche" aria-label="Vider la recherche"
                  onClick={() => { setQuery(""); searchRef.current?.focus(); }}>✕</button>
              )}
            </div>
            {poems.length > 0 && (
                <div className={"filterrow" + (activeList && !reorder ? " withreorder" : "")}>
                  {/* Deux zones, en <optgroup> : les listes qu'on constitue à
                      la main, puis les auteurs du carnet — des recherches
                      enregistrées, tirées des données. « Nouvelle liste » vit
                      DANS le groupe des listes : après quarante auteurs, elle
                      serait introuvable. */}
                  <select className="listsel" value={activeFilter} aria-label="Liste affichée"
                    onChange={(e) => {
                      if (e.target.value === "__new__") createList();
                      else setListFilter(e.target.value);
                    }}>
                    <option value="">Tous les poèmes</option>
                    <optgroup label="Listes">
                      {lists.defs.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({poems.filter((s) => inList(s, d.id)).length})
                        </option>
                      ))}
                      <option value="__new__">＋ Nouvelle liste…</option>
                    </optgroup>
                    {authors.length > 0 && (
                      <optgroup label="Auteurs">
                        {authors.map((a) => (
                          <option key={a.key} value={AUTHOR_PREFIX + a.name}>{a.name} ({a.count})</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  {/* Réorganiser : seulement quand une liste manuelle est
                      affichée — un auteur est un fait, il ne se range pas. */}
                  {activeList && !reorder && (
                    <button className="listsel reorderbtn" title="Réorganiser cette liste à la main"
                      onClick={startReorder}>⇅</button>
                  )}
                  {tags.defs.length > 0 && (
                    <div className="tagdd">
                      <button className={"listsel tagddbtn" + (tagFilter.length ? " on" : "")}
                        aria-haspopup="listbox" aria-expanded={tagMenu}
                        title={tagFilter.length ? "Tags filtrés — seuls les poèmes portant tous ces tags s'affichent" : "Filtrer par tags"}
                        onClick={() => setTagMenu((v) => !v)}>
                        <span>{tagFilter.length
                          ? tags.defs.filter((t) => tagFilter.includes(t.id)).map((t) => t.icon).join(" ")
                          : "Tags"}</span>
                        <i className="ddarrow">▾</i>
                      </button>
                      {tagMenu && (
                        <>
                          <div className="ddback" onClick={() => setTagMenu(false)} />
                          <div className="ddpanel" role="listbox" aria-multiselectable="true" aria-label="Filtrer par tags">
                            {tags.defs.map((t) => {
                              const on = tagFilter.includes(t.id);
                              const count = poems.filter((s) => hasTag(s, t.id)).length;
                              return (
                                <button key={t.id} role="option" aria-selected={on}
                                  className={"ddopt" + (on ? " on" : "")}
                                  style={on ? { color: tagInk(t.color, theme === "light") } : undefined}
                                  onClick={() => setTagFilter((f) => (on ? f.filter((x) => x !== t.id) : [...f, t.id]))}>
                                  <span>{t.icon}</span><span>{t.label}</span>
                                  <b>{count}</b>
                                  <span className="ddcheck">{on ? "✓" : ""}</span>
                                </button>
                              );
                            })}
                            {tagFilter.length > 0 && (
                              <button className="ddopt ddclear" onClick={() => setTagFilter([])}>Tout voir</button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
            )}
            {poems.length > 0 && (
              <div className="sortrow">
                {poems.length > 1 && (
                  <div className={"seg2" + (listOrder ? " tight" : "")}>
                    {[...(listOrder ? [["list", "Liste"]] : []), ["title", "Titre"], ["author", "Auteur"], ["memo", "Note"]].map(([k, lab]) => (
                      <button key={k} className={sortShown === k ? "on" : ""} aria-pressed={sortShown === k}
                        title={k === "list"
                          ? "L'ordre choisi à la main pour cette liste"
                          : sortShown === k
                            ? (sortDir === "asc" ? "Inverser : ordre descendant" : "Inverser : ordre ascendant")
                            : k === "memo" ? "Trier par note d'apprentissage — les moins sus d'abord" : undefined}
                        onClick={() => {
                          // L'ordre à la main n'a pas de sens inversé.
                          if (k === "list") { setSort("list"); return; }
                          if (sortShown === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
                          else { setSort(k); setSortDir("asc"); }
                        }}>
                        {lab}{sortShown === k && k !== "list" && <i className="sortdir">{sortDir === "asc" ? "↑" : "↓"}</i>}
                      </button>
                    ))}
                  </div>
                )}
                <p className="count">{filtered.length} / {poems.length} poème{poems.length > 1 ? "s" : ""}</p>
              </div>
            )}
          </div>
          <div className="lib">
            {status && (
              <div className="notice">
                <button className="noticeclose" title="Fermer" aria-label="Fermer le message"
                  onClick={() => setStatus("")}>✕</button>
                {status}
              </div>
            )}
            {!ready && <p className="hint">Chargement…</p>}
            {ready && poems.length === 0 && (
              <div className="empty">
                <h2>Carnet vide</h2>
                <p>Wikisource met à disposition des milliers de poèmes<br />du domaine public — Hugo, Baudelaire, Rimbaud, Louise Labé…</p>
                <div className="actions" style={{ justifyContent: "center" }}>
                  <button className="btn primary" onClick={() => setView("import")}>Chercher un poème</button>
                  <button className="btn" onClick={startNew}>Saisir</button>
                </div>
                <p className="hint" style={{ marginTop: 14 }}>
                  Un carnet existe déjà ailleurs ? La page Transfert (⇅) le rapatrie depuis une URL
                  de partage, un code compressé ou une sauvegarde. Une app installée sur l'écran
                  d'accueil a son propre stockage : le carnet du navigateur n'y est pas repris.
                </p>
              </div>
            )}
            {ready && poems.length > 0 && filtered.length === 0 && (
              <div className="empty">
                {query.trim()
                  ? <p>Rien ne correspond à « {query} ».</p>
                  : <p>Rien dans cette sélection — la liste ou les tags actifs ne retiennent aucun poème.</p>}
              </div>
            )}
            {reorder && (
              <div className="reorderbar">
                <span>Glissez les poignées <i>⠿</i> pour ranger la liste
                  entière — recherche et tags mis de côté.</span>
                <button className="btn slim primary" onClick={endReorder}>Terminé</button>
              </div>
            )}
            {(reorder && dragRows
              ? dragRows.map((id) => poems.find((x) => x.id === id)).filter(Boolean)
              : filtered).map((s) => {
              const marks = tagsOf(s);
              return (
              <div className={"card" + (reorder ? " reordering" : "") + (dragId === s.id ? " dragging" : "")} key={s.id}>
                {reorder && (
                  /* Poignée : touch-action none, sinon le glissé part en
                     défilement de page avant d'arriver jusqu'ici. */
                  <button className="cardgrip" aria-label={`Déplacer ${s.title}`}
                    onPointerDown={(e) => onGripDown(e, s.id)}
                    onPointerMove={onGripMove}
                    onPointerUp={onGripUp}
                    onPointerCancel={onGripUp}><i>⠿</i></button>
                )}
                <button className="cardmain" disabled={reorder} onClick={() => openFromList(s.id)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3>{s.title}</h3>
                    <p>{s.author || "Auteur inconnu"}</p>
                  </div>
                  {(s.memo || 0) > 0 && (
                    <span className="cardmemo" title={`Su à ${fmtMemo(s.memo)} sur 5`}>★ {fmtMemo(s.memo)}</span>
                  )}
                  {marks.length > 0 && (
                    <span className="tagrow">
                      {marks.map((t) => (
                        <span key={t.id} className="tagdot" title={t.label}
                          style={{ borderColor: t.color + "66", background: t.color + "1f" }}>{t.icon}</span>
                      ))}
                    </span>
                  )}
                </button>
              </div>
              );
            })}
          </div>
          </div>
          {poems.length > 1 && !reorder && (
            <div className={"floatbar" + (libScrolled ? " hide" : "")}>
              <button className="btn" onClick={askPlay}
                title="Enchaîner les poèmes — au hasard en privilégiant les mieux sus, ou le vivier dans l'ordre"><i>❦</i>Lire</button>
              <button className="btn" onClick={askQuiz}
                title="Un vers au hasard d'un poème au hasard — l'aviez-vous en tête ? Les scores se mettent à jour en révisant"><i>🎓</i>Réviser</button>
            </div>
          )}
          {playAsk && (
            <div className="modal" role="dialog" aria-modal="true" aria-label="Lire un poème"
              onClick={(e) => { if (e.target === e.currentTarget) setPlayAsk(false); }}>
              <div className="modalbox">
                <div className="modalicon">❦</div>
                <h2>Lire</h2>
                <p>{playRandom
                  ? "Un poème au hasard — les mieux sus sortent plus souvent."
                  : "Le vivier entier, l'un après l'autre, dans l'ordre de la liste."}</p>
                {tags.defs.length > 0 && (
                  <div className="tagpick center">
                    {tags.defs.map((t) => {
                      const on = playTags.includes(t.id);
                      return (
                        <button key={t.id} className={"tagchip" + (on ? " on" : "")} aria-pressed={on}
                          style={on ? { color: tagInk(t.color, theme === "light"), borderColor: tagInk(t.color, theme === "light"), background: t.color + "22" } : undefined}
                          onClick={() => setPlayTags((f) => (on ? f.filter((x) => x !== t.id) : [...f, t.id]))}>
                          <span>{t.icon}</span><span>{t.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="seg2 wide">
                  <button className={playScope === "all" ? "on" : ""} aria-pressed={playScope === "all"}
                    title="Tirage parmi tous les poèmes affichés, pondéré par la note"
                    onClick={() => setPlayScope("all")}>Tous</button>
                  <button className={playScope === "known" ? "on" : ""} aria-pressed={playScope === "known"}
                    title="Ne tirer que les poèmes dont la note atteint le seuil"
                    onClick={() => setPlayScope("known")}>Les mieux sus</button>
                </div>
                {playScope === "known" && (
                  <>
                    <p>Note au moins égale à <b style={{ color: "var(--acc)" }}>★ {playMin}</b></p>
                    <Stars value={playMin} onChange={(n) => setPlayMin(n || 1)} />
                  </>
                )}
                {/* Hasard ou ordre : le réglage vaut pour le premier départ et
                    pour tous les ⏭ qui suivront — la file s'en souvient. */}
                <div className="seg2 wide">
                  <button className={playRandom ? "on" : ""} aria-pressed={playRandom}
                    title="Tirage pondéré par la note, à chaque poème suivant"
                    onClick={() => setPlayRandom(true)}>Au hasard</button>
                  <button className={!playRandom ? "on" : ""} aria-pressed={!playRandom}
                    title="Le vivier entier, l'un après l'autre, dans l'ordre de la liste"
                    onClick={() => setPlayRandom(false)}>Dans l'ordre</button>
                </div>
                <p className="modalcount">
                  {playPool.length === 0
                    ? "Aucun poème dans ce vivier"
                    : `${playPool.length} poème${playPool.length > 1 ? "s" : ""} ${playRandom ? "dans le tirage" : "dans la file"}`}
                  {playPool.length > 0 && playPool.length < filtered.length && ` sur ${filtered.length}`}
                </p>
                <div className="actions" style={{ justifyContent: "center" }}>
                  <button className="btn ghost" onClick={() => setPlayAsk(false)}>Annuler</button>
                  <button className="btn primary" disabled={!playPool.length} onClick={startPlay}>Lire</button>
                </div>
              </div>
            </div>
          )}
          {quizAsk && (
            <div className="modal" role="dialog" aria-modal="true" aria-label="Lancer une révision"
              onClick={(e) => { if (e.target === e.currentTarget) setQuizAsk(false); }}>
              <div className="modalbox">
                <div className="modalicon">🎓</div>
                <h2>Réviser</h2>
                <p>Un vers au hasard d'un poème au hasard — l'aviez-vous en tête ?</p>
                <div className="seg2 wide">
                  <button className={quizScope === "all" ? "on" : ""} aria-pressed={quizScope === "all"}
                    title="Tirage au hasard, à égalité, parmi tous les poèmes affichés"
                    onClick={() => setQuizScope("all")}>Tous</button>
                  <button className={quizScope === "weak" ? "on" : ""} aria-pressed={quizScope === "weak"}
                    title="Ne tirer que les poèmes dont la note ne dépasse pas le seuil"
                    onClick={() => setQuizScope("weak")}>Les moins sus</button>
                </div>
                {quizScope === "weak" && (
                  <>
                    <p>Note au plus égale à <b style={{ color: "var(--acc)" }}>★ {quizMax}</b></p>
                    <Stars value={quizMax} onChange={(n) => setQuizMax(n || 1)} />
                  </>
                )}
                <p className="modalcount">
                  {quizPool.length === 0
                    ? "Aucun poème dans ce vivier"
                    : `${quizPool.length} poème${quizPool.length > 1 ? "s" : ""} dans le tirage`}
                  {quizPool.length > 0 && quizPool.length < filtered.length && ` sur ${filtered.length}`}
                </p>
                <div className="actions" style={{ justifyContent: "center" }}>
                  <button className="btn ghost" onClick={() => setQuizAsk(false)}>Annuler</button>
                  <button className="btn primary" disabled={!quizPool.length} onClick={startQuiz}>Commencer</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {view === "poem" && current && (
        <>
          <div className="head">
            <button className={"foldbtn" + (barOpen ? "" : " folded")} aria-expanded={barOpen}
              title={barOpen ? "Replier les réglages du poème" : "Déplier les réglages du poème"}
              onClick={() => setBarOpen(!barOpen)}><i>▲</i></button>
            <h1 className="title">{current.title}</h1>
            {/* Nom d'auteur tapable : il bascule la liste sur cet auteur et
                revient à la bibliothèque — l'idiome iOS. La recherche en cours
                est effacée au passage, sinon les deux filtres se cumuleraient
                et pourraient ne rien laisser. */}
            {current.author ? (
              <button className="author authorlink"
                title={`Voir tout ce que le carnet a de ${current.author}`}
                onClick={() => {
                  setQuery("");
                  setListFilter(AUTHOR_PREFIX + current.author);
                  leavePoem();
                }}>{current.author}</button>
            ) : (
              <p className="author">Auteur inconnu</p>
            )}
            <div className={"barwrap" + (barOpen ? "" : " folded")}>
            <div className="menu">
              {tags.defs.length > 0 && (
                <div className="tagpick">
                  {tags.defs.map((t) => {
                    const on = hasTag(current, t.id);
                    return (
                      <button key={t.id} className={"tagchip" + (on ? " on" : "")} aria-pressed={on}
                        style={on ? { color: tagInk(t.color, theme === "light"), borderColor: tagInk(t.color, theme === "light"), background: t.color + "22" } : undefined}
                        onClick={() => toggleTag(current, t.id)}>
                        <span>{t.icon}</span><span>{t.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {lists.defs.length > 0 && (
                <div className="tagpick">
                  {lists.defs.map((d) => {
                    const on = inList(current, d.id);
                    return (
                      <button key={d.id} className={"tagchip" + (on ? " on" : "")} aria-pressed={on}
                        title={on ? `Retirer de la liste ${d.name}` : `Ajouter à la liste ${d.name}`}
                        onClick={() => toggleList(current, d.id)}>
                        <span>≡</span><span>{d.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="mrow">
                <span className="mlab">Su par cœur</span>
                <div className="memocell">
                  {(current.memo || 0) > 0 && <span className="memoval">{fmtMemo(current.memo)}</span>}
                  <Stars value={current.memo || 0} onChange={(n) => {
                    if (current.memoAuto && !window.confirm(`Attention : vous allez écraser le score calculé automatiquement (★ ${fmtMemo(current.memo)}).`)) return;
                    setMemo(n);
                  }} />
                </div>
              </div>
              <div className="mact">
                <button className="btn slim" onClick={startEdit}>✎ Modifier</button>
                <button className="btn slim danger" onClick={remove}>Supprimer</button>
              </div>
            </div>
            </div>
          </div>
          <div
            className="sheet"
            ref={sheetRef}
            onPointerDown={() => { draggingRef.current = true; clearTimeout(resumeRef.current); }}
            onPointerUp={() => { clearTimeout(resumeRef.current); resumeRef.current = setTimeout(() => { draggingRef.current = false; }, 700); }}
            // Safari envoie pointercancel dès qu'il prend la main sur le
            // scroll — doigt encore posé. Reprise immédiate = la boucle se bat
            // avec le doigt ; on diffère, et onScroll repousse la reprise tant
            // que la feuille bouge (doigt ou inertie).
            onPointerCancel={() => { clearTimeout(resumeRef.current); resumeRef.current = setTimeout(() => { draggingRef.current = false; }, 700); }}
            onTouchStart={() => { draggingRef.current = true; clearTimeout(resumeRef.current); }}
            onTouchEnd={() => { clearTimeout(resumeRef.current); resumeRef.current = setTimeout(() => { draggingRef.current = false; }, 700); }}
            onScroll={() => {
              if (draggingRef.current) {
                clearTimeout(resumeRef.current);
                resumeRef.current = setTimeout(() => { draggingRef.current = false; }, 700);
              }
            }}
          >
            {sizeFly && (
              <div className="sizefly" aria-live="polite"><span>Taille <b>{size}</b></span></div>
            )}
            <Sheet blocks={blocks} size={size} source={current.source}
              maskFrom={reviseMode ? visibleLines : null} maskUnits={reviseUnits.byBlock} />
          </div>
          {scrolling && !reviseMode && (
            <div className="speedfly">
              <div className="stepper">
                <button onClick={() => setSpeed(Math.max(1, speed - 1))} title="Plus lent">«</button>
                <span>Vitesse <b>{speed}</b></span>
                <button onClick={() => setSpeed(Math.min(12, speed + 1))} title="Plus rapide">»</button>
              </div>
            </div>
          )}
          {reviseMode === "quiz" && quiz && (
            <div className="revbar">
              <div className="inner">
                <div className="revprog">
                  <span>Révision</span>
                  <div className="revtrack"><div className="revfill" style={{ width: quiz.asked ? `${(quiz.correct / quiz.asked) * 100}%` : "0%" }} /></div>
                  <span><b>{quiz.correct}</b> / {quiz.asked}</span>
                </div>
                <div className="revrow">
                  {revealed === 0 ? (
                    <button className="btn primary revmain" onClick={revealNext}>Révéler le vers</button>
                  ) : (<>
                    <button className="btn revmain know" onClick={() => answer(true)}>✓ Savais</button>
                    <button className="btn revmain dont" onClick={() => answer(false)}>✗ Savais pas</button>
                  </>)}
                  <button className="iconbtn stop" title="Arrêter la révision — score de la session"
                    onClick={stopQuiz}>■</button>
                </div>
              </div>
            </div>
          )}
          {reviseMode && reviseMode !== "quiz" && (
            <div className="revbar">
              <div className="inner">
                <div className="revprog">
                  <span>{reviseMode === "random" ? "Départ aléatoire" : "Depuis le début"}</span>
                  <div className="revtrack"><div className="revfill" style={{ width: `${revealables ? (visibleLines / revealables) * 100 : 0}%` }} /></div>
                  <span><b>{visibleLines}</b> / {revealables}</span>
                  {(current.memo || 0) > 0 && <span className="revscore">★ {fmtMemo(current.memo)}</span>}
                </div>
                <div className="revrow">
                  {(revealed === 0 || reviseDone) && (<>
                    <button className="iconbtn" title="Recommencer depuis le début"
                      onClick={() => startRevise("seq")}>↺</button>
                    <button className="iconbtn" title="Nouveau départ aléatoire dans le poème"
                      onClick={() => startRevise("random")}>🎲</button>
                  </>)}
                  {reviseDone ? (
                    <button className="btn revmain" onClick={() => startRevise(reviseMode)}>
                      Bravo, tout est là ! — recommencer
                    </button>
                  ) : revealed === 0 ? (
                    <button className="btn primary revmain" onClick={revealNext}>Révéler le vers</button>
                  ) : (<>
                    <button className="btn revmain know" onClick={() => answer(true)}>✓ Savais</button>
                    <button className="btn revmain dont" onClick={() => answer(false)}>✗ Savais pas</button>
                  </>)}
                  {(revealed === 0 || reviseDone) && poems.length > 1 && (
                    <button className="iconbtn" title="Réviser un autre poème — tiré parmi les moins sus"
                      onClick={openReviseRandom}>⏭</button>
                  )}
                  <button className="iconbtn" title="Quitter la révision"
                    onClick={() => setReviseMode(null)}>✕</button>
                </div>
              </div>
            </div>
          )}
          {memoPrompt && (
            <div className="modal" role="dialog" aria-modal="true" aria-label="Fin de révision"
              onClick={(e) => { if (e.target === e.currentTarget) setMemoPrompt(false); }}>
              <div className="modalbox">
                <div className="modalicon">🎉</div>
                <h2>Bravo, tout est là !</h2>
                <div className="modalscore">★ {fmtMemo(current.memo || 0)}</div>
                <p>
                  Score d'apprentissage de « {current.title} », calculé sur vos réponses
                  {memoBeforeRef.current ? <> — il était à {fmtMemo(memoBeforeRef.current)}</> : null}.
                </p>
                <div className="mrow" style={{ width: "100%" }}>
                  <span className="mlab">Ajuster ?</span>
                  <Stars value={memoDraft} onChange={setMemoDraft} />
                </div>
                <div className="actions" style={{ justifyContent: "center" }}>
                  <button className="btn ghost" onClick={() => setMemoPrompt(false)}>Fermer</button>
                  {memoDraft !== Math.round(current.memo || 0) && (
                    <button className="btn primary" onClick={() => { setMemo(memoDraft); setMemoPrompt(false); }}>Enregistrer</button>
                  )}
                </div>
                {poems.length > 1 && (
                  <button className="btn slim" style={{ width: "100%" }}
                    title="Enchaîne sur un poème à travailler"
                    onClick={() => { setMemoPrompt(false); openReviseRandom(); }}>
                    Réviser un autre →
                  </button>
                )}
              </div>
            </div>
          )}
          {quizEnd && (
            <div className="modal" role="dialog" aria-modal="true" aria-label="Fin de révision"
              onClick={(e) => { if (e.target === e.currentTarget) { setQuizEnd(null); setView("lib"); } }}>
              <div className="modalbox">
                <div className="modalicon">🏁</div>
                <h2>Révision terminée</h2>
                <div className="modalscore">{quizEnd.correct} / {quizEnd.asked}</div>
                <p>
                  {Math.round((100 * quizEnd.correct) / quizEnd.asked)} % de bonnes réponses —
                  les scores des poèmes révisés ont été mis à jour.
                </p>
                {quizEnd.rows && quizEnd.rows.length > 0 && (
                  <>
                    <button className="btn slim ghost" style={{ width: "100%" }} aria-expanded={quizDetail}
                      title="Score de chaque poème avant et après la session"
                      onClick={() => setQuizDetail(!quizDetail)}>
                      Détail ({quizEnd.rows.length}) {quizDetail ? "▴" : "▾"}
                    </button>
                    <div className={"qdwrap" + (quizDetail ? "" : " folded")}>
                      <div className="qdlist">
                        {quizEnd.rows.map((r, i) => (
                          <div className="qdrow" key={i}>
                            <div className="qdt">
                              <b>{r.title}</b>
                              <i>✓ {r.correct}/{r.asked}</i>
                            </div>
                            <div className="qdd">
                              {r.before ? fmtMemo(r.before) : "—"} →
                              <b className={r.after > r.before ? "up" : r.after < r.before ? "dn" : ""}>
                                {fmtMemo(r.after)}
                              </b>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                <div className="actions" style={{ justifyContent: "center" }}>
                  <button className="btn primary" onClick={() => { setQuizEnd(null); setView("lib"); }}>Retour à la liste</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {view === "edit" && (
        <Editor draft={draft} setDraft={setDraft} onSave={save}
          onCancel={() => setView(current ? "poem" : "lib")} onDelete={current ? remove : null} />
      )}

      {view === "import" && (
        <WikiImport have={haveKeys} online={online} onAdd={addFromWiki} onClose={() => setView("lib")} />
      )}

      {view === "transfer" && (
        <Transfer library={library} tags={tags} lists={lists} backup={backup} dirty={dirty}
          onClose={() => setView("lib")} onImport={importLibrary} onShareUrl={shareUrl} onSaved={markSaved} />
      )}

      {view === "settings" && (
        <div className="form">
          <div className="forminner">
            <div className="field">
              <label>Mode avion</label>
              <p className="hint">{offlineHint}</p>
              <p className="hint" style={{ marginTop: 6 }}>
                Pour l'avoir en plein écran, sans barre d'adresse : sur iPhone, menu Partager
                → « Sur l'écran d'accueil » ; sur Android, menu ⋮ → « Installer l'application ».
              </p>
            </div>
            {offline && offline.supported && (
              <div className="actions">
                <button className="btn" disabled={offline.warming || cached}
                  onClick={() => window.offline.warm()}>
                  {offline.warming ? "Préparation…" : cached ? "Tout est en cache" : "Préparer le mode avion"}
                </button>
              </div>
            )}
            <div className="field">
              <label>Apparence</label>
              <p className="hint">Clair pour le papier, sombre pour la lecture du soir.</p>
            </div>
            <div className="actions">
              <div className="seg2">
                <button className={theme === "dark" ? "on" : ""} aria-pressed={theme === "dark"}
                  onClick={() => setTheme("dark")}>Sombre</button>
                <button className={theme === "light" ? "on" : ""} aria-pressed={theme === "light"}
                  onClick={() => setTheme("light")}>Clair</button>
              </div>
            </div>
            <div className="field">
              <label>Mise à jour</label>
              <p className="hint">
                Version du code : <b>{appVersion}</b>.{" "}
                {!offline || !offline.supported
                  ? "Ici, pas de service worker : seul le rechargement en contournant le cache du navigateur peut rafraîchir le code."
                  : offline.waiting
                    ? (offline.warming
                      ? "Une nouvelle version attend. La préparation du cache est en cours : l'installation s'appliquera dès qu'elle sera finie."
                      : "Une nouvelle version est déjà téléchargée et attend : ce bouton l'installe et recharge la page, sans réseau et sans toucher à vos données.")
                    : upCheck === "found"
                      ? "Nouvelle version trouvée — téléchargement en cours ; le bouton d'installation apparaîtra tout seul."
                      : upCheck === "none"
                        ? "Vérifié à l'instant : cet appareil a déjà la dernière version publiée."
                        : "Aucune mise à jour en attente. Le carnet vérifie de lui-même à chaque ouverture ; ce bouton le redemande maintenant."}
              </p>
            </div>
            <div className="actions">
              {!offline || !offline.supported ? (
                <button className="btn primary" onClick={() => reloadFresh(true)}>Recharger la dernière version</button>
              ) : offline.waiting ? (
                <button className="btn primary" onClick={() => window.offline.update()}>Installer la nouvelle version</button>
              ) : (
                <button className="btn" disabled={!online || upCheck === "busy" || upCheck === "found"}
                  title={online ? "Demander au serveur s'il existe une version plus récente" : "Hors ligne"}
                  onClick={checkUpdate}>
                  {upCheck === "busy" ? "Vérification…" : upCheck === "found" ? "Téléchargement…" : "Chercher une mise à jour"}
                </button>
              )}
            </div>
            {upCheck === "none" && (
              <div className="actions">
                <button className="btn ghost" title="Dernier recours : recharger la page en contournant le cache du navigateur"
                  onClick={() => reloadFresh(true)}>Forcer le rechargement</button>
              </div>
            )}
            <div className="field">
              <label>Lecture</label>
              <p className="hint">
                Taille du texte des poèmes, pour tout le carnet. Se règle aussi au pincement
                à deux doigts, directement sur le poème.
              </p>
              <p className="hint">
                Sur le poème, un glissé du doigt vers la droite revient à la liste, vers la
                gauche passe au poème suivant.
              </p>
            </div>
            <div className="actions">
              <div className="stepper">
                <button onClick={() => setSize(Math.max(13, size - 1))}>A−</button>
                <span>Taille <b>{size}</b></span>
                <button onClick={() => setSize(Math.min(34, size + 1))}>A+</button>
              </div>
            </div>
            <div className="field">
              <label>Tags</label>
              <p className="hint">
                Un poème peut en porter plusieurs ; seules les icônes s'affichent dans la liste.
                Ils restent sur cet appareil et n'entrent pas dans l'URL de partage — un classement
                est personnel — mais la sauvegarde en fichier (⇅) les emporte.
              </p>
            </div>
            {tags.defs.map((t) => (
              <div className="tagedit" key={t.id}>
                <input className="tagicon" value={t.icon} maxLength={4} aria-label={`Icône du tag ${t.label}`}
                  onChange={(e) => setTagField(t.id, "icon", e.target.value)} />
                <input value={t.label} maxLength={24} aria-label="Nom du tag"
                  onChange={(e) => setTagField(t.id, "label", e.target.value)} />
                <div className="swatches">
                  {TAG_COLORS.map((c) => (
                    <button key={c} className={"swatch" + (c === t.color ? " on" : "")} style={{ background: c }}
                      aria-label={`Couleur ${c}`} aria-pressed={c === t.color}
                      onClick={() => setTagField(t.id, "color", c)} />
                  ))}
                </div>
                <button className="carddel" title={`Supprimer le tag ${t.label}`} onClick={() => removeTag(t.id)}>✕</button>
              </div>
            ))}
            <div className="actions">
              <button className="btn" onClick={addTag}>Ajouter un tag</button>
              {missingDefaults && (
                <button className="btn ghost" onClick={restoreDefaultTags}>Rétablir les tags par défaut</button>
              )}
            </div>
            <div className="field">
              <label>Listes</label>
              <p className="hint">
                Des sous-ensembles du carnet (une anthologie, ce qu'on dira ce soir…). Le menu
                au-dessus de la bibliothèque les affiche ; chaque poème s'y ajoute depuis son
                propre menu. Contrairement aux tags, elles voyagent dans l'URL de partage.
              </p>
            </div>
            {lists.defs.map((d) => (
              <div className="tagedit" key={d.id}>
                <input value={d.name} maxLength={40} aria-label="Nom de la liste"
                  onChange={(e) => renameList(d.id, e.target.value)} />
                <span className="tag">{poems.filter((s) => inList(s, d.id)).length}</span>
                <button className="carddel" title={`Supprimer la liste ${d.name}`} onClick={() => removeList(d.id)}>✕</button>
              </div>
            ))}
            <div className="actions">
              <button className="btn" onClick={createList}>Ajouter une liste</button>
            </div>
            <div className="field">
              <label>Stockage</label>
              <p className="hint">
                Le carnet vit uniquement dans ce navigateur, sur cet appareil — aucun serveur.
                Actuellement : {poems.length} poème{poems.length > 1 ? "s" : ""} enregistré{poems.length > 1 ? "s" : ""}.
                Pour une sauvegarde ou un passage sur un autre appareil, la page Transfert (⇅)
                fournit une URL contenant toutes les données, ou un fichier.
              </p>
            </div>
            <div className="field">
              <label>Réinitialiser</label>
              <p className="hint">
                Efface les poèmes et les réglages stockés sur cet appareil, retire les données de
                la barre d'adresse, puis recharge l'application depuis le serveur (cache
                contourné). Les autres appareils et les URL déjà copiées ne sont pas touchés.
              </p>
            </div>
            <div className="actions">
              <button className="btn danger" onClick={resetAll}>Tout effacer sur cet appareil</button>
              <button className="btn ghost" onClick={() => setView("lib")}>Retour</button>
            </div>
            <div className="field">
              <label>Sources</label>
              <p className="hint">
                Les poèmes importés viennent de{" "}
                <a href="https://fr.wikisource.org/" target="_blank" rel="noopener noreferrer">Wikisource</a> :
                les textes sont dans le domaine public, leur transcription est sous licence{" "}
                <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.fr" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>.
                Chaque poème garde en pied de page le lien vers sa page d'origine.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
