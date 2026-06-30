import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import multer from 'multer';
import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import fs from 'fs';
import path from 'path';

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
let useCloudDB = false;
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

// --- 数据库连接 ---
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 2000 })
    .then(() => { useCloudDB = true; console.log('✅ DATABASE: CLOUD'); })
    .catch(() => { useCloudDB = false; console.log('⚠️ DATABASE: LOCAL (Fallback)'); });
}

// --- 云端模型定义 ---
const User = mongoose.model('User', new mongoose.Schema({ username: {type:String, unique:true}, password: {type:String}, role: String, phone: String, securityQuestion: String, securityAnswer: String }));
const Product = mongoose.model('Product', new mongoose.Schema({ name: String, sku: String, category: String, unitPrice: Number, currency: String, factoryId: String, customerName: String, packaging: String, spec: String, material: String, notes: String, image: String, createdBy: String, creatorName: String }));
const Transaction = mongoose.model('Transaction', new mongoose.Schema({ productId: String, type: String, quantity: Number, orderNo: String, logisticsNo: String, notes: String, image: String, userId: String, username: String, date: { type: Date, default: Date.now } }));
const Customer = mongoose.model('Customer', new mongoose.Schema({ name: String, address: String, phone: String, createdBy: String }));
const Factory = mongoose.model('Factory', new mongoose.Schema({ name: String, address: String, color: String }));
const Category = mongoose.model('Category', new mongoose.Schema({ name: String }));

// --- Cloudinary ---
cloudinary.config({ cloud_name: process.env.CLOUDINARY_NAME, api_key: process.env.CLOUDINARY_KEY, api_secret: process.env.CLOUDINARY_SECRET });
const storage = isProduction ? new CloudinaryStorage({ cloudinary, params: { folder: 'inventory_pro' } }) : multer.diskStorage({ destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')), filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname) });
const upload = multer({ storage });

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
app.get('/api/categories', async (req, res) => { // 取消 Auth，解决预加载红气泡
  if (useCloudDB) {
    const c = await Category.find(); res.json(c.length ? c.map(x => x.name) : ['嘴贴', '鼻贴', '样品']);
  } else {
    res.json(getLocalData().categories);
  }
});

// --- API 核心逻辑 ---
app.post('/api/register', async (req, res) => {
  const { username, password, phone, question, answer } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  const userData = { username, password: hashedPassword, role: 'staff', phone, securityQuestion: question, securityAnswer: answer };
  
  if (useCloudDB) {
    try {
      const user = new User(userData);
      await user.save();
      res.json({ message: 'Success' });
    } catch (e) { res.status(400).json({ message: '用户名已存在' }); }
  } else {
    const db = getLocalData();
    if (db.users.find(u => u.username === username)) return res.status(400).json({ message: '用户名已存在' });
    userData.id = Date.now().toString();
    db.users.push(userData);
    saveLocalData(db);
    res.json({ message: 'Success' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = useCloudDB ? await User.findOne({ username }) : getLocalData().users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: '账号或密码错误' });
  const id = String(useCloudDB ? user._id : user.id);
  const token = jwt.sign({ id, username: user.username, role: user.role }, process.env.JWT_SECRET || 'secret');
  res.json({ token, user: { id, username: user.username, role: user.role } });
});

app.get('/api/forgot-password-verify', async (req, res) => {
  const { username } = req.query;
  const user = useCloudDB ? await User.findOne({ username }) : getLocalData().users.find(u => u.username === username);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  res.json({ question: user.securityQuestion });
});

app.post('/api/reset-password-now', async (req, res) => {
  const { username, phone, answer, newPassword } = req.body;
  const user = useCloudDB ? await User.findOne({ username }) : getLocalData().users.find(u => u.username === username);
  if (!user || user.phone !== phone || user.securityAnswer !== answer) return res.status(401).json({ message: '验证信息不匹配' });
  
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  if (useCloudDB) {
    user.password = hashedPassword;
    await user.save();
  } else {
    const db = getLocalData();
    const idx = db.users.findIndex(u => u.username === username);
    db.users[idx].password = hashedPassword;
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.get('/api/inventory', authenticate, async (req, res) => {
  const products = useCloudDB ? await Product.find() : getLocalData().products;
  const transactions = useCloudDB ? await Transaction.find() : getLocalData().transactions;
  res.json(products.map(p => {
    const pid = String(useCloudDB ? p._id : p.id);
    const balance = transactions.filter(t => String(t.productId) === pid).reduce((s, t) => t.type === 'in' ? s + t.quantity : s - t.quantity, 0);
    return { ...(useCloudDB ? p.toObject() : p), id: pid, balance };
  }));
});

app.post('/api/products', authenticate, upload.single('image'), async (req, res) => {
  const data = { ...req.body, unitPrice: parseFloat(req.body.unitPrice || 0), image: req.file ? (isProduction ? req.file.path : `/uploads/${req.file.filename}`) : '', createdBy: req.user.id, creatorName: req.user.username };
  if (useCloudDB) { const p = new Product(data); await p.save(); res.json({ ...p.toObject(), id: p._id }); }
  else { const db = getLocalData(); data.id = Date.now().toString(); db.products.push(data); saveLocalData(db); res.json(data); }
});

app.put('/api/products/:id', authenticate, upload.single('image'), async (req, res) => {
  const updateData = { ...req.body, unitPrice: parseFloat(req.body.unitPrice || 0) };
  if (req.file) updateData.image = isProduction ? req.file.path : `/uploads/${req.file.filename}`;
  
  if (useCloudDB) {
    const p = await Product.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ ...p.toObject(), id: p._id });
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
  if (useCloudDB) {
    const hasTrans = await Transaction.exists({ productId: req.params.id });
    if (hasTrans) return res.status(400).json({ message: '已有业务流水记录' });
    await Product.findByIdAndDelete(req.params.id);
  } else {
    const db = getLocalData();
    if (db.transactions.some(t => t.productId === req.params.id)) return res.status(400).json({ message: '已有业务流水记录' });
    db.products = db.products.filter(p => p.id !== req.params.id);
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.get('/api/transactions', authenticate, async (req, res) => {
  const trans = useCloudDB ? await Transaction.find().sort({ date: -1 }) : getLocalData().transactions.slice().reverse();
  res.json(trans.map(t => ({ ...(useCloudDB ? t.toObject() : t), id: String(useCloudDB ? t._id : t.id) })));
});

app.post('/api/transactions', authenticate, upload.single('transImage'), async (req, res) => {
  const data = { ...req.body, quantity: parseInt(req.body.quantity), image: req.file ? (isProduction ? req.file.path : `/uploads/${req.file.filename}`) : '', userId: req.user.id, username: req.user.username, date: new Date() };
  if (useCloudDB) { const t = new Transaction(data); await t.save(); res.json({ ...t.toObject(), id: t._id }); }
  else { const db = getLocalData(); data.id = Date.now().toString(); db.transactions.push(data); saveLocalData(db); res.json(data); }
});

app.delete('/api/transactions/:id', authenticate, async (req, res) => {
  if (useCloudDB) await Transaction.findByIdAndDelete(req.params.id);
  else {
    const db = getLocalData();
    db.transactions = db.transactions.filter(t => t.id !== req.params.id);
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.get('/api/admin/users', authenticate, async (req, res) => {
  const users = useCloudDB ? await User.find({}, '-password') : getLocalData().users.map(({password, ...u}) => u);
  res.json(users.map(u => ({ ... (useCloudDB ? u.toObject() : u), id: String(useCloudDB ? u._id : u.id) })));
});

app.delete('/api/admin/users/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: '无权操作' });
  if (req.params.id === req.user.id) return res.status(400).json({ message: '无法删除本人' });
  
  if (useCloudDB) {
    const target = await User.findById(req.params.id);
    if (target.role === 'admin') return res.status(400).json({ message: '无法删除最高管理员' });
    await User.findByIdAndDelete(req.params.id);
  } else {
    const db = getLocalData();
    const idx = db.users.findIndex(u => u.id === req.params.id);
    if (db.users[idx].role === 'admin') return res.status(400).json({ message: '无法删除最高管理员' });
    db.users = db.users.filter(u => u.id !== req.params.id);
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.post('/api/admin/change-role', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: '无权操作' });
  const { userId, newRole } = req.body;
  if (useCloudDB) await User.findByIdAndUpdate(userId, { role: newRole });
  else {
    const db = getLocalData();
    const idx = db.users.findIndex(u => u.id === userId);
    if (idx !== -1) db.users[idx].role = newRole;
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.post('/api/update-profile', authenticate, async (req, res) => {
  const { newUsername, oldPassword, newPassword } = req.body;
  if (useCloudDB) {
    const user = await User.findById(req.user.id);
    if (newUsername) user.username = newUsername;
    if (newPassword) {
      if (!(await bcrypt.compare(oldPassword, user.password))) return res.status(401).json({ message: '旧密码错误' });
      user.password = await bcrypt.hash(newPassword, 10);
    }
    await user.save();
    res.json({ user: { id: user._id, username: user.username, role: user.role } });
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
  if (useCloudDB) await Category.findOneAndDelete({ name });
  else {
    const db = getLocalData();
    db.categories = db.categories.filter(c => c !== name);
    saveLocalData(db);
  }
  res.json({ message: 'Success' });
});

app.post('/api/categories', authenticate, async (req, res) => {
  const { name } = req.body;
  if (useCloudDB) { const c = new Category({ name }); await c.save(); }
  else { const db = getLocalData(); db.categories.push(name); saveLocalData(db); }
  res.json({ message: 'Success' });
});

app.delete('/api/factories/:id', authenticate, async (req, res) => {
  if (useCloudDB) await Factory.findByIdAndDelete(req.params.id);
  else { const db = getLocalData(); db.factories = db.factories.filter(f => f.id !== req.params.id); saveLocalData(db); }
  res.json({ message: 'Success' });
});

app.post('/api/factories', authenticate, async (req, res) => {
  const data = { ...req.body, color: '#'+Math.floor(Math.random()*16777215).toString(16) };
  if (useCloudDB) { const f = new Factory(data); await f.save(); res.json({ ...f.toObject(), id: f._id }); }
  else { const db = getLocalData(); data.id = Date.now().toString(); db.factories.push(data); saveLocalData(db); res.json(data); }
});

app.delete('/api/customers/:id', authenticate, async (req, res) => {
  if (useCloudDB) await Customer.findByIdAndDelete(req.params.id);
  else { const db = getLocalData(); db.customers = db.customers.filter(c => c.id !== req.params.id); saveLocalData(db); }
  res.json({ message: 'Success' });
});

app.post('/api/customers', authenticate, async (req, res) => {
  const data = { ...req.body, createdBy: req.user.id };
  if (useCloudDB) { const c = new Customer(data); await c.save(); res.json({ ...c.toObject(), id: c._id }); }
  else { const db = getLocalData(); data.id = Date.now().toString(); db.customers.push(data); saveLocalData(db); res.json(data); }
});

// --- 统计与档案辅助 ---
app.get('/api/dashboard-stats', authenticate, async (req, res) => {
  const products = useCloudDB ? await Product.find() : getLocalData().products;
  const transactions = useCloudDB ? await Transaction.find() : getLocalData().transactions;
  const users = useCloudDB ? await User.find() : getLocalData().users;

  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const monthTrans = transactions.filter(t => new Date(t.date) >= monthStart);
  
  const performance = {
    totalOut: monthTrans.filter(t => t.type === 'out').reduce((s, t) => {
      const p = products.find(prod => String(useCloudDB?prod._id:prod.id) === String(t.productId));
      return s + (t.quantity * (p?.unitPrice || 0));
    }, 0),
    totalIn: monthTrans.filter(t => t.type === 'in').reduce((s, t) => {
      const p = products.find(prod => String(useCloudDB?prod._id:prod.id) === String(t.productId));
      return s + (t.quantity * (p?.unitPrice || 0));
    }, 0),
    transCount: monthTrans.length,
    activeSkus: products.length
  };

  const leaderboard = users.map(u => {
    const userTrans = monthTrans.filter(t => String(t.userId) === String(useCloudDB?u._id:u.id));
    const totalAmount = userTrans.reduce((s, t) => {
      const p = products.find(prod => String(useCloudDB?prod._id:prod.id) === String(t.productId));
      return s + (t.quantity * (p?.unitPrice || 0));
    }, 0);
    return { username: u.username, totalAmount };
  }).sort((a, b) => b.totalAmount - a.totalAmount).slice(0, 3);

  const productMix = products.map(p => {
    const pid = String(useCloudDB ? p._id : p.id);
    const balance = transactions.filter(t => String(t.productId) === pid).reduce((s, t) => t.type === 'in' ? s + t.quantity : s - t.quantity, 0);
    return { name: p.name, balance };
  }).sort((a, b) => b.balance - a.balance).slice(0, 7);

  res.json({ performance, leaderboard, productMix });
});
app.get('/api/exchange-rate', async (req, res) => res.json({ rate: 7.25, lastUpdate: Date.now() }));
app.get('/api/factories', authenticate, async (req, res) => res.json((useCloudDB ? await Factory.find() : getLocalData().factories).map(x => ({ ... (useCloudDB ? x.toObject() : x), id: useCloudDB ? x._id : x.id }))));
app.get('/api/customers', authenticate, async (req, res) => res.json((useCloudDB ? await Customer.find() : getLocalData().customers).map(x => ({ ... (useCloudDB ? x.toObject() : x), id: useCloudDB ? x._id : x.id }))));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT} | Mode: ${useCloudDB ? 'Cloud' : 'Local'}`));
