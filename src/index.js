import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import fs from 'fs';
import path from 'path';
import { getPool, initDatabase, queryRows, queryRow, execute, toSnakeCase } from './db-mysql.js';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 静态资源与模板 ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// --- 模式切换 ---
let useMySQL = false;
let mysqlReady = false; // MySQL连接是否就绪
const isProduction = process.env.NODE_ENV === 'production';

// --- 本地数据驱动 (原生 FS 强制同步) ---
const dbPath = path.join(__dirname, '../data/db.json');
const getLocalData = () => {
  try {
    if (!fs.existsSync(dbPath)) return { users: [], products: [], transactions: [], categories: ['嘴贴', '鼻贴', '样品'], factories: [], customers: [] };
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    return {
      users: data.users || [],
      products: data.products || [],
      transactions: data.transactions || [],
      categories: data.categories || ['嘴贴', '鼻贴', '样品'],
      factories: data.factories || [],
      customers: data.customers || []
    };
  } catch (e) { return { users: [], products: [], transactions: [], categories: ['嘴贴', '鼻贴', '样品'], factories: [], customers: [] }; }
};
const saveLocalData = (data) => { fs.writeFileSync(dbPath, JSON.stringify(data, null, 2)); };

// --- MySQL 数据库连接 (MySQL优先，JSON备选) ---
const mysqlInitPromise = process.env.MYSQL_HOST
  ? initDatabase()
      .then(() => {
        useMySQL = true;
        mysqlReady = true;
        console.log('✅ DATABASE: MySQL');
      })
      .catch((err) => {
        useMySQL = false;
        mysqlReady = false;
        console.log('⚠️ DATABASE: MySQL连接失败，回退到本地JSON存储');
        console.log('⚠️ MySQL连接报错详情:', err.message);
        console.log('💡 提示: 数据将保存到本地data/db.json，MySQL可用后需重新导入');
      })
  : Promise.resolve().then(() => console.log('ℹ️ 未配置MYSQL_HOST，使用本地JSON存储'));

// --- Cloudinary ---
cloudinary.config({ cloud_name: process.env.CLOUDINARY_NAME, api_key: process.env.CLOUDINARY_KEY, api_secret: process.env.CLOUDINARY_SECRET });
const storage = isProduction ? new CloudinaryStorage({ cloudinary, params: { folder: 'inventory_pro' } }) : multer.diskStorage({ destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')), filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname) });
const upload = multer({ storage });

// --- MySQL就绪检查中间件 ---
// MySQL可用时强制走MySQL；MySQL不可用时自动回退到本地JSON
const requireMySQL = (req, res, next) => {
  next();
};

// 所有API路由：MySQL可用时走MySQL，否则走本地JSON（无需额外拦截）

// --- Auth 中间件 ---
const authenticate = (req, res, next) => {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ message: 'No Token' });
  jwt.verify(h.split(' ')[1], process.env.JWT_SECRET || 'secret', (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid Token' });
    req.user = user; next();
  });
};

// --- 公开路由 ---
app.get('/', (req, res) => res.render('index'));
app.get('/api/categories', async (req, res) => {
  if (useMySQL) {
    const rows = await queryRows('SELECT name FROM categories');
    res.json(rows.length ? rows.map(r => r.name) : ['嘴贴', '鼻贴', '样品']);
  } else {
    res.json(getLocalData().categories);
  }
});

// --- API 核心逻辑 ---
app.post('/api/register', async (req, res) => {
  const { username, password, phone, question, answer } = req.body;
  if (!username || !password) return res.status(400).json({ message: '用户名和密码不能为空' });
  const hashedPassword = await bcrypt.hash(password, 10);
  let defaultRole = 'staff';
  if (!useMySQL) {
    const localData = getLocalData();
    if (localData.users.length === 0) defaultRole = 'admin';
  } else {
    const [cntRows] = await (await getPool()).query('SELECT COUNT(*) as cnt FROM users');
    if (cntRows[0].cnt === 0) defaultRole = 'admin';
  }
  
  if (useMySQL) {
    try {
      const id = Date.now().toString();
      await execute(
        'INSERT INTO users (id, username, password, role, phone, security_question, security_answer) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, username, hashedPassword, defaultRole, phone || '', question || '', answer || '']
      );
      res.json({ message: 'Success' });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) return res.status(400).json({ message: '用户名已存在' });
      console.error('注册失败:', e.message);
      return res.status(400).json({ message: '注册失败: ' + (e.sqlMessage || e.message) });
    }
  } else {
    const db = getLocalData();
    if (db.users.find(u => u.username === username)) return res.status(400).json({ message: '用户名已存在' });
    const userData = { id: Date.now().toString(), username, password: hashedPassword, role: defaultRole, phone: phone || '', securityQuestion: question || '', securityAnswer: answer || '' };
    db.users.push(userData);
    saveLocalData(db);
    res.json({ message: 'Success' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  let user;
  if (useMySQL) {
    user = await queryRow('SELECT * FROM users WHERE username = ?', [username]);
  } else {
    user = getLocalData().users.find(u => u.username === username);
  }
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: '账号或密码错误' });
  const id = String(user.id);
  const token = jwt.sign({ id, username: user.username, role: user.role }, process.env.JWT_SECRET || 'secret');
  res.json({ token, user: { id, username: user.username, role: user.role } });
});

app.get('/api/forgot-password-verify', async (req, res) => {
  const { username } = req.query;
  let user;
  if (useMySQL) {
    user = await queryRow('SELECT security_question FROM users WHERE username = ?', [username]);
  } else {
    user = getLocalData().users.find(u => u.username === username);
  }
  if (!user) return res.status(404).json({ message: '用户不存在' });
  res.json({ question: user.securityQuestion || user.security_question });
});

app.post('/api/reset-password-now', async (req, res) => {
  const { username, phone, answer, newPassword } = req.body;
  let user;
  if (useMySQL) {
    user = await queryRow('SELECT * FROM users WHERE username = ?', [username]);
  } else {
    user = getLocalData().users.find(u => u.username === username);
  }
  if (!user || user.phone !== phone || (user.securityAnswer || user.security_answer) !== answer) return res.status(401).json({ message: '验证信息不匹配' });
  
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  if (useMySQL) {
    await execute('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, username]);
  } else {
    const db = getLocalData();
    const idx = db.users.findIndex(u => u.username === username);
    db.users[idx].password = hashedPassword;
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.get('/api/inventory', authenticate, async (req, res) => {
  let products, transactions;
  if (useMySQL) {
    products = await queryRows('SELECT * FROM products');
    transactions = await queryRows('SELECT * FROM transactions ORDER BY date DESC');
  } else {
    products = getLocalData().products;
    transactions = getLocalData().transactions.slice().reverse();
  }
  
  res.json(products.map(p => {
    const pid = String(p.id);
    const productTrans = transactions.filter(t => String(t.productId || t.product_id) === pid);
    const balance = productTrans.reduce((s, t) => t.type === 'in' ? s + t.quantity : s - t.quantity, 0);
    const lastAction = productTrans[0];
    return { 
      ...p, 
      id: pid, 
      balance,
      lastOperator: lastAction ? lastAction.username : (p.creatorName || p.creator_name || '系统初始化'),
      lastDate: lastAction ? lastAction.date : null
    };
  }));
});

app.post('/api/products', authenticate, upload.single('image'), async (req, res) => {
  // 输入验证
  if (!req.body.name || !req.body.name.trim()) return res.status(400).json({ message: '产品名称不能为空' });
  
  const id = Date.now().toString();
  const image = req.file ? (isProduction ? req.file.path : `/uploads/${req.file.filename}`) : '';
  const data = { 
    id, name: req.body.name.trim(), sku: req.body.sku || '', category: req.body.category || '',
    unitPrice: parseFloat(req.body.unitPrice || 0), currency: req.body.currency || 'CNY',
    factoryId: req.body.factoryId || '', customerName: req.body.customerName || '',
    packaging: req.body.packaging || '', spec: req.body.spec || '', material: req.body.material || '',
    notes: req.body.notes || '', image, createdBy: req.user.id, creatorName: req.user.username
  };
  
  if (useMySQL) {
    await execute(
      'INSERT INTO products (id, name, sku, category, unit_price, currency, factory_id, customer_name, packaging, spec, material, notes, image, created_by, creator_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [data.id, data.name, data.sku, data.category, data.unitPrice, data.currency, data.factoryId, data.customerName, data.packaging, data.spec, data.material, data.notes, data.image, data.createdBy, data.creatorName]
    );
    res.json(data);
  } else {
    const db = getLocalData(); db.products.push(data); saveLocalData(db); res.json(data);
  }
});

app.put('/api/products/:id', authenticate, upload.single('image'), async (req, res) => {
  const updateData = { ...req.body, unitPrice: parseFloat(req.body.unitPrice || 0) };
  if (req.file) updateData.image = isProduction ? req.file.path : `/uploads/${req.file.filename}`;
  
  if (useMySQL) {
    const fields = [];
    const values = [];
    const fieldMap = { name: 'name', sku: 'sku', category: 'category', unitPrice: 'unit_price', currency: 'currency', factoryId: 'factory_id', customerName: 'customer_name', packaging: 'packaging', spec: 'spec', material: 'material', notes: 'notes', image: 'image' };
    for (const [key, col] of Object.entries(fieldMap)) {
      if (updateData[key] !== undefined) { fields.push(`${col} = ?`); values.push(updateData[key]); }
    }
    if (fields.length > 0) {
      values.push(req.params.id);
      await execute(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, values);
    }
    const updated = await queryRow('SELECT * FROM products WHERE id = ?', [req.params.id]);
    res.json(updated);
  } else {
    const db = getLocalData();
    const idx = db.products.findIndex(p => p.id === req.params.id);
    if (idx !== -1) {
      db.products[idx] = { ...db.products[idx], ...updateData };
      saveLocalData(db);
      res.json(db.products[idx]);
    } else res.status(404).json({ message: 'Not Found' });
  }
});

app.delete('/api/products/:id', authenticate, async (req, res) => {
  if (useMySQL) {
    const [transRows] = await (await getPool()).query('SELECT COUNT(*) as cnt FROM transactions WHERE product_id = ?', [req.params.id]);
    if (transRows[0].cnt > 0) return res.status(400).json({ message: '已有业务流水记录' });
    await execute('DELETE FROM products WHERE id = ?', [req.params.id]);
  } else {
    const db = getLocalData();
    if (db.transactions.some(t => t.productId === req.params.id)) return res.status(400).json({ message: '已有业务流水记录' });
    db.products = db.products.filter(p => p.id !== req.params.id);
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.get('/api/transactions', authenticate, async (req, res) => {
  const { startDate, endDate, type } = req.query;
  if (useMySQL) {
    let sql = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];
    if (startDate) { sql += ' AND date >= ?'; params.push(startDate); }
    if (endDate) { sql += ' AND date <= ?'; params.push(endDate + ' 23:59:59'); }
    if (type && ['in', 'out'].includes(type)) { sql += ' AND type = ?'; params.push(type); }
    sql += ' ORDER BY date DESC';
    const rows = await queryRows(sql, params);
    res.json(rows.map(t => ({ ...t, id: String(t.id) })));
  } else {
    let trans = getLocalData().transactions.slice().reverse();
    if (startDate) trans = trans.filter(t => new Date(t.date) >= new Date(startDate));
    if (endDate) trans = trans.filter(t => new Date(t.date) <= new Date(endDate + 'T23:59:59'));
    if (type && ['in', 'out'].includes(type)) trans = trans.filter(t => t.type === type);
    res.json(trans.map(t => ({ ...t, id: String(t.id) })));
  }
});

app.post('/api/transactions', authenticate, upload.single('transImage'), async (req, res) => {
  // 输入验证
  const quantity = parseInt(req.body.quantity);
  if (!req.body.productId) return res.status(400).json({ message: '请选择产品' });
  if (isNaN(quantity) || quantity <= 0) return res.status(400).json({ message: '数量必须为正整数' });
  if (!req.body.type || !['in', 'out'].includes(req.body.type)) return res.status(400).json({ message: '类型无效' });
  
  const id = Date.now().toString();
  const image = req.file ? (isProduction ? req.file.path : `/uploads/${req.file.filename}`) : '';
  const batchNo = req.body.type === 'in' ? (req.body.batchNo || `BN-${Date.now().toString(36).toUpperCase()}`) : (req.body.batchNo || '');
  const data = { 
    id, productId: req.body.productId, type: req.body.type, quantity,
    orderNo: req.body.orderNo || '', logisticsNo: req.body.logisticsNo || '', 
    customerName: req.body.customerName || '', receiver: req.body.receiver || '',
    batchNo, notes: req.body.notes || '',
    image, userId: req.user.id, username: req.user.username, date: new Date()
  };

  // ===== 出库核心校验：事务+行锁，绝对禁止负库存 =====
  if (req.body.type === 'out') {
    if (useMySQL) {
      // MySQL模式：事务 + FOR UPDATE 行锁，防止并发竞态
      const conn = await (await getPool()).getConnection();
      try {
        await conn.beginTransaction();
        // 原子查询：单条SQL计算余额，加FOR UPDATE锁住该产品的所有流水行
        const [rows] = await conn.query(
          'SELECT COALESCE(SUM(CASE WHEN type = ? THEN quantity ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN type = ? THEN quantity ELSE 0 END), 0) AS balance FROM transactions WHERE product_id = ? FOR UPDATE',
          ['in', 'out', req.body.productId]
        );
        const balance = rows[0].balance;
        if (quantity > balance) {
          await conn.rollback();
          return res.status(400).json({ message: `库存不足！当前库存 ${balance}，出库数量 ${quantity} 超出可用库存` });
        }
        await conn.execute(
          'INSERT INTO transactions (id, product_id, type, quantity, order_no, logistics_no, customer_name, receiver, batch_no, notes, image, user_id, username, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [data.id, data.productId, data.type, data.quantity, data.orderNo, data.logisticsNo, data.customerName, data.receiver, data.batchNo, data.notes, data.image, data.userId, data.username, data.date]
        );
        await conn.commit();
        return res.json(data);
      } catch (e) {
        await conn.rollback();
        return res.status(500).json({ message: '出库操作失败：' + e.message });
      } finally {
        conn.release();
      }
    } else {
      // JSON模式：同步校验+写入（单进程无并发问题）
      const db = getLocalData();
      const pid = req.body.productId;
      const balance = db.transactions.filter(t => t.productId === pid && t.type === 'in').reduce((s, t) => s + t.quantity, 0)
                   - db.transactions.filter(t => t.productId === pid && t.type === 'out').reduce((s, t) => s + t.quantity, 0);
      if (quantity > balance) {
        return res.status(400).json({ message: `库存不足！当前库存 ${balance}，出库数量 ${quantity} 超出可用库存` });
      }
      db.transactions.push(data); saveLocalData(db);
      return res.json(data);
    }
  }
  
  // ===== 入库：无需余额校验 =====
  if (useMySQL) {
    await execute(
      'INSERT INTO transactions (id, product_id, type, quantity, order_no, logistics_no, customer_name, receiver, batch_no, notes, image, user_id, username, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [data.id, data.productId, data.type, data.quantity, data.orderNo, data.logisticsNo, data.customerName, data.receiver, data.batchNo, data.notes, data.image, data.userId, data.username, data.date]
    );
    res.json(data);
  } else {
    const db = getLocalData(); db.transactions.push(data); saveLocalData(db); res.json(data);
  }
});

app.delete('/api/transactions/:id', authenticate, async (req, res) => {
  // ===== 删除流水前校验：防止产生负库存 =====
  if (useMySQL) {
    const conn = await (await getPool()).getConnection();
    try {
      await conn.beginTransaction();
      // 先查要删除的记录
      const [rows] = await conn.query('SELECT product_id, type, quantity FROM transactions WHERE id = ?', [req.params.id]);
      if (rows.length === 0) { await conn.rollback(); return res.status(404).json({ message: '记录不存在' }); }
      const { product_id: pid, type, quantity } = rows[0];
      // 如果是入库记录，删除后需检查是否会导致库存变负
      if (type === 'in') {
        const [balRows] = await conn.query(
          'SELECT COALESCE(SUM(CASE WHEN type = ? THEN quantity ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN type = ? THEN quantity ELSE 0 END), 0) AS balance FROM transactions WHERE product_id = ? FOR UPDATE',
          ['in', 'out', pid]
        );
        const currentBalance = balRows[0].balance;
        // 删除此入库记录后的新余额 = 当前余额 - 入库数量
        const newBalance = currentBalance - quantity;
        if (newBalance < 0) {
          await conn.rollback();
          return res.status(400).json({ message: `无法删除该入库记录！删除后库存将变为 ${newBalance}（负值），当前库存 ${currentBalance}，该入库数量 ${quantity}` });
        }
      }
      await conn.execute('DELETE FROM transactions WHERE id = ?', [req.params.id]);
      await conn.commit();
      res.json({ message: 'Success' });
    } catch (e) {
      await conn.rollback();
      res.status(500).json({ message: '删除失败：' + e.message });
    } finally {
      conn.release();
    }
  } else {
    const db = getLocalData();
    const trans = db.transactions.find(t => t.id === req.params.id);
    if (!trans) return res.status(404).json({ message: '记录不存在' });
    // 如果是入库记录，检查删除后是否负库存
    if (trans.type === 'in') {
      const pid = trans.productId;
      const currentBalance = db.transactions.filter(t => t.productId === pid && t.type === 'in').reduce((s, t) => s + t.quantity, 0)
                            - db.transactions.filter(t => t.productId === pid && t.type === 'out').reduce((s, t) => s + t.quantity, 0);
      const newBalance = currentBalance - trans.quantity;
      if (newBalance < 0) {
        return res.status(400).json({ message: `无法删除该入库记录！删除后库存将变为 ${newBalance}（负值），当前库存 ${currentBalance}，该入库数量 ${trans.quantity}` });
      }
    }
    db.transactions = db.transactions.filter(t => t.id !== req.params.id);
    saveLocalData(db);
    res.json({ message: 'Success' });
  }
});

app.get('/api/admin/users', authenticate, async (req, res) => {
  if (useMySQL) {
    const users = await queryRows('SELECT id, username, role, phone, created_at FROM users');
    res.json(users.map(u => ({ ...u, id: String(u.id) })));
  } else {
    const users = getLocalData().users.map(({password, ...u}) => u);
    res.json(users.map(u => ({ ...u, id: String(u.id) })));
  }
});

app.delete('/api/admin/users/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: '无权操作' });
  if (req.params.id === req.user.id) return res.status(400).json({ message: '无法删除本人' });
  
  if (useMySQL) {
    const target = await queryRow('SELECT role FROM users WHERE id = ?', [req.params.id]);
    if (!target) return res.status(404).json({ message: '用户不存在' });
    if (target.role === 'admin') return res.status(400).json({ message: '无法删除最高管理员' });
    await execute('DELETE FROM users WHERE id = ?', [req.params.id]);
  } else {
    const db = getLocalData();
    const idx = db.users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ message: '用户不存在' });
    if (db.users[idx].role === 'admin') return res.status(400).json({ message: '无法删除最高管理员' });
    db.users = db.users.filter(u => u.id !== req.params.id);
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.post('/api/admin/change-role', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: '无权操作' });
  const { userId, newRole } = req.body;
  if (useMySQL) {
    await execute('UPDATE users SET role = ? WHERE id = ?', [newRole, userId]);
  } else {
    const db = getLocalData();
    const idx = db.users.findIndex(u => u.id === userId);
    if (idx !== -1) db.users[idx].role = newRole;
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.post('/api/update-profile', authenticate, async (req, res) => {
  const { newUsername, oldPassword, newPassword } = req.body;
  if (useMySQL) {
    const user = await queryRow('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (newUsername) await execute('UPDATE users SET username = ? WHERE id = ?', [newUsername, req.user.id]);
    if (newPassword) {
      if (!(await bcrypt.compare(oldPassword, user.password))) return res.status(401).json({ message: '旧密码错误' });
      const hashed = await bcrypt.hash(newPassword, 10);
      await execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);
    }
    const updated = await queryRow('SELECT id, username, role FROM users WHERE id = ?', [req.user.id]);
    res.json({ user: { id: String(updated.id), username: updated.username, role: updated.role } });
  } else {
    const db = getLocalData();
    const idx = db.users.findIndex(u => u.id === req.user.id);
    if (newUsername) db.users[idx].username = newUsername;
    if (newPassword) {
      if (!(await bcrypt.compare(oldPassword, db.users[idx].password))) return res.status(401).json({ message: '旧密码错误' });
      db.users[idx].password = await bcrypt.hash(newPassword, 10);
    }
    saveLocalData(db);
    res.json({ user: { id: db.users[idx].id, username: db.users[idx].username, role: db.users[idx].role } });
  }
});

app.delete('/api/categories/:name', authenticate, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (useMySQL) {
    await execute('DELETE FROM categories WHERE name = ?', [name]);
  } else {
    const db = getLocalData();
    db.categories = db.categories.filter(c => c !== name);
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.post('/api/categories', authenticate, async (req, res) => {
  const { name } = req.body;
  if (useMySQL) {
    try { await execute('INSERT INTO categories (name) VALUES (?)', [name]); } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
  } else {
    const db = getLocalData(); db.categories.push(name); saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.delete('/api/factories/:id', authenticate, async (req, res) => {
  if (useMySQL) {
    await execute('DELETE FROM factories WHERE id = ?', [req.params.id]);
  } else {
    const db = getLocalData(); db.factories = db.factories.filter(f => f.id !== req.params.id); saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.post('/api/factories', authenticate, async (req, res) => {
  const id = Date.now().toString();
  const color = '#' + Math.floor(Math.random() * 16777215).toString(16);
  const data = { ...req.body, id, color };
  if (useMySQL) {
    await execute('INSERT INTO factories (id, name, address, color) VALUES (?, ?, ?, ?)', [id, req.body.name, req.body.address || '', color]);
    res.json(data);
  } else {
    const db = getLocalData(); db.factories.push(data); saveLocalData(db); res.json(data);
  }
});

app.delete('/api/customers/:id', authenticate, async (req, res) => {
  if (useMySQL) {
    await execute('DELETE FROM customers WHERE id = ?', [req.params.id]);
  } else {
    const db = getLocalData(); db.customers = db.customers.filter(c => c.id !== req.params.id); saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.post('/api/customers', authenticate, async (req, res) => {
  const id = Date.now().toString();
  const data = { ...req.body, id, createdBy: req.user.id };
  if (useMySQL) {
    await execute('INSERT INTO customers (id, name, address, phone, created_by) VALUES (?, ?, ?, ?, ?)', [id, req.body.name, req.body.address || '', req.body.phone || '', req.user.id]);
    res.json(data);
  } else {
    const db = getLocalData(); db.customers.push(data); saveLocalData(db); res.json(data);
  }
});

// --- 统计与档案辅助 ---
app.get('/api/dashboard-stats', authenticate, async (req, res) => {
  let products, transactions, users;
  if (useMySQL) {
    products = await queryRows('SELECT * FROM products');
    transactions = await queryRows('SELECT * FROM transactions');
    users = await queryRows('SELECT id, username FROM users');
  } else {
    products = getLocalData().products;
    transactions = getLocalData().transactions;
    users = getLocalData().users;
  }

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const monthTrans = transactions.filter(t => new Date(t.date) >= monthStart);

  const performance = {
    totalOut: monthTrans.filter(t => t.type === 'out').reduce((s, t) => {
      const p = products.find(prod => String(prod.id) === String(t.productId || t.product_id));
      return s + (t.quantity * (p?.unitPrice || p?.unit_price || 0));
    }, 0),
    totalIn: monthTrans.filter(t => t.type === 'in').reduce((s, t) => {
      const p = products.find(prod => String(prod.id) === String(t.productId || t.product_id));
      return s + (t.quantity * (p?.unitPrice || p?.unit_price || 0));
    }, 0),
    transCount: monthTrans.length,
    activeSkus: products.length
  };

  const leaderboard = users.map(u => {
    const userTrans = monthTrans.filter(t => String(t.userId || t.user_id) === String(u.id));
    const totalAmount = userTrans.reduce((s, t) => {
      const p = products.find(prod => String(prod.id) === String(t.productId || t.product_id));
      return s + (t.quantity * (p?.unitPrice || p?.unit_price || 0));
    }, 0);
    return { username: u.username, totalAmount };
  }).sort((a, b) => b.totalAmount - a.totalAmount).slice(0, 3);

  const productMix = products.map(p => {
    const pid = String(p.id);
    const balance = transactions.filter(t => String(t.productId || t.product_id) === pid).reduce((s, t) => t.type === 'in' ? s + t.quantity : s - t.quantity, 0);
    return { name: p.name, balance };
  }).sort((a, b) => b.balance - a.balance).slice(0, 7);

  res.json({ performance, leaderboard, productMix });
});

app.get('/api/exchange-rate', async (req, res) => {
  try {
    let cache = useMySQL ? await queryRow("SELECT value FROM config WHERE `key` = 'exchange_rate'") : null;
    const now = Date.now();
    if (cache && cache.value && (now - new Date(cache.value.lastUpdate).getTime() < 12 * 60 * 60 * 1000)) {
      return res.json(cache.value);
    }
    const resp = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await resp.json();
    const newRate = parseFloat(data.rates.CNY.toFixed(2));
    const result = { rate: newRate, lastUpdate: now, source: 'Real-time' };
    if (useMySQL) {
      await execute("INSERT INTO config (`key`, value) VALUES ('exchange_rate', ?) ON DUPLICATE KEY UPDATE value = ?", [JSON.stringify(result), JSON.stringify(result)]);
    }
    res.json(result);
  } catch (e) {
    let lastKnown = useMySQL ? await queryRow("SELECT value FROM config WHERE `key` = 'exchange_rate'") : null;
    if (lastKnown && lastKnown.value) {
      res.json({ ...lastKnown.value, source: 'Database Cache' });
    } else {
      res.json({ rate: 6.78, lastUpdate: Date.now(), source: 'Hardcoded Fallback' });
    }
  }
});

app.get('/api/factories', authenticate, async (req, res) => {
  if (useMySQL) {
    const rows = await queryRows('SELECT * FROM factories');
    res.json(rows.map(x => ({ ...x, id: String(x.id) })));
  } else {
    res.json(getLocalData().factories.map(x => ({ ...x, id: String(x.id) })));
  }
});

app.get('/api/customers', authenticate, async (req, res) => {
  if (useMySQL) {
    const rows = await queryRows('SELECT * FROM customers');
    res.json(rows.map(x => ({ ...x, id: String(x.id) })));
  } else {
    res.json(getLocalData().customers.map(x => ({ ...x, id: String(x.id) })));
  }
});

// --- 库存预警 ---
app.get('/api/inventory/alerts', authenticate, async (req, res) => {
  const threshold = parseInt(req.query.threshold) || 10;
  let products, transactions;
  if (useMySQL) {
    products = await queryRows('SELECT * FROM products');
    transactions = await queryRows('SELECT * FROM transactions');
  } else {
    products = getLocalData().products;
    transactions = getLocalData().transactions;
  }
  const alerts = products.map(p => {
    const pid = String(p.id);
    const balance = transactions.filter(t => String(t.productId || t.product_id) === pid)
      .reduce((s, t) => t.type === 'in' ? s + t.quantity : s - t.quantity, 0);
    return { ...p, id: pid, balance };
  }).filter(p => p.balance <= threshold && p.balance >= 0).sort((a, b) => a.balance - b.balance);
  res.json(alerts);
});

// --- CSV 导出 ---
app.get('/api/export/inventory', authenticate, async (req, res) => {
  let products, transactions;
  if (useMySQL) {
    products = await queryRows('SELECT * FROM products');
    transactions = await queryRows('SELECT * FROM transactions');
  } else {
    products = getLocalData().products;
    transactions = getLocalData().transactions;
  }
  const rows = products.map(p => {
    const pid = String(p.id);
    const pTrans = transactions.filter(t => String(t.productId || t.product_id) === pid);
    const balance = pTrans.reduce((s, t) => t.type === 'in' ? s + t.quantity : s - t.quantity, 0);
    const totalIn = pTrans.filter(t => t.type === 'in').reduce((s, t) => s + t.quantity, 0);
    const totalOut = pTrans.filter(t => t.type === 'out').reduce((s, t) => s + t.quantity, 0);
    return [p.name, p.sku || '', p.category || '', p.unitPrice || p.unit_price || 0, p.currency || 'CNY', balance, totalIn, totalOut, p.creatorName || p.creator_name || ''];
  });
  const header = '产品名称,货号SKU,品类,单价,币种,当前库存,累计入库,累计出库,创建人';
  const csv = '\uFEFF' + header + '\n' + rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="inventory_' + new Date().toISOString().slice(0, 10) + '.csv"');
  res.send(csv);
});

app.get('/api/export/transactions', authenticate, async (req, res) => {
  let transactions, products;
  if (useMySQL) {
    transactions = await queryRows('SELECT * FROM transactions ORDER BY date DESC');
    products = await queryRows('SELECT * FROM products');
  } else {
    transactions = getLocalData().transactions.slice().reverse();
    products = getLocalData().products;
  }
  const prodMap = {};
  products.forEach(p => { prodMap[String(p.id)] = p.name; });
  const rows = transactions.map(t => {
    const d = new Date(t.date);
    return [d.toLocaleDateString('zh-CN'), d.toLocaleTimeString('zh-CN'), prodMap[String(t.productId || t.product_id)] || '', t.type === 'in' ? '入库' : '出库', t.quantity, t.customerName || t.customer_name || '', t.receiver || '', t.batchNo || t.batch_no || '', t.orderNo || t.order_no || '', t.logisticsNo || t.logistics_no || '', t.username || '', t.notes || ''];
  });
  const header = '日期,时间,产品名称,类型,数量,客户,领用人,批次号,订单号,物流号,操作人,备注';
  const csv = '\uFEFF' + header + '\n' + rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions_' + new Date().toISOString().slice(0, 10) + '.csv"');
  res.send(csv);
});

// --- 数据备份与恢复 ---
app.get('/api/backup/export', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: '仅管理员可操作' });
  try {
    let backup;
    if (useMySQL) {
      const [users, products, transactions, categories, factories, customers] = await Promise.all([
        queryRows('SELECT * FROM users'),
        queryRows('SELECT * FROM products'),
        queryRows('SELECT * FROM transactions'),
        queryRows('SELECT name FROM categories'),
        queryRows('SELECT * FROM factories'),
        queryRows('SELECT * FROM customers')
      ]);
      backup = {
        exportTime: new Date().toISOString(),
        version: '2.0-mysql',
        users, products, transactions,
        categories: categories.map(c => c.name),
        factories, customers
      };
    } else {
      backup = { exportTime: new Date().toISOString(), version: '2.0-local', ...getLocalData() };
    }
    const filename = `inventory_backup_${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  } catch (e) {
    console.error('导出失败:', e);
    res.status(500).json({ message: '导出失败: ' + e.message });
  }
});

app.post('/api/backup/import', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: '仅管理员可操作' });
  try {
    const backup = req.body;
    if (!backup || !backup.users || !backup.products) {
      return res.status(400).json({ message: '无效的备份文件格式' });
    }
    if (useMySQL) {
      // MySQL模式：清空并重新导入
      const conn = await (await getPool()).getConnection();
      try {
        await conn.beginTransaction();
        // 清空表（按外键依赖顺序）
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        await conn.query('DELETE FROM transactions');
        await conn.query('DELETE FROM products');
        await conn.query('DELETE FROM factories');
        await conn.query('DELETE FROM customers');
        await conn.query('DELETE FROM categories');
        await conn.query('DELETE FROM users WHERE username != ?', [req.user.username]); // 保留当前管理员
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        // 导入用户
        for (const u of (backup.users || [])) {
          try {
            await conn.query(
              'INSERT IGNORE INTO users (id, username, password, role, phone, security_question, security_answer) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [String(u.id || u.user_id || Date.now()), u.username, u.password, u.role || 'staff', u.phone || '', u.securityQuestion || u.security_question || '', u.securityAnswer || u.security_answer || '']
            );
          } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
        }
        // 导入品类
        for (const c of (backup.categories || [])) {
          try { await conn.query('INSERT IGNORE INTO categories (name) VALUES (?)', [c]); } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
        }
        // 导入工厂
        for (const f of (backup.factories || [])) {
          await conn.query('INSERT IGNORE INTO factories (id, name, address, color) VALUES (?, ?, ?, ?)',
            [String(f.id || f.factory_id || Date.now()), f.name, f.address || '', f.color || '#000000']);
        }
        // 导入客户
        for (const c of (backup.customers || [])) {
          await conn.query('INSERT IGNORE INTO customers (id, name, address, phone, created_by) VALUES (?, ?, ?, ?, ?)',
            [String(c.id || c.customer_id || Date.now()), c.name, c.address || '', c.phone || '', c.createdBy || c.created_by || '']);
        }
        // 导入产品
        for (const p of (backup.products || [])) {
          await conn.query(
            'INSERT IGNORE INTO products (id, name, sku, category, unit_price, currency, factory_id, customer_name, packaging, spec, material, notes, image, created_by, creator_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [String(p.id || p.product_id || Date.now()), p.name, p.sku || '', p.category || '', p.unitPrice || p.unit_price || 0, p.currency || 'CNY', p.factoryId || p.factory_id || '', p.customerName || p.customer_name || '', p.packaging || '', p.spec || '', p.material || '', p.notes || '', p.image || '', p.createdBy || p.created_by || '', p.creatorName || p.creator_name || '']
          );
        }
        // 导入交易记录
        for (const t of (backup.transactions || [])) {
          await conn.query(
            'INSERT IGNORE INTO transactions (id, product_id, type, quantity, order_no, logistics_no, customer_name, notes, image, user_id, username, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [String(t.id || Date.now()), String(t.productId || t.product_id), t.type, t.quantity, t.orderNo || t.order_no || '', t.logisticsNo || t.logistics_no || '', t.customerName || t.customer_name || '', t.notes || '', t.image || '', String(t.userId || t.user_id || ''), t.username || '', t.date || new Date()]
          );
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    } else {
      // JSON模式：直接覆盖
      const currentDb = getLocalData();
      const imported = {
        users: backup.users || currentDb.users,
        products: backup.products || [],
        transactions: backup.transactions || [],
        categories: backup.categories || ['嘴贴', '鼻贴', '样品'],
        factories: backup.factories || [],
        customers: backup.customers || []
      };
      saveLocalData(imported);
    }
    res.json({ message: '数据恢复成功', stats: { users: backup.users?.length || 0, products: backup.products?.length || 0, transactions: backup.transactions?.length || 0 } });
  } catch (e) {
    console.error('导入失败:', e);
    res.status(500).json({ message: '导入失败: ' + e.message });
  }
});

const PORT = process.env.PORT || 5000;
import os from 'os';
app.listen(PORT, '0.0.0.0', async () => {
  // 等待MySQL初始化完成，避免竞态条件导致启动消息显示错误
  await mysqlInitPromise;
  const localIP = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address || 'localhost';
  const dbMode = useMySQL ? 'MySQL' : (process.env.MYSQL_HOST ? 'Local JSON (MySQL不可用)' : 'Local JSON');
  console.log(`🚀 Server on http://localhost:${PORT} | Mode: ${dbMode}`);
  console.log(`📱 Mobile access: http://${localIP}:${PORT}`);
  if (!useMySQL && process.env.MYSQL_HOST) {
    console.log('⚠️ MySQL不可用，数据保存到本地JSON。MySQL恢复后数据不会自动同步。');
  }
});