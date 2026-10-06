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
export const BUILTIN = [
  {
    id: 'builtin:mv',
    name: 'MV ca nhạc (concert)',
    theme: 'music',
    builtin: true,
    prompt: MASTER_PROMPT,
  },
  {
    id: 'builtin:drama-short',
    name: 'Drama ngắn',
    theme: 'film',
    builtin: true,
    prompt: readPreset('drama-short.txt'),
  },
  {
    id: 'builtin:drama-long',
    name: 'Phim drama dài',
    theme: 'film',
    builtin: true,
    prompt: readPreset('drama-long.txt'),
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
