// Node Kịch bản đang chạy chế độ nào. MỘT chỗ quyết định — trước đây bốn nơi tự tính (route chạy
// xưởng, public-state, trợ lý đạo diễn, gói giao hàng) và một nơi tính sai: gói giao hàng đọc
// `scriptNode.kind === 'mv'`, mà kind của node Kịch bản luôn là 'script', nên project MV luôn bị
// xuất ra tên bước của drama.
//
//   'drama'    không nối node Nhạc
//   'mv'       nối node Nhạc nhưng CHƯA có file nhạc (chỉ lời / link): không có gì để đo, LLM
//              phải tự lo mốc giây — đường cũ, một luồng
//   'mvaudio'  nối node Nhạc CÓ file nhạc: máy đo bài thật (tách vocal, đường năng lượng, căn lời
//              theo giây), LLM chỉ điền phần sáng tạo vào khung đã khoá giây → dựng HAI luồng
import { db as liveDb } from './projects.mjs';

// Node Nhạc nối vào node Kịch bản, tìm trong một db cụ thể (trợ lý đạo diễn kiểm kế hoạch trên
// db truyền vào, không phải db đang mở — nên phải nhận db tường minh).
export const songIn = (db, n) => {
  const byId = new Map((db?.nodes || []).map(x => [x.id, x]));
  return (
    (db?.edges || [])
      .filter(e => e.target === n?.id)
      .map(e => byId.get(e.source))
      .find(x => x?.kind === 'music') || null
  );
};

export function studioKindIn(db, scriptNode) {
  const music = songIn(db, scriptNode);
  if (!music) return 'drama';
  return music.audio ? 'mvaudio' : 'mv';
}

// Bản dùng db đang mở — cho route và public-state.
export const songOf = n => songIn(liveDb, n);
export const studioKind = n => studioKindIn(liveDb, n);
