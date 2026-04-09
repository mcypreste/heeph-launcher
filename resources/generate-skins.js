/**
 * Gera skins Minecraft padrão como PNG 64×64 RGBA.
 * Usa apenas módulos nativos do Node.js (zlib + fs).
 * Execute: node resources/generate-skins.js
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ──────────────────────────────────────────────
const CRC_TBL = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TBL[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── PNG writer ─────────────────────────────────────────
function chunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.allocUnsafe(4); lb.writeUInt32BE(data.length, 0);
  const cd = Buffer.concat([tb, data]);
  const cb = Buffer.allocUnsafe(4); cb.writeUInt32BE(crc32(cd), 0);
  return Buffer.concat([lb, tb, data, cb]);
}
function writePNG(filePath, rgba) {
  const W = 64, H = 64;
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4);
  ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  const rowLen = 1 + W * 4;
  const raw = Buffer.allocUnsafe(H * rowLen);
  for (let y = 0; y < H; y++) {
    raw[y * rowLen] = 0;
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      raw.set(rgba.slice(si, si + 4), y * rowLen + 1 + x * 4);
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ── Pixel helpers ──────────────────────────────────────
function fill(px, x, y, w, h, r, g, b, a = 255) {
  for (let py = y; py < y + h; py++)
    for (let px_ = x; px_ < x + w; px_++) {
      const i = (py * 64 + px_) * 4;
      px[i]=r; px[i+1]=g; px[i+2]=b; px[i+3]=a;
    }
}

// ── Skin builder ───────────────────────────────────────
// Minecraft 64×64 UV regions:
//   HEAD face (front): 8,8  8×8
//   HEAD top:          8,0  8×8
//   HEAD sides:        0,8  8×8 (right)  16,8 8×8 (left)  24,8 8×8 (back)
//   BODY:              16,16  24×16
//   R_ARM:             40,16  16×16
//   L_ARM (new):       32,48  16×16
//   R_LEG:             0,16   16×16
//   L_LEG (new):       16,48  16×16
function buildSkin(def) {
  const px = new Uint8Array(64 * 64 * 4); // all transparent
  const [fr,fg,fb] = def.skin;
  const [hr,hg,hb] = def.hair;
  const [er,eg,eb] = def.eyes || def.hair;
  const [sr,sg,sb] = def.shirt;
  const [pr,pg,pb] = def.pants;
  const [br,bg,bb] = def.boots || def.pants;
  const [c2r,c2g,c2b] = def.detail || def.shirt;

  // HEAD — skin tone base
  fill(px, 0, 8, 32, 8, fr,fg,fb);   // all face sides row
  fill(px, 8, 0, 8,  8, fr,fg,fb);   // head top (overwritten by hair)
  fill(px, 16,0, 8,  8, fr,fg,fb);   // head bottom

  // Hair: top face + top 3px of each side
  fill(px, 8, 0, 8, 8, hr,hg,hb);    // top face
  fill(px, 0, 8, 8, 3, hr,hg,hb);    // right side top band
  fill(px, 16,8, 8, 3, hr,hg,hb);    // left side top band
  fill(px, 24,8, 8, 3, hr,hg,hb);    // back side top band

  // Eyes: 2 dark squares on front face (at 8,8)
  fill(px, 9, 10, 2, 2, er,eg,eb);   // left eye
  fill(px, 13,10, 2, 2, er,eg,eb);   // right eye

  // BODY — shirt
  fill(px, 16,16, 24,16, sr,sg,sb);
  // Detail stripe on body front (20,20 to 28,32 = body front)
  if (def.detail) fill(px, 22,22, 4, 6, c2r,c2g,c2b);

  // ARMS — shirt color
  fill(px, 40,16, 16,16, sr,sg,sb);  // right arm
  fill(px, 32,48, 16,16, sr,sg,sb);  // left arm (new format)

  // LEGS — pants
  fill(px, 0, 16, 16,12, pr,pg,pb);  // right leg upper (pants)
  fill(px, 16,48, 16,12, pr,pg,pb);  // left leg upper (new format)
  // Boots — lower 4px of legs
  fill(px, 0, 28, 16, 4, br,bg,bb);  // right leg boots
  fill(px, 16,60, 16, 4, br,bg,bb);  // left leg boots

  return px;
}

// ── Skin definitions ───────────────────────────────────
const SKINS = {
  'ninja': {
    skin:   [215, 170, 125],
    hair:   [ 20,  20,  20],
    shirt:  [ 22,  22,  22],
    pants:  [ 33,  33,  33],
    boots:  [ 15,  15,  15],
    detail: [ 80,   0,   0],
  },
  'floresta': {
    skin:   [220, 175, 130],
    hair:   [ 60,  35,  10],
    shirt:  [ 40,  85,  35],
    pants:  [ 85,  55,  15],
    boots:  [ 55,  30,   8],
    detail: [ 20,  55,  15],
  },
  'guerreiro': {
    skin:   [210, 160, 115],
    hair:   [ 45,  25,   8],
    shirt:  [120,   0,   0],
    pants:  [ 40,  40,  75],
    boots:  [ 25,  25,  50],
    detail: [200, 160,  30],
  },
};

// ── Write files ────────────────────────────────────────
const outDir = path.join(__dirname, 'default-skins');
fs.mkdirSync(outDir, { recursive: true });

for (const [name, def] of Object.entries(SKINS)) {
  const fp = path.join(outDir, name + '.png');
  writePNG(fp, buildSkin(def));
  console.log('Gerado:', fp);
}
console.log('Pronto!');
