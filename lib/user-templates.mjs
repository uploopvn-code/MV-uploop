// User templates: reusable project skeletons (nodes + edges + fields, no media) the user saves
// from a project and clones a new project from. Stored under data/templates/<id>.json, shared by
// every project like the LLM key — not inside any one project. Storage only; building the
// template object from a project, and a project from a template, live in templates.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { data } from './config.mjs';

export const templatesDir = path.join(data, 'templates');
fs.mkdirSync(templatesDir, { recursive: true });
const tplFile = id => path.join(templatesDir, id + '.json');
const isId = id => /^[a-f0-9-]{36}$/.test(String(id || ''));

// Saves a template object (built by templateFromProject) under a fresh id. Returns its summary.
export function saveTemplate(tpl) {
  const id = crypto.randomUUID();
  const rec = { id, createdAt: new Date().toISOString(), ...tpl };
  fs.writeFileSync(tplFile(id), JSON.stringify(rec, null, 2));
  return summary(rec);
}
export function getTemplate(id) {
  if (!isId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(tplFile(id), 'utf8'));
  } catch {
    return null;
  }
}
export function deleteTemplate(id) {
  if (!isId(id)) return false;
  try {
    fs.unlinkSync(tplFile(id));
    return true;
  } catch {
    return false;
  }
}
const summary = t => ({
  id: t.id,
  name: t.name,
  theme: t.theme,
  nodeCount: Array.isArray(t.nodes) ? t.nodes.length : 0,
  createdAt: t.createdAt,
});
// Newest first, as the create/manage dialogs list them.
export function listTemplates() {
  let files = [];
  try {
    files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.json'));
  } catch {}
  return files
    .map(f => {
      try {
        return summary(JSON.parse(fs.readFileSync(path.join(templatesDir, f), 'utf8')));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
