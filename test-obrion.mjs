import assert from 'node:assert/strict';
import { obrionBlueprint, runObrion } from './lib/obrion.mjs';
import { buildGraph } from './director.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const production = { title: 'OBRION', shots: [{
  shot_id: 'E02-S1-01', scene_id: 'hangar', description: 'Ami giấu thẻ.',
  timecode: { start_seconds: 0, duration_seconds: 3, end_seconds: 3 },
  beat: 'setup', pacing_mode: 'asymmetric_beat',
  continuity_rules: { screen_direction: 'L_to_R', eyeline_vector: 'left', cut_transition: 'Hard cut' },
  generation_assets: { primary_character: 'ami', character_lora_tag: '' },
  cinematography: { camera_id: 'cam_cu', rig: 'Tripod', movement: 'Static', focal_length: '65mm', framing: 'CU' },
  performance_direction: { intensity_score: 0.4, gaze_action: 'down', micro_expressions: 'AU4' },
  audio_stems: { dialogue: { speaker: 'ami', text: 'Giấu nó đi.', delivery_tag: 'whisper' }, foley: ['card'], ambience: 'wind' },
  videoPrompt: 'Ami hides a card. Static hold. Whisper. Gritty realism.', first_frame_reference_url: '',
}] };
const bible = { characters: { ami: { description: 'Ami, flight suit' } }, scenes: [{ key: 'hangar', description: 'Dusty hangar' }] };
const blueprint = obrionBlueprint(production, bible);
const graph = buildGraph(blueprint);
const shot = graph.nodes.find(n => n.zone === 'production');
assert.equal(shot.duration, 3);
assert.equal(shot.lyric, 'Giấu nó đi.');
assert.ok(graph.edges.some(e => e.target === shot.id));
assert.equal(blueprint.shots[0].obrion.shot_id, 'E02-S1-01');
assert.throws(() => obrionBlueprint(production, {}), /thiếu nhân vật/);
const ready = await runObrion({ action: 'check' });
assert.equal(ready.ready, true);
const validated = await runObrion({ action: 'validate', production });
assert.equal(validated.production.shots[0].audio_stems.dialogue.text, 'Giấu nó đi.');
assert.equal(JSON.parse(validated.otio).OTIO_SCHEMA, 'Timeline.1');
await assert.rejects(runObrion({ action: 'validate', production: { ...production, shots: [] } }), /shots/);
console.log('OBRION bridge, UTF-8, schema, OTIO and graph conversion passed.');

// Exercise the real LangChain client against a local structured-output provider.
let providerCalls = 0;
const provider = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const b = JSON.parse(raw);
  const schema = b.response_format?.json_schema?.schema || b.tools?.[0]?.function?.parameters;
  const item = schema.properties.shots.items;
  const row = item.$ref ? schema.$defs[item.$ref.split('/').at(-1)] : item;
  const output = { shots: [Object.fromEntries(Object.keys(row.properties).map(key => [key, production.shots[0][key]]))] };
  providerCalls++;
  const message = b.tools ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_test', type: 'function', function: {
    name: b.tools[0].function.name, arguments: JSON.stringify(output),
  } }] } : { role: 'assistant', content: JSON.stringify(output) };
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: 'gpt-4o',
    choices: [{ index: 0, message, finish_reason: b.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const portProbe = http.createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'obrion-api-test-'));
const app = spawn(process.execPath, ['server.mjs'], { windowsHide: true, env: { ...process.env,
  MV_DATA_DIR: temp, MV_PORT: String(port), MV_DIRECTOR_KEY: 'test-key-local-only',
  MV_DIRECTOR_URL: `http://127.0.0.1:${provider.address().port}/v1`, MV_DIRECTOR_MODEL: 'gpt-4o',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = '';
app.stdout.on('data', chunk => { appLog += chunk; });
app.stderr.on('data', chunk => { appLog += chunk; });
async function request(route, data, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {});
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
try {
  for (let attempt = 0; attempt < 100 && !appLog.includes('ready:'); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(appLog, /ready:/);
  const initial = await request('/api/director/obrion');
  const projectId = initial.projectId;
  const payload = { projectId, title: 'OBRION', raw_script: 'Ami giấu thẻ. Ami: Giấu nó đi.', asset_bible: bible, camera_rules: 'Tripod', emotion_rules: 'Restrained' };
  await request('/api/director/obrion/save', { ...payload, projectId: 'wrong-project' }, 400);
  await request('/api/director/obrion/save', payload);
  const generated = await request('/api/director/obrion/generate', payload);
  assert.equal(providerCalls, 5);
  assert.equal(generated.draft.production.shots[0].shot_id, 'E02-S1-01');
  const corrected = structuredClone(generated.draft.production);
  corrected.shots[0].cinematography.movement = 'Slow push in';
  const saved = await request('/api/director/obrion/feedback', { projectId, production: corrected });
  assert.equal(saved.saved, 1);
  const duplicate = await request('/api/director/obrion/feedback', { projectId, production: corrected });
  assert.equal(duplicate.saved, 0);
  const exported = await request('/api/director/obrion/validate', { projectId, production: corrected });
  assert.equal(JSON.parse(exported.otio).OTIO_SCHEMA, 'Timeline.1');
  const converted = await request('/api/director/obrion/blueprint', { projectId, production: corrected });
  assert.equal(converted.blueprint.shots.length, 1);
  const persisted = await request('/api/director/obrion');
  assert.equal(persisted.draft.production.shots[0].cinematography.movement, 'Slow push in');
  assert.equal(persisted.draft.original.shots[0].cinematography.movement, 'Static');
  assert.equal(JSON.stringify(persisted).includes('test-key-local-only'), false);
  console.log('OBRION HTTP generation (5 LangChain calls), draft persistence, original preservation, feedback dedupe and exports passed.');
} finally {
  app.kill();
  await once(app, 'exit');
  await new Promise(resolve => provider.close(resolve));
  if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('obrion-api-test-'))
    fs.rmSync(temp, { recursive: true, force: true });
}
