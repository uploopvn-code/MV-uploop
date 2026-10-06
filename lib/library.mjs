// Reference image library: reuse across projects, export to the working folder
// (thu-vien, khung-hinh, video), and import from another folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isSetting } from './nodes.mjs';
import { activeId, db, mediaDir, projectDbFile, projectDir, projectsDir } from './projects.mjs';
import { nodeZone } from './zones.mjs';

// Images of the same character / scene / costume / look (same blueprint key) rendered in
// another project of this film — e.g. episode 1's project while episode 2 is imported into a
// new project or window. Newest project wins; a project of another film is never a source.
function otherProjectImages() {
  const found = new Map(); // assetKey → { image, from }
  if (!db.film) return found; // only sequences of one film share their assets
  let ids = [];
  try {
    ids = fs
      .readdirSync(projectsDir)
      .filter(id => id !== activeId && fs.existsSync(projectDbFile(id)));
  } catch {
    return found;
  }
  ids.sort((a, b) => fs.statSync(projectDbFile(b)).mtimeMs - fs.statSync(projectDbFile(a)).mtimeMs);
  for (const id of ids) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(projectDbFile(id), 'utf8'));
    } catch {
      continue;
    }
    if (d.film && d.film !== db.film) continue; // same key in another film ≠ same person
    for (const n of d.nodes || [])
      if (n.assetKey && n.image?.url && !found.has(n.assetKey))
        found.set(n.assetKey, { image: n.image, from: id });
  }
  return found;
}
// Fill the asset nodes that have no image yet from the other projects of this film; the file
// is copied into this project's media folder so the projects stay independent.
export function pullAssetImages() {
  const missing = db.nodes.filter(n => n.assetKey && !n.image);
  if (!missing.length) return 0;
  const found = otherProjectImages();
  let pulled = 0;
  for (const n of missing) {
    const hit = found.get(n.assetKey);
    if (!hit) continue;
    const fileId = String(hit.image.url || '').replace(/^\/media\//, '');
    if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(fileId)) continue;
    try {
      const dst = path.join(mediaDir, fileId);
      if (!fs.existsSync(dst))
        fs.copyFileSync(path.join(projectDir(hit.from), 'media', fileId), dst);
    } catch {
      continue; // the other project's file is gone
    }
    n.image = { ...hit.image };
    n.stale = false;
    pulled++;
  }
  return pulled;
}
// Filesystem-safe filename piece.
const safeFile = s =>
  String(s || 'anh')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'anh';
// Root folder for this project's organized file exports: the user-chosen exportDir, or the
// project's own folder by default.
export const exportRoot = () => db.exportDir || path.dirname(mediaDir);
// Copies a media file to <exportRoot>/<folder>/<base><ext>, best-effort (never throws).
// keep = do not overwrite a file already there (a clip is unique; an asset image is meant to
// be refreshed in place).
function copyExport(mediaId, folderParts, base, keep = false) {
  try {
    if (!/^[a-f0-9-]+\.(png|jpg|jpeg|webp|mp4|webm)$/.test(mediaId)) return;
    const src = path.join(mediaDir, mediaId);
    if (!fs.existsSync(src)) return;
    const folder = path.join(exportRoot(), ...folderParts);
    fs.mkdirSync(folder, { recursive: true });
    const ext = path.extname(mediaId);
    let target = path.join(folder, base + ext);
    if (keep)
      for (let i = 2; fs.existsSync(target); i++) target = path.join(folder, `${base}_${i}${ext}`);
    // Refreshed in place: drop the copy with another extension (a JPG upload edited into a
    // PNG), or the library would hold both and a later project could pick the old one.
    else
      for (const other of ['.png', '.jpg', '.jpeg', '.webp'])
        if (other !== ext) fs.rmSync(path.join(folder, base + other), { force: true });
    fs.copyFileSync(src, target);
  } catch (e) {
    console.error('Xuất file ra thư mục lỗi:', e.message);
  }
}
// Keeps an asset node's image in the project's library (keyed by its stable blueprint key)
// so a later sequence reuses it, and writes a readable copy into the export folders:
//   thu-vien/nhan-vat/<key>.png, thu-vien/boi-canh/<key>.png, khung-hinh/<seq>/<STT>_<tên>.png
function remember(n) {
  if (!n.assetKey) return;
  db.assetLibrary = db.assetLibrary || {};
  db.assetLibrary[n.assetKey] = { image: n.image, name: n.name, role: n.role || null };
}
// Before a graph is replaced: keep the images its library nodes carry, by blueprint key.
export function keepLibraryImages(nodes) {
  db.assetLibrary = db.assetLibrary || {};
  for (const n of nodes) if (n.assetKey && n.image) remember(n);
}
// …then give them back to the new graph's nodes with the same key. Returns how many.
export function reuseLibraryImages(nodes) {
  let reused = 0;
  for (const n of nodes)
    if (n.assetKey && db.assetLibrary[n.assetKey]?.image && !n.image) {
      n.image = db.assetLibrary[n.assetKey].image;
      n.stale = false;
      reused++;
    }
  return reused;
}
// "Start fresh": the next build must not re-attach the images just dropped.
export function forgetLibrary() {
  db.assetLibrary = {};
}
export function rememberAndExport(n) {
  if (!n || !n.image) return;
  remember(n);
  const id = String(n.image.url || '').replace(/^\/media\//, '');
  const z = nodeZone(n);
  if (z === 'character') copyExport(id, ['thu-vien', 'nhan-vat'], safeFile(n.assetKey || n.name));
  else if (z === 'wardrobe')
    copyExport(id, ['thu-vien', 'trang-phuc'], safeFile(n.assetKey || n.name));
  else if (z === 'design') copyExport(id, ['thu-vien', 'boi-canh'], safeFile(n.assetKey || n.name));
  else if (z === 'production')
    copyExport(
      id,
      ['khung-hinh', safeFile(db.name)],
      String(n.seq || 0).padStart(2, '0') + '_' + safeFile(n.name),
    );
  // A Seedance group's storyboard sheet, to reuse by hand on seedvis.com too.
  else if (z === 'seedance')
    copyExport(
      id,
      ['storyboard', safeFile(db.name)],
      String(n.seq || 0).padStart(2, '0') + '_' + safeFile(n.name),
    );
}
// --- Reference images on disk. A working folder holds the project's library as readable
// files, thu-vien/{nhan-vat,boi-canh,trang-phuc}/<key>.<ext>; a new project picks those up
// (same file stem = same blueprint key), and can bring another folder's library in.
const LIB_FOLDERS = ['nhan-vat', 'boi-canh', 'trang-phuc'];
const IMG_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
export function folderLibrary(root) {
  const out = new Map(); // file stem → { file, folder, name }
  for (const folder of LIB_FOLDERS) {
    const dir = path.join(root, 'thu-vien', folder);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      const ext = path.extname(f).toLowerCase();
      const stem = f.slice(0, -ext.length);
      if (!IMG_EXT[ext] || !stem) continue;
      const file = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      // A folder from before one-file-per-asset may hold a stem twice: the newest file wins.
      const had = out.get(stem);
      if (!had || mtime > had.mtime) out.set(stem, { file, folder, name: f, mtime });
    }
  }
  return out;
}
// Attaches an image file on disk to a node, copied into the project's media like an upload.
function attachFile(n, file) {
  const ext = path.extname(file).toLowerCase();
  const id = crypto.randomUUID() + (ext === '.jpeg' ? '.jpg' : ext);
  fs.copyFileSync(file, path.join(mediaDir, id));
  // The working folder's library is one set: a picture read from it does not outdate the
  // other nodes it fills (a look loaded before its costume), and it is not written back to
  // the folder it came from. Only empty nodes are filled, so nothing is replaced.
  n.image = { id, url: '/media/' + id, mime: IMG_EXT[ext], name: path.basename(file) };
  n.stale = false;
  remember(n);
}
// The library nodes: characters, looks, costumes, props, scenes, angles.
export const libraryNodes = () =>
  db.nodes.filter(
    n =>
      !n.terminal &&
      !isSetting(n) &&
      !['production', 'merged', 'seedance', 'output'].includes(nodeZone(n)),
  );
// Fills the library nodes that have no image yet from the files in the working folder.
export function pullFromFolder(root = exportRoot()) {
  const lib = folderLibrary(root);
  if (!lib.size) return 0;
  let pulled = 0;
  for (const n of libraryNodes()) {
    if (n.image) continue;
    const hit = lib.get(safeFile(n.assetKey || n.name));
    if (!hit) continue;
    try {
      attachFile(n, hit.file);
      pulled++;
    } catch (e) {
      console.error('Đọc ảnh tham chiếu từ thư mục lỗi:', e.message);
    }
  }
  return pulled;
}
// Brings another folder's library in: files copied into this project's working folder (kept
// when already there), then attached to the matching nodes.
export function importFolder(src) {
  const lib = folderLibrary(src);
  let copied = 0;
  for (const [stem, hit] of lib) {
    const folder = path.join(exportRoot(), 'thu-vien', hit.folder);
    // This folder's own picture is kept, whatever its extension.
    if (Object.keys(IMG_EXT).some(e => fs.existsSync(path.join(folder, stem + e)))) continue;
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(hit.file, path.join(folder, hit.name));
    copied++;
  }
  return { found: lib.size, copied, attached: pullFromFolder() };
}
// Writes a produced video into the export folder: video/<seq>/<STT>_<tên>_vN.mp4.
export function exportVideo(sourceNode, asset, version) {
  if (!sourceNode || !asset?.url) return;
  const id = String(asset.url).replace(/^\/media\//, '');
  copyExport(
    id,
    ['video', safeFile(db.name)],
    String(sourceNode.seq || 0).padStart(2, '0') + '_' + safeFile(sourceNode.name) + '_v' + version,
    true,
  );
}
