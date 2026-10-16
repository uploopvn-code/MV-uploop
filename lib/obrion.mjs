import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('../obrion/', import.meta.url));
export function runObrion(request, onLog = () => {}) {
  const venv = path.join(folder, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = process.env.OBRION_PYTHON || (fs.existsSync(venv) ? venv : process.platform === 'win32' ? 'py' : 'python3');
  const args = python === 'py' ? ['-3.12'] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(python, [...args, path.join(folder, 'main.py'), '--bridge'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let output = '', errors = '', settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('OBRION quá thời gian 30 phút. Chia kịch bản thành phân đoạn ngắn hơn.'));
    }, 30 * 60 * 1000);
    child.on('error', () => finish(new Error('Không chạy được Python. Cài Python 3.12 và obrion/requirements.txt hoặc đặt OBRION_PYTHON.')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', data => {
      output += data.toString('utf8');
      if (output.length > 20 * 1024 * 1024) {
        child.kill();
        finish(new Error('Kết quả OBRION quá lớn. Hãy chia nhỏ kịch bản.'));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', text => {
      errors = (errors + text).slice(-4000);
      // Only our progress lines are public, never provider errors or credentials.
      for (const line of text.split('\n')) if (/^\[(Agent_|Export_OTIO)/.test(line)) onLog(line.trim());
    });
    child.on('close', code => {
      try {
        const result = JSON.parse(output);
        if (code || result.error) {
          const message = String(result.error || 'Python lỗi').replaceAll(request.llm?.key || '\0', '[redacted]');
          finish(new Error(message));
        } else finish(null, result);
      } catch {
        finish(new Error(errors.includes('ModuleNotFoundError') ? 'Thiếu thư viện Python. Cài obrion/requirements.txt vào obrion/.venv.' : 'OBRION không trả JSON hợp lệ. Kiểm tra Python 3.10+.'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function obrionBlueprint(production, bible = {}) {
  const assets = [...(Array.isArray(bible.assets) ? bible.assets : [])];
  for (const [field, role] of [['characters', 'character'], ['scenes', 'scene'], ['props', 'prop']]) {
    const rows = bible[field];
    if (Array.isArray(rows)) assets.push(...rows.map(row => ({ ...row, role })));
    else if (rows && typeof rows === 'object')
      assets.push(...Object.entries(rows).map(([key, row]) => ({ ...(typeof row === 'object' ? row : { description: row }), key, role })));
  }
  const normalized = assets.map(a => ({ ...a, key: a.key || a.id || a.name, prompt: a.prompt || a.description || a.desc || '' }));
  const known = new Set(normalized.map(a => a.key));
  const cameras = [], audio = [];
  const shots = production.shots.map((s, i) => {
    const camera = `obrion_cam_${i + 1}`, sound = `obrion_audio_${i + 1}`;
    cameras.push({ key: camera, name: s.cinematography.camera_id, prompt: Object.values(s.cinematography).join(' · ') });
    audio.push({ key: sound, name: `Âm thanh ${s.shot_id}`, config: JSON.stringify(s.audio_stems) });
    const character = s.generation_assets.primary_character;
    if (character && !known.has(character)) throw new Error(`Asset Bible thiếu nhân vật "${character}". Bổ sung trước khi chuyển blueprint.`);
    return { name: s.shot_id, start: s.timecode.start_seconds, duration: s.timecode.duration_seconds,
      prompt: s.description, videoPrompt: s.videoPrompt, camera, audio: sound,
      uses: [character, known.has(s.scene_id) ? s.scene_id : ''].filter(Boolean),
      dialogue: s.audio_stems.dialogue.text, audio_delivery: s.audio_stems.dialogue.delivery_tag,
      obrion: s };
  });
  if (!normalized.length) throw new Error('Asset Bible cần assets, characters hoặc scenes để dựng sơ đồ.');
  return { project: { title: production.title }, assets: normalized, cameras, audio, shots,
    style: 'Sci-Fi gritty realism, grounded physical detail' };
}
