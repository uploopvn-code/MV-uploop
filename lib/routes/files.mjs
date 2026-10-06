// Routes: video ZIP, shot export, media files and the web app files.
import { buildZip } from '../../zip.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../config.mjs';
import { NEXT, body, json } from '../http.mjs';
import { videoFileName } from '../media.mjs';
import { assetRefs } from '../nodes.mjs';
import { db, mediaDir } from '../projects.mjs';
import { prompts } from '../prompts.mjs';
import { buildBible } from '../bible.mjs';

export async function handle(req, res, p, u) {
  // Package the selected videos into one ZIP, each named by its shot (STT_tên_vN.mp4).
  if (p === '/api/videos/zip' && req.method === 'POST') {
    const b = await body(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    const picked = db.nodes.filter(n => ids.includes(n.id) && n.video);
    if (!picked.length) throw new Error('Không có video nào để tải.');
    const used = new Map();
    const files = [];
    let total = 0;
    for (const n of picked) {
      const fileId = String(n.video.url || '').replace(/^\/media\//, '');
      if (!/^[a-f0-9-]+\.(mp4|webm)$/.test(fileId)) continue;
      const file = path.join(mediaDir, fileId);
      if (!fs.existsSync(file)) continue;
      let name = videoFileName(n);
      // Keep filenames unique inside the archive.
      if (used.has(name)) {
        const c = used.get(name) + 1;
        used.set(name, c);
        name = name.replace(/(\.\w+)$/, '_' + c + '$1');
      } else used.set(name, 1);
      const dataBuf = fs.readFileSync(file);
      total += dataBuf.length;
      if (total > 3 * 1024 * 1024 * 1024)
        throw new Error('Tổng dung lượng quá lớn (>3GB). Hãy chọn ít video hơn.');
      files.push({ name, data: dataBuf });
    }
    if (!files.length) throw new Error('Không tìm thấy file video cho các node đã chọn.');
    const zip = buildZip(files);
    const zname = (db.name || 'videos').replace(/[^\w.\- ]+/g, '_') + '.zip';
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zname)}`,
      'Content-Length': zip.length,
    });
    return res.end(zip);
  }
  if (p === '/api/export' && req.method === 'GET') {
    const shots = db.nodes.map(n => ({
      shotId: n.id,
      start: n.start,
      duration: n.duration,
      lyric: n.lyric,
      prompts: prompts(n),
      references: assetRefs(n),
      image: n.image,
      video: n.video,
      stale: !!n.stale,
    }));
    return json(res, 200, {
      project: db.name,
      edges: db.edges,
      version: 2,
      timingStatus: 'manual_unverified',
      audio: db.audio,
      fields: db.fields,
      shots,
      // The reusable asset definitions (characters, scenes, wardrobe, props, cameras, styles,
      // audio) as a blueprint Bible — downloaded as <project>-bible.json alongside the prompts.
      bible: buildBible(db),
    });
  }
  if (p.startsWith('/media/') && req.method === 'GET') {
    const name = p.slice(7);
    if (!/^[a-f0-9-]+\.(png|jpg|webp|mp4|webm|mp3|wav|m4a|ogg)$/.test(name))
      return json(res, 404, { error: 'Not found' });
    const file = path.join(mediaDir, name);
    if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(name),
      mime = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
      }[ext];
    const size = fs.statSync(file).size;
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    // ?dl=<filename> forces a download (browsers otherwise play video inline). The
    // name is sent RFC 5987-encoded so Vietnamese letters and dashes survive.
    const dl = u.searchParams.get('dl');
    if (dl) {
      const safe = dl.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'download';
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(dl)}`,
      );
    }
    if (range) {
      const start = Number(range[1]),
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': size });
      fs.createReadStream(file).pipe(res);
    }
    return;
  }
  // The web app: index.html, style.css and the feature modules in public/js/.
  const file =
    p === '/'
      ? 'index.html'
      : p === '/style.css' || /^\/js\/[\w-]+\.js$/.test(p)
        ? p.slice(1)
        : null;
  if (req.method === 'GET' && file) {
    const full = path.join(root, 'public', file);
    if (!fs.existsSync(full)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : file.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/css; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    // Stamp the page's entry script and stylesheet with a version (newest mtime of the app
    // files) so a browser can never run stale modules against a new index.html after an
    // update. The modules main.js imports are served no-store, so they are always fresh.
    if (file === 'index.html') {
      let v = 0;
      const modules = fs.readdirSync(path.join(root, 'public', 'js')).map(f => 'js/' + f);
      for (const f of ['style.css', ...modules])
        try {
          v = Math.max(v, fs.statSync(path.join(root, 'public', f)).mtimeMs);
        } catch {}
      const ver = Math.floor(v).toString(36);
      const html = fs
        .readFileSync(full, 'utf8')
        .replace('/js/main.js"', '/js/main.js?v=' + ver + '"')
        .replace('/style.css"', '/style.css?v=' + ver + '"');
      return res.end(html);
    }
    return fs.createReadStream(full).pipe(res);
  }
  return NEXT;
}
