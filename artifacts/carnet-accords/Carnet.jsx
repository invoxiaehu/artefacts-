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
.lib { flex:1; overflow-y:auto; padding:14px 16px 96px; }
.search { width:100%; padding:11px 13px; border-radius:10px; border:1px solid var(--line); background:var(--panel);
  color:var(--ink); font-size:15px; margin-bottom:12px; }
.search::placeholder { color:var(--muted); }
.count { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.16em; color:var(--muted); text-transform:uppercase; margin:0 0 10px; }
.notice { border:1px solid var(--amber-dim); background:rgba(233,180,76,.07); border-radius:10px; padding:11px 13px;
  font-size:13px; line-height:1.5; margin-bottom:12px; }
.card { width:100%; text-align:left; display:flex; align-items:center; gap:14px; padding:13px 14px; border:1px solid var(--line);
  border-left:3px solid var(--line); border-radius:10px; background:var(--panel); margin-bottom:8px; transition:border-color .15s, transform .1s; }
.card:hover { border-left-color:var(--amber); }
.card:active { transform:scale(.994); }
.card h3 { margin:0; font-family:'Barlow Condensed'; font-weight:600; font-size:21px; letter-spacing:.03em; text-transform:uppercase; line-height:1.05; }
.card p { margin:2px 0 0; font-size:12.5px; color:var(--muted); }
.tag { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.1em; text-transform:uppercase; border:1px solid var(--line);
  color:var(--muted); border-radius:6px; padding:3px 7px; flex:0 0 auto; }
.tag.full { color:var(--amber); border-color:var(--amber-dim); }
.empty { text-align:center; padding:44px 20px; color:var(--muted); }
.empty h2 { font-family:'Barlow Condensed'; text-transform:uppercase; letter-spacing:.1em; color:var(--ink); font-size:22px; margin:0 0 8px; }
.empty p { margin:0 0 20px; font-size:14px; line-height:1.5; }
.dock { position:absolute; left:0; right:0; bottom:0; display:flex; gap:10px; padding:12px 16px;
  background:linear-gradient(to top, var(--bg) 62%, transparent); }
.dock .btn { flex:1; }
.head { padding:12px 16px; border-bottom:1px solid var(--line); background:var(--panel); flex:0 0 auto; }
.title { font-family:'Barlow Condensed'; font-weight:700; font-size:26px; line-height:1; letter-spacing:.02em; text-transform:uppercase; margin:0; }
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
.reportline { font-family:'JetBrains Mono'; font-size:10.5px; line-height:1.6; color:var(--muted); margin-top:6px; word-break:break-word; }
.reportline b { color:var(--amber); }
.warnbar { font-family:'JetBrains Mono'; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--hot);
  border:1px solid rgba(200,80,60,.4); border-radius:8px; padding:8px 10px; margin-bottom:14px; }
.engine { font-family:'JetBrains Mono'; font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
@media (min-width:720px) { .sheet { padding:26px 32px 130px; } .lib { padding:18px 32px 96px; } .dock { padding:14px 32px; } }
@media (prefers-reduced-motion:reduce) { .cb * { transition:none !important; } }
`;

/* ------------------------------------------------------------------ */

function VU() {
  const h = [5, 9, 6, 13, 8, 16, 11, 7];
  return <div className="vu" aria-hidden="true">{h.map((v, i) => <i key={i} className={i < 5 ? "on" : ""} style={{ height: v }} />)}</div>;
}

function Sheet({ blocks, showChords, size }) {
  return (
    <div className="sheetinner" style={{ fontSize: size }}>
      {blocks.map((b, i) => {
        if (b.type === "section") return <div className="sec" key={i}>{b.label}</div>;
        if (b.type === "blank") return <div className="gap" key={i} />;
        if (b.type === "text") return <div className="plain" key={i}>{b.text}</div>;
        if (!showChords) {
          // Les blancs venaient de l'alignement des accords : on les résorbe.
          const text = b.cells.map((c) => c.lyrics).join("").replace(/\s+/g, " ").trim();
          return text ? <div className="plain" key={i}>{text}</div> : null;
        }
        return (
          <div className="row" key={i}>
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

function Transfer({ songs, engine, onImport, onClose }) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const json = useMemo(() => JSON.stringify(songs.map(({ id, ...r }) => r), null, 1), [songs]);
  const doImport = () => {
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error();
      const clean = data.filter((s) => s && typeof s.body === "string").map((s) => ({
        id: uid(), title: String(s.title || "Sans titre"), artist: String(s.artist || ""),
        body: s.body, steps: Number(s.steps) || 0,
      }));
      if (!clean.length) throw new Error();
      onImport(clean);
      setMsg(`${clean.length} grille(s) ajoutée(s).`);
      setText("");
    } catch {
      setMsg("Texte non reconnu. Attendu : une liste JSON avec title, artist et body.");
    }
  };
  return (
    <div className="form">
      <div className="forminner">
        <div className="field">
          <label>Sauvegarde du carnet</label>
          <textarea readOnly value={json} style={{ minHeight: 140 }} onFocus={(e) => e.target.select()} />
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(json)}>Copier</button>
        </div>
        <div className="field">
          <label htmlFor="imp">Restaurer ou ajouter</label>
          <textarea id="imp" value={text} placeholder='[{"title":"…","artist":"…","body":"…"}]' style={{ minHeight: 140 }}
            onChange={(e) => setText(e.target.value)} />
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
  const [size, setSize] = useState(17);
  const [scrolling, setScrolling] = useState(false);
  const [speed, setSpeed] = useState(3);
  const draggingRef = useRef(false);
  const resumeRef = useRef(null);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState([]);
  const sheetRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await Promise.race([
        loadLibrary(),
        new Promise((r) => setTimeout(() => r(null), 2500)),
      ]);
      if (!alive) return;
      if (data && Array.isArray(data.songs)) {
        setSongs(data.songs);
        if (typeof data.showChords === "boolean") setShowChords(data.showChords);
        if (data.size) setSize(data.size);
        if (data.speed) setSpeed(data.speed);
      } else {
        setSongs([]);
      }
      setReady(true);
      const lib = await loadChordSheetJS();
      if (!alive) return;
      setCS(lib);
      setCsTried(true);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { if (ready) saveLibrary({ songs, showChords, size, speed }); }, [songs, showChords, size, speed, ready]);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? songs.filter((s) => (s.title + " " + s.artist).toLowerCase().includes(q)) : songs;
    return [...list].sort((a, b) => a.title.localeCompare(b.title, "fr"));
  }, [songs, query]);

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
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      setSongs((prev) => {
        const keep = prev.filter((s) => !added.some((a) => norm(a.title) === norm(s.title)));
        return [...keep, ...added];
      });
      setStatus(`${added.length} PDF importé(s).`);
      if (added.length === 1) openSong(added[0].id);
    } else {
      setStatus("Aucun PDF n'a pu être lu.");
    }
  };

  const openSong = (id) => {
    setCurrentId(id); setView("song"); setScrolling(false);
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
  const remove = () => { setSongs(songs.filter((s) => s.id !== current.id)); setCurrentId(null); setView("lib"); };
  const shift = (n) => setSongs(songs.map((s) => (s.id === current.id ? { ...s, steps: Math.max(-6, Math.min(6, (s.steps || 0) + n)) } : s)));

  const engine = CS ? "ChordSheetJS 15.6" : csTried ? "lecteur interne (CDN inaccessible)" : "chargement…";

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
            <button className="iconbtn" title="Sauvegarde" onClick={() => setView("transfer")}>⇅</button>
          </>
        ) : (
          <>
            <button className="iconbtn" title="Retour" onClick={() => { setScrolling(false); setView("lib"); }}>‹</button>
            <div className="brand" style={{ fontSize: 15, color: "var(--muted)" }}>
              {view === "edit" ? (current ? "Modifier" : "Nouvelle grille") : view === "transfer" ? "Transfert" : "Lecture"}
            </div>
            <div className="spacer" />
            {view === "song" && <button className="iconbtn" title="Modifier" onClick={startEdit}>✎</button>}
          </>
        )}
      </div>

      {view === "lib" && (
        <>
          <div className="lib">
            <input className="search" value={query} placeholder="Chercher un titre, un artiste…"
              onChange={(e) => setQuery(e.target.value)} />
            {status && (
              <div className="notice">
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
                <button className="btn primary" onClick={() => fileRef.current?.click()}>Importer des PDF</button>
              </div>
            )}
            {ready && songs.length > 0 && filtered.length === 0 && (
              <div className="empty"><p>Rien ne correspond à « {query} ».</p></div>
            )}
            {filtered.map((s) => (
              <button className="card" key={s.id} onClick={() => openSong(s.id)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3>{s.title}</h3>
                  <p>{s.artist || "Artiste inconnu"}</p>
                </div>
                <span className="tag full">{(s.body.match(/^\s*\[[^\]]+\]\s*$/gm) || []).length || "—"} sect.</span>
              </button>
            ))}
          </div>
          <div className="dock">
            <button className="btn primary" onClick={() => fileRef.current?.click()}>Importer des PDF</button>
            <button className="btn" onClick={startNew}>Saisir</button>
          </div>
        </>
      )}

      {view === "song" && current && (
        <>
          <div className="head">
            <h1 className="title">{current.title}</h1>
            <p className="artist">{current.artist || "Artiste inconnu"}</p>
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
            <Sheet blocks={blocks} showChords={showChords} size={size} />
          </div>
        </>
      )}

      {view === "edit" && (
        <Editor draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setView(current ? "song" : "lib")} onDelete={current ? remove : null} />
      )}

      {view === "transfer" && (
        <Transfer songs={songs} engine={engine} onClose={() => setView("lib")} onImport={(list) => setSongs((prev) => [...prev, ...list])} />
      )}
    </div>
  );
}
