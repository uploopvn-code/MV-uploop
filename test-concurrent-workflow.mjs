import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-concurrent-'));
process.env.MV_DATA_DIR = dir;
try {
  const projects = await import('./lib/projects.mjs');
  await projects.initWorkspace();
  const { assetRefs } = await import('./lib/nodes.mjs');
  const { prompts } = await import('./lib/prompts.mjs');
  const { autoProtectedIds, jobResultStale, requireEditableNode, requireNoAutoRun } = await import('./lib/jobs.mjs');
  const db = projects.db;
  const node = db.nodes.find(n => !n.terminal && n.kind !== 'setting' && assetRefs(n).length === 0);
  assert.ok(node, 'template needs an image node without image references');
  const job = { nodeId: node.id, kind: 'image', payload: {
    projectRevision: db.revision, inputRev: node.inputRev || 0,
    prompt: prompts(node).image, references: [],
  } };
  db.jobs.push({ nodeId: node.id, kind: 'image', status: 'running' });
  assert.doesNotThrow(requireNoAutoRun, 'one running job must not lock graph edits');
  db.revision++;
  assert.equal(jobResultStale(job), false, 'an unrelated graph edit must not stale this job');
  node.prompt = 'Changed while the job was running';
  assert.equal(jobResultStale(job), true, 'changing the job’s own prompt must stale its result');
  db.autoRun = { status: 'running', order: [node.id] };
  db.edges.push({ source: 'parent-a', target: node.id }, { source: 'grandparent-a', target: 'parent-a' });
  assert.throws(requireNoAutoRun, /Chuỗi tự động/);
  assert.ok(autoProtectedIds().has(node.id));
  assert.ok(autoProtectedIds().has('grandparent-a'), 'all upstream inputs are protected');
  assert.throws(() => requireEditableNode(node.id), /Node này/);
  assert.doesNotThrow(() => requireEditableNode('unrelated-new-node'));
  console.log('PASS: concurrent single job, per-node freshness and automatic-chain protection');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
