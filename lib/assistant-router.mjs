// Deterministic zero-token routes and a conservative key for learned commands.
import { directAssistantImageEdit } from './assistant-plan.mjs';
import { matchRecipe } from './recipe-def.mjs';

export const commandKey = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

export function directAssistantPlan(request, db, recipes = []) {
  // A whole run the tool already knows how to steer (built-in or learned): no LLM needed.
  const m = matchRecipe(request, recipes);
  if (m)
    return {
      summary: `Chạy quy trình "${m.recipe.name}"${m.auto ? ' — chạy hết, không dừng hỏi' : ' — dừng hỏi ở các điểm đã định'}.`,
      actions: [{ type: 'run_recipe', recipeId: m.recipe.id, auto: m.auto }],
    };
  const image = directAssistantImageEdit(request, db);
  if (image) return image;
  const key = commandKey(request);
  if (/^(thong ke|tong quan|summary|project summary)( (du an|project)( hien tai| nay)?)?$/.test(key))
    return { summary: 'Thống kê project hiện tại.', actions: [{ type: 'summary' }] };
  if (/^(sap xep|arrange)( lai)? (node|so do|graph|khu vuc|workflow)$/.test(key))
    return { summary: 'Sắp xếp lại node theo khu vực và timeline.', actions: [{ type: 'arrange' }] };
  const images = key.match(/^(tao|cap nhat) anh (o|khu) (nhan vat|trang phuc|boi canh|san xuat)$/);
  if (images) {
    const zone = { 'nhan vat': 'character', 'trang phuc': 'wardrobe', 'boi canh': 'design', 'san xuat': 'production' }[images[3]];
    return { summary: `Tạo ảnh khu ${images[3]}.`, actions: [{ type: 'image_zone', zone }] };
  }
  // Đóng gói — 0 token. GIAO HÀNG (video + ảnh theo node, folder nhóm, 7 bước kịch bản) vs SAO LƯU
  // project. Backup có tên project cụ thể thì để Claude (ở đây không có danh sách project để khớp).
  // `commandKey` không đổi "đ"→"d" nên phải đổi riêng ở đây, không "đong goi" sẽ trượt.
  const pk = key.replace(/đ/g, 'd');
  // "Ghi nhớ việc vừa làm vào bộ nhớ agent" — học LỆNH vừa chạy để lần sau tự chạy 0 token. Khác
  // hẳn sao lưu/đóng gói (loại trừ bên dưới). Server sẽ tìm lệnh learnable gần nhất của project.
  if (
    /(ghi nho|nho lai|luu lai|luu vao|hoc lenh|hoc lai)/.test(pk) &&
    /(bo nho|agent|\bhoc\b|huan luyen|training|lenh vua|viec vua|tac dong|dap ung|vua lam|vua roi|lenh nay|viec nay)/.test(pk) &&
    !/(sao luu|backup|dong goi|package|export|zip|nen|du an|project)/.test(pk)
  )
    return {
      summary:
        'Ghi nhớ lệnh vừa chạy vào bộ nhớ agent — lần sau gặp lại, tool tự chạy với 0 token (không gọi Claude).',
      actions: [{ type: 'remember_last' }],
    };
  if (/\b(dong goi|xuat ban|giao hang|backup|sao luu|package|export|zip|nen)\b/.test(pk)) {
    const delivery =
      /(giao hang|xuat ban|du lieu|dong goi giao|handoff)/.test(pk) ||
      (/(dong goi|package|export|zip|nen)/.test(pk) && !/(du an|project|backup|sao luu)/.test(pk));
    if (delivery)
      return {
        summary:
          'Đóng gói giao hàng project hiện tại: video + ảnh đặt tên theo node (nhóm trong thư mục nhom/), 7 bước kịch bản, prompts/bible/manifest.',
        actions: [{ type: 'package', deliverable: true }],
      };
    const all = /(tat ca|toan bo|moi|\ball\b|\bevery\b)/.test(pk);
    const current = /(nay|hien tai|dang mo|\bcurrent\b|\bthis\b)/.test(pk);
    // Chỉ chắc chắn ở hai trường hợp này; backup theo TÊN project để Claude xử lý.
    if (all || current)
      return {
        summary: all ? 'Sao lưu TẤT CẢ project thành ZIP.' : 'Sao lưu project hiện tại thành ZIP.',
        actions: [{ type: 'package', scope: all ? 'all' : 'current' }],
      };
  }
  return null;
}

export function learnableActions(actions) {
  return Array.isArray(actions) && actions.length > 0 && actions.length <= 5 &&
    actions.every(a => ['edit_node', 'set_provider', 'edit_image'].includes(a.type));
}

// A learned command is PORTABLE (reusable in other projects) only when every step selects its
// targets by zone/name rather than by a concrete node ID that exists in one project. Today that
// means set_provider addressed by zone/name — it re-resolves to the right shots in any project.
// edit_node/edit_image bind to a specific node or image, so they stay project-scoped.
export function portableActions(rawActions) {
  return Array.isArray(rawActions) && rawActions.length > 0 && rawActions.length <= 5 &&
    rawActions.every(a =>
      a.type === 'set_provider' &&
      (typeof a.zone === 'string' || typeof a.nameContains === 'string') &&
      !Array.isArray(a.nodeIds));
}
