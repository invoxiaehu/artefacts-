import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";

/* ==================================================================
   Deux librairies font le travail :
   - pdf.js        : lecture du PDF, avec reconstruction des colonnes
   - ChordSheetJS  : modèle musical (accords, sections, transposition)
   Un analyseur interne prend le relais si l'une est inaccessible.

   Elles sont servies par le site lui-même (dossier vendor/, rempli au build
   depuis node_modules) : rien à télécharger en vol, et le service worker les
   garde en cache. Les CDN ne restent qu'en repli, pour les environnements où
   vendor/ n'existe pas — l'aperçu d'artefact, par exemple.
   ================================================================== */

const PDFJS = [
  "./vendor/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
];
const PDFJS_WORKER = [
  "./vendor/pdf.worker.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
];
const CHORDSHEET = [
  "./vendor/chordsheet.min.js",
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

/** Charge la première source qui répond et renvoie son URL. */
async function loadFirst(sources) {
  for (const src of sources) {
    try { await loadScript(src); return src; } catch { /* source suivante */ }
  }
  throw new Error(sources[0]);
}

/** Ici, ni `new Worker(url_distante)` ni les blob: ne fonctionnent : le bac à
 *  sable réécrit les URL. Mais pdf.js sait travailler sur le thread principal
 *  si le script du worker est déjà chargé dans la page — il le retrouve via
 *  globalThis.pdfjsWorker et n'a alors plus rien à télécharger. */
async function loadPdfJs() {
  if (!window.pdfjsLib) await loadFirst(PDFJS);
  const lib = window.pdfjsLib;
  let worker = PDFJS_WORKER[0];
  if (!window.pdfjsWorker) {
    try { worker = await loadFirst(PDFJS_WORKER); } catch { /* signalé plus bas */ }
  }
  lib.GlobalWorkerOptions.workerSrc = worker;
  return lib;
}

async function openPdf(lib, data) {
  try {
    return await lib.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
  } catch (e) {
    if (!window.pdfjsWorker) {
      throw new Error("le script pdf.worker n'a pas pu être chargé");
    }
    throw e;
  }
}

async function loadChordSheetJS() {
  if (window.ChordSheetJS) return window.ChordSheetJS;
  for (const url of CHORDSHEET) {
    try {
      await loadScript(url);
      if (window.ChordSheetJS) return window.ChordSheetJS;
    } catch { /* source suivante */ }
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
  return /^(?:Maj|maj|min|m|M|aug|dim|sus|add|°|Δ|ø|\+|-|\d|\(|\)|#|b)*$/.test(parts[0]);
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

/** Nature d'une section pour la révision, d'après son étiquette (FR/EN) :
 *  un refrain est connu par cœur, on le révèle d'un bloc ; tout le reste —
 *  couplets, ponts, sections sans étiquette — se travaille ligne à ligne.
 *  L'instrumental ne se devine pas au nom (une outro peut porter des
 *  paroles) : c'est l'absence de paroles, bloc par bloc, qui le dit. */
const sectionKind = (label) =>
  /(refrain|chorus)/i.test(String(label || "")) ? "chorus" : "verse"; // couvre pré-refrain / pre-chorus

/* ------------------------------------------------------------------ */
/* Moteur d'accords : du symbole ("F#m7", "D/F#") aux notes et aux     */
/* doigtés. Tout est embarqué — aucune librairie, aucun réseau.        */
/* ------------------------------------------------------------------ */

/** Intervalles en demi-tons depuis la fondamentale, par suffixe normalisé. */
const CHORD_FORMULAS = {
  "": [0, 4, 7], m: [0, 3, 7], 5: [0, 7],
  7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
  dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10],
  aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], "7sus4": [0, 5, 7, 10],
  6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 69: [0, 4, 7, 9, 14],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  9: [0, 4, 7, 10, 14], m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14],
  11: [0, 4, 7, 10, 17], 13: [0, 4, 7, 10, 21],
  "7b9": [0, 4, 7, 10, 13], "7#9": [0, 4, 7, 10, 15], mmaj7: [0, 3, 7, 11],
};

/** Ramène les graphies rencontrées dans la nature (Δ, °, M7, min, -, +…)
 *  vers les clés de CHORD_FORMULAS. Suffixe inconnu : on rogne la fin
 *  jusqu'à retrouver une formule connue — exact:false le signale. */
function normalizeSuffix(s) {
  let x = (s || "")
    .replace(/[()]/g, "")
    .replace(/Δ/g, "maj7")
    .replace(/ø/g, "m7b5")
    .replace(/°7/g, "dim7").replace(/°/g, "dim")
    .replace(/^\+/, "aug").replace(/^-/, "m")
    .replace(/^min/, "m").replace(/^Maj/, "maj")
    .replace(/^M$/, "maj").replace(/^M(?=\d)/, "maj");
  if (x === "maj") x = "";
  if (x === "sus") x = "sus4";
  if (x === "7sus") x = "7sus4";
  if (x === "add2" || x === "2") x = "add9";
  if (CHORD_FORMULAS[x] !== undefined) return { suffix: x, exact: true };
  for (let cut = x.length - 1; cut > 0; cut--) {
    const head = x.slice(0, cut);
    if (CHORD_FORMULAS[head] !== undefined) return { suffix: head, exact: false };
  }
  return { suffix: "", exact: x === "" };
}

/** "F#m7/C#" → { root, rootSemi, suffix, intervals, bass, bassSemi, exact, label }.
 *  null pour tout ce qui n'est pas un accord jouable : jetons de structure
 *  (N.C., x2, |, %) — qu'isChordToken accepte mais qui ne se visualisent pas. */
function parseChordSymbol(raw) {
  const t = (raw || "").replace(/[,|.]+$/, "");
  if (!t || /^(N\.?C\.?|x\d+|\|+|%)$/i.test(t)) return null;
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(t);
  if (!m || SEMIS[m[1]] === undefined) return null;
  const { suffix, exact } = normalizeSuffix(m[2]);
  const bass = m[3] && SEMIS[m[3]] !== undefined ? m[3] : null;
  return {
    root: m[1], rootSemi: SEMIS[m[1]], suffix, intervals: CHORD_FORMULAS[suffix],
    bass, bassSemi: bass ? SEMIS[bass] : null, exact, label: t,
  };
}

/** Noms des notes de l'accord, en bémols si le symbole est écrit en bémols. */
function chordNoteNames(parsed) {
  const flats = /^[A-G]b/.test(parsed.root) || (parsed.bass ? /^[A-G]b/.test(parsed.bass) : false);
  const scale = flats ? FLATS : SHARPS;
  return parsed.intervals.map((iv) => scale[(parsed.rootSemi + iv) % 12]);
}

/* --- Guitare : un petit dictionnaire de formes, pas une base de données ---
   frets : 6 valeurs, corde Mi grave → Mi aigu ; -1 = étouffée.
   Formes MOBILES (GUITAR_SHAPES) : relatives au barré (0 = barré/sillet),
   transposées le long du manche selon la fondamentale. rootString 6 = type E,
   rootString 5 = type A. barre:0 = barré complet une fois décalé.
   Formes OUVERTES (OPEN_SHAPES) : doigtés exacts, clé = symbole complet,
   y compris les basses slash courantes. */
const GUITAR_SHAPES = {
  "": [{ rootString: 6, frets: [0, 2, 2, 1, 0, 0], barre: 0 },
    { rootString: 5, frets: [-1, 0, 2, 2, 2, 0], barre: 0 }],
  m: [{ rootString: 6, frets: [0, 2, 2, 0, 0, 0], barre: 0 },
    { rootString: 5, frets: [-1, 0, 2, 2, 1, 0], barre: 0 }],
  7: [{ rootString: 6, frets: [0, 2, 0, 1, 0, 0], barre: 0 },
    { rootString: 5, frets: [-1, 0, 2, 0, 2, 0], barre: 0 }],
  m7: [{ rootString: 6, frets: [0, 2, 0, 0, 0, 0], barre: 0 },
    { rootString: 5, frets: [-1, 0, 2, 0, 1, 0], barre: 0 }],
  maj7: [{ rootString: 6, frets: [0, -1, 1, 1, 0, -1] },
    { rootString: 5, frets: [-1, 0, 2, 1, 2, 0], barre: 0 }],
  sus4: [{ rootString: 6, frets: [0, 2, 2, 2, 0, 0], barre: 0 },
    { rootString: 5, frets: [-1, 0, 2, 2, 3, 0], barre: 0 }],
  sus2: [{ rootString: 5, frets: [-1, 0, 2, 2, 0, 0], barre: 0 }],
  "7sus4": [{ rootString: 6, frets: [0, 2, 0, 2, 0, 0], barre: 0 },
    { rootString: 5, frets: [-1, 0, 2, 0, 3, 0], barre: 0 }],
  6: [{ rootString: 5, frets: [-1, 0, 2, 2, 2, 2] },
    { rootString: 6, frets: [0, -1, 2, 1, 2, -1] }],
  m6: [{ rootString: 6, frets: [0, -1, 2, 0, 2, -1] },
    { rootString: 5, frets: [-1, 0, 2, 2, 1, 2] }],
  9: [{ rootString: 6, frets: [0, 2, 0, 1, 0, 2] }],
  m9: [{ rootString: 6, frets: [0, 2, 0, 0, 0, 2] }],
  maj9: [{ rootString: 6, frets: [0, 2, 1, 1, 0, 2] }],
  dim: [{ rootString: 5, frets: [-1, 0, 1, 2, 1, -1] }],
  dim7: [{ rootString: 5, frets: [-1, 0, 1, 2, 1, 2] }],
  m7b5: [{ rootString: 5, frets: [-1, 0, 1, 0, 1, -1] }],
  aug: [{ rootString: 6, frets: [0, 3, 2, 1, 1, -1] }],
  13: [{ rootString: 6, frets: [0, -1, 0, 1, 2, -1] }],
  mmaj7: [{ rootString: 5, frets: [-1, 0, 2, 1, 1, 0] }],
  5: [{ rootString: 6, frets: [0, 2, 2, -1, -1, -1] },
    { rootString: 5, frets: [-1, 0, 2, 2, -1, -1] }],
};
/** Suffixes sans forme dédiée : forme voisine, signalée « approx. ». */
const GUITAR_NEAREST = { add9: "", madd9: "m", 69: "6", 11: "7sus4", "7b9": "7", "7#9": "7" };

const OPEN_SHAPES = {
  C: { frets: [-1, 3, 2, 0, 1, 0] }, A: { frets: [-1, 0, 2, 2, 2, 0] },
  G: { frets: [3, 2, 0, 0, 0, 3] }, E: { frets: [0, 2, 2, 1, 0, 0] },
  D: { frets: [-1, -1, 0, 2, 3, 2] },
  F: { frets: [1, 3, 3, 2, 1, 1], barre: { fret: 1, from: 0, to: 5 } },
  Am: { frets: [-1, 0, 2, 2, 1, 0] }, Em: { frets: [0, 2, 2, 0, 0, 0] },
  Dm: { frets: [-1, -1, 0, 2, 3, 1] },
  A7: { frets: [-1, 0, 2, 0, 2, 0] }, B7: { frets: [-1, 2, 1, 2, 0, 2] },
  C7: { frets: [-1, 3, 2, 3, 1, 0] }, D7: { frets: [-1, -1, 0, 2, 1, 2] },
  E7: { frets: [0, 2, 0, 1, 0, 0] }, G7: { frets: [3, 2, 0, 0, 0, 1] },
  Am7: { frets: [-1, 0, 2, 0, 1, 0] }, Em7: { frets: [0, 2, 0, 0, 0, 0] },
  Dm7: { frets: [-1, -1, 0, 2, 1, 1] },
  Cmaj7: { frets: [-1, 3, 2, 0, 0, 0] }, Amaj7: { frets: [-1, 0, 2, 1, 2, 0] },
  Dmaj7: { frets: [-1, -1, 0, 2, 2, 2] }, Fmaj7: { frets: [-1, -1, 3, 2, 1, 0] },
  Gmaj7: { frets: [3, 2, 0, 0, 0, 2] },
  Dsus2: { frets: [-1, -1, 0, 2, 3, 0] }, Dsus4: { frets: [-1, -1, 0, 2, 3, 3] },
  Asus2: { frets: [-1, 0, 2, 2, 0, 0] }, Asus4: { frets: [-1, 0, 2, 2, 3, 0] },
  Esus4: { frets: [0, 2, 2, 2, 0, 0] },
  "D/F#": { frets: [2, -1, 0, 2, 3, 2] }, "G/B": { frets: [-1, 2, 0, 0, 0, 3] },
  "C/G": { frets: [3, 3, 2, 0, 1, 0] }, "Am/G": { frets: [3, 0, 2, 2, 1, 0] },
  "C/E": { frets: [0, 3, 2, 0, 1, 0] }, "F/C": { frets: [-1, 3, 3, 2, 1, 1] },
  "C/B": { frets: [-1, 2, 2, 0, 1, 0] }, "Em/D": { frets: [-1, -1, 0, 0, 0, 0] },
};

/** Lookup insensible à l'enharmonie : Db trouve la forme rangée sous C#. */
function openShapeFor(label) {
  if (OPEN_SHAPES[label]) return OPEN_SHAPES[label];
  for (const flats of [true, false]) {
    const alt = respell(label, flats);
    if (OPEN_SHAPES[alt]) return OPEN_SHAPES[alt];
  }
  return null;
}

/** Les 1 à 3 positions affichables d'un accord, triées du bas du manche
 *  vers le haut : { frets (absolus), barre?, approx, bassMissing }. */
function guitarPositions(parsed) {
  const out = [];
  const seen = new Set();
  const push = (frets, barre, approx, bassMissing) => {
    const key = frets.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ frets, barre: barre || null, approx: !!approx, bassMissing: !!bassMissing });
  };

  const plainLabel = parsed.root + parsed.suffix;
  let suffix = parsed.suffix;
  let approxShape = !parsed.exact;
  if (!GUITAR_SHAPES[suffix]) {
    suffix = GUITAR_NEAREST[suffix] !== undefined ? GUITAR_NEAREST[suffix] : "";
    approxShape = true;
  }

  // 1. Basse slash : uniquement les doigtés ouverts connus — on n'invente pas.
  const slash = parsed.bass ? openShapeFor(parsed.label) : null;
  if (slash) push(slash.frets, slash.barre, !parsed.exact, false);
  // 2. Forme ouverte de l'accord (sans la basse le cas échéant).
  const open = openShapeFor(plainLabel);
  if (open) push(open.frets, open.barre, !parsed.exact, !!parsed.bass && !slash);
  // 3. Formes mobiles, décalées selon la fondamentale.
  for (const shape of GUITAR_SHAPES[suffix] || []) {
    const openSemi = shape.rootString === 6 ? 4 : 9; // Mi grave / La à vide
    const base = (((parsed.rootSemi - openSemi) % 12) + 12) % 12;
    const frets = shape.frets.map((f) => (f < 0 ? -1 : f + base));
    let barre = null;
    if (base > 0 && shape.barre === 0) {
      let from = -1, to = -1;
      shape.frets.forEach((f, i) => { if (f === 0) { if (from < 0) from = i; to = i; } });
      if (from >= 0) barre = { fret: base, from, to };
    }
    push(frets, barre, approxShape, !!parsed.bass && !slash);
  }

  out.sort((a, b) => {
    const lo = (p) => Math.min(...p.frets.filter((f) => f > 0), 99);
    return lo(a) - lo(b);
  });
  return out.slice(0, 3);
}

/** La chanson comme suite d'occurrences d'accords, chacune avec sa ligne de
 *  parole et le fragment chanté dessus. eventAt : "bloc:cellule" → index. */
function chordEvents(blocks) {
  const events = [];
  const eventAt = new Map();
  let section = "";
  blocks.forEach((b, bi) => {
    if (b.type === "section") { section = b.label; return; }
    if (b.type !== "row") return;
    const line = b.cells.map((c) => c.lyrics).join("");
    const hasLyrics = /\S/.test(line);
    let at = 0;
    b.cells.forEach((c, ci) => {
      const parsed = parseChordSymbol(c.chord);
      if (parsed) {
        eventAt.set(bi + ":" + ci, events.length);
        events.push({
          chord: c.chord, parsed, section, blockIndex: bi, cellIndex: ci,
          line: hasLyrics ? line : "", segStart: at, segEnd: at + c.lyrics.length,
        });
      }
      at += c.lyrics.length;
    });
  });
  return { events, eventAt };
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
      // Note d'apprentissage : absente tant qu'elle vaut zéro, l'URL de
      // partage et les sauvegardes restent aussi courtes qu'avant. Une
      // décimale suffit — c'est la précision du scoring automatique, dont
      // le drapeau memoAuto doit survivre au transfert.
      ...(Number(s.memo) > 0 ? {
        memo: clampMemo(Number(s.memo)),
        ...(s.memoAuto === true ? { memoAuto: true } : {}),
      } : {}),
    }));
  if (!songs.length) throw new Error("aucune grille exploitable");
  const lib = { songs };
  if (typeof src.showChords === "boolean") lib.showChords = src.showChords;
  if (Number(src.size)) lib.size = Number(src.size);
  if (Number(src.speed)) lib.speed = Number(src.speed);
  if (src.sort === "title" || src.sort === "artist" || src.sort === "memo") lib.sort = src.sort;
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

/* ------------------------------------------------------------------ */
/* Tags : un classement personnel, propre à l'appareil                 */
/*                                                                     */
/* Ils ne voyagent PAS dans l'URL de partage — un classement est       */
/* personnel, et l'URL n'a pas à grossir pour ça — mais ils entrent    */
/* dans la sauvegarde en fichier, sinon un changement de téléphone      */
/* effacerait tout le travail de classement.                            */
/*                                                                     */
/* L'ancre d'une chanson est « titre + artiste » normalisés : les ids    */
/* sont régénérés à chaque import (normalizeLibrary), ils ne peuvent    */
/* donc pas servir de clé.                                              */
/* ------------------------------------------------------------------ */

const TAGS_KEY = "tags:v1";
const normPart = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const songKey = (song) => (song ? `${normPart(song.title)}|${normPart(song.artist)}` : "");

const TAG_COLORS = ["#E9B44C", "#7FB3D5", "#86C48B", "#C8503C", "#B98BD9", "#E08A5B"];
const DEFAULT_TAGS = [
  { id: "piano", label: "Piano", icon: "🎹", color: "#7FB3D5" },
  { id: "guitar", label: "Guitar", icon: "🎸", color: "#E9B44C" },
  { id: "new", label: "New", icon: "✨", color: "#86C48B" },
  { id: "favorite", label: "Favorite", icon: "★", color: "#C8503C" },
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

/** La charge d'une sauvegarde : grilles, tags et listes, jamais les ids
 *  (régénérés à chaque import). Une seule fonction pour que le fichier écrit
 *  et la signature comparée soient forcément d'accord. */
const backupJson = (songs, tags, lists) =>
  JSON.stringify({ songs: songs.map(({ id, ...rest }) => rest), tags, lists }, null, 1);

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

/* Listes : des sous-ensembles nommés du carnet (concert, répertoire du
   moment…). Même mécanique que les tags : ancrées par songKey (les ids sont
   régénérés à chaque import), hors de l'URL de partage, mais dans la
   sauvegarde en fichier. */
const LISTS_KEY = "lists:v1";
const freshLists = () => ({ defs: [], byKey: {} });

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
  return { defs, byKey };
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
  return { defs, byKey };
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

/** Score d'apprentissage : une décimale au plus, virgule française. */
const fmtMemo = (m) => (Math.round(Number(m) * 10) / 10).toFixed(1).replace(/\.0$/, "").replace(".", ",");
/** Jamais 0 (qui supprimerait la clé memo), jamais plus d'une décimale. */
const clampMemo = (m) => Math.min(5, Math.max(0.1, Math.round(m * 10) / 10));
/** Un pas de score : moyenne mobile exponentielle vers 5 (« savais ») ou 0
 *  (« savais pas »). α dépend du nombre d'unités de la chanson pour qu'une
 *  session complète pèse ~50 % du score, courte ou longue — et qu'une seule
 *  réponse de quiz pèse « une unité de cette chanson ». */
const emaStep = (memo, known, units) => {
  const a = Math.min(0.5, Math.max(0.03, 1 - 0.5 ** (1 / Math.max(1, units))));
  const base = Number(memo) > 0 ? Number(memo) : 2.5;
  return base + a * ((known ? 5 : 0) - base);
};

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

// Les polices sont chargées par un <link> de l'index.html, et non par un
// @import ici : c'est ce qui permet au service worker de les garder en cache
// pour les vols sans réseau. Sans elles, les polices système prennent le
// relais (font-family plus bas).
const CSS = `
.cb, .cb * { box-sizing:border-box; }
.cb { --bg:#111216; --panel:#181A1F; --panel2:#20232A; --line:#2E323B;
  --ink:#ECE9E3; --muted:#878C97; --amber:#E9B44C; --amber-dim:#8A6B2A; --hot:#C8503C;
  --ok:#5FA971; --ok-soft:rgba(95,169,113,.14);
  /* Voiles translucides de l'accent — fonds actifs, survols, surlignage.
     En variables pour que le mode clair les recolore avec son propre accent. */
  --acc-soft:rgba(233,180,76,.12); --acc-faint:rgba(233,180,76,.07); --acc-glow:rgba(233,180,76,.16);
  /* Zones réservées par le système — barre d'état, indicateur d'accueil, encoche en
     paysage. Nulles partout ailleurs, donc sans effet sur un écran ordinaire. En
     variables plutôt qu'en env() dispersés : c'est ce qui rend la mise en page
     vérifiable ailleurs que sur un iPhone. */
  --sat:env(safe-area-inset-top, 0px); --sab:env(safe-area-inset-bottom, 0px);
  --sal:env(safe-area-inset-left, 0px); --sar:env(safe-area-inset-right, 0px);
  position:absolute; inset:0; display:flex; flex-direction:column; background:var(--bg); color:var(--ink);
  padding-left:var(--sal); padding-right:var(--sar);
  font-family:'Archivo', ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing:antialiased; overflow:hidden; }
/* Mode clair : un beau gris très pâle, la même encre, et le cobalt en accent
   — vif et lisible en plein jour, sans rien de brun. */
.cb.light { --bg:#F5F6F9; --panel:#FFFFFF; --panel2:#ECEEF4; --line:#D6DAE3;
  --ink:#1D1F26; --muted:#6B7280; --amber:#2E5BD7; --amber-dim:#93A8E8; --hot:#C23A2B;
  --ok:#1E7C46; --ok-soft:rgba(30,124,70,.10);
  --acc-soft:rgba(46,91,215,.10); --acc-faint:rgba(46,91,215,.06); --acc-glow:rgba(46,91,215,.14); }
.cb.light .btn.primary { color:#FFF; }
.cb.light .speedfly { background:rgba(255,255,255,.94); box-shadow:0 4px 16px rgba(0,0,0,.18); }
.cb.light .modal { background:rgba(0,0,0,.35); }
.cb button { font:inherit; color:inherit; background:none; border:none; cursor:pointer; }
/* Champs de fichier pilotés par un bouton : rendus mais invisibles. Un input en
   display:none n'ouvre pas toujours le sélecteur iOS quand on le clique par script. */
.vhide { position:absolute; width:1px; height:1px; padding:0; margin:-1px; border:0;
  overflow:hidden; clip:rect(0 0 0 0); clip-path:inset(50%); opacity:0; }
.cb :focus-visible { outline:2px solid var(--amber); outline-offset:2px; }
.top { display:flex; align-items:center; gap:12px; padding:calc(12px + var(--sat)) 16px 10px;
  border-bottom:1px solid var(--line); background:var(--panel); flex:0 0 auto; }
.brand { font-family:'Barlow Condensed'; font-weight:700; font-size:19px; letter-spacing:.14em; text-transform:uppercase; line-height:1; }
.brand span { color:var(--amber); }
.vu { display:flex; gap:3px; align-items:flex-end; height:16px; }
.vu i { width:2px; background:var(--line); border-radius:1px; }
.vu i.on { background:var(--amber); }
.spacer { flex:1; }
.iconbtn { width:34px; height:34px; border-radius:8px; border:1px solid var(--line); display:grid; place-items:center;
  color:var(--muted); background:var(--panel2); font-size:16px; }
.iconbtn:hover { color:var(--ink); border-color:var(--amber-dim); }
/* Bouton-état de la barre du haut : révision en cours, accords affichés, défilement. */
.iconbtn.on { color:var(--amber); border-color:var(--amber-dim); background:var(--acc-soft); }
.iconbtn:disabled { opacity:.4; cursor:default; }
@media (max-width:374px) { .top { gap:8px; } }
/* Un point ambre : le carnet a changé depuis la dernière sauvegarde en fichier. */
.iconbtn.nudge { position:relative; }
.iconbtn.nudge::after { content:''; position:absolute; top:4px; right:4px; width:6px; height:6px;
  border-radius:50%; background:var(--amber); box-shadow:0 0 0 2px var(--panel); }
.lib { flex:1; overflow-y:auto; padding:14px 16px calc(28px + var(--sab)); }
.search { width:100%; padding:11px 13px; border-radius:10px; border:1px solid var(--line); background:var(--panel);
  color:var(--ink); font-size:15px; margin-bottom:12px; }
.search::placeholder { color:var(--muted); }
.count { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.16em; color:var(--muted); text-transform:uppercase; margin:0 0 10px; }
.notice { position:relative; border:1px solid var(--amber-dim); background:var(--acc-faint); border-radius:10px;
  padding:11px 40px 11px 13px; font-size:13px; line-height:1.5; margin-bottom:12px; }
.noticeclose { position:absolute; top:7px; right:7px; width:26px; height:26px; border-radius:7px; display:grid;
  place-items:center; color:var(--muted); font-size:13px; line-height:1; }
.noticeclose:hover { color:var(--ink); background:var(--acc-soft); }
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
.seg2 button.on { color:var(--amber); background:var(--acc-soft); }
.seg2 .sortdir { font-style:normal; margin-left:5px; font-size:11px; }
.btn.slim { padding:8px 14px; font-size:13.5px; }
.card h3 { margin:0; font-family:'Barlow Condensed'; font-weight:600; font-size:21px; letter-spacing:.03em; text-transform:uppercase; line-height:1.05; }
.card p { margin:2px 0 0; font-size:12.5px; color:var(--muted); }
.tag { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.1em; text-transform:uppercase; border:1px solid var(--line);
  color:var(--muted); border-radius:6px; padding:3px 7px; flex:0 0 auto; }
/* Tags : icône seule dans la liste, icône + nom partout où la place existe. */
.tagrow { display:flex; gap:4px; flex:0 0 auto; }
.tagdot { font-size:13px; line-height:1.15; padding:3px 5px; border-radius:6px; border:1px solid; }
.tagchip { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:8px;
  border:1px solid var(--line); background:var(--panel2); color:var(--muted); font-size:12.5px; }
.tagchip b { font-family:'JetBrains Mono'; font-size:10px; }
.tagchip:hover { border-color:var(--amber-dim); }
/* Les tags actifs portent leur couleur en style inline ; les chips sans
   couleur propre (listes) prennent l'ambre par défaut. */
.tagchip.on { color:var(--amber); border-color:var(--amber-dim); background:var(--acc-soft); }
.cardmemo { font-family:'JetBrains Mono'; font-size:11px; letter-spacing:.06em; color:var(--amber); flex:0 0 auto; }
.listsel { flex:1; min-width:0; padding:9px 11px; border-radius:8px; border:1px solid var(--line);
  background:var(--panel2); color:var(--ink); font-size:13.5px; }
.tagpick { display:flex; gap:6px; flex-wrap:wrap; width:100%; }
.tagedit { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.tagedit input { flex:1; min-width:110px; padding:10px 12px; border-radius:9px; border:1px solid var(--line);
  background:var(--panel); color:var(--ink); font-size:15px; }
.tagedit input.tagicon { flex:0 0 54px; min-width:0; text-align:center; font-size:17px; padding:9px 4px; }
.swatches { display:flex; gap:5px; }
.swatch { width:22px; height:22px; border-radius:6px; border:1px solid rgba(0,0,0,.35); }
.swatch.on { box-shadow:0 0 0 2px var(--bg), 0 0 0 4px var(--ink); }
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
/* Repli du menu par grille 0fr/1fr : la hauteur du contenu ne compte plus,
   contrairement à un max-height figé qui rognerait un menu qui grandit. */
.barwrap { display:grid; grid-template-rows:1fr; opacity:1; transition:grid-template-rows .28s ease, opacity .22s; }
.barwrap.folded { grid-template-rows:0fr; opacity:0; }
.barwrap > * { overflow:hidden; min-height:0; }
.artist { font-size:12.5px; color:var(--muted); margin:3px 0 0; letter-spacing:.04em; }
/* Menu de la chanson : des rangées label à gauche / contrôle à droite,
   toutes alignées sur la même grille — pas de flex-wrap qui zigzague. */
.menu { display:flex; flex-direction:column; gap:9px; margin-top:12px; }
.mrow { display:grid; grid-template-columns:1fr auto; align-items:center; gap:10px; }
.mlab { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); }
.mact { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:3px; }
/* Étoiles de mémorisation. */
.stars { display:flex; gap:2px; }
.memocell { display:flex; align-items:center; gap:8px; }
.memoval { font-family:'JetBrains Mono'; font-size:12px; color:var(--amber); }
.star { font-size:21px; line-height:1; padding:3px 4px; color:var(--line); }
.star.on { color:var(--amber); }
.stars.big .star { font-size:32px; padding:5px 6px; }
.stepper { display:flex; align-items:center; border:1px solid var(--line); border-radius:8px; background:var(--panel2); overflow:hidden; }
.stepper button { width:30px; height:31px; color:var(--muted); font-size:15px; line-height:1; }
.stepper button:hover { color:var(--amber); background:var(--acc-faint); }
.stepper span { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.1em; color:var(--muted); padding:0 8px;
  text-transform:uppercase; min-width:70px; text-align:center; }
.stepper span b { color:var(--ink); font-weight:700; }
.sheet { flex:1; overflow-y:auto; padding:20px 16px calc(120px + var(--sab)); }
.sheetinner { max-width:760px; margin:0 auto; }
.sec { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--amber);
  margin:26px 0 10px; display:flex; align-items:center; gap:10px; }
.sec:first-child { margin-top:0; }
.sec::after { content:''; flex:1; height:1px; background:var(--line); }
.row { display:flex; flex-wrap:wrap; align-items:flex-end; margin-bottom:2px; }
.row, .plain { transition:filter .4s, opacity .4s; }
.masked { filter:blur(8px); opacity:.35; user-select:none; pointer-events:none; }
.revbar { position:absolute; left:0; right:0; bottom:0; z-index:4; display:flex; flex-direction:column; gap:9px;
  padding:10px 16px calc(14px + var(--sab));
  background:linear-gradient(to top, var(--bg) 72%, transparent); }
.revbar .inner { max-width:760px; margin:0 auto; width:100%; display:flex; flex-direction:column; gap:9px; }
.revprog { display:flex; align-items:center; gap:10px; font-family:'JetBrains Mono'; font-size:10px;
  letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.revprog b { color:var(--amber); }
.revtrack { flex:1; height:3px; background:var(--line); border-radius:2px; overflow:hidden; }
.revfill { height:100%; background:var(--amber); transition:width .3s; }
.revrow { display:flex; gap:8px; align-items:stretch; }
.revrow .iconbtn { width:44px; height:auto; flex:0 0 auto; }
.revmain { flex:1; padding:14px 16px; font-size:17px; min-width:0; }
/* Réponses « savais / savais pas » : vert et rouge, côte à côte à 375 px. */
.btn.know { color:var(--ok); border-color:var(--ok); background:var(--ok-soft); }
.btn.dont { color:var(--hot); border-color:var(--hot); background:none; }
.revrow .revmain.know, .revrow .revmain.dont { padding-left:6px; padding-right:6px; font-size:15px; white-space:nowrap; }
.iconbtn.stop { color:var(--hot); }
.revscore { color:var(--amber); }
.seg { display:inline-flex; flex-direction:column; }
.ch { font-family:'JetBrains Mono'; font-weight:700; color:var(--amber); font-size:.74em; line-height:1.5; white-space:pre; padding-right:8px; }
.ch.tappable { cursor:pointer; border-radius:4px; padding:6px 8px 2px 2px; margin:-6px -8px -2px -2px; }
.ch.tappable:active { background:var(--acc-glow); }
.ly { white-space:pre-wrap; line-height:1.42; }
.plain { line-height:1.55; margin-bottom:2px; white-space:pre-wrap; }
.gap { height:14px; }
.form { flex:1; overflow-y:auto; padding:18px 16px calc(40px + var(--sab)); }
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
.flow { position:absolute; inset:0; z-index:6; background:var(--bg); display:flex; flex-direction:column; }
.flowtop { display:flex; align-items:center; gap:10px; padding:calc(10px + var(--sat)) 14px 10px;
  border-bottom:1px solid var(--line); background:var(--panel); flex:0 0 auto; }
.flowprog { flex:1; display:flex; align-items:center; gap:10px; min-width:0;
  font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.12em; color:var(--muted); white-space:nowrap; }
.flowprog b { color:var(--amber); }
.flowtrack { flex:1; display:flex; overflow-x:auto; overflow-y:hidden; scroll-snap-type:x mandatory;
  overscroll-behavior-x:contain; scrollbar-width:none; }
.flowtrack::-webkit-scrollbar { display:none; }
.slide { flex:0 0 100%; width:100%; scroll-snap-align:start; scroll-snap-stop:always;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:clamp(8px, 2.2vh, 18px); padding:8px 20px 16px; text-align:center; }
.flowsec { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.2em; text-transform:uppercase;
  color:var(--amber); min-height:13px; }
.flowlyric { font-size:17px; line-height:1.5; color:var(--muted); max-width:600px; min-height:2.9em;
  display:flex; align-items:center; justify-content:center; white-space:pre-wrap; }
.flowlyric .hl { color:var(--ink); background:var(--acc-glow); box-shadow:inset 0 -2px var(--amber);
  border-radius:3px; padding:0 3px; font-weight:600; font-style:normal; }
.flowinstru { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.16em; text-transform:uppercase; }
.flowchord { font-family:'Barlow Condensed'; font-weight:700; line-height:1;
  font-size:clamp(56px, 15vw, 104px); color:var(--amber); letter-spacing:.02em; }
.flowdiag svg { width:min(78vw, 330px); height:auto; display:block; }
.flowmeta { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.12em; text-transform:uppercase;
  color:var(--muted); min-height:13px; }
.flowbottom { flex:0 0 auto; display:flex; align-items:center; gap:10px;
  padding:10px 14px calc(14px + var(--sab)); }
.flowchip { border:1px solid var(--line); border-radius:8px; padding:9px 13px; font-family:'JetBrains Mono';
  font-size:12px; color:var(--muted); min-width:72px; background:var(--panel2); white-space:nowrap; }
.flowchip:disabled { opacity:.35; cursor:default; }
.flowchip:hover:not(:disabled) { color:var(--amber); border-color:var(--amber-dim); }
.flowhint { display:none; }
/* Vitesse : n'existe que pendant le défilement, flotte au-dessus de la feuille. */
.speedfly { position:absolute; right:12px; bottom:calc(14px + var(--sab)); z-index:4;
  border:1px solid var(--line); border-radius:10px; background:rgba(24,26,31,.94);
  box-shadow:0 4px 16px rgba(0,0,0,.45); }
.speedfly .stepper { border:none; background:none; }
/* Popup de fin de révision — au-dessus de la revbar (z-index 4). */
.modal { position:absolute; inset:0; z-index:8; display:flex; align-items:center; justify-content:center;
  padding:20px; background:rgba(0,0,0,.55); }
.modalbox { width:100%; max-width:340px; background:var(--panel); border:1px solid var(--line);
  border-radius:14px; padding:24px 20px 20px; text-align:center;
  display:flex; flex-direction:column; align-items:center; gap:12px; }
.modalicon { font-size:34px; line-height:1; }
.modalbox h2 { font-family:'Barlow Condensed'; text-transform:uppercase; letter-spacing:.08em;
  font-size:22px; margin:0; color:var(--amber); }
.modalbox p { margin:0; font-size:13.5px; color:var(--muted); line-height:1.5; }
.modalscore { font-family:'Barlow Condensed'; font-weight:700; font-size:42px; line-height:1; color:var(--amber); }
@media (min-width:720px) { .sheet { padding:26px 32px calc(130px + var(--sab)); }
  .lib { padding:18px 32px calc(32px + var(--sab)); }
  .flowdiag svg { width:min(44vh, 380px); }
  .flowhint { display:block; text-align:center; font-family:'JetBrains Mono'; font-size:9.5px;
    letter-spacing:.14em; text-transform:uppercase; color:var(--muted); padding:0 0 10px; } }
@media (prefers-reduced-motion:reduce) { .cb * { transition:none !important; } }
`;

/* ------------------------------------------------------------------ */

function VU() {
  const h = [5, 9, 6, 13, 8, 16, 11, 7];
  return <div className="vu" aria-hidden="true">{h.map((v, i) => <i key={i} className={i < 5 ? "on" : ""} style={{ height: v }} />)}</div>;
}

/* ------------------------------------------------------------------ */
/* Diagrammes d'accords : SVG dessinés en code, couleurs du thème.     */
/* ------------------------------------------------------------------ */

const WHITE_PITCH = [0, 2, 4, 5, 7, 9, 11];
const BLACK_LEFT = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 }; // pitch → blanche à sa gauche

/** Clavier de 2 octaves ; touches de l'accord marquées d'une pastille :
 *  pleine = fondamentale, cerclée = autres notes, rouge = basse slash. */
function PianoDiagram({ parsed }) {
  const W = 26, H = 86, BW = 15, BH = 54;
  const whites = [], blacks = [];
  for (let o = 0; o < 2; o++) {
    WHITE_PITCH.forEach((p, i) => whites.push({ semi: o * 12 + p, x: (o * 7 + i) * W }));
    Object.entries(BLACK_LEFT).forEach(([p, left]) =>
      blacks.push({ semi: o * 12 + Number(p), x: (o * 7 + Number(left) + 1) * W - BW / 2 }));
  }
  const notes = new Set(parsed.intervals.map((iv) => {
    let n = parsed.rootSemi + iv;
    while (n > 23) n -= 12;
    return n;
  }));
  const dot = (k, black) => {
    const isRoot = k.semi === parsed.rootSemi;
    const isBass = parsed.bassSemi != null && k.semi === parsed.bassSemi && !notes.has(k.semi);
    if (!notes.has(k.semi) && !isBass) return null;
    const cx = k.x + (black ? BW / 2 : W / 2);
    const cy = black ? BH - 10 : H - 12;
    return <circle key={"d" + k.semi} cx={cx} cy={cy} r={5.5}
      fill={isBass ? "var(--hot)" : isRoot ? "var(--amber)" : black ? "#15161A" : "#F2EFE8"}
      stroke={isBass ? "var(--hot)" : "var(--amber)"} strokeWidth={2} />;
  };
  return (
    <svg viewBox={`-1 -1 ${14 * W + 2} ${H + 2}`} role="img" aria-label={"Accord " + parsed.label + " au piano"}>
      {whites.map((k) => (
        <rect key={k.semi} x={k.x} y={0} width={W} height={H} rx={2}
          fill="#F2EFE8" stroke="#3A3E48" strokeWidth={1} />
      ))}
      {whites.map((k) => dot(k, false))}
      {blacks.map((k) => (
        <rect key={k.semi} x={k.x} y={0} width={BW} height={BH} rx={2}
          fill="#15161A" stroke="#3A3E48" strokeWidth={1} />
      ))}
      {blacks.map((k) => dot(k, true))}
    </svg>
  );
}

/** Grille de manche : cordes verticales (Mi grave à gauche), pastilles,
 *  barré, cordes à vide (o) et étouffées (×), numéro de case si déplacé. */
function GuitarDiagram({ pos, label }) {
  const { frets, barre } = pos;
  const fretted = frets.filter((f) => f > 0);
  const maxF = fretted.length ? Math.max(...fretted) : 1;
  const minF = fretted.length ? Math.min(...fretted) : 1;
  const start = maxF <= 4 ? 1 : minF;
  const rows = Math.max(4, maxF - start + 1);
  const SX = 30, SY = 32, X0 = 34, Y0 = 30;
  const width = X0 * 2 + SX * 5, height = Y0 + SY * rows + 10;
  const sx = (i) => X0 + i * SX;
  const fy = (f) => Y0 + (f - start + 0.5) * SY;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={"Accord " + label + " à la guitare"}>
      {start === 1
        ? <rect x={sx(0) - 1.5} y={Y0 - 5} width={SX * 5 + 3} height={5} rx={1.5} fill="var(--ink)" />
        : <text x={X0 - 14} y={Y0 + SY * 0.5 + 4} textAnchor="end" fontSize="13"
            fontFamily="'JetBrains Mono', monospace" fill="var(--muted)">{start}fr</text>}
      {Array.from({ length: rows + 1 }, (_, r) => (
        <line key={"f" + r} x1={sx(0)} y1={Y0 + r * SY} x2={sx(5)} y2={Y0 + r * SY}
          stroke="var(--line)" strokeWidth={r === 0 && start === 1 ? 0 : 1.5} />
      ))}
      {frets.map((_, i) => (
        <line key={"s" + i} x1={sx(i)} y1={Y0} x2={sx(i)} y2={Y0 + rows * SY}
          stroke="#4A4F5A" strokeWidth={1.5} />
      ))}
      {barre && (
        <rect x={sx(barre.from) - 9} y={fy(barre.fret) - 9} width={sx(barre.to) - sx(barre.from) + 18}
          height={18} rx={9} fill="var(--amber)" opacity={0.9} />
      )}
      {frets.map((f, i) => {
        if (f > 0 && (!barre || f !== barre.fret || i < barre.from || i > barre.to)) {
          return <circle key={"n" + i} cx={sx(i)} cy={fy(f)} r={9} fill="var(--amber)" />;
        }
        if (f === 0) {
          return <circle key={"n" + i} cx={sx(i)} cy={Y0 - 14} r={4.5}
            fill="none" stroke="var(--muted)" strokeWidth={1.6} />;
        }
        if (f === -1) {
          return <text key={"n" + i} x={sx(i)} y={Y0 - 9.5} textAnchor="middle" fontSize="13"
            fontFamily="'JetBrains Mono', monospace" fill="var(--muted)">×</text>;
        }
        return null;
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Mode visualisation : la chanson accord par accord, en plein écran.  */
/* Carrousel scroll-snap natif : un swipe = un accord. Seules les      */
/* slides voisines (±2) montent leur contenu — les autres restent des  */
/* boîtes vides qui préservent la géométrie des points d'accroche.     */
/* ------------------------------------------------------------------ */

/** Étend le fragment chanté aux frontières de mots, pour ne jamais
 *  surligner un mot coupé en deux. */
function segmentBounds(line, s0, e0) {
  let s = Math.max(0, Math.min(s0, line.length));
  let e = Math.max(s, Math.min(e0, line.length));
  while (s > 0 && !/\s/.test(line[s - 1])) s--;
  while (e < line.length && !/\s/.test(line[e])) e++;
  while (s < e && /\s/.test(line[s])) s++;
  while (e > s && /\s/.test(line[e - 1])) e--;
  return [s, e];
}

function FlowSlide({ ev, instrument, posIndex }) {
  const positions = instrument === "guitar" ? guitarPositions(ev.parsed) : [];
  const pos = positions[Math.min(posIndex, positions.length - 1)] || null;
  // Les espaces de bord viennent de l'alignement des accords : on les retire
  // en décalant d'autant le segment surligné.
  const lead = ev.line ? /^\s*/.exec(ev.line)[0].length : 0;
  const line = ev.line ? ev.line.trim() : "";
  const [s0, e0] = ev.line ? segmentBounds(ev.line, ev.segStart, ev.segEnd) : [0, 0];
  const s = Math.max(0, Math.min(s0 - lead, line.length));
  const e = Math.max(s, Math.min(e0 - lead, line.length));
  const meta = [chordNoteNames(ev.parsed).join(" · ")];
  if (instrument === "guitar" && pos && pos.bassMissing) meta.push("basse : " + ev.parsed.bass);
  if (instrument === "guitar" ? (pos && pos.approx) : !ev.parsed.exact) meta.push("approx.");
  return (
    <>
      <div className="flowsec">{ev.section}</div>
      <div className="flowlyric">
        <span>
          {line && s < e ? (
            <>{line.slice(0, s)}<b className="hl">{line.slice(s, e)}</b>{line.slice(e)}</>
          ) : line ? line : <span className="flowinstru">— instrumental —</span>}
        </span>
      </div>
      <div className="flowchord">{ev.parsed.label}</div>
      <div className="flowdiag">
        {instrument === "guitar" && pos
          ? <GuitarDiagram pos={pos} label={ev.parsed.label} />
          : <PianoDiagram parsed={ev.parsed} />}
      </div>
      <div className="flowmeta">{meta.join("  ·  ")}</div>
    </>
  );
}

function ChordFlow({ events, index, setIndex, instrument, setInstrument, onClose }) {
  const trackRef = useRef(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const [posIndex, setPosIndex] = useState(0);
  useEffect(() => { setPosIndex(0); }, [index, instrument]);

  // Positionnement initial, sans animation : on arrive direct sur l'accord.
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (el) el.scrollLeft = indexRef.current * el.clientWidth;
  }, []);

  const go = (i) => {
    const el = trackRef.current;
    if (!el) return;
    const k = Math.max(0, Math.min(events.length - 1, i));
    if (k === indexRef.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: k * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
    setIndex(k);
  };

  // Suivi de l'index au doigt : pas de scrollend sur Safari, on arrondit.
  const onScroll = () => {
    const el = trackRef.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== indexRef.current && i >= 0 && i < events.length) setIndex(i);
  };

  useEffect(() => {
    const h = (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); go(indexRef.current + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(indexRef.current - 1); }
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // Rotation / redimensionnement : scrollLeft ne suit pas la largeur.
  useEffect(() => {
    const onResize = () => {
      const el = trackRef.current;
      if (el) el.scrollTo({ left: indexRef.current * el.clientWidth, behavior: "auto" });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const ev = events[index];
  const positions = instrument === "guitar" && ev ? guitarPositions(ev.parsed) : [];
  const pos = Math.min(posIndex, Math.max(0, positions.length - 1));
  const posFretted = positions[pos] ? positions[pos].frets.filter((f) => f > 0) : [];
  const posFret = posFretted.length ? Math.min(...posFretted) : 0;
  const prev = events[index - 1], next = events[index + 1];

  return (
    <div className="flow" role="dialog" aria-label={ev ? "Accord " + ev.parsed.label : "Accords"}>
      <div className="flowtop">
        <button className="iconbtn" title="Fermer" aria-label="Fermer la visualisation" onClick={onClose}>✕</button>
        <div className="flowprog">
          <div className="revtrack"><div className="revfill" style={{ width: `${((index + 1) / events.length) * 100}%` }} /></div>
          <span><b>{index + 1}</b> / {events.length}</span>
        </div>
        <div className="seg2">
          <button className={instrument === "guitar" ? "on" : ""} aria-pressed={instrument === "guitar"}
            onClick={() => setInstrument("guitar")}>Guitare</button>
          <button className={instrument === "piano" ? "on" : ""} aria-pressed={instrument === "piano"}
            onClick={() => setInstrument("piano")}>Piano</button>
        </div>
      </div>
      <div className="flowtrack" ref={trackRef} onScroll={onScroll}>
        {events.map((e2, k) => (
          <div className="slide" key={k}>
            {Math.abs(k - index) <= 2 && (
              <FlowSlide ev={e2} instrument={instrument} posIndex={k === index ? pos : 0} />
            )}
          </div>
        ))}
      </div>
      <div className="flowbottom">
        <button className="flowchip" disabled={!prev} onClick={() => go(index - 1)}
          title="Accord précédent">{prev ? "‹ " + prev.parsed.label : "‹"}</button>
        <div className="spacer" />
        {instrument === "guitar" && positions.length > 1 && (
          <div className="stepper">
            <button onClick={() => setPosIndex(Math.max(0, pos - 1))} title="Position plus basse">◀</button>
            <span>pos <b>{pos + 1}</b>/{positions.length} · {posFret ? posFret + "fr" : "ouvert"}</span>
            <button onClick={() => setPosIndex(Math.min(positions.length - 1, pos + 1))} title="Position plus haute">▶</button>
          </div>
        )}
        <div className="spacer" />
        <button className="flowchip" disabled={!next} onClick={() => go(index + 1)}
          title="Accord suivant">{next ? next.parsed.label + " ›" : "›"}</button>
      </div>
      <div className="flowhint">← → pour naviguer · Échap pour fermer</div>
    </div>
  );
}

/** maskFrom : en révision, numéro d'unité à partir duquel le texte est
 *  flouté ; maskUnits donne l'unité de chaque bloc (null = jamais masqué :
 *  sections, blancs, instrumentales). La structure guide, le texte se mérite. */
function Sheet({ blocks, showChords, size, maskFrom, maskUnits, onChordTap }) {
  // Dernier bloc de l'unité tout juste révélée : c'est lui qu'on recentre.
  let frontierBlock = -1;
  if (maskFrom != null && maskUnits) {
    for (let i = 0; i < blocks.length; i++) if (maskUnits[i] === maskFrom - 1) frontierBlock = i;
  }
  return (
    <div className="sheetinner" style={{ fontSize: size }}>
      {blocks.map((b, i) => {
        if (b.type === "section") return <div className="sec" key={i}>{b.label}</div>;
        if (b.type === "blank") return <div className="gap" key={i} />;
        const unit = maskUnits ? maskUnits[i] : null;
        const masked = maskFrom != null && unit != null && unit >= maskFrom;
        const frontier = i === frontierBlock;
        const cls = masked ? " masked" : "";
        const fr = frontier ? "1" : undefined;
        if (b.type === "text") return <div className={"plain" + cls} data-frontier={fr} key={i}>{b.text}</div>;
        if (!showChords) {
          // Les blancs venaient de l'alignement des accords : on les résorbe.
          const text = b.cells.map((c) => c.lyrics).join("").replace(/\s+/g, " ").trim();
          return text ? <div className={"plain" + cls} data-frontier={fr} key={i}>{text}</div> : <div className="gap" key={i} />;
        }
        return (
          <div className={"row" + cls} data-frontier={fr} data-bi={i} key={i}>
            {b.cells.map((c, j) => {
              // Un vrai accord ouvre la visualisation ; les jetons (N.C., x2…)
              // restent du texte. onClick uniquement : un scroll au doigt ne
              // produit pas de click, donc pas d'ouverture accidentelle.
              const tappable = onChordTap && !masked && parseChordSymbol(c.chord);
              return (
                <span className="seg" key={j}>
                  {tappable ? (
                    <span className="ch tappable" role="button" tabIndex={0}
                      title={"Voir l'accord " + c.chord}
                      onClick={() => onChordTap(i, j)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChordTap(i, j); }
                      }}>{c.chord}</span>
                  ) : (
                    <span className="ch">{c.chord}</span>
                  )}
                  <span className="ly">{c.lyrics}</span>
                </span>
              );
            })}
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

function Transfer({ library, tags, lists, engine, backup, dirty, onImport, onShareUrl, onSaved, onClose }) {
  const { songs } = library;
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [urlMsg, setUrlMsg] = useState("");
  const [share, setShare] = useState(null);
  const [fileMsg, setFileMsg] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const fileRef = useRef(null);
  // Le fichier de sauvegarde porte les grilles, les tags ET les listes ;
  // l'URL de partage, elle, ne reçoit que le carnet (encodeShare plus bas).
  const json = useMemo(() => backupJson(songs, tags, lists), [songs, tags, lists]);

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
      if (/^[\[{]/.test(t)) {
        const parsed = JSON.parse(t);
        lib = normalizeLibrary(parsed);
        addedTags = normalizeTags(parsed && parsed.tags);
        addedLists = normalizeLists(parsed && parsed.lists);
      } else {
        const data = extractShareData(t);
        if (!data) throw new Error();
        lib = await decodeShareData(data);
      }
      onImport(lib.songs, lib, addedTags, addedLists);
      const withTags = addedTags && (addedTags.defs.length || Object.keys(addedTags.byKey).length);
      setMsg(`${lib.songs.length} grille(s) ajoutée(s)${withTags ? ", tags compris" : ""}.`);
      if (raw == null) setText("");
    } catch {
      setMsg("Texte non reconnu. Attendu : une liste JSON avec title, artist et body, ou un code/URL généré par « Partager par URL ».");
    }
  };

  /** Sur iPhone, la feuille de partage d'un *fichier* propose « Enregistrer dans
   *  Fichiers », donc iCloud Drive — et elle fonctionne depuis l'app installée, là
   *  où un téléchargement classique est capricieux. Ailleurs, téléchargement. Rien
   *  d'asynchrone avant navigator.share : le geste de l'utilisateur serait perdu. */
  /** Nom daté et horodaté. Un nom fixe serait plus propre, mais iOS ne propose
   *  pas de remplacer : il numérote en silence (« carnet-accords 2.json »), ce
   *  qui donne une pile indiscernable. Avec la date et l'heure, la pile reste
   *  chronologique et la dernière sauvegarde se reconnaît au premier coup d'œil. */
  const saveFile = () => {
    const d = new Date();
    const p2 = (v) => String(v).padStart(2, "0");
    const name = `carnet-accords-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      + `-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
    const file = new File([json], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      setFileMsg("");
      navigator.share({ files: [file], title: "Sauvegarde du Carnet d'accords" })
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
            {songs.length} chanson{plural(songs.length)} et {tags.defs.length} tag{plural(tags.defs.length)},
            dans un fichier daté à la minute — <b>carnet-accords-{new Date().getFullYear()}-…json</b>.{" "}
            {isIOS
              ? <>« Enregistrer » ouvre la feuille de partage : choisissez <b>Enregistrer dans Fichiers</b>, par exemple
                dans iCloud Drive. iOS ne sait pas remplacer un fichier existant — il numérote —, d'où la date dans le
                nom : la dernière sauvegarde est celle du haut, les précédentes se suppriment depuis Fichiers.</>
              : <>La date dans le nom garde la pile lisible ; les anciennes sauvegardes se suppriment à la main.</>}
          </p>
          <p className="hint" style={{ marginTop: 6, color: dirty ? "var(--amber)" : undefined }}>
            {backup
              ? <>Dernière sauvegarde : <b>{dateFmt(backup.at)}</b>{dirty ? " — le carnet a changé depuis." : " — à jour."}</>
              : songs.length > 0
                ? "Aucune sauvegarde enregistrée depuis cet appareil."
                : "Carnet vide : rien à sauvegarder pour l'instant."}
          </p>
        </div>
        <div className="actions">
          <button className="btn primary" disabled={!songs.length} onClick={saveFile}>Enregistrer</button>
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
            touchez <b>Partager</b> → <b>« Sur l'écran d'accueil »</b>. L'icône créée rouvrira le carnet avec ses grilles.</>
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
              <textarea id="imp" value={text} placeholder={'https://…#v=1&data=…'}
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
  const [sortDir, setSortDir] = useState("asc"); // re-taper le tri actif inverse l'ordre
  const [size, setSize] = useState(17);
  const [scrolling, setScrolling] = useState(false);
  const [speed, setSpeed] = useState(3);
  const [barOpen, setBarOpen] = useState(true);
  const [flowIndex, setFlowIndex] = useState(null); // null = fermé, sinon index d'accord
  const [instrument, setInstrument] = useState("guitar"); // "guitar" | "piano"
  const [reviseMode, setReviseMode] = useState(null); // null | "seq" | "random" | "quiz"
  const [reviseStart, setReviseStart] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const [judged, setJudged] = useState(0); // unités « savais / savais pas » répondues cette session
  const [memoPrompt, setMemoPrompt] = useState(false); // popup de score en fin de révision
  const [memoDraft, setMemoDraft] = useState(0);
  const memoPromptedRef = useRef(false); // une seule apparition par session de révision
  const memoLiveRef = useRef(null); // score non arrondi de la session — l'arrondi à une décimale gèlerait les petits pas
  const memoBeforeRef = useRef(null); // score au départ de la session, pour le popup de fin
  const draggingRef = useRef(false);
  const resumeRef = useRef(null);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState([]);
  // window.offline est posé par main.jsx (service worker) ; absent dans un
  // aperçu d'artefact, où le mode hors connexion n'existe pas.
  const [offline, setOffline] = useState(() => (window.offline ? window.offline.get() : null));
  const [tags, setTags] = useState(freshTags);
  const [tagFilter, setTagFilter] = useState([]);
  const [lists, setLists] = useState(freshLists);
  const [listFilter, setListFilter] = useState(""); // id de liste, "" = tout le carnet
  const [theme, setTheme] = useState("dark"); // "dark" | "light"
  const pendingReviseRef = useRef(false); // « Réviser au hasard » : démarrer dès la chanson ouverte
  const [quiz, setQuiz] = useState(null); // null | { asked, correct } — la partie survit aux changements de chanson
  const [quizEnd, setQuizEnd] = useState(null); // score affiché à l'arrêt de la partie
  const [quizQ, setQuizQ] = useState(0); // nonce de question : re-arme même quand le hasard retombe sur la même chanson
  const pendingQuizRef = useRef(false); // question à armer dès la chanson ouverte
  const quizDeadRef = useRef(new Set()); // chansons sans paroles croisées pendant la partie : écartées du vivier
  const [backup, setBackup] = useState(null); // { at, sig } de la dernière sauvegarde en fichier
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
      // Tags : hors du carnet partagé, donc chargés à part. Un enregistrement
      // vide est respecté (tags tous supprimés) ; seule leur absence remet les
      // quatre tags par défaut.
      const saved = await loadTags();
      const savedLists = await loadLists();
      const mark = await loadBackup();
      if (!alive) return;
      if (saved) setTags(saved);
      if (savedLists) setLists(savedLists);
      if (mark) setBackup(mark);
      if (typeof carnet.showChords === "boolean") setShowChords(carnet.showChords);
      if (carnet.size) setSize(carnet.size);
      if (carnet.speed) setSpeed(carnet.speed);
      if (carnet.sort === "title" || carnet.sort === "artist" || carnet.sort === "memo") setSort(carnet.sort);
      if (carnet.sortDir === "desc") setSortDir("desc");
      if (typeof carnet.barOpen === "boolean") setBarOpen(carnet.barOpen);
      if (carnet.theme === "light") setTheme("light");
      if (typeof carnet.listFilter === "string") setListFilter(carnet.listFilter);
      if (carnet.instrument === "piano" || carnet.instrument === "guitar") setInstrument(carnet.instrument);
      setReady(true);
      const lib = await loadChordSheetJS();
      if (!alive) return;
      setCS(lib);
      setCsTried(true);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { if (ready) saveLibrary({ songs, showChords, size, speed, sort, sortDir, barOpen, instrument, theme, listFilter }); }, [songs, showChords, size, speed, sort, sortDir, barOpen, instrument, theme, listFilter, ready]);
  useEffect(() => { if (ready) saveTags(tags); }, [tags, ready]);
  useEffect(() => { if (ready) saveLists(lists); }, [lists, ready]);

  // Sur iOS, aucune page web ne peut réécrire seule dans un fichier : la
  // sauvegarde reste un geste. À défaut de l'automatiser, l'app signale qu'elle
  // est due — point ambre sur ⇅, état détaillé dans la page Transfert.
  const currentSig = useMemo(() => signature(backupJson(songs, tags, lists)), [songs, tags, lists]);
  const dirty = ready && songs.length > 0 && (!backup || backup.sig !== currentSig);
  const markSaved = () => {
    const mark = { at: Date.now(), sig: currentSig };
    setBackup(mark);
    saveBackupMark(mark);
  };

  // Un effet ne doit rien renvoyer d'autre qu'une fonction de nettoyage.
  useEffect(() => (window.offline ? window.offline.subscribe(setOffline) : undefined), []);
  // L'état affiché dans les Réglages est relu à l'ouverture de la page.
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

  // La chanson vue comme suite d'accords, pour le mode visualisation.
  const { events, eventAt } = useMemo(() => chordEvents(blocks), [blocks]);

  const openFlow = (i = 0) => {
    if (!events.length) return;
    setScrolling(false);       // le défilement auto n'a pas de sens sous l'overlay
    setReviseMode(null);       // exclusif du mode révision, comme startRevise
    setFlowIndex(Math.max(0, Math.min(events.length - 1, i)));
  };
  const closeFlow = () => {
    const ev = events[flowIndex];
    setFlowIndex(null);
    // La feuille se cale sur la ligne de l'accord où l'on s'est arrêté.
    if (ev) requestAnimationFrame(() => {
      const el = sheetRef.current && sheetRef.current.querySelector(`[data-bi="${ev.blockIndex}"]`);
      if (el) el.scrollIntoView({ block: "center", behavior: "auto" });
    });
  };
  const onChordTap = (bi, ci) => {
    const k = eventAt.get(bi + ":" + ci);
    if (k != null) openFlow(k);
  };

  // Révision par unités : seuls les blocs qui portent des paroles se
  // masquent — les lignes d'accords seuls (intro, solo, break au milieu
  // d'un couplet…) restent en clair et ne comptent pas, quel que soit le
  // nom de leur section. Un refrain forme une seule unité révélée d'un
  // bloc ; le reste va ligne à ligne. byBlock[i] = unité du bloc i
  // (null = jamais masqué : sections, blancs, blocs sans paroles).
  const reviseUnits = useMemo(() => {
    const byBlock = new Array(blocks.length).fill(null);
    const kinds = [];
    let kind = "verse";
    let chorusUnit = -1; // unité de la section refrain en cours
    // Préambule : avant la première section, un bloc sans le moindre accord
    // est de la métadonnée d'import (titre, crédits, accordage), pas une
    // parole — jamais masqué ni compté. Les lignes accordées y restent
    // révisables (couplet non étiqueté), et sans aucune section tout reste
    // comme avant. Les deux parseurs rendent le texte pur en « row » à
    // accords vides, d'où le critère au contenu plutôt qu'au type.
    const firstSection = blocks.findIndex((b) => b.type === "section");
    const chordless = (b) => b.type === "text"
      || (b.type === "row" && b.cells.every((c) => !(c.chord || "").trim()));
    blocks.forEach((b, i) => {
      if (b.type === "section") { kind = sectionKind(b.label); chorusUnit = -1; return; }
      if (firstSection >= 0 && i < firstSection && chordless(b)) return;
      const lyrical = b.type === "row" ? b.cells.some((c) => c.lyrics.trim())
        : b.type === "text" ? !!b.text.trim() : false;
      if (!lyrical) return;
      if (kind === "chorus") {
        if (chorusUnit < 0) { chorusUnit = kinds.length; kinds.push("chorus"); }
        byBlock[i] = chorusUnit;
      } else {
        byBlock[i] = kinds.length;
        kinds.push("verse");
      }
    });
    return { byBlock, kinds };
  }, [blocks]);
  const revealables = reviseUnits.kinds.length;
  const visibleLines = Math.min(revealables, reviseStart + revealed);
  // Unités à juger cette session : celles à partir du point de départ — en
  // départ aléatoire, le contexte déjà visible n'est pas jugé. La session ne
  // finit qu'une fois la dernière unité révélée ET jugée.
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
   *  de la chanson, écrit à chaque fois : une session interrompue a déjà
   *  compté. Le pas part de la valeur non arrondie gardée en ref. */
  const applyAuto = (known) => {
    const next = emaStep(memoLiveRef.current ?? (current && current.memo), known, revealables);
    memoLiveRef.current = next;
    const m = clampMemo(next);
    setSongs((prev) => prev.map((s) => (s.id === currentId ? { ...s, memo: m, memoAuto: true } : s)));
  };
  /** Le jugement porte sur la dernière unité révélée : en révision, répondre
   *  révèle du même geste l'unité suivante ; en quiz, il enchaîne sur la
   *  chanson suivante. */
  const answer = (known) => {
    if (!reviseMode || revealed === 0) return;
    if (reviseMode === "quiz") {
      applyAuto(known);
      setQuiz((g) => g && { asked: g.asked + 1, correct: g.correct + (known ? 1 : 0) });
      quizNext();
      return;
    }
    if (judged >= toJudge) return;
    applyAuto(known);
    setJudged((j) => j + 1);
    revealNext();
  };

  // La ligne tout juste révélée (ou la fin du contexte en départ aléatoire)
  // est ramenée au centre de l'écran.
  useEffect(() => {
    if (!reviseMode || !sheetRef.current) return;
    const el = sheetRef.current.querySelector('[data-frontier="1"]');
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    else sheetRef.current.scrollTop = 0;
  }, [reviseMode, reviseStart, revealed]);

  // Fin de session : le popup de score apparaît une seule fois (le drapeau
  // n'est réarmé que par startRevise), et seulement si on a vraiment répondu
  // — un départ aléatoire sans rien à juger ne mérite pas de popup.
  useEffect(() => {
    if (reviseDone && judged > 0 && !memoPromptedRef.current) {
      memoPromptedRef.current = true;
      setMemoDraft(Math.round((current && current.memo) || 0));
      setMemoPrompt(true);
    }
  }, [reviseDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // « Réviser au hasard » : la révision démarre dès que la chanson tirée est
  // ouverte — sauf si elle n'a rien à réviser, auquel cas elle s'ouvre normalement.
  useEffect(() => {
    if (!pendingReviseRef.current || view !== "song") return;
    pendingReviseRef.current = false;
    if (revealables) startRevise("seq");
  }, [currentId, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quiz : la question s'arme dès que la chanson tirée est ouverte — contexte
  // visible jusqu'à l'unité tirée, le reste masqué. Une chanson sans paroles
  // est écartée et on retire aussitôt. Le nonce quizQ est indispensable :
  // quand le hasard retombe sur la chanson déjà ouverte, currentId ne change pas.
  useEffect(() => {
    if (!pendingQuizRef.current || view !== "song") return;
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
  // servent qu'à révéler la première unité — ensuite chaque réponse révèle
  // la suivante d'elle-même.
  useEffect(() => {
    if (!reviseMode || view !== "song") return;
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

  // Une liste supprimée laisse parfois son id en filtre persisté : on l'ignore.
  const activeList = listFilter && lists.defs.some((d) => d.id === listFilter) ? listFilter : "";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q ? songs.filter((s) => (s.title + " " + s.artist).toLowerCase().includes(q)) : songs;
    if (activeList) list = list.filter((s) => (lists.byKey[songKey(s)] || []).includes(activeList));
    // Filtres cumulés : « Piano » et « Favorite » donnent les favorites au piano.
    if (tagFilter.length) {
      list = list.filter((s) => {
        const ids = tags.byKey[songKey(s)] || [];
        return tagFilter.every((id) => ids.includes(id));
      });
    }
    // Tri par note, ascendant par défaut : les moins connues d'abord — l'ordre
    // de travail. Re-taper le tri actif inverse l'ordre (dir).
    const dir = sortDir === "desc" ? -1 : 1;
    if (sort === "memo") {
      return [...list].sort((a, b) =>
        dir * (((a.memo || 0) - (b.memo || 0)) || a.title.localeCompare(b.title, "fr")));
    }
    const key = sort === "artist" ? (s) => (s.artist || "").trim() : (s) => s.title;
    return [...list].sort((a, b) =>
      dir * (key(a).localeCompare(key(b), "fr") || a.title.localeCompare(b.title, "fr")));
  }, [songs, query, sort, sortDir, tagFilter, tags, activeList, lists]);

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
    setCurrentId(id); setView("song"); setScrolling(false); setReviseMode(null); setRevealed(0); setJudged(0); setFlowIndex(null); setMemoPrompt(false);
    requestAnimationFrame(() => sheetRef.current && (sheetRef.current.scrollTop = 0));
  };
  const startNew = () => { setCurrentId(null); setDraft({ title: "", artist: "", body: "" }); setView("edit"); };
  const startEdit = () => { setDraft({ title: current.title, artist: current.artist, body: current.body }); setView("edit"); };
  const save = () => {
    if (!draft.body.trim()) return;
    const title = draft.title.trim() || "Sans titre";
    if (current) {
      const renamed = { title, artist: draft.artist.trim() };
      moveTags(songKey(current), songKey(renamed));
      moveLists(songKey(current), songKey(renamed));
      setSongs(songs.map((s) => (s.id === current.id ? { ...s, ...renamed, body: draft.body } : s)));
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
  /* Deux intentions, deux tirages. « Jouer » (en public : une valeur sûre)
     double le poids d'une chanson par étoile ; « Réviser » fait l'inverse,
     les non-notées en tête. Pondération douce : tout reste tirable, et un
     carnet sans note redevient un tirage uniforme. Le tirage respecte les
     filtres de la bibliothèque (recherche, tags, liste), chanson courante
     exclue. */
  const drawPool = () => {
    const pool = filtered.filter((s) => s.id !== currentId);
    return pool.length ? pool : songs.filter((s) => s.id !== currentId);
  };
  const weightedDraw = (pool, weightOf) => {
    if (!pool.length) return null;
    let total = 0;
    const acc = pool.map((s) => (total += weightOf(s)));
    const r = Math.random() * total;
    return pool[acc.findIndex((a) => r < a)] || pool[pool.length - 1];
  };
  const openRandom = () => {
    const pick = weightedDraw(drawPool(), (s) => 2 ** (s.memo || 0));
    if (pick) openSong(pick.id);
  };
  const openReviseRandom = () => {
    const pick = weightedDraw(drawPool(), (s) => 2 ** (5 - (s.memo || 0)));
    if (!pick) return;
    pendingReviseRef.current = true;
    openSong(pick.id);
  };
  /* Quiz : une ligne au hasard d'une chanson au hasard de la sous-liste
     affichée. Tirage UNIFORME — esprit jeu, contrairement aux deux boutons
     pondérés ci-dessus — en évitant de retomber sur la chanson en cours
     tant que le vivier le permet. */
  const quizNext = () => {
    const dead = quizDeadRef.current;
    let pool = filtered.filter((s) => s.id !== currentId && !dead.has(s.id));
    if (!pool.length) pool = filtered.filter((s) => !dead.has(s.id)); // une seule chanson : la répétition est permise
    if (!pool.length) { stopQuiz(); return; }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    pendingQuizRef.current = true;
    setQuizQ((q) => q + 1);
    openSong(pick.id);
  };
  const startQuiz = () => {
    if (!filtered.length) return;
    quizDeadRef.current = new Set();
    setQuizEnd(null);
    setQuiz({ asked: 0, correct: 0 });
    quizNext();
  };
  const stopQuiz = () => {
    const game = quiz;
    setQuiz(null);
    setReviseMode(null);
    pendingQuizRef.current = false;
    if (game && game.asked > 0) setQuizEnd(game);
    else setView("lib");
  };
  const resetAll = async () => {
    if (!window.confirm("Tout effacer sur cet appareil ? Les grilles et les réglages stockés localement seront supprimés, puis l'application rechargera sa dernière version. Copiez d'abord l'URL de partage si vous voulez pouvoir revenir en arrière.")) return;
    syncHashRef.current = false;
    setReady(false); // gèle la sauvegarde automatique pendant l'effacement
    await clearLibrary();
    reloadFresh(false); // repart à neuf, sans le fragment ni le cache
  };
  const tagsOf = (song) => {
    const ids = tags.byKey[songKey(song)] || [];
    return tags.defs.filter((d) => ids.includes(d.id));
  };
  const hasTag = (song, id) => (tags.byKey[songKey(song)] || []).includes(id);
  const toggleTag = (song, id) => setTags((t) => {
    const k = songKey(song);
    const cur = t.byKey[k] || [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    const byKey = { ...t.byKey };
    if (next.length) byKey[k] = next; else delete byKey[k];
    return { ...t, byKey };
  });
  /** Renommer une chanson déplace son ancre : les tags suivent. */
  const moveTags = (from, to) => setTags((t) => {
    if (from === to || !t.byKey[from]) return t;
    const byKey = { ...t.byKey };
    byKey[to] = [...new Set([...(byKey[to] || []), ...byKey[from]])];
    delete byKey[from];
    return { ...t, byKey };
  });

  const inList = (song, id) => (lists.byKey[songKey(song)] || []).includes(id);
  const toggleList = (song, id) => setLists((l) => {
    const k = songKey(song);
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
    return { ...l, byKey };
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
    if (def && !window.confirm(`Supprimer la liste « ${def.name} » ? Les chansons elles-mêmes ne bougent pas.`)) return;
    if (listFilter === id) setListFilter("");
    setLists((l) => {
      const byKey = {};
      for (const [k, arr] of Object.entries(l.byKey)) {
        const keep = arr.filter((x) => x !== id);
        if (keep.length) byKey[k] = keep;
      }
      return { defs: l.defs.filter((d) => d.id !== id), byKey };
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
    if (def && !window.confirm(`Supprimer le tag « ${def.label} » ? Il sera retiré de toutes les chansons.`)) return;
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
    setSongs((prev) => mergeByTitle(prev, list));
    if (settings) {
      if (typeof settings.showChords === "boolean") setShowChords(settings.showChords);
      if (settings.size) setSize(settings.size);
      if (settings.speed) setSpeed(settings.speed);
      if (settings.sort === "title" || settings.sort === "artist" || settings.sort === "memo") setSort(settings.sort);
    }
  };
  const library = useMemo(() => ({ songs, showChords, size, speed, sort }), [songs, showChords, size, speed, sort]);
  const shift = (n) => setSongs(songs.map((s) => (s.id === current.id ? { ...s, steps: Math.max(-6, Math.min(6, (s.steps || 0) + n)) } : s)));
  // Réglage manuel : il reprend la main sur le scoring automatique, dont le
  // drapeau saute — plus d'avertissement tant qu'une révision ne l'a pas reposé.
  const setMemo = (n) => setSongs(songs.map((s) => {
    if (s.id !== current.id) return s;
    if (!n) { const { memo, memoAuto, ...rest } = s; return rest; }
    const { memoAuto, ...rest } = s;
    return { ...rest, memo: n };
  }));

  const engine = CS ? "ChordSheetJS 15.6" : csTried ? "lecteur interne (librairie inaccessible)" : "chargement…";
  const mo = (n) => (n / 1048576).toFixed(1).replace(".", ",") + " Mo";
  const cached = offline && offline.vendor && offline.vendor.total > 0 && offline.vendor.done >= offline.vendor.total;
  const offlineHint = !offline || !offline.supported
    ? "Indisponible ici : garder l'application en cache demande un service worker, donc une page servie en HTTPS — c'est le cas sur GitHub Pages, pas dans un aperçu d'artefact."
    : !offline.shell
      ? "Mise en cache de l'application en cours…"
      : cached
        ? `Prêt pour l'avion ✓ — l'application démarre et le carnet se lit sans réseau, import de PDF compris (${mo(offline.vendor.total)} de librairies en cache).`
        : `L'application démarre et le carnet se lit déjà sans réseau. Pour l'import de PDF, il reste ${mo(Math.max(0, offline.vendor.total - offline.vendor.done))} à mettre en cache.`;
  const appVersion = useMemo(() => {
    const s = document.querySelector('script[src*="app.js"]');
    const m = s && /[?&]v=([0-9a-f]+)/.exec(s.getAttribute("src") || "");
    return m ? m[1] : "dev";
  }, []);

  return (
    <div className={"cb" + (theme === "light" ? " light" : "")}>
      <style>{CSS}</style>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple
        className="vhide" tabIndex={-1} aria-hidden="true"
        onChange={(e) => { importPdfs(e.target.files); e.target.value = ""; }} />

      <div className="top">
        {view === "lib" ? (
          <>
            <div className="brand">Carnet <span>d'accords</span></div>
            <VU />
            {offline && !offline.online && <span className="tag">hors ligne</span>}
            <div className="spacer" />
            <button className="iconbtn" title="Importer des PDF" onClick={() => fileRef.current?.click()}>⤓</button>
            <button className="iconbtn" title="Saisir une grille" onClick={startNew}>＋</button>
            <button className={"iconbtn" + (dirty ? " nudge" : "")} onClick={() => setView("transfer")}
              title={dirty ? "Sauvegarde et partage — carnet modifié depuis la dernière sauvegarde" : "Sauvegarde et partage"}>⇅</button>
            <button className="iconbtn" title="Réglages" onClick={() => setView("settings")}>⚙</button>
          </>
        ) : view === "song" ? (
          <>
            <button className="iconbtn" title="Retour" onClick={() => { setScrolling(false); if (quiz) stopQuiz(); else setView("lib"); }}>‹</button>
            <div className="spacer" />
            {songs.length > 1 && (
              <button className="iconbtn" title="Une autre au hasard — les mieux connues sortent plus souvent" onClick={openRandom}>🎲</button>
            )}
            <button className={"iconbtn" + (reviseMode ? " on" : "")} aria-pressed={!!reviseMode} disabled={!revealables}
              title={quiz ? "Arrêter le quiz" : reviseMode ? "Quitter la révision" : "Réviser — paroles cachées, révélées ligne à ligne"}
              onClick={() => (quiz ? stopQuiz() : reviseMode ? setReviseMode(null) : startRevise("seq"))}>🎓</button>
            <button className={"iconbtn" + (showChords ? " on" : "")} aria-pressed={showChords}
              title={showChords ? "Masquer les accords" : "Afficher les accords"}
              onClick={() => setShowChords(!showChords)}>♯</button>
            <button className="iconbtn" disabled={!showChords || !events.length}
              title="Accords un par un, en diagrammes guitare ou piano"
              onClick={() => openFlow(0)}>🎼</button>
            <button className={"iconbtn" + (scrolling ? " on" : "")} aria-pressed={scrolling}
              title={scrolling ? "Arrêter le défilement automatique" : "Défilement automatique"}
              onClick={() => setScrolling(!scrolling)}>{scrolling ? "⏸" : "▶"}</button>
          </>
        ) : (
          <>
            <button className="iconbtn" title="Retour" onClick={() => { setScrolling(false); setView("lib"); }}>‹</button>
            <div className="brand" style={{ fontSize: 15, color: "var(--muted)" }}>
              {view === "edit" ? (current ? "Modifier" : "Nouvelle grille") : view === "transfer" ? "Transfert" : "Réglages"}
            </div>
            <div className="spacer" />
          </>
        )}
      </div>

      {view === "lib" && (
        <>
          <div className="lib">
            <input className="search" value={query} placeholder="Chercher un titre, un artiste…"
              onChange={(e) => setQuery(e.target.value)} />
            {songs.length > 0 && (
              <div className="toolrow">
                <span className="lab">Liste</span>
                <select className="listsel" value={activeList} aria-label="Liste affichée"
                  onChange={(e) => {
                    if (e.target.value === "__new__") createList();
                    else setListFilter(e.target.value);
                  }}>
                  <option value="">Toutes les chansons</option>
                  {lists.defs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({songs.filter((s) => inList(s, d.id)).length})
                    </option>
                  ))}
                  <option value="__new__">＋ Nouvelle liste…</option>
                </select>
              </div>
            )}
            {songs.length > 1 && (
              <div className="toolrow">
                <span className="lab">Tri</span>
                <div className="seg2">
                  {[["title", "Titre"], ["artist", "Artiste"], ["memo", "Note"]].map(([k, lab]) => (
                    <button key={k} className={sort === k ? "on" : ""} aria-pressed={sort === k}
                      title={sort === k
                        ? (sortDir === "asc" ? "Inverser : ordre descendant" : "Inverser : ordre ascendant")
                        : k === "memo" ? "Trier par note d'apprentissage — les moins connues d'abord" : undefined}
                      onClick={() => {
                        if (sort === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
                        else { setSort(k); setSortDir("asc"); }
                      }}>
                      {lab}{sort === k && <i className="sortdir">{sortDir === "asc" ? "↑" : "↓"}</i>}
                    </button>
                  ))}
                </div>
                <div className="spacer" />
                <button className="btn slim" onClick={openRandom}
                  title="Une chanson au hasard, en privilégiant les mieux connues — pour jouer">🎲 Jouer</button>
                <button className="btn slim" onClick={openReviseRandom}
                  title="Une chanson au hasard, en privilégiant les moins connues — la révision démarre aussitôt">🎓 Réviser</button>
                <button className="btn slim" onClick={startQuiz}
                  title="Une ligne au hasard d'une chanson au hasard — l'aviez-vous en tête ? Les scores se mettent à jour en jouant">❓ Quiz</button>
              </div>
            )}
            {songs.length > 0 && tags.defs.length > 0 && (
              <div className="toolrow">
                <span className="lab">Tags</span>
                {tags.defs.map((t) => {
                  const on = tagFilter.includes(t.id);
                  const count = songs.filter((s) => hasTag(s, t.id)).length;
                  return (
                    <button key={t.id} className={"tagchip" + (on ? " on" : "")} aria-pressed={on}
                      title={`${t.label} — ${count} chanson${count > 1 ? "s" : ""}`}
                      style={on ? { color: tagInk(t.color, theme === "light"), borderColor: tagInk(t.color, theme === "light"), background: t.color + "22" } : undefined}
                      onClick={() => setTagFilter((f) => (on ? f.filter((x) => x !== t.id) : [...f, t.id]))}>
                      <span>{t.icon}</span>{count > 0 && <b>{count}</b>}
                    </button>
                  );
                })}
                {tagFilter.length > 0 && (
                  <button className="btn slim" onClick={() => setTagFilter([])}>Tout voir</button>
                )}
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
                <p className="hint" style={{ marginTop: 14 }}>
                  Un carnet existe déjà ailleurs ? La page Transfert (⇅) le rapatrie depuis une URL
                  de partage, un code compressé ou un export JSON. Une app installée sur l'écran
                  d'accueil a son propre stockage : le carnet du navigateur n'y est pas repris.
                </p>
              </div>
            )}
            {ready && songs.length > 0 && filtered.length === 0 && (
              <div className="empty"><p>Rien ne correspond à « {query} ».</p></div>
            )}
            {filtered.map((s) => {
              const marks = tagsOf(s);
              return (
              <div className="card" key={s.id}>
                <button className="cardmain" onClick={() => openSong(s.id)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3>{s.title}</h3>
                    <p>{s.artist || "Artiste inconnu"}</p>
                  </div>
                  {(s.memo || 0) > 0 && (
                    <span className="cardmemo" title={`Apprise à ${fmtMemo(s.memo)} sur 5`}>★ {fmtMemo(s.memo)}</span>
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
        </>
      )}

      {view === "song" && current && (
        <>
          <div className="head">
            <button className={"foldbtn" + (barOpen ? "" : " folded")} aria-expanded={barOpen}
              title={barOpen ? "Replier les réglages de la chanson" : "Déplier les réglages de la chanson"}
              onClick={() => setBarOpen(!barOpen)}><i>▲</i></button>
            <h1 className="title">{current.title}</h1>
            <p className="artist">{current.artist || "Artiste inconnu"}</p>
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
                <span className="mlab">Appris</span>
                <div className="memocell">
                  {(current.memo || 0) > 0 && <span className="memoval">{fmtMemo(current.memo)}</span>}
                  <Stars value={current.memo || 0} onChange={(n) => {
                    if (current.memoAuto && !window.confirm(`Attention : vous allez écraser le score calculé automatiquement (★ ${fmtMemo(current.memo)}).`)) return;
                    setMemo(n);
                  }} />
                </div>
              </div>
              {showChords && (
                <div className="mrow">
                  <span className="mlab">Tonalité</span>
                  <div className="stepper">
                    <button onClick={() => shift(-1)} title="Un demi-ton plus bas">−</button>
                    <span>Ton <b>{steps > 0 ? `+${steps}` : steps}</b></span>
                    <button onClick={() => shift(1)} title="Un demi-ton plus haut">+</button>
                  </div>
                </div>
              )}
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
              maskFrom={reviseMode ? visibleLines : null} maskUnits={reviseUnits.byBlock}
              onChordTap={showChords ? onChordTap : null} />
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
                  <span>Quiz</span>
                  <div className="revtrack"><div className="revfill" style={{ width: quiz.asked ? `${(quiz.correct / quiz.asked) * 100}%` : "0%" }} /></div>
                  <span><b>{quiz.correct}</b> / {quiz.asked}</span>
                </div>
                <div className="revrow">
                  {revealed === 0 ? (
                    <button className="btn primary revmain" onClick={revealNext}>
                      {reviseUnits.kinds[visibleLines] === "chorus" ? "Révéler le refrain" : "Révéler la ligne"}
                    </button>
                  ) : (<>
                    <button className="btn revmain know" onClick={() => answer(true)}>✓ Savais</button>
                    <button className="btn revmain dont" onClick={() => answer(false)}>✗ Savais pas</button>
                  </>)}
                  <button className="iconbtn stop" title="Arrêter le quiz — score de la partie"
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
                    <button className="iconbtn" title="Nouveau départ aléatoire dans la chanson"
                      onClick={() => startRevise("random")}>🎲</button>
                  </>)}
                  {reviseDone ? (
                    <button className="btn revmain" onClick={() => startRevise(reviseMode)}>
                      Bravo, tout est là ! — recommencer
                    </button>
                  ) : revealed === 0 ? (
                    <button className="btn primary revmain" onClick={revealNext}>
                      {reviseUnits.kinds[visibleLines] === "chorus" ? "Révéler le refrain" : "Révéler la ligne"}
                    </button>
                  ) : (<>
                    <button className="btn revmain know" onClick={() => answer(true)}>✓ Savais</button>
                    <button className="btn revmain dont" onClick={() => answer(false)}>✗ Savais pas</button>
                  </>)}
                  {(revealed === 0 || reviseDone) && songs.length > 1 && (
                    <button className="iconbtn" title="Réviser une autre chanson — tirée parmi les moins connues"
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
                {songs.length > 1 && (
                  <button className="btn slim" style={{ width: "100%" }}
                    title="Enchaîne sur une chanson à travailler"
                    onClick={() => { setMemoPrompt(false); openReviseRandom(); }}>
                    Réviser une autre →
                  </button>
                )}
              </div>
            </div>
          )}
          {quizEnd && (
            <div className="modal" role="dialog" aria-modal="true" aria-label="Fin de quiz"
              onClick={(e) => { if (e.target === e.currentTarget) { setQuizEnd(null); setView("lib"); } }}>
              <div className="modalbox">
                <div className="modalicon">🏁</div>
                <h2>Quiz terminé</h2>
                <div className="modalscore">{quizEnd.correct} / {quizEnd.asked}</div>
                <p>
                  {Math.round((100 * quizEnd.correct) / quizEnd.asked)} % de bonnes réponses —
                  les scores des chansons jouées ont été mis à jour.
                </p>
                <div className="actions" style={{ justifyContent: "center" }}>
                  <button className="btn primary" onClick={() => { setQuizEnd(null); setView("lib"); }}>Retour à la liste</button>
                </div>
              </div>
            </div>
          )}
          {flowIndex != null && events.length > 0 && (
            <ChordFlow events={events} index={Math.min(flowIndex, events.length - 1)}
              setIndex={setFlowIndex} instrument={instrument} setInstrument={setInstrument}
              onClose={closeFlow} />
          )}
        </>
      )}

      {view === "edit" && (
        <Editor draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setView(current ? "song" : "lib")} onDelete={current ? remove : null} />
      )}

      {view === "transfer" && (
        <Transfer library={library} tags={tags} lists={lists} engine={engine} backup={backup} dirty={dirty}
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
              <p className="hint">Sombre pour la scène et la pénombre, clair pour le plein jour.</p>
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
                {offline && offline.waiting
                  ? "Une nouvelle version est prête : ce bouton l'installe et recharge la page — sans toucher à vos données."
                  : "Si l'application semble en retard sur la dernière version publiée, ce bouton recharge la page en contournant le cache du navigateur — sans toucher à vos données."}
              </p>
            </div>
            <div className="actions">
              {offline && offline.waiting
                ? <button className="btn primary" onClick={() => window.offline.update()}>Installer la nouvelle version</button>
                : <button className="btn" onClick={() => reloadFresh(true)}>Recharger la dernière version</button>}
            </div>
            <div className="field">
              <label>Lecture</label>
              <p className="hint">Taille du texte des grilles, pour tout le carnet.</p>
            </div>
            <div className="actions">
              <div className="stepper">
                <button onClick={() => setSize(Math.max(13, size - 1))}>A−</button>
                <span>Taille <b>{size}</b></span>
                <button onClick={() => setSize(Math.min(30, size + 1))}>A+</button>
              </div>
            </div>
            <div className="field">
              <label>Tags</label>
              <p className="hint">
                Une chanson peut en porter plusieurs ; seules les icônes s'affichent dans la liste.
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
                Des sous-ensembles du carnet (concert, répertoire du moment…). Le menu au-dessus
                de la bibliothèque les affiche ; chaque chanson s'y ajoute depuis son propre menu.
                Comme les tags, elles restent sur cet appareil mais entrent dans la sauvegarde en fichier.
              </p>
            </div>
            {lists.defs.map((d) => (
              <div className="tagedit" key={d.id}>
                <input value={d.name} maxLength={40} aria-label="Nom de la liste"
                  onChange={(e) => renameList(d.id, e.target.value)} />
                <span className="tag">{songs.filter((s) => inList(s, d.id)).length}</span>
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
