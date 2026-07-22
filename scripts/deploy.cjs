// FTP自动部署脚本
// 用法: node scripts/deploy.cjs
const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');

// 从.env文件读取配置
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const env = {};
  envContent.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      let val = match[2].trim();
      // 去掉引号
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[match[1].trim()] = val;
    }
  });
  return env;
}

async function deploy() {
  const env = loadEnv();
  
  const config = {
    host: env.FTP_HOST,
    port: parseInt(env.FTP_PORT || '21'),
    user: env.FTP_USER,
    password: env.FTP_PASSWORD,
    secure: false
  };
  
  if (!config.host || !config.user || !config.password) {
    console.error('❌ 缺少FTP配置，请检查.env中的FTP_HOST, FTP_USER, FTP_PASSWORD');
    process.exit(1);
  }
  
  const remotePath = env.FTP_PATH || 'public_html';
  const localDir = path.join(__dirname, '..');
  
  console.log('🚀 开始部署到FTP服务器...');
  console.log(`📡 服务器: ${config.host}:${config.port}`);
  console.log(`👤 用户: ${config.user}`);
  console.log(`📁 远程路径: ${remotePath}`);
  
  const client = new ftp.Client();
  client.ftp.verbose = false; // 设为true可看详细日志
  
  try {
    // 连接FTP
    console.log('\n⏳ 连接FTP服务器...');
    await client.access(config);
    console.log('✅ FTP连接成功！');
    
    // 确保远程目录存在
    console.log(`\n⏳ 确保远程目录 ${remotePath} 存在...`);
    await client.ensureDir(remotePath);
    
    // 需要上传的文件和目录
    const uploadItems = [
      { local: 'src', remote: 'src', type: 'dir' },
      { local: 'views', remote: 'views', type: 'dir' },
      { local: 'public', remote: 'public', type: 'dir' },
      { local: 'package.json', remote: 'package.json', type: 'file' },
      { local: 'package-lock.json', remote: 'package-lock.json', type: 'file' },
      { local: 'CHANGELOG.md', remote: 'CHANGELOG.md', type: 'file' },
      { local: '.env', remote: '.env', type: 'file' },
    ];
    
    // 上传文件
    for (const item of uploadItems) {
      const localPath = path.join(localDir, item.local);
      if (!fs.existsSync(localPath)) {
        console.log(`⚠️ 跳过不存在的: ${item.local}`);
        continue;
      }
      
      if (item.type === 'dir') {
        console.log(`📁 上传目录: ${item.local}/ → ${item.remote}/`);
        await client.uploadDir(localPath, item.remote);
      } else {
        console.log(`📄 上传文件: ${item.local} → ${item.remote}`);
        await client.uploadFrom(localPath, item.remote);
      }
    }
    
    // 在远程创建uploads目录
    console.log('\n📁 确保uploads目录存在...');
    await client.ensureDir('uploads');
    
    // 创建 tmp/restart.txt 触发 Passenger 重启
    console.log('\n🔄 触发 Passenger 应用重启...');
    try {
      const tmpDir = `${remotePath}/tmp`;
      await client.ensureDir(tmpDir);
      // ensureDir 后 CWD 已在 tmp 目录，直接用文件名上传
      const restartContent = `Restart triggered at ${new Date().toISOString()}`;
      const tmpRestartPath = path.join(localDir, 'tmp_restart.txt');
      fs.writeFileSync(tmpRestartPath, restartContent);
      await client.uploadFrom(tmpRestartPath, 'restart.txt');
      fs.unlinkSync(tmpRestartPath);
      console.log('✅ tmp/restart.txt 已创建，Passenger 将在下次请求时重启应用');
      // 回到 public_html 目录
      await client.cd(`/${remotePath}`);
    } catch (restartErr) {
      console.log('⚠️ 创建 restart.txt 失败（非致命）:', restartErr.message);
      console.log('   请在 Hostinger 面板手动重启 Node.js 应用');
    }
    
    // 创建启动脚本
    console.log('\n📄 创建远程启动脚本...');
    const startScript = `#!/bin/bash
cd $(dirname $0)
export NODE_ENV=production
npm install --production 2>/dev/null
node src/index.js
`;
    // 写入临时文件再上传
    const tmpStartPath = path.join(localDir, 'tmp_start.sh');
    fs.writeFileSync(tmpStartPath, startScript);
    await client.uploadFrom(tmpStartPath, 'start.sh');
    fs.unlinkSync(tmpStartPath);
    
    // 创建 .htaccess (用于Hostinger Node.js路由)
    console.log('📄 创建.htaccess...');
    const htaccess = `# Node.js 应用路由
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ^$ http://localhost:${env.PORT || 5000}/ [P]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule ^(.*)$ http://localhost:${env.PORT || 5000}/$1 [P]
</IfModule>
`;
    const tmpHtaccessPath = path.join(localDir, 'tmp_htaccess');
    fs.writeFileSync(tmpHtaccessPath, htaccess);
    await client.uploadFrom(tmpHtaccessPath, '.htaccess');
    fs.unlinkSync(tmpHtaccessPath);
    
    console.log('\n✅ 部署完成！');
    console.log('\n📋 后续步骤：');
    console.log('  1. 登录Hostinger面板 → 网站 → Node.js');
    console.log('  2. 创建Node.js应用：');
    console.log(`     - Node.js版本: 18+`);
    console.log(`     - 应用根目录: ${remotePath}`);
    console.log(`     - 启动文件: src/index.js`);
    console.log('  3. 设置环境变量：');
    console.log('     NODE_ENV = production');
    console.log('  4. 启动应用');
    console.log(`\n🌐 网站地址: https://erp.hlknasalstrips.com`);
    
  } catch (err) {
    console.error('\n❌ 部署失败:', err.message);
    if (err.code) console.error('   错误码:', err.code);
    process.exit(1);
  } finally {
    client.close();
    console.log('\nFTP连接已关闭');
  }
}

deploy();