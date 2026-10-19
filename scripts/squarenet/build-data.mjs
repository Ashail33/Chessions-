// Finds the board in every photo (detectBoard, as the app does), cuts out the
// 64 squares (squarePatches, as the app does) and labels each from the piece
// boxes. Writes OUT/patches.bin (uint8, photos x 64 x PATCH_H x PATCH_W x 3)
// and OUT/patches.json.
// Usage: node build-data.mjs OUT   (after prepare.py OUT)
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { detectBoard } from '../../src/detect.js';
import { boardHomography, homography, project } from '../../src/vision.js';
import { squarePatches, PATCH_W, PATCH_H } from '../../src/squares.js';

const OUT = process.argv[2];
const photos = JSON.parse(readFileSync(`${OUT}/labels.json`, 'utf8'));
const patches = [];
const meta = [];
const skipped = { noBoard: 0, offBoard: 0 };
for (const item of photos) {
  const rgb = gunzipSync(readFileSync(`${OUT}/img/${item.file}.rgb.gz`));
  const data = new Uint8ClampedArray(item.w * item.h * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    data[j] = rgb[i];
    data[j + 1] = rgb[i + 1];
    data[j + 2] = rgb[i + 2];
    data[j + 3] = 255;
  }
  const img = { data, width: item.w, height: item.h };
  const found = detectBoard(img);
  if (!found) { skipped.noBoard++; continue; }
  const inv = homography(found.corners, [[0, 0], [8, 0], [8, 8], [0, 8]]);
  const label = new Array(64).fill(0); // 0 empty, 1 white, 2 black, -1 unsure
  const firm = new Array(64).fill(false);
  let off = 0;
  for (const p of item.pieces) {
    // The base sits somewhere between just above the box bottom (low camera)
    // and half a piece width above it (overhead). Where those two land on
    // different squares the label is a guess, so leave both squares out.
    const [x, y, w, h] = p.box;
    const at = [[x + w / 2, y + h - 0.08 * h], [x + w / 2, y + h - 0.45 * w]].map(([u, v]) => {
      const [bx, by] = project(inv, u, v);
      if (bx < -0.3 || by < -0.3 || bx > 8.3 || by > 8.3) return -1;
      const f = Math.min(7, Math.max(0, Math.floor(bx)));
      const row = Math.min(7, Math.max(0, Math.floor(by)));
      return (7 - row) * 8 + f;
    });
    if (at[0] < 0 && at[1] < 0) { off++; continue; }
    const c = p.colour === 'w' ? 1 : p.colour === 'b' ? 2 : -1;
    if (at[0] === at[1]) { label[at[0]] = c; firm[at[0]] = true; continue; }
    for (const sq of at) if (sq >= 0 && !firm[sq]) label[sq] = -1;
  }
  // Real boxes sit on the board. Many off it means the board was found in the
  // wrong place, or the boxes don't belong to this picture (some augmented
  // copies in the sets kept the boxes of the unflipped photo).
  if (off > item.pieces.length * 0.1) { skipped.offBoard++; continue; }
  patches.push(squarePatches(img, boardHomography(found.corners)));
  meta.push({ file: item.file, split: item.split, source: item.source, label });
}
const all = new Uint8Array(patches.length * 64 * PATCH_H * PATCH_W * 3);
patches.forEach((p, i) => all.set(p, i * p.length));
writeFileSync(`${OUT}/patches.bin`, all);
writeFileSync(`${OUT}/patches.json`, JSON.stringify({ PATCH_W, PATCH_H, meta }));
console.log('photos', meta.length, 'skipped', JSON.stringify(skipped));
