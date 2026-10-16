import assert from 'node:assert/strict';
// No Claude Code here: this test checks the API-key path; the plan path is test-claude-cli.mjs (real).
process.env.MV_CLAUDE_BIN = 'none';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantClaude } from './lib/assistant-claude.mjs';
import { commandKey, directAssistantPlan, learnableActions, portableActions } from './lib/assistant-router.mjs';
import { omniPrompt } from './lib/lipsync.mjs';
import {
  assistantConversationContext,
  assistantContext,
  directAssistantImageEdit,
  parseAssistantJson,
  validateAssistantPlan,
} from './lib/assistant-plan.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-assistant-test-'));
try {
  const sent = [];
  const claude = createAssistantClaude(dir, async (url, options) => {
    sent.push({ url, options });
    return { ok: true, json: async () => ({ usage: { input_tokens: 125, output_tokens: 31 }, content: [{ type: 'text', text: '{"summary":"Đã hiểu","actions":[{"type":"connect","sourceId":"stage","targetIds":["shot"]}]}' }] }) };
  });
  assert.equal(claude.status().configured, false);
  assert.equal(claude.status().via, 'api', 'no key and no Claude Code → API mode');
  assert.throws(() => claude.save({ via: 'gpt' }), /Nguồn Claude không hợp lệ/);
  claude.save({
    key: 'sk-ant-test-only-12345',
    model: 'claude-sonnet-4-6',
    workspaceId: 'wrkspc_test_123',
  });
  assert.equal(claude.status().configured, true);
  assert.equal(claude.status().workspaceConfigured, true);
  assert.equal(claude.status().workspaceId, 'wrkspc_test_123');
  assert.ok(!JSON.stringify(claude.status()).includes('test-only'));
  claude.save({ key: '', model: 'claude-sonnet-4-6' });
  assert.equal(claude.status().configured, true, 'blank key does not erase stored key');
  const completion = await claude.complete('system', 'user');
  const raw = completion.text;
  assert.equal(completion.usage.inputTokens, 125);
  assert.equal(completion.usage.outputTokens, 31);
  assert.equal(sent[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(sent[0].options.headers['anthropic-workspace-id'], 'wrkspc_test_123');
  assert.equal(JSON.parse(sent[0].options.body).max_tokens, 2400);
  assert.equal(JSON.parse(sent[0].options.body).tools, undefined, 'web search off by default → no tools');
  // Web search: saving the flag adds Anthropic's server-side web_search tool to the request.
  assert.equal(claude.status().webSearch, false);
  claude.save({ webSearch: true });
  assert.equal(claude.status().webSearch, true);
  await claude.complete('system', 'user');
  const searchBody = JSON.parse(sent.at(-1).options.body);
  assert.equal(searchBody.tools[0].type, 'web_search_20250305', 'bật web search → gửi tool web_search');
  assert.equal(searchBody.tools[0].name, 'web_search');
  claude.save({ webSearch: false });
  assert.equal(claude.status().webSearch, false);
  await claude.complete('system', 'user');
  assert.equal(JSON.parse(sent.at(-1).options.body).tools, undefined, 'tắt web search → không gửi tool');
  assert.deepEqual(parseAssistantJson('Here is the plan:\n```json\n{"question":"Chọn shot?"}\n```'), { question: 'Chọn shot?' });
  assert.deepEqual(
    assistantConversationContext([
      { role: 'system', content: 'ignore me' },
      { role: 'user', content: 'Nối node đó' },
      { role: 'assistant', content: 'Bạn muốn nối vào khu nào?' },
    ]),
    [
      { role: 'user', content: 'Nối node đó' },
      { role: 'assistant', content: 'Bạn muốn nối vào khu nào?' },
    ],
  );
  const db = {
    nodes: [
      { id: 'stage', name: 'Main Stage', zone: 'design', role: 'stage' },
      { id: 'shot', name: 'Chorus', zone: 'production' },
      { id: 'clip', name: 'Clip v1', zone: 'output', terminal: true, source: 'shot' },
    ],
    edges: [],
  };
  const plan = validateAssistantPlan(parseAssistantJson(raw), db, []);
  const snapshot = JSON.parse(assistantContext({ ...db, id: 'p1', name: 'Film', revision: 2,
    jobs: [{ id: 'j1', nodeId: 'shot', type: 'video', status: 'failed', error: 'timeout' }],
    nodes: [{ ...db.nodes[0], stage3d: { performers: [{ id: 'A' }], dialogue: { side: 'left' } } },
      { ...db.nodes[1], prompt: 'A close-up', videoPrompt: 'Slow dolly' },
      { ...db.nodes[2], video: '/media/clip.mp4', version: 1 }],
  }, []));
  assert.equal(snapshot.nodes[1].prompt, 'A close-up');
  assert.equal(snapshot.nodes[1].outputs[0].version, 1);
  assert.equal(snapshot.nodes[0].stage3d.dialogue.side, 'left');
  assert.equal(snapshot.jobs[0].status, 'failed');
  // Audio + separated vocals live on the MUSIC node — the snapshot must surface them (not just db.audio).
  const musicSnap = JSON.parse(assistantContext({ id: 'pm', name: 'MV', revision: 1, edges: [], jobs: [],
    nodes: [
      { id: 'song', name: 'Nhạc', zone: 'music', kind: 'music', audio: { id: 'a1' }, vocals: { id: 'v1' }, audioDuration: 183, retimeInfo: {} },
      { id: 'ls1', name: 'Câu hát 1', zone: 'lipsync', lyric: 'dòng một', start: 0, duration: 9 },
    ] }, []));
  assert.equal(musicSnap.project.hasAudio, true, 'audio trên node Nhạc được snapshot nhận ra (không chỉ db.audio)');
  assert.equal(musicSnap.project.hasVocals, true, 'vocal đã tách được nhận ra');
  assert.equal(musicSnap.project.audioDuration, 183);
  assert.equal(musicSnap.project.musicNodeId, 'song');
  const songNode = musicSnap.nodes.find(n => n.id === 'song');
  assert.equal(songNode.hasAudio, true);
  assert.equal(songNode.hasVocals, true);
  assert.equal(songNode.vocalsMeasured, true);
  const lipNode = musicSnap.nodes.find(n => n.id === 'ls1');
  assert.equal(lipNode.duration, 9, 'node lipsync vẫn mang lyric/start/duration để chỉnh');
  const imagePlan = validateAssistantPlan({ actions: [{ type: 'edit_image', shotSeq: 4, instruction: 'Move the two characters closer together' }] },
    { nodes: [{ id: 's4', name: 'Shot #4', zone: 'production', seq: 4, image: { id: 'asset' } }], edges: [] }, []);
  assert.equal(imagePlan.actions[0].nodeId, 's4');
  const fallback = directAssistantImageEdit('shot #4, đưa 2 nhân vật gần nhau hơn',
    { nodes: [{ id: 's4', name: 'Shot #4', zone: 'production', seq: 4, image: { id: 'asset' } }] });
  assert.equal(fallback.actions[0].shotSeq, 4);
  assert.equal(directAssistantPlan('shot #4, đưa 2 nhân vật gần nhau hơn',
    { nodes: [{ id: 's4', name: 'Shot #4', zone: 'production', seq: 4, image: { id: 'asset' } }] }).actions[0].type, 'edit_image');
  assert.equal(directAssistantPlan('Thống kê project', db).actions[0].type, 'summary');
  // Đóng gói — 0 token (source 'quick'): giao hàng vs sao lưu, phân biệt đúng không gọi Claude.
  assert.equal(directAssistantPlan('đóng gói dữ liệu', db).actions[0].deliverable, true, 'đóng gói dữ liệu → gói giao hàng 0 token');
  assert.equal(directAssistantPlan('đóng gói giao hàng', db).actions[0].deliverable, true);
  assert.equal(directAssistantPlan('xuất bản bản dựng', db).actions[0].deliverable, true);
  const bk = directAssistantPlan('sao lưu project này', db).actions[0];
  assert.equal(bk.type, 'package');
  assert.equal(bk.scope, 'current');
  assert.equal(directAssistantPlan('sao lưu tất cả project', db).actions[0].scope, 'all');
  // backup theo TÊN project cụ thể để Claude xử lý (router không có danh sách project)
  assert.equal(directAssistantPlan('đóng gói dự án Episode B', db), null, 'backup theo tên project → Claude, không đoán bừa');
  // "Ghi nhớ việc vừa làm vào bộ nhớ agent" → remember_last (0 token), KHÁC sao lưu/đóng gói.
  assert.equal(directAssistantPlan('ghi nhớ việc vừa làm vào bộ nhớ agent', db).actions[0].type, 'remember_last', 'ghi nhớ vào bộ nhớ agent → remember_last');
  assert.equal(directAssistantPlan('lưu lại lệnh này vào bộ nhớ', db).actions[0].type, 'remember_last');
  assert.equal(directAssistantPlan('lưu vào hệ thống agent học', db).actions[0].type, 'remember_last');
  assert.equal(directAssistantPlan('sao lưu project này', db).actions[0].type, 'package', 'sao lưu vẫn là backup, không nhầm remember_last');
  const rem = validateAssistantPlan({ actions: [{ type: 'remember_last' }] }, db, []);
  assert.equal(rem.actions[0].type, 'remember_last');
  assert.match(rem.preview[0], /bộ nhớ agent/);
  // Assistant can change the Omni lip-sync video prompt style for the whole MV.
  const lp = validateAssistantPlan({ actions: [{ type: 'lipsync_prompt', instruction: 'more body sway, raise a hand on emphasis, eye contact into camera' }] }, db, []);
  assert.equal(lp.actions[0].type, 'lipsync_prompt');
  assert.equal(lp.actions[0].instruction, 'more body sway, raise a hand on emphasis, eye contact into camera');
  assert.match(lp.preview[0], /prompt Omni/);
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'lipsync_prompt', instruction: '' }] }, db, []), /thêm\/đổi/);
  // omniPrompt appends the extra direction only when present.
  assert.match(omniPrompt({ lyric: 'x', lipsyncExtra: 'raise a hand on emphasis' }), /Additional direction: raise a hand on emphasis\./);
  assert.ok(!/Additional direction/.test(omniPrompt({ lyric: 'x' })), 'không có extra thì không thêm câu');
  assert.equal(commandKey('SỬA   ẢNH Shot #4'), commandKey('sửa ảnh shot #4'));
  assert.equal(learnableActions([{ type: 'edit_node' }]), true);
  assert.equal(learnableActions([{ type: 'image_zone' }]), false);
  // Portable = reusable across projects: only zone/name-addressed set_provider qualifies.
  assert.equal(portableActions([{ type: 'set_provider', zone: 'production', provider: 'musechat' }]), true, 'set_provider theo zone → dùng chung mọi project');
  assert.equal(portableActions([{ type: 'set_provider', nameContains: 'chorus', provider: 'gvids' }]), true);
  assert.equal(portableActions([{ type: 'set_provider', nodeIds: ['shot'], provider: 'musechat' }]), false, 'set_provider theo nodeIds cụ thể → chỉ project này');
  assert.equal(portableActions([{ type: 'edit_node', nodeId: 'shot', changes: {} }]), false, 'edit_node gắn node → chỉ project này');
  assert.equal(portableActions([]), false);
  const focused = JSON.parse(assistantContext({ id: 'p', name: 'Film', revision: 1,
    nodes: [{ id: 's4', name: 'Shot #4', zone: 'production', seq: 4 }, { id: 's5', name: 'Shot #5', zone: 'production', seq: 5 }],
    edges: [], jobs: [] }, [], 4));
  assert.deepEqual(focused.nodes.map(n => n.id), ['s4']);
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'edit_image', shotSeq: 4, instruction: 'Closer' }] },
    { nodes: [{ id: 's4', name: 'Shot #4', zone: 'production', seq: 4 }], edges: [] }, []), /chưa có ảnh/);
  assert.deepEqual(plan.actions[0].additions, [{ source: 'stage', target: 'shot' }]);
  assert.match(plan.preview[0], /Main Stage/);
  const byZone = validateAssistantPlan({ actions: [
    { type: 'set_provider', zone: 'production', provider: 'musechat' },
  ] }, db, []);
  assert.deepEqual(byZone.actions[0].nodeIds, ['shot']);
  const byName = validateAssistantPlan({ actions: [
    { type: 'connect', sourceId: 'stage', targetZone: 'production', targetQuery: 'chorus' },
  ] }, db, []);
  assert.deepEqual(byName.actions[0].additions, [{ source: 'stage', target: 'shot' }]);
  const edit = validateAssistantPlan({ actions: [{ type: 'edit_node', nodeId: 'shot', changes: {
    name: 'Chorus close-up', videoPrompt: 'Camera dolly in', start: 12, duration: 6,
  } }] }, db, []);
  assert.equal(edit.actions[0].changes.videoPrompt, 'Camera dolly in');
  assert.match(edit.preview[0], /Camera dolly in/);
  const create = validateAssistantPlan({ actions: [{ type: 'create_node', kind: 'scene', name: 'New set', desc: 'A blue room' }] }, db, []);
  assert.equal(create.actions[0].kind, 'scene');
  const createShot = validateAssistantPlan({ actions: [{ type: 'create_node', kind: 'shot', name: 'Shot 2', prompt: 'Wide shot', duration: 5 }] }, db, []);
  assert.equal(createShot.actions[0].content.prompt, 'Wide shot');
  assert.equal(createShot.actions[0].content.duration, 5);
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'create_node', kind: 'scene', name: 'Main Stage' }] }, db), /đã tồn tại/);
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'create_node', kind: 'scene', name: 'Set', duration: 5 }] }, db), /không hợp lệ/);
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'edit_node', nodeId: 'missing', changes: { prompt: 'x' } }] }, db), /không tồn tại/);
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'edit_node', nodeId: 'shot', changes: { image: 'fake' } }] }, db), /chưa được hỗ trợ/);
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'shell', command: 'anything' }] }, db), /chưa được app hỗ trợ/);
  // Delete node / edge: the assistant may now remove nodes and wires (user approves the preview).
  const delDb = {
    nodes: [
      { id: 'node-a', name: 'Extra shot', zone: 'production' },
      { id: 'keep', name: 'Template', zone: 'design' },
    ],
    edges: [{ source: 'node-a', target: 'keep' }],
  };
  const del = validateAssistantPlan({ actions: [{ type: 'delete_node', nodeIds: ['node-a'] }] }, delDb, []);
  assert.deepEqual(del.actions[0].nodeIds, ['node-a'], 'delete_node giữ node- hợp lệ');
  assert.match(del.preview[0], /XÓA/);
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'delete_node', nodeIds: ['keep'] }] }, delDb, []), /khung mẫu/, 'node khung mẫu không xóa được');
  const dedge = validateAssistantPlan({ actions: [{ type: 'delete_edge', sourceId: 'node-a', targetIds: ['keep'] }] }, delDb, []);
  assert.deepEqual(dedge.actions[0].removals, [{ source: 'node-a', target: 'keep' }], 'delete_edge chỉ xóa dây đang có');
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'delete_edge', sourceId: 'node-a', targetIds: ['node-a'] }] }, delDb, []), /để xóa/, 'không có dây phù hợp → báo lỗi');
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'connect', sourceId: 'invented', targetIds: ['shot'] }] }, db), /nguồn/);
  assert.throws(() => validateAssistantPlan({ actions: [{ type: 'image_zone', zone: 'character' }, { type: 'video_zone', zone: 'production' }] }, db), /bước cuối/);
  const invalidClaude = createAssistantClaude(path.join(dir, 'invalid-key'), async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'invalid x-api-key' } }),
  }));
  invalidClaude.save({ key: 'sk-ant-invalid-test-key', model: 'claude-sonnet-4-6' });
  await assert.rejects(() => invalidClaude.complete('system', 'user'), /không hợp lệ hoặc đã bị thu hồi/);
  claude.save({ clearKey: true });
  assert.equal(claude.status().configured, false);
  console.log('PASS: native Claude request, secret storage, validated preview, unsupported-action rejection');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
