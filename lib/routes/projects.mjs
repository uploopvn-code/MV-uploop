// Routes: project settings, create/switch/delete projects, windows, backup.
import { validateDirectory } from '../../output-config.mjs';
import { templateFromProject, themes } from '../../templates.mjs';
import { deleteTemplate, getTemplate, listTemplates, saveTemplate } from '../user-templates.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isChild } from '../config.mjs';
import { NEXT, body, json } from '../http.mjs';
import { holdsProject, requireIdle, requireNoRunningJobs } from '../jobs.mjs';
import {
  activeId,
  createProjectFiles,
  db,
  loadProject,
  lockOwner,
  mutate,
  okSeedvisModel,
  projectDbFile,
  projectDir,
  projectList,
  vocalTasks,
  writeAppDefaults,
  writeProject,
  writeWorkspace,
  ws,
} from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { markAll } from '../staleness.mjs';
import { closeWindow, mainOnly, openWindow, windows } from '../windows.mjs';

export async function handle(req, res, p, u) {
  if (p === '/api/project' && req.method === 'PATCH') {
    requireIdle();
    const b = await body(req);
    const outputDirectory =
      'outputDirectory' in b ? validateDirectory(b.outputDirectory) : db.outputDirectory;
    if (b.fields) {
      const fieldsBefore = JSON.stringify(db.fields);
      if (b.fields.bpm && (!Number.isFinite(Number(b.fields.bpm)) || Number(b.fields.bpm) <= 0))
        throw new Error('BPM phải là số dương.');
      for (const key of Object.keys(db.fields))
        if (key in b.fields) db.fields[key] = String(b.fields[key]).slice(0, 5000);
      if (db.fields.bpm && (!Number.isFinite(Number(db.fields.bpm)) || Number(db.fields.bpm) <= 0))
        throw new Error('BPM phải là số dương.');
      if (JSON.stringify(db.fields) !== fieldsBefore) markAll();
    }
    db.outputDirectory = outputDirectory;
    // Folder where this project's generated images/videos are saved as organized files.
    // Empty = default (inside the project's own folder). Must be an absolute path.
    if ('exportDir' in b) db.exportDir = b.exportDir ? validateDirectory(b.exportDir) : '';
    if ('website' in b) db.website = String(b.website).slice(0, 500);
    if ('name' in b) db.name = String(b.name).slice(0, 100);
    if ('theme' in b && themes.some(t => t.id === b.theme)) db.theme = b.theme;
    // Project-wide default source for nodes that have not chosen their own. image can be
    // seedvis | web (ChatGPT extension) | orbit; video seedvis | orbit (web makes images only).
    if (b.defaults) {
      db.defaults = db.defaults || {};
      if (['seedvis', 'web', 'orbit', 'musechat'].includes(b.defaults.image))
        db.defaults.image = b.defaults.image;
      if (['seedvis', 'orbit', 'gvids', 'musechat'].includes(b.defaults.video))
        db.defaults.video = b.defaults.video;
      // The default Seedvis model a new node uses when its source is Seedvis.
      if (okSeedvisModel('image', b.defaults.imageModel))
        db.defaults.imageModel = b.defaults.imageModel;
      if (okSeedvisModel('video', b.defaults.videoModel))
        db.defaults.videoModel = b.defaults.videoModel;
      // Make this the sticky app-wide default so new projects inherit the chosen source + model.
      writeAppDefaults(b.defaults);
    }
    mutate();
    return json(res, 200, publicState());
  }
  if (p === '/api/projects' && req.method === 'GET')
    return json(res, 200, {
      active: activeId,
      projects: projectList(),
      themes,
      templates: listTemplates(),
    });
  // User templates: reusable project skeletons shared by every project.
  if (p === '/api/templates' && req.method === 'GET')
    return json(res, 200, { templates: listTemplates() });
  if (p === '/api/templates/save' && req.method === 'POST') {
    const b = await body(req);
    const saved = saveTemplate(templateFromProject(db, b.name));
    return json(res, 200, { saved, templates: listTemplates() });
  }
  if (p === '/api/templates/delete' && req.method === 'POST') {
    const b = await body(req);
    if (!deleteTemplate(String(b.id || ''))) throw new Error('Template không tồn tại.');
    return json(res, 200, { templates: listTemplates() });
  }
  if (p === '/api/projects' && req.method === 'POST') {
    mainOnly('Tạo project');
    // Creating a project must never wait on the queue of the one already open — each project
    // is its own ordering system. Switching `db` out from under running jobs is what we
    // actually have to avoid, so a busy window keeps its project and opens the new one in a
    // window of its own.
    const busy = holdsProject();
    const b = await body(req);
    // Clone from a saved user template when one is chosen; otherwise the theme's skeleton.
    const template = b.templateId ? getTemplate(b.templateId) : null;
    if (b.templateId && !template) throw new Error('Template không tồn tại.');
    const theme = template
      ? template.theme
      : themes.some(t => t.id === b.theme)
        ? b.theme
        : 'music';
    // Every project works in a folder of its own: images/videos are exported there and the
    // reference images already in it (thu-vien/…) are picked up when the graph is built.
    if (!String(b.exportDir || '').trim())
      throw new Error(
        'Chọn thư mục làm việc cho project (đường dẫn tuyệt đối, ví dụ D:\\PHIM AI\\TAP2).',
      );
    const exportDir = validateDirectory(b.exportDir);
    try {
      fs.mkdirSync(exportDir, { recursive: true });
    } catch (e) {
      throw new Error('Không tạo được thư mục làm việc: ' + e.message);
    }
    const id = createProjectFiles(b.name, theme, exportDir, template);
    ws.order.push(id);
    if (busy) {
      writeWorkspace(ws);
      const url = await openWindow(id);
      return json(res, 201, { ...publicState(), opened: { id, url } });
    }
    ws.active = id;
    writeWorkspace(ws);
    loadProject(id);
    return json(res, 201, publicState());
  }
  if (p === '/api/projects/switch' && req.method === 'POST') {
    requireNoRunningJobs();
    if (vocalTasks.size)
      throw new Error('Đang tách vocal / tạo storyboard cho project này — đợi xong rồi chuyển.');
    const b = await body(req);
    if (!ws.order.includes(b.id)) throw new Error('Project không tồn tại.');
    loadProject(b.id); // refused while another window holds the project
    ws.active = b.id;
    if (!isChild) writeWorkspace(ws);
    return json(res, 200, publicState());
  }
  if (p === '/api/projects/delete' && req.method === 'POST') {
    mainOnly('Xóa project');
    requireIdle();
    const b = await body(req);
    if (!ws.order.includes(b.id)) throw new Error('Project không tồn tại.');
    if (ws.order.length === 1) throw new Error('Phải còn ít nhất một project.');
    if (b.id === activeId && vocalTasks.size)
      throw new Error('Đang tách vocal / tạo storyboard cho project này — đợi xong rồi xóa.');
    if (windows.has(b.id) || lockOwner(b.id))
      throw new Error('Project đang mở ở cửa sổ khác. Đóng cửa sổ đó trước khi xóa.');
    fs.rmSync(projectDir(b.id), { recursive: true, force: true });
    ws.order = ws.order.filter(x => x !== b.id);
    if (ws.active === b.id) ws.active = ws.order[0];
    writeWorkspace(ws);
    loadProject(ws.active);
    return json(res, 200, publicState());
  }
  // Several projects at once: open another project in its own window (server process).
  if (p === '/api/projects/open-window' && req.method === 'POST') {
    const b = await body(req);
    const url = await openWindow(String(b.id || ''));
    return json(res, 200, { ...publicState(), opened: { id: b.id, url } });
  }
  if (p === '/api/projects/close-window' && req.method === 'POST') {
    mainOnly('Đóng cửa sổ');
    const b = await body(req);
    closeWindow(String(b.id || ''));
    return json(res, 200, publicState());
  }
  // Backup: download one project (graph + its media) as a single .mvproj.json file.
  if (p === '/api/projects/export' && req.method === 'GET') {
    const id = u.searchParams.get('id') || activeId;
    if (!ws.order.includes(id)) throw new Error('Project không tồn tại.');
    const project = JSON.parse(fs.readFileSync(projectDbFile(id), 'utf8'));
    const mdir = path.join(projectDir(id), 'media');
    const media = {};
    if (fs.existsSync(mdir))
      for (const f of fs.readdirSync(mdir))
        media[f] = fs.readFileSync(path.join(mdir, f)).toString('base64');
    const bundle = { type: 'mv-director-project', version: 1, project, media };
    const fname =
      (String(project.name || 'project').replace(/[^\w.\- ]+/g, '_') || 'project') + '.mvproj.json';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    });
    return res.end(JSON.stringify(bundle));
  }
  // Restore: import a .mvproj.json bundle as a new project (keeps existing ones).
  if (p === '/api/projects/import' && req.method === 'POST') {
    mainOnly('Nhập project');
    requireNoRunningJobs();
    const bundle = await body(req);
    if (!bundle || bundle.type !== 'mv-director-project' || !bundle.project?.nodes)
      throw new Error('File không hợp lệ. Hãy chọn đúng file .mvproj.json đã xuất từ công cụ.');
    const id = crypto.randomUUID();
    const mdir = path.join(projectDir(id), 'media');
    fs.mkdirSync(mdir, { recursive: true });
    for (const [fname, b64] of Object.entries(bundle.media || {}))
      if (/^[a-f0-9-]+\.(png|jpg|webp|mp4|webm|mp3|wav|m4a|ogg)$/.test(fname))
        fs.writeFileSync(path.join(mdir, fname), Buffer.from(String(b64), 'base64'));
    const d = bundle.project;
    d.name = String(d.name || 'Project nhập').slice(0, 100);
    writeProject(id, d);
    ws.order.push(id);
    ws.active = id;
    writeWorkspace(ws);
    loadProject(id);
    return json(res, 200, publicState());
  }
  return NEXT;
}
