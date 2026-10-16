// Toolbar actions that add nodes: shot, style/camera/audio, costume, look, angles.
import { store } from './store.js';
import { $, api, toast } from './core.js';
import { inspect, openStage } from './inspector.js';
import { render } from './render.js';
import { t } from './i18n.js';

$('#addNode').onclick = async () => {
  try {
    store.state = await api('/api/nodes', {
      method: 'POST',
      body: { name: t('node.newImage') + ' ' + (store.state.nodes.length + 1) },
    });
    document.dispatchEvent(
      new CustomEvent('canvasnodeadded', { detail: { id: store.state.nodes.at(-1).id } }),
    );
    render();
    inspect(store.state.nodes.at(-1).id);
  } catch (e) {
    toast(e.message, true);
  }
};
// Typed reference sheets: the user names the subject and describes it, the server owns the
// prompt. Opens the new node so the description field is the next thing they see.
const SHEET_TOAST = {
  prop: 'node.toastProp',
  character: 'node.toastCharacter',
  scene: 'node.toastScene',
};
async function addSheet(kind) {
  try {
    store.state = await api('/api/nodes', { method: 'POST', body: { kind } });
    render();
    inspect(store.state.nodes.at(-1).id);
    toast(t(SHEET_TOAST[kind]));
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
    toast(t('node.toastStage'));
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
    toast(t('node.toastMusic'));
  } catch (e) {
    toast(e.message, true);
  }
}
if ($('#addMusic')) $('#addMusic').onclick = () => addMusic();
// A script node: the brief a film is written from. The studio turns it into a blueprint and
// checks that blueprint with the tool's own validator before anything is built.
export async function addScript() {
  try {
    store.state = await api('/api/nodes', { method: 'POST', body: { kind: 'script' } });
    render();
    inspect(store.state.nodes.at(-1).id);
    toast('Đã thêm node Kịch bản — nhập ý tưởng rồi bấm "Chạy xưởng".');
  } catch (e) {
    toast(e.message, true);
  }
}
if ($('#addScript')) $('#addScript').onclick = () => addScript();
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
    toast(t('node.toastWardrobe'));
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
    toast(t('node.toastLook'));
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
    toast(t('node.toastAngle'));
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
    toast(t('node.toastReverseAngles'));
  } catch (e) {
    toast(e.message, true);
  }
}
