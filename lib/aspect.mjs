// Khuôn hình của project: MỘT nơi quyết định tỉ lệ khung cho mọi ảnh và video.
//
// Trước đây tỉ lệ nằm rải rác — mặc định '16:9' ghi cứng trong seedvis-client, trong từng payload
// job (ChatGPT / Google Vids / Muse / Orbit), trong node nhóm Seedance, và cả trong NỘI DUNG
// prompt ("cinematic 35mm, 16:9") — nên một phim dọc vẫn có ảnh ra ngang. Giờ tất cả đọc ở đây.
import { db } from './projects.mjs';

// Hai tỉ lệ đầu mọi model đều nhận; các tỉ lệ sau tuỳ model (validateSeedvisBinding tự lùi về
// tỉ lệ đầu tiên model đó hỗ trợ nếu không khớp).
export const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
export const DEFAULT_ASPECT = '16:9';

export const projectAspect = () =>
  ASPECTS.includes(db.defaults?.aspect) ? db.defaults.aspect : DEFAULT_ASPECT;

// Cách viết tỉ lệ trong câu prompt: "9:16 vertical" rõ hơn "9:16" với model sinh ảnh.
export function aspectPhrase() {
  const a = projectAspect();
  const [w, h] = a.split(':').map(Number);
  return a + (h > w ? ' vertical' : w > h ? ' horizontal' : ' square');
}
