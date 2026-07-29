// src/helpers.js — 公共纯函数与中间件，消除 index.js 中的重复逻辑
// 这些函数均为“纯”或“薄封装”，调用点替换后行为保持不变。

// 计算某产品的净库存：Σ(入库) − Σ(出库)
// transactions 中字段可能是 camelCase（本地 JSON）或 snake_case（MySQL 经 toCamelCase 转换）
export function computeBalance(transactions, productId) {
  const pid = String(productId);
  return transactions
    .filter(t => String(t.productId ?? t.product_id) === pid)
    .reduce((s, t) => (t.type === 'in' ? s + t.quantity : s - t.quantity), 0);
}

// 仅超级管理员可访问；message 可覆盖（备份接口需更明确的提示）
export function requireAdmin(message = '无权操作') {
  return (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message });
    next();
  };
}

// 非 staff（经理/管理员）可访问，拦截普通员工越权
export function requireNonStaff(req, res, next) {
  if (req.user.role === 'staff') return res.status(403).json({ message: '无权操作' });
  next();
}

// CSV 单元格转义：双引号转义 + 防 Excel 公式注入（以 = + - @ 开头时加前缀）
export function csvCell(v) {
  let s = String(v ?? '').replace(/"/g, '""');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s + '"';
}

// 发送 CSV 下载响应
export function sendCsv(res, header, rows) {
  const csv = '\uFEFF' + header + '\n' + rows.map(r => r.map(csvCell).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="export_' + new Date().toISOString().slice(0, 10) + '.csv"');
  res.send(csv);
}
