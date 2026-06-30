import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultData = { 
  users: [], 
  products: [], 
  transactions: [],
  categories: ['嘴贴', '鼻贴', '样品'],
  factories: [],
  customers: []
};

export const getDb = async () => {
  // Use /tmp on Render if local storage is needed temporarily, 
  // but long-term data should use a real DB or Disk.
  // We'll keep local file but make path more robust for cloud.
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/db.json');
  const adapter = new JSONFile(dbPath);
  const db = new Low(adapter, defaultData);
  await db.read();
  db.data ||= defaultData;
  return db;
};
