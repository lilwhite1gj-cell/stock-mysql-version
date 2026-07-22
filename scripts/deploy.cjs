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
    
    // 注意：不创建/覆盖 .htaccess 和 start.sh
    // Hostinger 使用 Passenger 管理 Node.js 应用，Passenger 有自己的路由机制
    // Hostinger 面板创建 Node.js 应用时会自动生成正确的 .htaccess
    // 手动创建 .htaccess 的 mod_proxy 规则会与 Passenger 冲突导致 503
    // 因此部署时不要修改服务器上的 .htaccess
    
    console.log('\n✅ 部署完成！');
    console.log('\n🌐 网站地址: https://erp.hlknasalstrips.com');
    
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