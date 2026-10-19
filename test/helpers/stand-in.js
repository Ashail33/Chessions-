import { OCC } from '../../src/vision.js';

// A stand-in for the model's output: the truth, with some squares wrong.
export function standIn(occ, wrongShare, seed = 1) {
  let s = seed * 9301 + 49297;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = new Float32Array(64 * 3);
  for (let sq = 0; sq < 64; sq++) {
    let o = OCC.indexOf(occ[sq]);
    if (rnd() < wrongShare) o = (o + 1 + Math.floor(rnd() * 2)) % 3;
    for (let k = 0; k < 3; k++) out[sq * 3 + k] = Math.log(k === o ? 0.9 : 0.05);
  }
  return out;
}
