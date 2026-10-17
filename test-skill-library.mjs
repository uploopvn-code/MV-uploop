// Hai thứ: thư viện SKILL xếp theo thể loại, và trợ lý đạo diễn can thiệp được vào từng BƯỚC
// của xưởng kịch bản (sửa kết quả một trạm rồi chạy tiếp các trạm sau).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GENRES, genreLabel, listMasterPrompts } from './lib/master-prompts.mjs';
import { buildGraph } from './director.mjs';
import { placeKey } from './lib/music-auto.mjs';
import { stages } from './lib/script-studio.mjs';
import { ASSISTANT_SYSTEM, validateAssistantPlan } from './lib/assistant-plan.mjs';

// --- 1) Thư viện skill theo thể loại --------------------------------------------------------
const all = listMasterPrompts();
const builtin = all.filter(t => t.builtin);
assert.ok(builtin.length >= 7, 'thư viện có ít nhất 7 skill dựng sẵn, có ' + builtin.length);
assert.ok(
  builtin.every(t => t.genre && GENRES.some(g => g.id === t.genre)),
  'skill nào cũng thuộc một thể loại có trong GENRES: ' +
    builtin.map(t => t.name + '=' + t.genre).join(', '),
);
assert.ok(
  builtin.every(t => t.prompt && t.prompt.length > 1500),
  'skill nào cũng có master prompt thật, không phải đoạn mô tả suông',
);
const byGenre = {};
for (const t of builtin) (byGenre[t.genre] ||= []).push(t.name);
for (const g of ['mv', 'drama', 'horror', 'comedy', 'ads'])
  assert.ok(byGenre[g]?.length, 'thể loại "' + g + '" phải có ít nhất một skill');
assert.ok(byGenre.mv.length >= 2, 'MV có nhiều hơn một lựa chọn');
assert.equal(genreLabel('horror'), 'Kinh dị · Hồi hộp');
assert.equal(genreLabel('khong-co'), 'Khác', 'thể loại lạ rơi về Khác');
// Tên id không đụng nhau, và tên hiển thị không trùng (người dùng chọn bằng mắt).
assert.equal(new Set(builtin.map(t => t.id)).size, builtin.length, 'id không trùng');
assert.equal(new Set(builtin.map(t => t.name)).size, builtin.length, 'tên không trùng');

// Mỗi skill phải khoá CẤU TRÚC, không chỉ tả cảm hứng: nhắc tới thời lượng shot và xuất JSON.
for (const t of builtin) {
  assert.match(t.prompt, /```json/, t.name + ': phải nêu rõ khối JSON xuất ra');
  assert.match(t.prompt, /8 giây|8 second|duration/i, t.name + ': phải khoá thời lượng shot');
}
// Skill nào có nhân vật thì phải đòi câu nhân vật hư cấu — thiếu là model video từ chối dựng.
for (const t of builtin.filter(x => /role": "character|role: "character|character/.test(x.prompt)))
  assert.match(
    t.prompt,
    /fictional AI-generated character/,
    t.name + ': phải bắt buộc câu nhân vật hư cấu',
  );

// UI nhóm theo thể loại: director.js phải đọc danh sách thể loại từ state, không chép cứng.
const dj = fs.readFileSync(new URL('./public/js/director.js', import.meta.url), 'utf8');
assert.match(dj, /promptGenres/, 'dropdown lấy danh sách thể loại từ state');
assert.match(dj, /optgroup/, 'vẫn nhóm bằng optgroup');

// --- 2) Trợ lý can thiệp vào từng BƯỚC ------------------------------------------------------
assert.match(ASSISTANT_SYSTEM, /edit_stage/, 'Claude được biết hành động edit_stage');
assert.match(ASSISTANT_SYSTEM, /never a diff/, 'và được dặn gửi NGUYÊN văn bước mới');

const script = {
  id: 'n-script',
  kind: 'script',
  name: 'Kịch bản',
  mode: 'full',
  zone: 'start',
  stages: { story: 'truyện cũ' },
};
const db = { name: 'P', nodes: [script], edges: [] };

// Sửa một bước có thật, không chạy tiếp → hợp lệ.
let plan = validateAssistantPlan(
  {
    summary: 's',
    actions: [{ type: 'edit_stage', stage: 'story', text: 'truyện mới', rerun: false }],
  },
  db,
);
assert.equal(plan.actions.length, 1);
assert.equal(plan.actions[0].type, 'edit_stage');
assert.equal(plan.actions[0].nodeId, 'n-script', 'tự tìm ra node Kịch bản khi chỉ có một');
assert.equal(plan.actions[0].stage, 'story');
assert.equal(plan.actions[0].rerun, false);
assert.match(plan.preview[0], /① Biên kịch/, 'preview gọi đúng tên bước: ' + plan.preview[0]);
assert.match(plan.preview[0], /không chạy lại/, 'preview nói rõ có chạy tiếp hay không');

// Bước không có trong chế độ đang chạy → từ chối, và nói ra các bước hợp lệ.
assert.throws(
  () =>
    validateAssistantPlan(
      { summary: 's', actions: [{ type: 'edit_stage', stage: 'khong-co', text: 'x' }] },
      db,
    ),
  /không có trong chế độ đang chạy/,
  'bước lạ bị chặn',
);
// Nội dung trống → từ chối (xoá sạch một bước là hỏng cả chuỗi phía sau).
assert.throws(
  () =>
    validateAssistantPlan(
      { summary: 's', actions: [{ type: 'edit_stage', stage: 'story', text: '   ' }] },
      db,
    ),
  /không được trống/,
  'nội dung trống bị chặn',
);
// Chạy tiếp từ một bước GIỮA khi các bước trước chưa chạy → từ chối, không chạy vào chỗ trống.
assert.throws(
  () =>
    validateAssistantPlan(
      { summary: 's', actions: [{ type: 'edit_stage', stage: 'faces', text: 'biểu cảm mới' }] },
      db,
    ),
  /Chưa chạy các bước trước/,
  'chạy tiếp mà thiếu bước trước thì bị chặn',
);
// Có đủ bước trước → cho chạy tiếp.
const full = stages('full', 'drama');
const ready = { ...script, stages: Object.fromEntries(full.slice(0, 4).map(s => [s.key, 'x'])) };
plan = validateAssistantPlan(
  { summary: 's', actions: [{ type: 'edit_stage', stage: 'faces', text: 'biểu cảm mới' }] },
  { ...db, nodes: [ready] },
);
assert.equal(plan.actions[0].rerun, true, 'mặc định là chạy tiếp');
assert.match(plan.preview[0], /chạy tiếp các bước sau/, 'preview nói sẽ chạy tiếp');

// Nối node Nhạc vào thì danh sách bước đổi sang MV — trạm 'blocking' của drama không còn.
const music = { id: 'n-music', kind: 'music', name: 'Nhạc', zone: 'start' };
const mvDb = {
  ...db,
  nodes: [script, music],
  edges: [{ source: 'n-music', target: 'n-script' }],
};
assert.ok(
  !stages('full', 'mv').some(s => s.key === 'blocking'),
  'chế độ MV không có trạm blocking (tiền đề của phép kiểm dưới)',
);
assert.throws(
  () =>
    validateAssistantPlan(
      { summary: 's', actions: [{ type: 'edit_stage', stage: 'blocking', text: 'x' }] },
      mvDb,
    ),
  /không có trong chế độ đang chạy/,
  'nối nhạc vào thì bước của drama không còn hợp lệ',
);

// Không có node Kịch bản → nói rõ, không ném lỗi khó hiểu.
assert.throws(
  () =>
    validateAssistantPlan(
      { summary: 's', actions: [{ type: 'edit_stage', stage: 'story', text: 'x' }] },
      { ...db, nodes: [] },
    ),
  /Không tìm thấy node Kịch bản/,
  'không có node Kịch bản thì báo rõ',
);

// Trình duyệt phải áp được hành động này.
const cj = fs.readFileSync(new URL('./public/js/commands.js', import.meta.url), 'utf8');
assert.match(cj, /action\.type === 'edit_stage'/, 'commands.js áp được edit_stage');
assert.match(cj, /api\/script\/run/, 'và gọi chạy tiếp từ bước đã sửa');

// --- 3) Skill nhạc sân khấu live: tạo hình cho luồng A (không hát nhép) ----------------------
// Nó là nửa còn lại của master prompt shot list: shot list viết storyboard phủ cảnh, skill này
// dựng kho hình storyboard đó gọi tên. Hai thứ chỉ nối được khi key bối cảnh của skill trùng
// đúng cách tool đổi cột Location thành key, và khi ảnh ca sĩ không há miệng hát (luồng A cắt
// vào bất cứ giây nào, kể cả giây đang có tiếng hát).
const stage = builtin.find(t => t.id === 'builtin:stage-live');
assert.ok(stage, 'thư viện có skill nhạc sân khấu live');
assert.equal(stage.genre, 'mv');
assert.match(stage.prompt, /mouth closed/, 'model sheet ca sĩ phải khép miệng');
assert.match(stage.prompt, /LUỒNG A/, 'skill nói rõ nó phục vụ luồng nào');
assert.match(stage.prompt, /audience_rows/, 'có bối cảnh hàng ghế khán giả riêng');
assert.match(
  stage.prompt,
  /KHÁN GIẢ KHÔNG PHẢI NHÂN VẬT/,
  'đám đông dựng từ bối cảnh, không thành asset nhân vật',
);
assert.match(stage.prompt, /trạng thái TRUNG TÍNH|TRUNG TÍNH/, 'đèn trong ảnh bối cảnh để trung tính');

// Khối JSON skill dạy viết phải dựng được graph thật, không chỉ đọc xuôi tai.
const stageBlueprint = {
  project: { name: 'Đêm diễn thử', theme: 'music' },
  style: 'Cinematic 35mm photorealistic live stage performance; subtle film grain; no on-screen text.',
  assets: [
    {
      key: 'singer',
      role: 'character',
      name: 'Ca sĩ',
      code: 'NV1',
      identity_label: 'the dark-haired singer',
      physical_anchors: ['woman, late 20s', 'long dark wavy hair'],
      voice_profile: 'female, late 20s, warm low alto, unhurried phrasing, restrained grief',
      prompt:
        'Character model sheet turnaround of a 28yo woman singer, mouth closed, calm neutral expression, not singing, portrait on left, front, side and back views on right, neutral standing pose, solid gray background, studio lighting, consistent facial identity, cinematic 35mm photorealistic. This is an original fictional AI-generated character, not a real person and not resembling any celebrity, public figure or existing model; any resemblance is purely coincidental.',
    },
    {
      key: 'pianist',
      role: 'character',
      name: 'Pianist',
      code: 'NV2',
      identity_label: 'the bearded pianist',
      physical_anchors: ['man, early 40s', 'short beard'],
      prompt:
        'Character model sheet turnaround of a 42yo male pianist, mouth closed, calm neutral expression, not singing, portrait on left, front, side and back views on right, neutral standing pose, solid gray background, studio lighting, consistent facial identity, cinematic 35mm photorealistic. This is an original fictional AI-generated character, not a real person and not resembling any celebrity, public figure or existing model; any resemblance is purely coincidental.',
    },
    {
      key: 'main_stage',
      role: 'scene',
      name: 'Main stage',
      prompt:
        'Thrust stage with a dark LED wall showing a dim particle pattern, moving heads on overhead truss at neutral balance, thin even haze, worn red carpet, no on-screen text, no watermarks.',
    },
    {
      key: 'audience_rows',
      role: 'scene',
      name: 'Audience rows',
      prompt:
        'Sloped rows of seated listeners seen from the stage, faces lit from the stage spill, no on-screen text, no watermarks.',
    },
  ],
  cameras: [
    { key: 'ews', name: 'EWS · Toàn cảnh', config: 'extreme wide, whole hall, locked' },
    { key: 'ws', name: 'WS · Toàn ban nhạc', config: 'wide, full band on stage, slow push-in' },
    { key: 'cu', name: 'CU · Cận một người', config: '85mm close-up, catchlight, soft key' },
  ],
  shots: [
    {
      name: 'S01 — mẫu',
      start: 0,
      duration: 8,
      uses: ['singer', 'main_stage'],
      camera: 'ws',
      lyric: '',
      videoPrompt: 'The singer walks into the beam, seen from behind.',
    },
  ],
};
const stageGraph = buildGraph(stageBlueprint);
assert.deepEqual(stageGraph.warnings, [], 'blueprint theo skill dựng không cảnh báo');
assert.equal(stageGraph.theme, 'music');
assert.equal(stageGraph.nodes.filter(n => n.role === 'character').length, 2);
const stageScenes = stageGraph.nodes.filter(n => n.role === 'scene');
assert.equal(stageScenes.length, 2, 'sân khấu và hàng ghế là hai bối cảnh riêng');
// Điểm nối với shot list: cột Location "Audience rows" phải ra đúng key bối cảnh skill đã dựng,
// nếu không shot khán giả sẽ dùng nhầm ảnh sân khấu.
for (const location of ['Main stage', 'Audience rows'])
  assert.ok(
    stageScenes.some(n => n.assetKey === placeKey(location)),
    'Location "' + location + '" khớp một bối cảnh qua placeKey',
  );
// Ca sĩ vào shot nào thì ảnh model sheet của họ là ảnh gốc của khung đó, nên lời hát phải trống.
assert.equal(stageGraph.nodes.find(n => n.zone === 'production')?.lyric, '', 'shot luồng A không có lời để nhép');

console.log(
  `PASS: thư viện skill — ${builtin.length} skill dựng sẵn chia ${Object.keys(byGenre).length} thể loại ` +
    `(${Object.entries(byGenre)
      .map(([g, v]) => genreLabel(g) + ':' + v.length)
      .join(', ')}), ` +
    'mỗi skill khoá cấu trúc + bắt buộc câu nhân vật hư cấu; trợ lý đạo diễn sửa được từng BƯỚC ' +
    'của xưởng kịch bản và chạy tiếp, chặn bước lạ / nội dung trống / thiếu bước trước, và đổi ' +
    'theo chế độ MV khi nối node Nhạc; skill nhạc sân khấu live dựng được graph thật, khán giả ' +
    'là bối cảnh riêng khớp cột Location, ảnh ca sĩ khép miệng cho luồng A',
);
