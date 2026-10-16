// Documentation fixture: the AI-film example must remain importable by the actual graph builder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildGraph } from './director.mjs';

const blueprint = JSON.parse(fs.readFileSync(new URL('./examples/film-blueprint-example.json', import.meta.url), 'utf8'));
const graph = buildGraph(blueprint);
assert.equal(graph.theme, 'film');
assert.equal(graph.name, blueprint.project.title);
assert.deepEqual(graph.warnings, []);
assert.ok(graph.nodes.length < 200);
assert.equal(graph.nodes.filter(n => n.role === 'character').length, 2);
assert.equal(graph.nodes.filter(n => n.role === 'scene').length, 1);
assert.equal(graph.nodes.filter(n => n.role === 'prop').length, 1);
assert.equal(graph.nodes.filter(n => n.role === 'merged').length, 1);
assert.equal(graph.nodes.filter(n => n.role === 'frame').length, 2);
assert.equal(graph.nodes.filter(n => n.zone === 'production' && n.role !== 'frame').length, 3);
let next = 0;
for (const shot of blueprint.shots) {
  assert.equal(shot.start, next, `timeline gap/overlap at ${shot.name}`);
  assert.ok(shot.duration > 0);
  next += shot.duration;
}
assert.equal(next, 24);
const ids = new Set(graph.nodes.map(n => n.id));
for (const edge of graph.edges) {
  assert.ok(ids.has(edge.source));
  assert.ok(ids.has(edge.target));
}
console.log('PASS: documented film JSON builds a 24-second graph with no warnings');
