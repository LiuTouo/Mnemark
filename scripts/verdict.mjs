// Final verdict: per show, compares all frames in the show window against the
// forced hidden-ref (just before hotkey) and forced open-ref. Reports any frame
// differing from both + the worst frame's worst-row deviation.
import { readFileSync } from "node:fs";
const log = JSON.parse(readFileSync(process.argv[2] ?? "target/full-log.json", "utf8"));
const { w, h, marks, snaps } = log;
const BAND = 37, N = w * BAND;
const bgrx = (i) => readFileSync(`target/full-frames/frame-${String(i).padStart(3, "0")}.bgrx`);
const lumTop = (i) => {
  const b = bgrx(i); const l = new Float32Array(N);
  for (let y = 0; y < BAND; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4; l[y * w + x] = b[o + 2] * .299 + b[o + 1] * .587 + b[o] * .114;
  } return l;
};
const m = (n) => marks.find((x) => x[0] === n)?.[1];
for (let c = 0; ; c++) {
  const t = m(`show-${c}`); if (t == null) break;
  const hidT = m(`hid-ref-${c}`), openT = m(`open-ref-${c}`);
  const hid = snaps.filter(([st]) => st >= hidT && st < hidT + 200).pop();
  const open = snaps.filter(([st]) => st >= openT && st < openT + 200).pop();
  if (!hid || !open) { console.log(`show-${c}: refs missing`); continue; }
  const hl = lumTop(hid[1]), ol = lumTop(open[1]);
  const win = snaps.filter(([st]) => st >= t - 5 && st < t + 90);
  let worst = null;
  for (const [st, i] of win) {
    const L = lumTop(i);
    let d1 = 0, d2 = 0;
    for (let k = 0; k < N; k++) { d1 += Math.abs(L[k] - ol[k]); d2 += Math.abs(L[k] - hl[k]); }
    d1 /= N; d2 /= N;
    if (d1 > 5 && d2 > 5 && (!worst || Math.max(d1, d2) > worst.d)) worst = { st: st - t, i, d: Math.max(d1, d2) };
  }
  console.log(`show-${c}: ${worst ? `FLASH idx=${worst.i} t+${worst.st} diff=${worst.d.toFixed(1)}` : "clean"}`);
}
