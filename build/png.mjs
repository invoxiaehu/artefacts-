// Encodeur PNG minimal (RVB 8 bits, sans dépendance) : les icônes des artefacts
// installables sont dessinées au build, pour ne commiter aucun binaire.
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const hex = (color) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) throw new Error(`couleur invalide : ${color}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

/** Petite surface de dessin : de quoi poser un fond et des rectangles à coins
 *  arrondis, ce que demandent les icônes d'application. */
export function canvas(size, background) {
  const px = Buffer.alloc(size * size * 3);
  const bg = hex(background);
  for (let i = 0; i < size * size; i++) px.set(bg, i * 3);

  const set = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    px.set(rgb, (y * size + x) * 3);
  };

  return {
    size,
    /** Rectangle à coins arrondis, en pixels. Anticrénelage par échantillonnage
     *  2×2 : suffisant à ces tailles, et sans canal alpha à gérer. */
    roundedRect(x, y, w, h, radius, color) {
      const rgb = hex(color);
      const r = Math.max(0, Math.min(radius, w / 2, h / 2));
      const inside = (px2, py2) => {
        if (px2 < x || py2 < y || px2 > x + w || py2 > y + h) return false;
        const cx = Math.min(Math.max(px2, x + r), x + w - r);
        const cy = Math.min(Math.max(py2, y + r), y + h - r);
        const dx = px2 - cx;
        const dy = py2 - cy;
        return dx * dx + dy * dy <= r * r || (px2 >= x + r && px2 <= x + w - r) || (py2 >= y + r && py2 <= y + h - r);
      };
      for (let iy = Math.floor(y); iy <= Math.ceil(y + h); iy++) {
        for (let ix = Math.floor(x); ix <= Math.ceil(x + w); ix++) {
          let hits = 0;
          for (const oy of [0.25, 0.75]) for (const ox of [0.25, 0.75]) if (inside(ix + ox, iy + oy)) hits++;
          if (!hits) continue;
          if (hits === 4) { set(ix, iy, rgb); continue; }
          const a = hits / 4;
          const o = (iy * size + ix) * 3;
          for (let c = 0; c < 3; c++) px[o + c] = Math.round(px[o + c] * (1 - a) + rgb[c] * a);
        }
      }
    },
    toPng() {
      const raw = Buffer.alloc((size * 3 + 1) * size);
      for (let y = 0; y < size; y++) {
        raw[y * (size * 3 + 1)] = 0; // filtre « None »
        px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
      }
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(size, 0);
      ihdr.writeUInt32BE(size, 4);
      ihdr[8] = 8; // 8 bits par canal
      ihdr[9] = 2; // RVB
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
      ]);
    },
  };
}

/** L'icône du Carnet : les barres du VU-mètre de l'en-tête, en ambre sur le fond
 *  sombre de l'app. Le motif tient dans les 60 % centraux, donc à l'abri du
 *  masque circulaire des icônes « maskable » d'Android. */
export function vuIcon(size, { background, accent, dim, bars = [0.45, 0.72, 1, 0.58, 0.86] }) {
  const c = canvas(size, background);
  const box = size * 0.6;
  const left = (size - box) / 2;
  const bottom = (size + box) / 2;
  const gap = box / (bars.length * 2.6);
  const width = (box - gap * (bars.length - 1)) / bars.length;
  const radius = Math.max(1, width * 0.34);
  bars.forEach((ratio, i) => {
    const h = Math.max(width, box * ratio);
    c.roundedRect(left + i * (width + gap), bottom - h, width, h, radius, ratio === 1 ? accent : dim || accent);
  });
  return c.toPng();
}

/** L'icône du Carnet de poésie : quatre traits de longueurs inégales — un
 *  quatrain vu de loin —, le deuxième en accent. Comme le VU-mètre, le motif
 *  tient dans les 60 % centraux, à l'abri du masque circulaire d'Android. */
export function versesIcon(size, { background, accent, dim }) {
  const c = canvas(size, background);
  const box = size * 0.6;
  const left = (size - box) / 2;
  const top = (size - box) / 2;
  const lines = [1, 0.62, 0.86, 0.44];
  const gap = box / (lines.length * 2.2);
  const height = (box - gap * (lines.length - 1)) / lines.length;
  const radius = height / 2;
  lines.forEach((ratio, i) => {
    c.roundedRect(left, top + i * (height + gap), Math.max(height, box * ratio), height,
      radius, i === 1 ? accent : dim || accent);
  });
  return c.toPng();
}
