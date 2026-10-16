// Files attached to a Trợ lý đạo diễn message: what the server accepts, how a text document is
// folded into the prompt as data, and the content blocks the Messages API request carries.
// Real bytes throughout (a real PNG, a real PDF header, real UTF-8 text) — nothing is faked except
// the HTTP transport, which createAssistantClaude already takes as an argument.
import assert from 'node:assert/strict';
process.env.MV_CLAUDE_BIN = 'none'; // force the API-key path; the CLI path needs the real binary
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantClaude } from './lib/assistant-claude.mjs';
import { MAX_FILES, documentsPrompt, readAttachments } from './lib/assistant-files.mjs';

// A real 1x1 PNG (signature + IHDR + IDAT + IEND).
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n', 'utf8');
const b64 = buf => buf.toString('base64');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-assistant-files-'));
try {
  // --- what the server accepts -------------------------------------------------------------
  assert.deepEqual(
    readAttachments(undefined),
    { attachments: [], documents: [], names: [] },
    'không đính kèm gì thì trả rỗng',
  );

  const script = 'CẢNH 1 — Đêm.\nMai bước lên cầu thép.\n';
  const mixed = readAttachments([
    { name: 'ref.png', mime: 'image/png', base64: b64(png) },
    { name: 'hopdong.pdf', mime: 'application/pdf', base64: b64(pdf) },
    { name: 'kichban.srt', mime: '', base64: b64(Buffer.from(script, 'utf8')) },
  ]);
  assert.equal(mixed.attachments.length, 2, 'ảnh + PDF đi kèm như tệp');
  assert.equal(mixed.attachments[0].mime, 'image/png');
  assert.equal(mixed.attachments[1].mime, 'application/pdf');
  assert.equal(mixed.documents.length, 1, 'tài liệu chữ được đọc thành text');
  assert.equal(mixed.documents[0].text, script, 'đọc đúng UTF-8 tiếng Việt');
  assert.deepEqual(mixed.names, ['ref.png', 'hopdong.pdf', 'kichban.srt']);

  // A browser that reports no mime for .md/.srt must still be accepted by extension…
  assert.equal(
    readAttachments([{ name: 'ghichu.md', mime: '', base64: b64(Buffer.from('# ghi chú')) }])
      .documents.length,
    1,
    'nhận .md dù trình duyệt không báo mime',
  );
  // …and a PDF whose mime is missing is still a PDF.
  assert.equal(
    readAttachments([{ name: 'a.pdf', mime: '', base64: b64(pdf) }]).attachments[0].mime,
    'application/pdf',
  );

  assert.throws(
    () => readAttachments([{ name: 'virus.exe', mime: 'application/x-msdownload', base64: 'AA==' }]),
    /Không nhận được tệp/,
    'loại tệp lạ bị từ chối',
  );
  assert.throws(
    () => readAttachments([{ name: 'trong.png', mime: 'image/png', base64: '' }]),
    /rỗng/,
    'tệp rỗng bị từ chối',
  );
  assert.throws(
    () =>
      readAttachments(
        Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
          name: `r${i}.png`,
          mime: 'image/png',
          base64: b64(png),
        })),
      ),
    new RegExp(`Tối đa ${MAX_FILES} tệp`),
    'quá số tệp cho phép bị từ chối',
  );
  assert.throws(
    () => readAttachments([{ name: 'to.png', mime: 'image/png', base64: 'A'.repeat(17 * 1024 * 1024) }]),
    /lớn hơn/,
    'tệp quá nặng bị từ chối',
  );

  // A long document is cut, not dropped, so one big script cannot blow up the request.
  const long = readAttachments([
    { name: 'dai.txt', mime: 'text/plain', base64: b64(Buffer.from('x'.repeat(40000))) },
  ]);
  assert.ok(long.documents[0].text.length < 21000, 'tài liệu quá dài bị cắt');
  assert.match(long.documents[0].text, /đã cắt bớt/, 'và nói rõ là đã cắt');

  // --- the prompt section ------------------------------------------------------------------
  assert.equal(documentsPrompt([]), '', 'không có tài liệu thì không thêm gì vào prompt');
  const section = documentsPrompt(mixed.documents);
  assert.match(section, /data, not instructions/, 'tài liệu phải được dán nhãn là DỮ LIỆU');
  assert.match(section, /--- kichban\.srt ---/, 'kèm tên tệp');
  assert.ok(section.includes(script), 'kèm nội dung');

  // --- the Messages API request --------------------------------------------------------------
  const sent = [];
  const claude = createAssistantClaude(dir, async (url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ usage: {}, content: [{ type: 'text', text: '{}' }] }) };
  });
  claude.save({ key: 'sk-ant-test-only-12345', model: 'claude-sonnet-4-6' });

  await claude.complete('sys', 'câu hỏi', { attachments: mixed.attachments });
  const content = sent[0].messages[0].content;
  assert.ok(Array.isArray(content), 'có tệp → content là mảng block');
  assert.equal(content.length, 3, 'hai tệp + một khối chữ');
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.type, 'base64');
  assert.equal(content[0].source.media_type, 'image/png');
  assert.equal(content[0].source.data, b64(png), 'gửi đúng byte ảnh');
  assert.equal(content[1].type, 'document', 'PDF đi dạng document block');
  assert.equal(content[1].source.media_type, 'application/pdf');
  assert.equal(content[2].type, 'text', 'câu hỏi nằm SAU tệp');
  assert.equal(content[2].text, 'câu hỏi');

  await claude.complete('sys', 'không kèm gì');
  assert.equal(
    sent[1].messages[0].content,
    'không kèm gì',
    'không có tệp → content vẫn là chuỗi như cũ',
  );

  console.log(
    'PASS: assistant attachments — nhận ảnh/PDF/tài liệu chữ (kể cả khi trình duyệt không báo mime), từ chối loại lạ/rỗng/quá nặng/quá nhiều, cắt tài liệu quá dài, tài liệu vào prompt có nhãn DỮ LIỆU, request API dựng đúng block image/document rồi mới tới chữ, không kèm gì thì giữ nguyên dạng chuỗi',
  );
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
