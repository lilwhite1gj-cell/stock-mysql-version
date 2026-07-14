import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

let pool = null;

// 获取连接池
export async function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'inventory_pro',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
    ssl: process.env.MYSQL_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 15000
  });
  return pool;
}

// 初始化数据库表和默认数据
export async function initDatabase() {
  const db = await getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(50) PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(200) NOT NULL,
      role VARCHAR(20) DEFAULT 'staff',
      phone VARCHAR(50),
      security_question VARCHAR(200),
      security_answer VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      sku VARCHAR(100),
      category VARCHAR(100),
      unit_price DECIMAL(12,2) DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'CNY',
      factory_id VARCHAR(50),
      customer_name VARCHAR(200),
      packaging VARCHAR(200),
      spec VARCHAR(200),
      material VARCHAR(200),
      notes TEXT,
      image VARCHAR(500),
      created_by VARCHAR(50),
      creator_name VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id VARCHAR(50) PRIMARY KEY,
      product_id VARCHAR(50) NOT NULL,
      type VARCHAR(10) NOT NULL,
      quantity INT NOT NULL,
      order_no VARCHAR(100),
      logistics_no VARCHAR(100),
      customer_name VARCHAR(200),
      receiver VARCHAR(100),
      batch_no VARCHAR(100),
      notes TEXT,
      image VARCHAR(500),
      user_id VARCHAR(50),
      username VARCHAR(100),
      date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_product (product_id),
      INDEX idx_date (date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 兼容旧表：自动添加新字段（如果不存在）
  const alterColumns = [
    { table: 'transactions', col: 'receiver', def: 'VARCHAR(100)' },
    { table: 'transactions', col: 'batch_no', def: 'VARCHAR(100)' }
  ];
  for (const { table, col, def } of alterColumns) {
    try { await db.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS factories (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      address VARCHAR(500),
      color VARCHAR(20)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      address VARCHAR(500),
      phone VARCHAR(50),
      created_by VARCHAR(50)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS config (
      \`key\` VARCHAR(100) PRIMARY KEY,
      value JSON
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 初始化默认管理员
  const [rows] = await db.query('SELECT COUNT(*) as cnt FROM users');
  if (rows[0].cnt === 0) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await db.query(
      'INSERT INTO users (id, username, password, role, phone, security_question, security_answer) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [Date.now().toString(), 'admin', hashedPassword, 'admin', '13800138000', '出生地', '北京']
    );
    console.log('🚀 已自动初始化 admin 账号 (密码: admin123)');
  }

  // 初始化默认品类
  const [catRows] = await db.query('SELECT COUNT(*) as cnt FROM categories');
  if (catRows[0].cnt === 0) {
    await db.query("INSERT INTO categories (name) VALUES ('嘴贴'), ('鼻贴'), ('样品')");
    console.log('📦 已自动初始化默认品类');
  }

  console.log('✅ MySQL 数据库表初始化完成');
}

// ============ 通用 CRUD 助手 ============

// 瞬态错误重试（ECONNRESET/EPIPE/PROTOCOL_CONNECTION_LOST等）
const TRANSIENT_ERRORS = ['ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'];
async function retryOnTransient(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isTransient = TRANSIENT_ERRORS.some(e => err.code === e || (err.message && err.message.includes(e)));
      if (isTransient && i < retries) {
        console.log(`⚠️ MySQL瞬态错误(${err.code})，重试 ${i + 1}/${retries}...`);
        // 重置连接池，强制下次获取新连接
        pool = null;
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

// 查询并返回数组（自动将 snake_case 转为 camelCase）
export async function queryRows(sql, params = []) {
  return retryOnTransient(async () => {
    const db = await getPool();
    const [rows] = await db.query(sql, params);
    return rows.map(row => toCamelCase(row));
  });
}

// 查询并返回单行
export async function queryRow(sql, params = []) {
  const rows = await queryRows(sql, params);
  return rows[0] || null;
}

// 执行写操作
export async function execute(sql, params = []) {
  return retryOnTransient(async () => {
    const db = await getPool();
    const [result] = await db.execute(sql, params);
    return result;
  });
}

// snake_case → camelCase 转换
function toCamelCase(obj) {
  const result = {};
  for (const key of Object.keys(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = obj[key];
  }
  return result;
}

// camelCase → snake_case 转换
export function toSnakeCase(obj) {
  const result = {};
  for (const key of Object.keys(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
    result[snakeKey] = obj[key];
  }
  return result;
}