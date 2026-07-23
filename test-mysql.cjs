const mysql = require('mysql2/promise');
(async () => {
  try {
    const pool = mysql.createPool({
      host: '45.129.228.121',
      port: 3306,
      user: 'u543363431_xiaobai',
      password: 'k0uK:?5RtO$',
      database: 'u543363431_erphlk',
      connectTimeout: 10000
    });
    const [rows] = await pool.query('SELECT COUNT(*) as cnt FROM users');
    console.log('MySQL IP连接成功! 用户数:', rows[0].cnt);
    process.exit(0);
  } catch (e) {
    console.error('MySQL IP连接失败:', e.message);
    process.exit(1);
  }
})();