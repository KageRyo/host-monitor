const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');

function loadEnvFile() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;

  try {
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex === -1) return;

      const key = trimmed.slice(0, equalsIndex).trim();
      let value = trimmed.slice(equalsIndex + 1).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) return;

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    });
  } catch (e) {
    console.error('Failed to load .env file:', e.message);
  }
}

loadEnvFile();

function readIntegerEnv(name, defaultValue, minValue) {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw.trim())) return defaultValue;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minValue) return defaultValue;
  return value;
}

function readBooleanEnv(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

const LOG_FILE = path.join(__dirname, 'logs', 'monitor.log');
const LOG_MAX_BYTES = readIntegerEnv('LOG_MAX_BYTES', 5 * 1024 * 1024, 1);
const LOG_MAX_FILES = readIntegerEnv('LOG_MAX_FILES', 5, 0);
const LOG_TO_STDOUT = readBooleanEnv(
  'LOG_TO_STDOUT',
  Boolean(process.stdout.isTTY || process.stderr.isTTY)
);

function ensureLogDirectory() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rotateLogFiles() {
  if (LOG_MAX_FILES === 0) {
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
    return;
  }

  const oldest = `${LOG_FILE}.${LOG_MAX_FILES}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

  for (let i = LOG_MAX_FILES - 1; i >= 1; i -= 1) {
    const current = `${LOG_FILE}.${i}`;
    if (fs.existsSync(current)) {
      fs.renameSync(current, `${LOG_FILE}.${i + 1}`);
    }
  }

  if (fs.existsSync(LOG_FILE)) {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  }
}

function rotateLogIfNeeded(incomingBytes) {
  ensureLogDirectory();

  let currentSize = 0;
  if (fs.existsSync(LOG_FILE)) {
    currentSize = fs.statSync(LOG_FILE).size;
  }

  if (currentSize > 0 && currentSize + incomingBytes > LOG_MAX_BYTES) {
    rotateLogFiles();
  }
}

function formatLogEntry(level, message) {
  const prefix = `[${new Date().toISOString()}] ${level} `;
  return `${prefix}${message.replace(/\n/g, `\n${prefix}`)}\n`;
}

function setupLogger() {
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  function write(level, originalMethod, args) {
    if (LOG_TO_STDOUT) {
      originalMethod(...args);
    }

    const message = util.format(...args);
    const entry = formatLogEntry(level, message);

    try {
      rotateLogIfNeeded(Buffer.byteLength(entry, 'utf8'));
      fs.appendFileSync(LOG_FILE, entry, 'utf8');
    } catch (e) {
      if (LOG_TO_STDOUT) {
        original.error('Failed to write log file:', e.message);
      }
    }
  }

  console.log = (...args) => write('INFO', original.log, args);
  console.info = (...args) => write('INFO', original.info, args);
  console.warn = (...args) => write('WARN', original.warn, args);
  console.error = (...args) => write('ERROR', original.error, args);
}

setupLogger();

// Get all non-internal IPv4 addresses for LAN access
function getLocalIPs() {
  const results = [];
  let nets;

  try {
    nets = os.networkInterfaces();
  } catch (e) {
    console.warn('Failed to read network interfaces:', e.message);
    return results;
  }

  for (const name of Object.keys(nets)) {
    for (const iface of (nets[name] || [])) {
      if (iface.family === 'IPv4' && !iface.internal) {
        results.push(iface.address);
      }
    }
  }
  return results;
}

// Boot
const { createApp } = require('./app');
const PORT = parseInt(process.env.PORT || '3000', 10);
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '30000', 10);
const backend = createApp({ config: { checkInterval: CHECK_INTERVAL } });
backend.startChecker();

backend.app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();

  console.log(`\n✅ 主機監測系統已啟動`);
  console.log(`   本機瀏覽：  http://localhost:${PORT}`);

  if (ips.length > 0) {
    console.log(`   區域網路：`);
    ips.forEach(ip => {
      console.log(`                 http://${ip}:${PORT}`);
    });
  } else {
    console.log(`   區域網路：  http://<本機IP>:${PORT}`);
  }

  console.log(`   自動檢查間隔：${CHECK_INTERVAL / 1000} 秒\n`);
});
