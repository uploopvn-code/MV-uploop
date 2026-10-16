// Read-only ZIP snapshot of one project or the whole local workspace. Never includes
// global worker tokens, API keys, .lock files, or arbitrary external export folders.
import fs from 'node:fs';
import path from 'node:path';
import { activeId, projectDbFile, projectDir, ws } from './projects.mjs';

const mediaName = /^[a-f0-9-]+\.(png|jpg|webp|mp4|webm|mp3|wav|m4a|ogg)$/i;
export function projectPackage(scope = 'current', projectId = null) {
  if (!['current', 'all', 'project'].includes(scope)) throw new Error('Phạm vi đóng gói không hợp lệ.');
  if (scope === 'project' && !ws.order.includes(projectId)) throw new Error('Project được chọn không tồn tại.');
  const ids = scope === 'all' ? [...new Set(ws.order)] : [scope === 'project' ? projectId : activeId];
  if (!ids.length || ids.some(id => !/^[a-f0-9-]{36}$/i.test(id)))
    throw new Error('Không tìm thấy project hợp lệ để đóng gói.');
  const files = [];
  const projects = [];
  let bytes = 0;
  for (const id of ids) {
    const source = projectDbFile(id);
    const raw = fs.readFileSync(source);
    const project = JSON.parse(raw.toString('utf8'));
    files.push({ name: `projects/${id}/project.json`, data: raw });
    bytes += raw.length;
    const media = path.join(projectDir(id), 'media');
    let mediaCount = 0;
    if (fs.existsSync(media))
      for (const entry of fs.readdirSync(media, { withFileTypes: true })) {
        if (!entry.isFile() || !mediaName.test(entry.name)) continue;
        const sourceFile = path.join(media, entry.name);
        const size = fs.statSync(sourceFile).size;
        files.push({ name: `projects/${id}/media/${entry.name}`, path: sourceFile });
        bytes += size;
        mediaCount++;
      }
    projects.push({ id, name: project.name || id, mediaCount });
  }
  const workspace = Buffer.from(JSON.stringify({ active: ids.includes(ws.active) ? ws.active : ids[0], order: ids }, null, 2));
  files.unshift({ name: 'workspace.json', data: workspace });
  bytes += workspace.length;
  const manifest = Buffer.from(JSON.stringify({
    format: 'mv-director-package', version: 1, createdAt: new Date().toISOString(),
    scope, projects,
    note: 'Snapshot of project.json and local media. External export folders and application credentials are not included.',
  }, null, 2));
  files.unshift({ name: 'manifest.json', data: manifest });
  bytes += manifest.length;
  return { scope, projects, mediaCount: projects.reduce((sum, p) => sum + p.mediaCount, 0), bytes, files };
}
