import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../director.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, 'examples', file), 'utf8'));
const bible = read('obrion-e02-bible.json');
assert.equal(bible.film.title, 'THE RECKLESS NEWCOMER / OBRION');
let totalShots = 0;
for (let seq = 1; seq <= 5; seq++) {
  const file = `obrion-e02-seq${String(seq).padStart(2, '0')}.json`;
  const bp = read(file);
  assert.equal(bp.shots.length, 90);
  assert.equal(bp.shots[0].start, 0);
  assert.equal(bp.shots.at(-1).start + bp.shots.at(-1).duration, 300);
  for (let i = 0; i < bp.shots.length; i++) {
    const shot = bp.shots[i];
    assert.equal(shot.start, i ? bp.shots[i - 1].start + bp.shots[i - 1].duration : 0);
    assert.ok(shot.uses.some(k => bible.assets.some(a => a.key === k && a.role === 'scene')));
    assert.ok(shot.duration > 0 && shot.duration <= 4);
  }
  const graph = buildGraph([bible, bp]);
  assert.equal(graph.film, bible.film.title);
  assert.equal(graph.warnings.length, 0, `${file}: ${graph.warnings.join('; ')}`);
  assert.ok(graph.nodes.length <= 200);
  totalShots += bp.shots.length;
  console.log(`${file}: ${bp.shots.length} shots, ${graph.nodes.length} nodes, ${graph.warnings.length} warnings`);
}
assert.equal(totalShots, 450);
