// Kỹ năng Trợ lý — standing instructions the Director Assistant always follows when it plans.
// A skill is a named guideline the user writes (or the assistant distills from a successful run);
// enabled skills are injected into the planning system prompt. Stored like the Claude key: one file
// in the data dir, shared by every project. A skill is global by default, or scoped to one project.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createAssistantSkills(dataDir) {
  const file = path.join(dataDir, 'assistant-skills.json');
  const read = () => {
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };
  const write = rows => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(rows.slice(-300)));
    fs.renameSync(file + '.tmp', file);
  };
  // Skills that apply in this project: the global ones plus this project's own.
  const forProject = activeId =>
    read().filter(s => s.scope === 'global' || s.projectId === activeId);
  const clean = s => ({
    id: s.id,
    name: s.name,
    text: s.text,
    enabled: s.enabled !== false,
    scope: s.scope === 'project' ? 'project' : 'global',
    at: s.at,
  });
  return {
    list: activeId => forProject(activeId).map(clean).slice(-200).reverse(),
    save: ({ id, name, text, scope, projectId }) => {
      const nm = String(name || '').trim().slice(0, 120);
      const tx = String(text || '').trim().slice(0, 4000);
      if (!nm || !tx) throw new Error('Kỹ năng cần có tên và nội dung.');
      const rows = read();
      const sc = scope === 'project' ? 'project' : 'global';
      const existing = id ? rows.find(s => s.id === id) : null;
      const row = {
        id: existing ? existing.id : 'skill-' + crypto.randomUUID(),
        name: nm,
        text: tx,
        enabled: existing ? existing.enabled !== false : true, // editing keeps the on/off state
        scope: sc,
        projectId: sc === 'project' ? projectId : undefined,
        at: new Date().toISOString(),
      };
      write([...rows.filter(s => s.id !== row.id), row]);
      return clean(row);
    },
    toggle: (id, enabled) => {
      const rows = read();
      const row = rows.find(s => s.id === id);
      if (!row) throw new Error('Kỹ năng không tồn tại.');
      row.enabled = !!enabled;
      write(rows);
      return clean(row);
    },
    remove: id => {
      write(read().filter(s => s.id !== id));
    },
    // The enabled skills for this project, as one block for the planning system prompt.
    enabledText: activeId => {
      const on = forProject(activeId).filter(s => s.enabled !== false);
      if (!on.length) return '';
      return on
        .map((s, i) => `Skill ${i + 1} — ${s.name}:\n${s.text}`)
        .join('\n\n');
    },
    enabledCount: activeId => forProject(activeId).filter(s => s.enabled !== false).length,
  };
}
