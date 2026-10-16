// Canonical studio vocabulary. IDs remain backward-compatible; only presentation labels use this map.
export const STUDIO_TERMS = Object.freeze({
  project: 'Project',
  assets: 'Assets',
  shots: 'Shots',
  production: 'Production',
  timeline: 'Timeline',
  queue: 'Render Queue',
  deliverables: 'Deliverables',
  characters: 'Characters',
  wardrobe: 'Wardrobe & Props',
  locations: 'Locations & Sets',
  cameraStyle: 'Camera & Style',
  audio: 'Audio & Music',
  lipSync: 'Lip Sync',
  merged: 'Merged Scenes',
  groups: 'Groups & Multi-shot',
  stale: 'Stale Image',
  needsReview: 'Needs Review',
  rendering: 'Rendering',
  completed: 'Completed',
});

export const STATUS_LABELS = Object.freeze({
  queued: 'Queued · Đang chờ',
  running: 'Rendering · Đang render',
  script_completed: 'Completed · Đã hoàn tất',
  completed: 'Completed · Hoàn tất',
  failed: 'Failed · Lỗi',
  retried: 'Retrying · Đã chạy lại',
  needs_review: 'Needs Review · Cần xác minh',
  cancelled: 'Cancelled · Đã hủy',
});
