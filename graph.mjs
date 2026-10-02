export function orderGraph(nodes, edges, target) {
  const ids = new Set(nodes.map(n => n.id)),
    seen = new Set(),
    active = new Set(),
    out = [];
  for (const e of edges)
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target)
      throw new Error('Đường nối không hợp lệ.');
  function visit(id) {
    if (active.has(id)) throw new Error('Không thể nối thành vòng lặp.');
    if (seen.has(id)) return;
    active.add(id);
    for (const e of edges.filter(e => e.target === id)) visit(e.source);
    active.delete(id);
    seen.add(id);
    out.push(id);
  }
  if (target && !ids.has(target)) throw new Error('Node đích không tồn tại.');
  // Validate the entire graph, even when running a branch.
  for (const id of ids) visit(id);
  if (!target) return out;
  seen.clear();
  active.clear();
  out.length = 0;
  visit(target);
  return out;
}
