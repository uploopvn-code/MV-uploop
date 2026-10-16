// Kỹ năng Trợ lý storage: global/project scope, enable toggle, enabledText injection, persistence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantSkills } from './lib/assistant-skills.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-skills-'));
try {
  const sk = createAssistantSkills(dir);
  assert.deepEqual(sk.list('p1'), []);
  assert.equal(sk.enabledText('p1'), '');

  const a = sk.save({ name: 'Cú máy chậm', text: 'Prompt video luôn dùng cú máy chậm.\nÁnh sáng ấm.' });
  assert.equal(a.scope, 'global');
  assert.equal(a.enabled, true);
  const b = sk.save({ name: 'Riêng project', text: 'Chỉ MV này: đổi Production sang Muse.', scope: 'project', projectId: 'p1' });
  assert.equal(b.scope, 'project');

  // p1 sees the global skill + its own; p2 sees only the global one.
  assert.equal(sk.list('p1').length, 2);
  assert.equal(sk.list('p2').length, 1, 'kỹ năng theo project không rò sang project khác');
  assert.match(sk.enabledText('p1'), /Cú máy chậm/);
  assert.match(sk.enabledText('p1'), /Riêng project/);
  assert.ok(!/Riêng project/.test(sk.enabledText('p2')), 'enabledText của p2 không chứa kỹ năng của p1');

  // Toggling off removes it from the injected text.
  sk.toggle(a.id, false);
  assert.ok(!/Cú máy chậm/.test(sk.enabledText('p1')));
  assert.equal(sk.enabledCount('p1'), 1);

  // Editing by id keeps ONE row and preserves the on/off state (stays off here).
  sk.save({ id: a.id, name: 'Cú máy chậm v2', text: 'x' });
  assert.equal(sk.list('p1').filter(s => /Cú máy chậm/.test(s.name)).length, 1, 'sửa giữ một dòng');
  assert.equal(sk.list('p1').find(s => s.id === a.id).enabled, false, 'sửa kỹ năng đang tắt vẫn tắt');

  // Delete.
  sk.remove(b.id);
  assert.equal(sk.list('p1').length, 1);

  // Validation.
  assert.throws(() => sk.save({ name: '', text: 'x' }), /tên và nội dung/);
  assert.throws(() => sk.save({ name: 'x', text: '' }), /tên và nội dung/);

  // Persistence across instances (stored in the data dir like the Claude key).
  const sk2 = createAssistantSkills(dir);
  assert.equal(sk2.list('p1').length, 1);
  assert.equal(sk2.list('p1')[0].name, 'Cú máy chậm v2');

  console.log('PASS: assistant skills storage (global/project scope, toggle, enabledText, edit, delete, persistence)');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
