import React, { useState, useEffect, useMemo, useRef } from "react";

/* ==================================================================
   Deux librairies font le travail :
   - pdf.js        : lecture du PDF, avec reconstruction des colonnes
   - ChordSheetJS  : modèle musical (accords, sections, transposition)
   Un analyseur interne prend le relais si un CDN est inaccessible.
   ================================================================== */

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const CHORDSHEET_CDNS = [
  "https://cdnjs.cloudflare.com/ajax/libs/chordsheetjs/15.6.2/bundle.min.js",
  "https://cdn.jsdelivr.net/npm/chordsheetjs@15.6.2/lib/bundle.min.js",
  "https://unpkg.com/chordsheetjs@15.6.2/lib/bundle.min.js",
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(src));
    document.head.appendChild(el);
  });
}

/** Ici, ni `new Worker(url_distante)` ni les blob: ne fonctionnent : le bac à
 *  sable réécrit les URL. Mais pdf.js sait travailler sur le thread principal
 *  si le script du worker est déjà chargé dans la page — il le retrouve via
 *  globalThis.pdfjsWorker et n'a alors plus rien à télécharger. */
async function loadPdfJs() {
  if (!window.pdfjsLib) await loadScript(PDFJS);
  const lib = window.pdfjsLib;
  if (!window.pdfjsWorker) {
    try { await loadScript(PDFJS_WORKER); } catch { /* signalé plus bas */ }
  }
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return lib;
}

async function openPdf(lib, data) {
  try {
    return await lib.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
  } catch (e) {
    if (!window.pdfjsWorker) {
      throw new Error("le script pdf.worker n'a pas pu être chargé depuis le CDN");
    }
    throw e;
  }
}

async function loadChordSheetJS() {
  if (window.ChordSheetJS) return window.ChordSheetJS;
  for (const url of CHORDSHEET_CDNS) {
    try {
      await loadScript(url);
      if (window.ChordSheetJS) return window.ChordSheetJS;
    } catch { /* CDN suivant */ }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Lecture du PDF : les positions horizontales font l'alignement       */
/* ------------------------------------------------------------------ */

function rowsToText(items, out) {
  if (!items.length) return;
  const w = [];
  for (const it of items) if (it.str.length > 1 && it.width > 0) w.push(it.width / it.str.length);
  w.sort((a, b) => a - b);
  const cw = w.length ? w[Math.floor(w.length / 2)] : 5;
  const minX = Math.min(...items.map((i) => i.x));

  const rows = [];
  for (const it of items) {
    let row = rows.find((r) => Math.abs(r.y - it.y) <= 2.5);
    if (!row) { row = { y: it.y, cells: [] }; rows.push(row); }
    row.cells.push(it);
  }
  rows.sort((a, b) => b.y - a.y);

  for (const row of rows) {
    row.cells.sort((a, b) => a.x - b.x);
    let line = "";
    for (const c of row.cells) {
      const col = Math.max(0, Math.round((c.x - minX) / cw));
      if (col > line.length) line += " ".repeat(col - line.length);
      line += c.str;
    }
    out.push(line.replace(/\s+$/, ""));
  }
}

async function pdfToText(file) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await openPdf(pdfjs, data);
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], width: i.width }));
    if (!items.length) continue;

    // Page sur deux colonnes : sinon la fin de la colonne gauche se colle
    // au début de la droite (le fameux « Bbm[Verse 2] »).
    const mid = viewport.width / 2;
    const crosses = items.some((i) => i.x < mid + 8 && i.x + i.width > mid - 8);
    const left = items.filter((i) => i.x + i.width <= mid);
    const right = items.filter((i) => i.x >= mid);
    if (!crosses && left.length > 3 && right.length > 3) {
      rowsToText(left, out);
      out.push("");
      rowsToText(right, out);
    } else {
      rowsToText(items, out);
    }
    out.push("");
  }
  return out.join("\n");
}

/** Compte ce que l'extraction a réellement produit : sans ça, un échec
 *  silencieux ressemble à un import réussi. */
function extractionStats(text) {
  const lines = tidy(text).split("\n").filter((l) => l.trim());
  let chords = 0, sections = 0, lyrics = 0;
  for (const l of lines) {
    if (isSectionLine(l)) sections++;
    else if (isChordLine(l)) chords++;
    else lyrics++;
  }
  return { lines: lines.length, chords, sections, lyrics };
}

function namesFromFile(filename) {
  const base = filename.replace(/\.pdf$/i, "").replace(/_/g, " ");
  const parts = base.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  const clean = parts.filter((p) => !/^(chords?|tabs?|lyrics?|accords?|paroles?)$/i.test(p));
  if (clean.length >= 2) return { artist: clean[0], title: clean.slice(1).join(" – ") };
  return { artist: "", title: clean[0] || base };
}

/* ------------------------------------------------------------------ */
/* Classement des lignes, puis conversion en ChordPro                  */
/* ------------------------------------------------------------------ */

function isChordToken(raw) {
  if (!raw) return false;
  const t = raw.replace(/[,|.]+$/, "");
  if (!t) return false;
  if (/^(N\.?C\.?|x\d+|\|+|%)$/i.test(t)) return true;
  const m = /^([A-G][#b]?)(.*)$/.exec(t);
  if (!m) return false;
  const parts = m[2].split("/");
  if (parts.length > 2) return false;
  if (parts.length === 2 && !/^[A-G][#b]?$/.test(parts[1])) return false;
  return /^(?:maj|min|m|M|aug|dim|sus|add|°|Δ|\+|-|\d|\(|\)|#|b)*$/.test(parts[0]);
}
const isChordLine = (line) => {
  const t = line.trim();
  return !!t && t.split(/\s+/).every(isChordToken);
};
const isSectionLine = (line) => /^\s*\[[^\]]+\]\s*$/.test(line);

function tidy(raw) {
  return (raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/([^\s\[])\[/g, "$1\n[")
    .replace(/\](\S)/g, "]\n$1")
    .replace(/\n{3,}/g, "\n\n");
}

/** ChordPro est sans ambiguïté : c'est nous qui décidons ce qui est un
 *  accord, ChordSheetJS n'a plus qu'à faire de la musique. */
function toChordPro(text) {
  const lines = tidy(text).split("\n");
  const esc = (s) => s.replace(/([[\]{}])/g, "\\$1");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isSectionLine(line)) {
      out.push("{comment: " + line.trim().replace(/^\[|\]$/g, "") + "}");
      i++;
    } else if (!line.trim()) {
      out.push("");
      i++;
    } else if (isChordLine(line)) {
      const marks = [...line.matchAll(/\S+/g)].map((m) => ({ c: m[0], at: m.index }));
      const next = lines[i + 1];
      if (next && next.trim() && !isChordLine(next) && !isSectionLine(next)) {
        let res = "";
        if (marks[0].at > 0) res += esc(next.slice(0, marks[0].at));
        marks.forEach((m, k) => {
          const end = k + 1 < marks.length ? marks[k + 1].at : next.length;
          res += "[" + m.c + "]" + esc(next.slice(m.at, Math.max(m.at, end)));
        });
        out.push(res);
        i += 2;
      } else {
        out.push(marks.map((m) => "[" + m.c + "]").join(" "));
        i++;
      }
    } else {
      out.push(esc(line));
      i++;
    }
  }
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Enharmonie : Ab plutôt que G# quand la grille est écrite en bémols   */
/* ------------------------------------------------------------------ */

const TO_FLAT = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb", Cb: "B", Fb: "E", "B#": "C", "E#": "F" };
const TO_SHARP = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B", Fb: "E", "B#": "C", "E#": "F" };
const respell = (ch, flats) =>
  (ch || "").replace(/(^|\/)([A-G][#b])/g, (_, p, n) => p + ((flats ? TO_FLAT : TO_SHARP)[n] || n));
const prefersFlats = (raw) =>
  (raw.match(/[A-G]b/g) || []).length >= (raw.match(/[A-G]#/g) || []).length;

/* ------------------------------------------------------------------ */
/* Deux chemins vers le même modèle d'affichage                         */
/* ------------------------------------------------------------------ */

function collapse(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "blank" && (!out.length || out[out.length - 1].type === "blank")) continue;
    out.push(b);
  }
  return out;
}

function blocksWithLibrary(CS, text, steps, flats) {
  let song = new CS.ChordProParser().parse(toChordPro(text));
  if (steps) song = song.transpose(steps);
  const blocks = [];
  for (const line of song.lines) {
    const cells = [];
    for (const item of line.items) {
      if (item && typeof item.name === "string") {
        const label = item.value || "";
        if (label) blocks.push({ type: "section", label });
      } else if (item && (item.chords !== undefined || item.lyrics !== undefined)) {
        const chord = respell(item.chords || "", flats);
        const lyrics = item.lyrics || "";
        if (chord || lyrics) cells.push({ chord, lyrics });
      } else if (item && item.content) {
        blocks.push({ type: "text", text: String(item.content) });
      }
    }
    if (cells.length) blocks.push({ type: "row", cells });
    else blocks.push({ type: "blank" });
  }
  return collapse(blocks);
}

const SEMIS = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const shiftChord = (tok, steps, flats) =>
  !steps || !tok
    ? tok
    : tok.replace(/[A-G][#b]?/g, (r) => {
        const i = SEMIS[r];
        return i === undefined ? r : (flats ? FLATS : SHARPS)[(((i + steps) % 12) + 12) % 12];
      });

function blocksFallback(text, steps, flats) {
  const lines = tidy(text).split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isSectionLine(line)) {
      blocks.push({ type: "section", label: line.trim().replace(/^\[|\]$/g, "") });
      i++;
    } else if (!line.trim()) {
      blocks.push({ type: "blank" });
      i++;
    } else if (isChordLine(line)) {
      const marks = [...line.matchAll(/\S+/g)].map((m) => ({ c: m[0], at: m.index }));
      const next = lines[i + 1];
      const lyric = next && next.trim() && !isChordLine(next) && !isSectionLine(next) ? next : "";
      const cells = [];
      if (marks[0].at > 0 && lyric) cells.push({ chord: "", lyrics: lyric.slice(0, marks[0].at) });
      marks.forEach((m, k) => {
        const end = k + 1 < marks.length ? marks[k + 1].at : lyric.length;
        cells.push({
          chord: shiftChord(m.c, steps, flats),
          lyrics: lyric ? lyric.slice(m.at, Math.max(m.at, end)) : "  ",
        });
      });
      blocks.push({ type: "row", cells });
      i += lyric ? 2 : 1;
    } else {
      blocks.push({ type: "row", cells: [{ chord: "", lyrics: line }] });
      i++;
    }
  }
  return collapse(blocks);
}

const KEY = "carnet:v4";
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
    else await window.storage.set(KEY, JSON.stringify({ songs: [] }));
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
 *  JSON) : on n'accepte que des grilles exploitables, jamais de champs
 *  inconnus, et les ids sont toujours régénérés. */
function normalizeLibrary(data) {
  const src = Array.isArray(data) ? { songs: data } : data;
  if (!src || !Array.isArray(src.songs)) throw new Error("structure inattendue");
  const songs = src.songs
    .filter((s) => s && typeof s.body === "string" && s.body.trim())
    .map((s) => ({
      id: uid(),
      title: String(s.title || "Sans titre"),
      artist: String(s.artist || ""),
      body: s.body,
      steps: Math.max(-6, Math.min(6, Number(s.steps) || 0)),
    }));
  if (!songs.length) throw new Error("aucune grille exploitable");
  const lib = { songs };
  if (typeof src.showChords === "boolean") lib.showChords = src.showChords;
  if (Number(src.size)) lib.size = Number(src.size);
  if (Number(src.speed)) lib.speed = Number(src.speed);
  if (src.sort === "title" || src.sort === "artist") lib.sort = src.sort;
  return lib;
}

async function encodeShare(library) {
  if (typeof CompressionStream !== "function") {
    throw new Error("CompressionStream indisponible dans ce navigateur");
  }
  const json = JSON.stringify({
    songs: library.songs.map(({ id, ...rest }) => rest),
    showChords: library.showChords,
    size: library.size,
    speed: library.speed,
    sort: library.sort,
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
  return normalizeLibrary(JSON.parse(new TextDecoder().decode(jsonBytes)));
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

const fmtBytes = (n) => (n < 1024 ? `${n} o` : `${(n / 1024).toFixed(1)} Ko`);
const mergeByTitle = (prev, added) => {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [...prev.filter((s) => !added.some((a) => norm(a.title) === norm(s.title))), ...added];
};

/* ------------------------------------------------------------------ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Archivo:wght@400;500;600&family=JetBrains+Mono:wght@700&display=swap');
.cb, .cb * { box-sizing:border-box; }
.cb { --bg:#111216; --panel:#181A1F; --panel2:#20232A; --line:#2E323B;
  --ink:#ECE9E3; --muted:#878C97; --amber:#E9B44C; --amber-dim:#8A6B2A; --hot:#C8503C;
  position:absolute; inset:0; display:flex; flex-direction:column; background:var(--bg); color:var(--ink);
  font-family:'Archivo', ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing:antialiased; overflow:hidden; }
.cb button { font:inherit; color:inherit; background:none; border:none; cursor:pointer; }
.cb :focus-visible { outline:2px solid var(--amber); outline-offset:2px; }
.top { display:flex; align-items:center; gap:12px; padding:12px 16px 10px; border-bottom:1px solid var(--line);
  background:var(--panel); flex:0 0 auto; }
.brand { font-family:'Barlow Condensed'; font-weight:700; font-size:19px; letter-spacing:.14em; text-transform:uppercase; line-height:1; }
.brand span { color:var(--amber); }
.vu { display:flex; gap:3px; align-items:flex-end; height:16px; }
.vu i { width:2px; background:var(--line); border-radius:1px; }
.vu i.on { background:var(--amber); }
.spacer { flex:1; }
.iconbtn { width:34px; height:34px; border-radius:8px; border:1px solid var(--line); display:grid; place-items:center;
  color:var(--muted); background:var(--panel2); font-size:16px; }
.iconbtn:hover { color:var(--ink); border-color:var(--amber-dim); }
.lib { flex:1; overflow-y:auto; padding:14px 16px 28px; }
.search { width:100%; padding:11px 13px; border-radius:10px; border:1px solid var(--line); background:var(--panel);
  color:var(--ink); font-size:15px; margin-bottom:12px; }
.search::placeholder { color:var(--muted); }
.count { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.16em; color:var(--muted); text-transform:uppercase; margin:0 0 10px; }
.notice { position:relative; border:1px solid var(--amber-dim); background:rgba(233,180,76,.07); border-radius:10px;
  padding:11px 40px 11px 13px; font-size:13px; line-height:1.5; margin-bottom:12px; }
.noticeclose { position:absolute; top:7px; right:7px; width:26px; height:26px; border-radius:7px; display:grid;
  place-items:center; color:var(--muted); font-size:13px; line-height:1; }
.noticeclose:hover { color:var(--ink); background:rgba(233,180,76,.12); }
.card { width:100%; display:flex; align-items:stretch; border:1px solid var(--line);
  border-left:3px solid var(--line); border-radius:10px; background:var(--panel); margin-bottom:8px;
  transition:border-color .15s; overflow:hidden; }
.card:hover { border-left-color:var(--amber); }
.cardmain { flex:1; min-width:0; display:flex; align-items:center; gap:14px; padding:13px 14px; text-align:left; }
.cardmain:active { transform:scale(.996); }
.carddel { flex:0 0 auto; padding:0 13px; color:var(--muted); border-left:1px solid var(--line); font-size:14px; }
.carddel:hover { color:var(--hot); background:rgba(200,80,60,.08); }
.toolrow { display:flex; align-items:center; gap:8px; margin:0 0 12px; flex-wrap:wrap; }
.toolrow .lab { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); }
.seg2 { display:flex; border:1px solid var(--line); border-radius:8px; background:var(--panel2); overflow:hidden; }
.seg2 button { padding:8px 13px; font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.seg2 button.on { color:var(--amber); background:rgba(233,180,76,.12); }
.btn.slim { padding:8px 14px; font-size:13.5px; }
.card h3 { margin:0; font-family:'Barlow Condensed'; font-weight:600; font-size:21px; letter-spacing:.03em; text-transform:uppercase; line-height:1.05; }
.card p { margin:2px 0 0; font-size:12.5px; color:var(--muted); }
.tag { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.1em; text-transform:uppercase; border:1px solid var(--line);
  color:var(--muted); border-radius:6px; padding:3px 7px; flex:0 0 auto; }
.tag.full { color:var(--amber); border-color:var(--amber-dim); }
.empty { text-align:center; padding:44px 20px; color:var(--muted); }
.empty h2 { font-family:'Barlow Condensed'; text-transform:uppercase; letter-spacing:.1em; color:var(--ink); font-size:22px; margin:0 0 8px; }
.empty p { margin:0 0 20px; font-size:14px; line-height:1.5; }
.head { position:relative; padding:12px 16px; border-bottom:1px solid var(--line); background:var(--panel); flex:0 0 auto; }
.title { font-family:'Barlow Condensed'; font-weight:700; font-size:26px; line-height:1; letter-spacing:.02em; text-transform:uppercase; margin:0; padding-right:40px; }
.foldbtn { position:absolute; top:11px; right:14px; width:30px; height:30px; border-radius:8px; border:1px solid var(--line);
  background:var(--panel2); color:var(--muted); display:grid; place-items:center; font-size:10px; }
.foldbtn:hover { color:var(--amber); border-color:var(--amber-dim); }
.foldbtn i { display:block; font-style:normal; transition:transform .25s; }
.foldbtn.folded i { transform:rotate(180deg); }
.barwrap { overflow:hidden; max-height:280px; opacity:1; transition:max-height .28s ease, opacity .22s; }
.barwrap.folded { max-height:0; opacity:0; }
.artist { font-size:12.5px; color:var(--muted); margin:3px 0 0; letter-spacing:.04em; }
.bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:12px; }
.switch { display:flex; align-items:center; gap:9px; padding:5px 11px 5px 7px; border-radius:8px; border:1px solid var(--line); background:var(--panel2); }
.track { width:38px; height:21px; border-radius:11px; background:#0D0E11; border:1px solid var(--line); position:relative; transition:background .18s; }
.knob { position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:var(--muted); transition:transform .18s, background .18s; }
.switch.on .track { background:rgba(233,180,76,.18); border-color:var(--amber-dim); }
.switch.on .knob { transform:translateX(17px); background:var(--amber); }
.switch label { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); cursor:pointer; }
.switch.on label { color:var(--amber); }
.stepper { display:flex; align-items:center; border:1px solid var(--line); border-radius:8px; background:var(--panel2); overflow:hidden; }
.stepper button { width:30px; height:31px; color:var(--muted); font-size:15px; line-height:1; }
.stepper button:hover { color:var(--amber); background:rgba(233,180,76,.07); }
.stepper span { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.1em; color:var(--muted); padding:0 8px;
  text-transform:uppercase; min-width:70px; text-align:center; }
.stepper span b { color:var(--ink); font-weight:700; }
.sheet { flex:1; overflow-y:auto; padding:20px 16px 120px; }
.sheetinner { max-width:760px; margin:0 auto; }
.sec { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--amber);
  margin:26px 0 10px; display:flex; align-items:center; gap:10px; }
.sec:first-child { margin-top:0; }
.sec::after { content:''; flex:1; height:1px; background:var(--line); }
.row { display:flex; flex-wrap:wrap; align-items:flex-end; margin-bottom:2px; }
.row, .plain { transition:filter .4s, opacity .4s; }
.masked { filter:blur(8px); opacity:.35; user-select:none; pointer-events:none; }
.revbar { position:absolute; left:0; right:0; bottom:0; padding:10px 16px 14px; display:flex; flex-direction:column; gap:9px;
  background:linear-gradient(to top, var(--bg) 72%, transparent); }
.revbar .inner { max-width:760px; margin:0 auto; width:100%; display:flex; flex-direction:column; gap:9px; }
.revprog { display:flex; align-items:center; gap:10px; font-family:'JetBrains Mono'; font-size:10px;
  letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.revprog b { color:var(--amber); }
.revtrack { flex:1; height:3px; background:var(--line); border-radius:2px; overflow:hidden; }
.revfill { height:100%; background:var(--amber); transition:width .3s; }
.revrow { display:flex; gap:8px; align-items:stretch; }
.revmain { flex:1; padding:14px 16px; font-size:17px; }
.seg { display:inline-flex; flex-direction:column; }
.ch { font-family:'JetBrains Mono'; font-weight:700; color:var(--amber); font-size:.74em; line-height:1.5; white-space:pre; padding-right:8px; }
.ly { white-space:pre-wrap; line-height:1.42; }
.plain { line-height:1.55; margin-bottom:2px; white-space:pre-wrap; }
.gap { height:14px; }
.form { flex:1; overflow-y:auto; padding:18px 16px 40px; }
.forminner { max-width:760px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
.field label { display:block; font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); margin-bottom:6px; }
.field input, .field textarea { width:100%; padding:11px 13px; border-radius:9px; border:1px solid var(--line); background:var(--panel); color:var(--ink); font-size:15px; }
.field textarea { font-family:'JetBrains Mono'; font-weight:700; font-size:13px; line-height:1.6; min-height:280px; resize:vertical;
  white-space:pre; overflow-wrap:normal; overflow-x:auto; }
.hint { font-size:12.5px; color:var(--muted); line-height:1.5; margin:0; }
.actions { display:flex; gap:10px; padding-top:4px; flex-wrap:wrap; }
.btn { padding:11px 18px; border-radius:9px; font-family:'Barlow Condensed'; font-weight:700; font-size:15px; letter-spacing:.09em;
  text-transform:uppercase; border:1px solid var(--line); background:var(--panel2); text-align:center; }
.btn.primary { background:var(--amber); color:#17181B; border-color:var(--amber); }
.btn.ghost { color:var(--muted); background:none; }
.btn.ghost:hover { color:var(--ink); }
.btn.danger { color:var(--hot); border-color:rgba(200,80,60,.4); background:none; }
.btn:disabled { opacity:.45; cursor:default; }
.reportline { font-family:'JetBrains Mono'; font-size:10.5px; line-height:1.6; color:var(--muted); margin-top:6px; word-break:break-word; }
.reportline b { color:var(--amber); }
.warnbar { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--hot);
  border:1px solid rgba(200,80,60,.4); border-radius:8px; padding:8px 10px; margin-bottom:14px; }
.engine { font-family:'JetBrains Mono'; font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
@media (min-width:720px) { .sheet { padding:26px 32px 130px; } .lib { padding:18px 32px 32px; } }
@media (prefers-reduced-motion:reduce) { .cb * { transition:none !important; } }
`;

/* ------------------------------------------------------------------ */

function VU() {
  const h = [5, 9, 6, 13, 8, 16, 11, 7];
  return <div className="vu" aria-hidden="true">{h.map((v, i) => <i key={i} className={i < 5 ? "on" : ""} style={{ height: v }} />)}</div>;
}

/** maskFrom : en révision, ordinal (parmi les lignes révélables) à partir
 *  duquel le texte est flouté. Les sections et blancs restent visibles :
 *  la structure guide, le texte se mérite. */
function Sheet({ blocks, showChords, size, maskFrom }) {
  let ord = -1;
  return (
    <div className="sheetinner" style={{ fontSize: size }}>
      {blocks.map((b, i) => {
        if (b.type === "section") return <div className="sec" key={i}>{b.label}</div>;
        if (b.type === "blank") return <div className="gap" key={i} />;
        ord++;
        const masked = maskFrom != null && ord >= maskFrom;
        const frontier = maskFrom != null && ord === maskFrom - 1;
        const cls = masked ? " masked" : "";
        const fr = frontier ? "1" : undefined;
        if (b.type === "text") return <div className={"plain" + cls} data-frontier={fr} key={i}>{b.text}</div>;
        if (!showChords) {
          // Les blancs venaient de l'alignement des accords : on les résorbe.
          const text = b.cells.map((c) => c.lyrics).join("").replace(/\s+/g, " ").trim();
          return text ? <div className={"plain" + cls} data-frontier={fr} key={i}>{text}</div> : <div className="gap" key={i} />;
        }
        return (
          <div className={"row" + cls} data-frontier={fr} key={i}>
            {b.cells.map((c, j) => (
              <span className="seg" key={j}>
                <span className="ch">{c.chord}</span>
                <span className="ly">{c.lyrics}</span>
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const PLACEHOLDER = `[Couplet]
Am        F
Collez ici la grille
C         G
Accords sur une ligne, parole en dessous`;

function Editor({ draft, setDraft, onSave, onCancel, onDelete }) {
  return (
    <div className="form">
      <div className="forminner">
        <div className="field">
          <label htmlFor="t">Titre</label>
          <input id="t" value={draft.title} placeholder="Sans titre" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="a">Artiste</label>
          <input id="a" value={draft.artist} placeholder="Inconnu" onChange={(e) => setDraft({ ...draft, artist: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="g">Grille</label>
          <textarea id="g" value={draft.body} spellCheck={false} placeholder={PLACEHOLDER}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        </div>
        <p className="hint">Une ligne d'accords, la parole juste en dessous, les sections entre crochets.</p>
        <div className="actions">
          <button className="btn primary" onClick={onSave}>Enregistrer</button>
          <button className="btn ghost" onClick={onCancel}>Annuler</button>
          {onDelete && <button className="btn danger" onClick={onDelete}>Supprimer</button>}
        </div>
      </div>
    </div>
  );
}

function Transfer({ library, engine, onImport, onShareUrl, onClose }) {
  const { songs } = library;
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [urlMsg, setUrlMsg] = useState("");
  const [share, setShare] = useState(null);
  const json = useMemo(() => JSON.stringify(songs.map(({ id, ...r }) => r), null, 1), [songs]);

  useEffect(() => {
    let alive = true;
    setShare(null);
    setUrlMsg("");
    if (!songs.length) { setShare({ error: "le carnet est vide" }); return; }
    (async () => {
      try {
        const s = await encodeShare(library);
        const url = window.location.origin + window.location.pathname + window.location.search + s.hash;
        if (alive) setShare({ ...s, url });
      } catch (e) {
        if (alive) setShare({ error: String(e && e.message ? e.message : e) });
      }
    })();
    return () => { alive = false; };
  }, [library, songs.length]);

  const doImport = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      let lib;
      if (/^[\[{]/.test(t)) {
        lib = normalizeLibrary(JSON.parse(t));
      } else {
        const data = extractShareData(t);
        if (!data) throw new Error();
        lib = await decodeShareData(data);
      }
      onImport(lib.songs, lib);
      setMsg(`${lib.songs.length} grille(s) ajoutée(s).`);
      setText("");
    } catch {
      setMsg("Texte non reconnu. Attendu : une liste JSON avec title, artist et body, ou un code/URL généré par « Partager par URL ».");
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

  return (
    <div className="form">
      <div className="forminner">
        <div className="field">
          <label htmlFor="shareurl">Partager par URL — toutes les données voyagent après le #</label>
          <textarea id="shareurl" readOnly style={{ minHeight: 90, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            value={share ? (share.error ? `Indisponible : ${share.error}` : share.url) : "Préparation…"}
            onFocus={(e) => e.target.select()} />
        </div>
        {share && !share.error && (
          <p className="reportline">
            JSON <b>{fmtBytes(share.rawBytes)}</b> → gzip <b>{fmtBytes(share.packedBytes)}</b> → URL
            de <b>{share.url.length.toLocaleString("fr-FR")}</b> caractères
            {share.url.length > 30000 && " — très longue : certaines messageries ou navigateurs tronquent au-delà"}
          </p>
        )}
        <div className="actions">
          <button className="btn primary" disabled={!share || !!share.error} onClick={copyUrl}>Copier l'URL avec mes données</button>
          <button className="btn" disabled={!share || !!share.error}
            onClick={() => window.open(share.url, "_blank", "noopener")}>Ouvrir dans une autre fenêtre</button>
          <button className="btn ghost" disabled={!share || !!share.error}
            onClick={() => { navigator.clipboard?.writeText(share.data); setUrlMsg("Code compressé copié."); }}>Copier le code seul</button>
        </div>
        {urlMsg && <p className="hint">{urlMsg}</p>}
        <div className="field">
          <label>Retrouver ce carnet plus tard</label>
          <p className="hint">
            Après « Copier l'URL avec mes données », la barre d'adresse porte le carnet complet et reste à jour.{" "}
            {isIOS ? (
              <>Sur iPhone/iPad, iOS n'autorise aucun bouton à le faire tout seul : touchez <b>Partager</b> puis
              <b> « Sur l'écran d'accueil »</b> (ou « Ajouter un signet ») — l'icône créée rouvrira le carnet avec toutes vos grilles.</>
            ) : isAndroid ? (
              <>Sur Android : menu <b>⋮</b> puis <b>« Ajouter à l'écran d'accueil »</b>, ou l'étoile pour les favoris.</>
            ) : (
              <>Appuyez sur <b>{isMac ? "⌘D" : "Ctrl+D"}</b> pour ajouter la page aux favoris — les navigateurs
              modernes n'autorisent plus les sites à le déclencher eux-mêmes.</>
            )}
          </p>
        </div>
        <div className="field">
          <label>Sauvegarde du carnet (JSON)</label>
          <textarea readOnly value={json} style={{ minHeight: 140 }} onFocus={(e) => e.target.select()} />
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(json)}>Copier</button>
        </div>
        <div className="field">
          <label htmlFor="imp">Restaurer ou ajouter — JSON, code compressé ou URL partagée</label>
          <textarea id="imp" value={text} placeholder={'[{"title":"…","artist":"…","body":"…"}]  ou  https://…#v=1&data=…'}
            style={{ minHeight: 140 }} onChange={(e) => setText(e.target.value)} />
        </div>
        {msg && <p className="hint">{msg}</p>}
        <div className="actions">
          <button className="btn primary" onClick={doImport}>Importer</button>
          <button className="btn ghost" onClick={onClose}>Retour</button>
        </div>
        <p className="engine">Moteur d'analyse : {engine}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Carnet() {
  const [songs, setSongs] = useState([]);
  const [ready, setReady] = useState(false);
  const [CS, setCS] = useState(null);
  const [csTried, setCsTried] = useState(false);
  const [view, setView] = useState("lib");
  const [currentId, setCurrentId] = useState(null);
  const [draft, setDraft] = useState({ title: "", artist: "", body: "" });
  const [query, setQuery] = useState("");
  const [showChords, setShowChords] = useState(true);
  const [sort, setSort] = useState("title");
  const [size, setSize] = useState(17);
  const [scrolling, setScrolling] = useState(false);
  const [speed, setSpeed] = useState(3);
  const [barOpen, setBarOpen] = useState(true);
  const [reviseMode, setReviseMode] = useState(null); // null | "seq" | "random"
  const [reviseStart, setReviseStart] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const draggingRef = useRef(false);
  const resumeRef = useRef(null);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState([]);
  const sheetRef = useRef(null);
  const fileRef = useRef(null);
  const syncHashRef = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await Promise.race([
        loadLibrary(),
        new Promise((r) => setTimeout(() => r(null), 2500)),
      ]);
      if (!alive) return;
      let carnet = data && Array.isArray(data.songs) ? data : { songs: [] };
      // Un fragment #v=1&data=… l'emporte : c'est le sens d'ouvrir un lien
      // partagé. Les grilles locales de même titre sont remplacées, les
      // autres conservées.
      try {
        const shared = await libraryFromHash(window.location.hash);
        if (!alive) return;
        if (shared) {
          carnet = { ...carnet, ...shared, songs: mergeByTitle(carnet.songs, shared.songs) };
          syncHashRef.current = true;
          setStatus(`${shared.songs.length} grille(s) chargée(s) depuis l'URL.`);
        }
      } catch (e) {
        setStatus("Le lien contenait des données illisibles ou incompatibles — carnet local conservé. ("
          + String(e && e.message ? e.message : e).slice(0, 120) + ")");
      }
      setSongs(carnet.songs);
      if (typeof carnet.showChords === "boolean") setShowChords(carnet.showChords);
      if (carnet.size) setSize(carnet.size);
      if (carnet.speed) setSpeed(carnet.speed);
      if (carnet.sort === "title" || carnet.sort === "artist") setSort(carnet.sort);
      if (typeof carnet.barOpen === "boolean") setBarOpen(carnet.barOpen);
      setReady(true);
      const lib = await loadChordSheetJS();
      if (!alive) return;
      setCS(lib);
      setCsTried(true);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { if (ready) saveLibrary({ songs, showChords, size, speed, sort, barOpen }); }, [songs, showChords, size, speed, sort, barOpen, ready]);

  // La barre d'adresse n'est réécrite qu'une fois le partage activé
  // (ouverture d'un lien #data=… ou « Copier l'URL ») : elle reflète alors
  // le carnet en continu, et un favori pris à n'importe quel moment —
  // Ctrl+D, écran d'accueil iOS — embarque les données à jour.
  useEffect(() => {
    if (!ready || !syncHashRef.current) return;
    let alive = true;
    (async () => {
      try {
        if (!songs.length) {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
          return;
        }
        const { hash } = await encodeShare({ songs, showChords, size, speed, sort });
        if (alive && window.location.hash !== hash) window.history.replaceState(null, "", hash);
      } catch { /* barre d'adresse laissée telle quelle */ }
    })();
    return () => { alive = false; };
  }, [songs, showChords, size, speed, sort, ready]);

  const shareUrl = (hash) => {
    syncHashRef.current = true;
    window.history.replaceState(null, "", hash);
  };

  // Défilement : vitesse en pixels par seconde, indépendante du rafraîchissement.
  // Le doigt met la boucle en pause puis elle repart d'où l'on s'est arrêté.
  useEffect(() => {
    if (!scrolling) return;
    let raf, last = null, carry = 0;
    const tick = (t) => {
      const el = sheetRef.current;
      if (el) {
        if (draggingRef.current) {
          last = null;
          carry = 0;
        } else {
          if (last !== null) {
            carry += ((t - last) / 1000) * speed * 9;
            const whole = Math.floor(carry);
            if (whole >= 1) {
              carry -= whole;
              el.scrollTop += whole;
              if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) setScrolling(false);
            }
          }
          last = t;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scrolling, speed]);

  const current = songs.find((s) => s.id === currentId) || null;
  const steps = current?.steps || 0;

  const blocks = useMemo(() => {
    if (!current) return [];
    const flats = prefersFlats(current.body);
    if (CS) {
      try { return blocksWithLibrary(CS, current.body, steps, flats); } catch { /* repli */ }
    }
    return blocksFallback(current.body, steps, flats);
  }, [current, steps, CS]);

  // Révision : on compte les lignes révélables (texte/paroles+accords) ;
  // sections et blancs ne comptent pas, ils restent toujours visibles.
  const revealables = useMemo(
    () => blocks.reduce((n, b) => n + (b.type === "row" || b.type === "text" ? 1 : 0), 0),
    [blocks]);
  const visibleLines = Math.min(revealables, reviseStart + revealed);
  const reviseDone = reviseMode && visibleLines >= revealables;

  const startRevise = (mode) => {
    if (!revealables) return;
    setScrolling(false);
    setReviseMode(mode);
    setReviseStart(mode === "random" ? 1 + Math.floor(Math.random() * Math.max(1, revealables - 1)) : 0);
    setRevealed(0);
  };
  const revealNext = () => {
    setRevealed((r) => Math.min(r + 1, Math.max(0, revealables - reviseStart)));
  };

  // La ligne tout juste révélée (ou la fin du contexte en départ aléatoire)
  // est ramenée au centre de l'écran.
  useEffect(() => {
    if (!reviseMode || !sheetRef.current) return;
    const el = sheetRef.current.querySelector('[data-frontier="1"]');
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    else sheetRef.current.scrollTop = 0;
  }, [reviseMode, reviseStart, revealed]);

  // Au clavier : Espace, Entrée ou ↓ révèlent la ligne suivante.
  useEffect(() => {
    if (!reviseMode || view !== "song") return;
    const h = (e) => {
      if (e.code === "Space" || e.code === "Enter" || e.code === "ArrowDown") {
        e.preventDefault();
        setRevealed((r) => Math.min(r + 1, Math.max(0, revealables - reviseStart)));
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [reviseMode, view, revealables, reviseStart]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? songs.filter((s) => (s.title + " " + s.artist).toLowerCase().includes(q)) : songs;
    const key = sort === "artist" ? (s) => (s.artist || "").trim() : (s) => s.title;
    return [...list].sort((a, b) =>
      key(a).localeCompare(key(b), "fr") || a.title.localeCompare(b.title, "fr"));
  }, [songs, query, sort]);

  const importPdfs = async (files) => {
    if (!files || !files.length) return;
    setStatus("Lecture des PDF…");
    setReport([]);
    const added = [];
    const lines = [];
    for (const file of Array.from(files)) {
      try {
        const body = await pdfToText(file);
        const st = extractionStats(body);
        if (!st.lines) throw new Error("aucun texte : PDF probablement scanné (image)");
        const { artist, title } = namesFromFile(file.name);
        added.push({ id: uid(), title, artist, body, steps: 0 });
        lines.push({
          name: file.name, ok: true,
          detail: `${st.lyrics} lignes de paroles, ${st.chords} lignes d'accords, ${st.sections} sections`,
          warn: st.lyrics === 0,
        });
      } catch (e) {
        lines.push({ name: file.name, ok: false, detail: String(e && e.message ? e.message : e).slice(0, 140) });
      }
    }
    setReport(lines);
    if (added.length) {
      setSongs((prev) => mergeByTitle(prev, added));
      setStatus(`${added.length} PDF importé(s).`);
      if (added.length === 1) openSong(added[0].id);
    } else {
      setStatus("Aucun PDF n'a pu être lu.");
    }
  };

  const openSong = (id) => {
    setCurrentId(id); setView("song"); setScrolling(false); setReviseMode(null); setRevealed(0);
    requestAnimationFrame(() => sheetRef.current && (sheetRef.current.scrollTop = 0));
  };
  const startNew = () => { setCurrentId(null); setDraft({ title: "", artist: "", body: "" }); setView("edit"); };
  const startEdit = () => { setDraft({ title: current.title, artist: current.artist, body: current.body }); setView("edit"); };
  const save = () => {
    if (!draft.body.trim()) return;
    const title = draft.title.trim() || "Sans titre";
    if (current) {
      setSongs(songs.map((s) => (s.id === current.id ? { ...s, title, artist: draft.artist.trim(), body: draft.body } : s)));
    } else {
      const song = { id: uid(), title, artist: draft.artist.trim(), body: draft.body, steps: 0 };
      setSongs([...songs, song]); setCurrentId(song.id);
    }
    setView("song");
  };
  const removeSong = (song) => {
    if (!window.confirm(`Supprimer « ${song.title} » ?`)) return false;
    setSongs((prev) => prev.filter((s) => s.id !== song.id));
    if (currentId === song.id) setCurrentId(null);
    return true;
  };
  const remove = () => { if (removeSong(current)) setView("lib"); };
  const openRandom = () => {
    const pool = view === "song" ? songs.filter((s) => s.id !== currentId) : filtered;
    if (!pool.length) return;
    openSong(pool[Math.floor(Math.random() * pool.length)].id);
  };
  const resetAll = async () => {
    if (!window.confirm("Tout effacer sur cet appareil ? Les grilles et les réglages stockés localement seront supprimés, puis l'application rechargera sa dernière version. Copiez d'abord l'URL de partage si vous voulez pouvoir revenir en arrière.")) return;
    syncHashRef.current = false;
    setReady(false); // gèle la sauvegarde automatique pendant l'effacement
    await clearLibrary();
    reloadFresh(false); // repart à neuf, sans le fragment ni le cache
  };
  const importLibrary = (list, settings) => {
    setSongs((prev) => mergeByTitle(prev, list));
    if (settings) {
      if (typeof settings.showChords === "boolean") setShowChords(settings.showChords);
      if (settings.size) setSize(settings.size);
      if (settings.speed) setSpeed(settings.speed);
      if (settings.sort === "title" || settings.sort === "artist") setSort(settings.sort);
    }
  };
  const library = useMemo(() => ({ songs, showChords, size, speed, sort }), [songs, showChords, size, speed, sort]);
  const shift = (n) => setSongs(songs.map((s) => (s.id === current.id ? { ...s, steps: Math.max(-6, Math.min(6, (s.steps || 0) + n)) } : s)));

  const engine = CS ? "ChordSheetJS 15.6" : csTried ? "lecteur interne (CDN inaccessible)" : "chargement…";
  const appVersion = useMemo(() => {
    const s = document.querySelector('script[src*="app.js"]');
    const m = s && /[?&]v=([0-9a-f]+)/.exec(s.getAttribute("src") || "");
    return m ? m[1] : "dev";
  }, []);

  return (
    <div className="cb">
      <style>{CSS}</style>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple hidden
        onChange={(e) => { importPdfs(e.target.files); e.target.value = ""; }} />

      <div className="top">
        {view === "lib" ? (
          <>
            <div className="brand">Carnet <span>d'accords</span></div>
            <VU />
            <div className="spacer" />
            <button className="iconbtn" title="Importer des PDF" onClick={() => fileRef.current?.click()}>⤓</button>
            <button className="iconbtn" title="Saisir une grille" onClick={startNew}>＋</button>
            <button className="iconbtn" title="Sauvegarde et partage" onClick={() => setView("transfer")}>⇅</button>
            <button className="iconbtn" title="Réglages" onClick={() => setView("settings")}>⚙</button>
          </>
        ) : (
          <>
            <button className="iconbtn" title="Retour" onClick={() => { setScrolling(false); setView("lib"); }}>‹</button>
            <div className="brand" style={{ fontSize: 15, color: "var(--muted)" }}>
              {view === "edit" ? (current ? "Modifier" : "Nouvelle grille") : view === "transfer" ? "Transfert" : view === "settings" ? "Réglages" : "Lecture"}
            </div>
            <div className="spacer" />
            {view === "song" && songs.length > 1 && (
              <button className="iconbtn" title="Une autre au hasard" onClick={openRandom}>🎲</button>
            )}
            {view === "song" && <button className="iconbtn" title="Modifier" onClick={startEdit}>✎</button>}
          </>
        )}
      </div>

      {view === "lib" && (
        <>
          <div className="lib">
            <input className="search" value={query} placeholder="Chercher un titre, un artiste…"
              onChange={(e) => setQuery(e.target.value)} />
            {songs.length > 1 && (
              <div className="toolrow">
                <span className="lab">Tri</span>
                <div className="seg2">
                  <button className={sort === "title" ? "on" : ""} aria-pressed={sort === "title"}
                    onClick={() => setSort("title")}>Titre</button>
                  <button className={sort === "artist" ? "on" : ""} aria-pressed={sort === "artist"}
                    onClick={() => setSort("artist")}>Artiste</button>
                </div>
                <div className="spacer" />
                <button className="btn slim" onClick={openRandom} title="Ouvrir une chanson au hasard">🎲 Au hasard</button>
              </div>
            )}
            {status && (
              <div className="notice">
                <button className="noticeclose" title="Fermer" aria-label="Fermer le message"
                  onClick={() => { setStatus(""); setReport([]); }}>✕</button>
                {status}
                {report.map((r, i) => (
                  <div key={i} className="reportline">
                    <b>{r.ok ? (r.warn ? "⚠" : "✓") : "✕"}</b> {r.name} — {r.detail}
                  </div>
                ))}
                {report.some((r) => !r.ok) && (
                  <div className="reportline">
                    Si l'erreur mentionne le worker ou le réseau, l'environnement bloque le
                    chargement de pdf.js. Vous pouvez toujours coller le texte du PDF via « Saisir ».
                  </div>
                )}
              </div>
            )}
            {songs.length > 0 && <p className="count">{filtered.length} / {songs.length} chanson{songs.length > 1 ? "s" : ""}</p>}
            {!ready && <p className="hint">Chargement…</p>}
            {ready && songs.length === 0 && (
              <div className="empty">
                <h2>Carnet vide</h2>
                <p>Importez vos PDF de grilles : paroles et accords sont extraits<br />et alignés automatiquement.</p>
                <div className="actions" style={{ justifyContent: "center" }}>
                  <button className="btn primary" onClick={() => fileRef.current?.click()}>Importer des PDF</button>
                  <button className="btn" onClick={startNew}>Saisir</button>
                </div>
              </div>
            )}
            {ready && songs.length > 0 && filtered.length === 0 && (
              <div className="empty"><p>Rien ne correspond à « {query} ».</p></div>
            )}
            {filtered.map((s) => (
              <div className="card" key={s.id}>
                <button className="cardmain" onClick={() => openSong(s.id)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3>{s.title}</h3>
                    <p>{s.artist || "Artiste inconnu"}</p>
                  </div>
                  <span className="tag full">{(s.body.match(/^\s*\[[^\]]+\]\s*$/gm) || []).length || "—"} sect.</span>
                </button>
                <button className="carddel" title={`Supprimer « ${s.title} »`} onClick={() => removeSong(s)}>✕</button>
              </div>
            ))}
          </div>
        </>
      )}

      {view === "song" && current && (
        <>
          <div className="head">
            <button className={"foldbtn" + (barOpen ? "" : " folded")} aria-expanded={barOpen}
              title={barOpen ? "Replier les réglages" : "Déplier les réglages"}
              onClick={() => setBarOpen(!barOpen)}><i>▲</i></button>
            <h1 className="title">{current.title}</h1>
            <p className="artist">{current.artist || "Artiste inconnu"}</p>
            <div className={"barwrap" + (barOpen ? "" : " folded")}>
            <div className="bar">
              <button className={"switch" + (showChords ? " on" : "")} aria-pressed={showChords} onClick={() => setShowChords(!showChords)}>
                <span className="track"><span className="knob" /></span><label>Accords</label>
              </button>
              {showChords && (
                <div className="stepper">
                  <button onClick={() => shift(-1)} title="Un demi-ton plus bas">−</button>
                  <span>Ton <b>{steps > 0 ? `+${steps}` : steps}</b></span>
                  <button onClick={() => shift(1)} title="Un demi-ton plus haut">+</button>
                </div>
              )}
              <div className="stepper">
                <button onClick={() => setSize(Math.max(13, size - 1))}>A−</button>
                <span>Taille <b>{size}</b></span>
                <button onClick={() => setSize(Math.min(30, size + 1))}>A+</button>
              </div>
              <button className={"switch" + (scrolling ? " on" : "")} aria-pressed={scrolling} onClick={() => setScrolling(!scrolling)}>
                <span className="track"><span className="knob" /></span><label>Défilement</label>
              </button>
              <div className="stepper">
                <button onClick={() => setSpeed(Math.max(1, speed - 1))} title="Plus lent">«</button>
                <span>Vitesse <b>{speed}</b></span>
                <button onClick={() => setSpeed(Math.min(12, speed + 1))} title="Plus rapide">»</button>
              </div>
              <button className={"switch" + (reviseMode ? " on" : "")} aria-pressed={!!reviseMode}
                onClick={() => (reviseMode ? setReviseMode(null) : startRevise("seq"))}
                title="Cacher les paroles et les faire apparaître ligne à ligne">
                <span className="track"><span className="knob" /></span><label>Révision</label>
              </button>
            </div>
            </div>
          </div>
          <div
            className="sheet"
            ref={sheetRef}
            onPointerDown={() => { draggingRef.current = true; clearTimeout(resumeRef.current); }}
            onPointerUp={() => { clearTimeout(resumeRef.current); resumeRef.current = setTimeout(() => { draggingRef.current = false; }, 700); }}
            onPointerCancel={() => { draggingRef.current = false; }}
            onTouchStart={() => { draggingRef.current = true; clearTimeout(resumeRef.current); }}
            onTouchEnd={() => { clearTimeout(resumeRef.current); resumeRef.current = setTimeout(() => { draggingRef.current = false; }, 700); }}
          >
            {!blocks.some((b) => b.type === "row" && b.cells.some((c) => c.lyrics.trim())) && (
              <div className="sheetinner">
                <div className="warnbar">
                  Aucune parole détectée dans ce PDF — il s'agit peut-être d'un scan (image)
                </div>
              </div>
            )}
            <Sheet blocks={blocks} showChords={showChords} size={size}
              maskFrom={reviseMode ? visibleLines : null} />
          </div>
          {reviseMode && (
            <div className="revbar">
              <div className="inner">
                <div className="revprog">
                  <span>{reviseMode === "random" ? "Départ aléatoire" : "Depuis le début"}</span>
                  <div className="revtrack"><div className="revfill" style={{ width: `${revealables ? (visibleLines / revealables) * 100 : 0}%` }} /></div>
                  <span><b>{visibleLines}</b> / {revealables}</span>
                </div>
                <div className="revrow">
                  <button className="iconbtn" style={{ width: 48, height: "auto" }} title="Recommencer depuis le début"
                    onClick={() => startRevise("seq")}>↺</button>
                  <button className="iconbtn" style={{ width: 48, height: "auto" }} title="Nouveau départ aléatoire"
                    onClick={() => startRevise("random")}>🎲</button>
                  {reviseDone ? (
                    <button className="btn revmain" onClick={() => startRevise(reviseMode)}>
                      Bravo, tout est là ! — recommencer
                    </button>
                  ) : (
                    <button className="btn primary revmain" onClick={revealNext}>
                      Ligne suivante
                    </button>
                  )}
                  <button className="iconbtn" style={{ width: 48, height: "auto" }} title="Quitter la révision"
                    onClick={() => setReviseMode(null)}>✕</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {view === "edit" && (
        <Editor draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setView(current ? "song" : "lib")} onDelete={current ? remove : null} />
      )}

      {view === "transfer" && (
        <Transfer library={library} engine={engine} onClose={() => setView("lib")} onImport={importLibrary} onShareUrl={shareUrl} />
      )}

      {view === "settings" && (
        <div className="form">
          <div className="forminner">
            <div className="field">
              <label>Mise à jour</label>
              <p className="hint">
                Version du code : <b>{appVersion}</b>. Si l'application semble en retard sur la
                dernière version publiée, ce bouton recharge la page en contournant le cache du
                navigateur — sans toucher à vos données.
              </p>
            </div>
            <div className="actions">
              <button className="btn" onClick={() => reloadFresh(true)}>Recharger la dernière version</button>
            </div>
            <div className="field">
              <label>Stockage</label>
              <p className="hint">
                Le carnet vit uniquement dans ce navigateur, sur cet appareil — aucun serveur.
                Actuellement : {songs.length} chanson{songs.length > 1 ? "s" : ""} enregistrée{songs.length > 1 ? "s" : ""}.
                Pour une sauvegarde ou un passage sur un autre appareil, la page Transfert (⇅)
                fournit une URL contenant toutes les données, ou un export JSON.
              </p>
            </div>
            <div className="field">
              <label>Réinitialiser</label>
              <p className="hint">
                Efface les grilles et les réglages stockés sur cet appareil, retire les
                données de la barre d'adresse, puis recharge l'application depuis le serveur
                (cache contourné). Les autres appareils et les URL déjà copiées ne sont pas touchés.
              </p>
            </div>
            <div className="actions">
              <button className="btn danger" onClick={resetAll}>Tout effacer sur cet appareil</button>
              <button className="btn ghost" onClick={() => setView("lib")}>Retour</button>
            </div>
            <p className="engine">Moteur d'analyse : {engine}</p>
          </div>
        </div>
      )}
    </div>
  );
}
