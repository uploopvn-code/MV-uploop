// Toolbar actions that add nodes: shot, style/camera/audio, costume, look, angles.
import { store } from './store.js';
import { $, api, toast } from './core.js';
import { inspect, openStage } from './inspector.js';
import { render } from './render.js';

$('#addNode').onclick = async () => {
  try {
    store.state = await api('/api/nodes', {
      method: 'POST',
      body: { name: 'Ảnh mới ' + (store.state.nodes.length + 1) },
    });
    render();
    inspect(store.state.nodes.at(-1).id);
  } catch (e) {
    toast(e.message, true);
  }
};
// Typed reference sheets: the user names the subject and describes it, the server owns the
// prompt. Opens the new node so the description field is the next thing they see.
const SHEET_TOAST = {
  prop: 'Đã tạo node vật dụng. Gõ mô tả tiếng Anh rồi Lưu — tool dựng model sheet 1 góc chính + 2 góc xoay.',
  character:
    'Đã tạo node nhân vật. Gõ mô tả tiếng Anh rồi Lưu — tool dựng model sheet chân dung + 3 góc toàn thân.',
  scene: 'Đã tạo node bối cảnh. Gõ mô tả tiếng Anh rồi Lưu — tool dựng cảnh toàn trống người.',
};
async function addSheet(kind) {
  try {
    store.state = await api('/api/nodes', { method: 'POST', body: { kind } });
    render();
    inspect(store.state.nodes.at(-1).id);
    toast(SHEET_TOAST[kind]);
  } catch (e) {
    toast(e.message, true);
  }
}
$('#addCharacter').onclick = () => addSheet('character');
$('#addProp').onclick = () => addSheet('prop');
$('#addScene').onclick = () => addSheet('scene');
// A 3D stage node: made, then straight into the 3D editor to pin everyone.
$('#addStage').onclick = async () => {
  try {
    store.state = await api('/api/nodes', { method: 'POST', body: { kind: 'stage' } });
    render();
    openStage(store.state.nodes.at(-1).id);
    toast(
      'Đã tạo node sân khấu 3D. Ghim vị trí, rồi nối node này vào các shot (hoặc vào bối cảnh của chúng).',
    );
  } catch (e) {
    toast(e.message, true);
  }
};
async function addSetting(settingType) {
  try {
    store.state = await api('/api/nodes', {
      method: 'POST',
      body: { kind: 'setting', settingType },
    });
    render();
    inspect(store.state.nodes.at(-1).id);
  } catch (e) {
    toast(e.message, true);
  }
}
$('#addStyle').onclick = () => addSetting('style');
$('#addCamera').onclick = () => addSetting('camera');
$('#addAudio').onclick = () => addSetting('audio');
// A music node: paste a YouTube link / upload a song file, then analyze it into the parameters
// the tool needs (structure, timing, bpm, suggested shots).
export async function addMusic() {
  try {
    store.state = await api('/api/nodes', { method: 'POST', body: { kind: 'music' } });
    render();
    inspect(store.state.nodes.at(-1).id);
    toast('Đã tạo node Nhạc (MUSIC). Dán link YouTube hoặc tải file nhạc, rồi bấm Phân tích.');
  } catch (e) {
    toast(e.message, true);
  }
}
if ($('#addMusic')) $('#addMusic').onclick = () => addMusic();
// A wardrobe node = one character in one costume (+ personal items) for a scene context.
// From a character's inspector it is pre-wired to that character (face reference); from
// the toolbar it is created loose and the user wires a character into it.
export async function addWardrobe(characterId) {
  try {
    store.state = await api('/api/nodes', {
      method: 'POST',
      body: { kind: 'wardrobe', characterId: characterId || undefined },
    });
    render();
    inspect(store.state.nodes.at(-1).id);
    toast('Đã tạo node trang phục. Điền trang phục & vật dụng rồi tạo ảnh.');
  } catch (e) {
    toast(e.message, true);
  }
}
$('#addWardrobe').onclick = () => addWardrobe(null);
// A look node = "this character wearing this costume": composed from the costume's character
// (face) and the costume image (outfit). Shots use it instead of the raw costume.
export async function addLook(costumeId) {
  try {
    store.state = await api('/api/nodes', { method: 'POST', body: { kind: 'look', costumeId } });
    render();
    inspect(store.state.nodes.at(-1).id);
    toast(
      'Đã tạo node nhân vật đã mặc. Tạo ảnh nhân vật và trang phục trước, rồi tạo ảnh node này và nối vào shot.',
    );
  } catch (e) {
    toast(e.message, true);
  }
}
// A scene angle = the same place seen from another camera position, rendered from the
// scene's image. Presets a / b = the two opposing close angles of a dialogue.
export async function addAngle(sceneId, preset) {
  try {
    store.state = await api('/api/nodes', {
      method: 'POST',
      body: { kind: 'angle', sceneId, preset },
    });
    render();
    inspect(store.state.nodes.at(-1).id);
    toast('Đã tạo node góc máy. Tạo ảnh bối cảnh gốc trước, rồi tạo ảnh node này và nối vào shot.');
  } catch (e) {
    toast(e.message, true);
  }
}
export async function addReverseAngles(sceneId) {
  try {
    for (const preset of ['a', 'b'])
      store.state = await api('/api/nodes', {
        method: 'POST',
        body: { kind: 'angle', sceneId, preset },
      });
    render();
    inspect(sceneId);
    toast(
      'Đã tạo 2 góc cận đối nghịch A/B. Tạo ảnh bối cảnh gốc trước, rồi tạo ảnh hai góc; shot OTS A nối góc A, OTS B nối góc B.',
    );
  } catch (e) {
    toast(e.message, true);
  }
}
