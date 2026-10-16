// Hai thứ: thư viện SKILL xếp theo thể loại, và trợ lý đạo diễn can thiệp được vào từng BƯỚC
// của xưởng kịch bản (sửa kết quả một trạm rồi chạy tiếp các trạm sau).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GENRES, genreLabel, listMasterPrompts } from './lib/master-prompts.mjs';
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

console.log(
  `PASS: thư viện skill — ${builtin.length} skill dựng sẵn chia ${Object.keys(byGenre).length} thể loại ` +
    `(${Object.entries(byGenre)
      .map(([g, v]) => genreLabel(g) + ':' + v.length)
      .join(', ')}), ` +
    'mỗi skill khoá cấu trúc + bắt buộc câu nhân vật hư cấu; trợ lý đạo diễn sửa được từng BƯỚC ' +
    'của xưởng kịch bản và chạy tiếp, chặn bước lạ / nội dung trống / thiếu bước trước, và đổi ' +
    'theo chế độ MV khi nối node Nhạc',
);
