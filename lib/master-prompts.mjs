// Master-prompt library: ready-made master prompts per theme (MV, drama short, long drama) the
// user picks from in the Đạo diễn tab, plus ones they save themselves. Built-ins ship with the
// app (MV = the default MASTER_PROMPT, drama ones from lib/master-prompts/*.txt); user ones live
// in data/master-prompts/<id>.json, shared by every project like the LLM key.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { data } from './config.mjs';
import { MASTER_PROMPT } from '../director.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const readPreset = f => {
  try {
    return fs.readFileSync(path.join(here, 'master-prompts', f), 'utf8').trim();
  } catch {
    return '';
  }
};
// Built-in presets (read-only). Their ids start with "builtin:" so they never look like a user id.
// Thể loại để xếp thư viện skill. `theme` là chủ đề project (music/film) — việc khác: một
// project "film" có cả drama, kinh dị lẫn quảng cáo. Thứ tự ở đây là thứ tự hiện trên UI.
export const GENRES = [
  { id: 'mv', label: 'MV ca nhạc' },
  { id: 'drama', label: 'Drama / Phim truyện' },
  { id: 'horror', label: 'Kinh dị · Hồi hộp' },
  { id: 'comedy', label: 'Hài · Đời thường' },
  { id: 'ads', label: 'Quảng cáo · TVC' },
  { id: 'doc', label: 'Tài liệu · Kể chuyện' },
  { id: 'other', label: 'Khác' },
];
export const genreLabel = id => GENRES.find(g => g.id === id)?.label || 'Khác';

export const BUILTIN = [
  {
    id: 'builtin:mv',
    genre: 'mv',
    name: 'MV ca nhạc (concert)',
    theme: 'music',
    builtin: true,
    prompt: MASTER_PROMPT,
  },
  {
    // MV một sân khấu, ballad tiếng Tây Ban Nha: khoá cứng 1 bối cảnh + shot 8 giây + dàn diễn
    // 2–4 người + lời hát giữ nguyên văn, nên mỗi clip render riêng vẫn ghép lại thành một MV.
    id: 'builtin:mv-ballad-es',
    genre: 'mv',
    name: 'MV ballad Tây Ban Nha (sân khấu nhỏ)',
    theme: 'music',
    builtin: true,
    prompt: readPreset('mv-ballad-es.txt'),
  },
  {
    id: 'builtin:drama-short',
    genre: 'drama',
    name: 'Drama ngắn',
    theme: 'film',
    builtin: true,
    prompt: readPreset('drama-short.txt'),
  },
  {
    id: 'builtin:drama-long',
    genre: 'drama',
    name: 'Phim drama dài',
    theme: 'film',
    builtin: true,
    prompt: readPreset('drama-long.txt'),
  },
  {
    // Kinh dị: luật riêng là CẤM tả bạo lực (model từ chối dựng) và chỗ trống dọa hơn con quái.
    id: 'builtin:horror-short',
    genre: 'horror',
    name: 'Phim ngắn kinh dị 60–90 giây',
    theme: 'film',
    builtin: true,
    prompt: readPreset('horror-short.txt'),
  },
  {
    // Hài: mặt tỉnh bơ + leo thang bộ ba + máy tĩnh. Cận mặt giết tiếng cười.
    id: 'builtin:comedy-short',
    genre: 'comedy',
    name: 'Hài tình huống 30–45 giây',
    theme: 'film',
    builtin: true,
    prompt: readPreset('comedy-short.txt'),
  },
  {
    // TVC: khoá sản phẩm (nhãn/màu/tỉ lệ không đổi giữa shot) + một lời hứa duy nhất.
    id: 'builtin:tvc-product',
    genre: 'ads',
    name: 'TVC sản phẩm 15 / 30 giây',
    theme: 'film',
    builtin: true,
    prompt: readPreset('tvc-product.txt'),
  },
].filter(t => t.prompt);

const dir = path.join(data, 'master-prompts');
fs.mkdirSync(dir, { recursive: true });
const file = id => path.join(dir, id + '.json');
const isId = id => /^[a-f0-9-]{36}$/.test(String(id || ''));

function readUser() {
  let out = [];
  try {
    for (const f of fs.readdirSync(dir))
      if (f.endsWith('.json'))
        try {
          out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        } catch {}
  } catch {}
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
// Built-in presets first, then the user's own (newest first). The full prompt is included so the
// UI can load a chosen template into the editor without a second request.
export function listMasterPrompts() {
  return [
    ...BUILTIN,
    ...readUser().map(t => ({
      id: t.id,
      name: t.name,
      theme: t.theme || '',
      genre: t.genre || 'other',
      builtin: false,
      prompt: t.prompt,
    })),
  ];
}
export function saveMasterPrompt(name, prompt) {
  const p = String(prompt || '').slice(0, 100000);
  if (!p.trim()) throw new Error('Master prompt trống — không lưu được mẫu.');
  const id = crypto.randomUUID();
  const rec = {
    id,
    name: String(name || 'Mẫu của tôi').slice(0, 100),
    theme: '',
    genre: '',
    prompt: p,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(file(id), JSON.stringify(rec, null, 2));
  return { id: rec.id, name: rec.name };
}
// Only user templates are deletable: a "builtin:" id is not a uuid, so it is refused here.
export function deleteMasterPrompt(id) {
  if (!isId(id)) return false;
  try {
    fs.unlinkSync(file(id));
    return true;
  } catch {
    return false;
  }
}
