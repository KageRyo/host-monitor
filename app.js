const express = require('express');
const ping = require('ping');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

function generateId(ip) {
  return ip.replaceAll('.', '-');
}

function normalizeIpv4(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return net.isIP(clean) === 4 ? clean : null;
}

function dataWriteError() {
  return {
    error: '資料儲存失敗，請確認磁碟空間與 data/ 目錄權限後再試一次'
  };
}

async function realProbe(ip) {
  try {
    const res = await ping.promise.probe(ip, {
      timeout: 3,
      min_reply: 1,
      numeric: true
    });
    const alive = !!res.alive;
    let rtt = null;
    if (alive) {
      const t = res.time;
      if (typeof t === 'number') rtt = Math.round(t);
      else if (typeof t === 'string' && t !== 'unknown') rtt = Math.round(Number.parseFloat(t));
    }
    return { alive, rtt };
  } catch {
    // A failed ping is a down result; raw probe errors do not change the API response.
    return { alive: false, rtt: null };
  }
}

function updateMonitor(monitor, result) {
  const now = new Date();

  monitor.status = result.alive ? 'up' : 'down';
  monitor.responseTime = result.rtt;
  monitor.lastCheck = now.toISOString();

  monitor.totalChecks = (monitor.totalChecks || 0) + 1;
  if (result.alive) monitor.upChecks = (monitor.upChecks || 0) + 1;

  monitor.history.push({
    time: now.toISOString(),
    alive: result.alive,
    rtt: result.rtt
  });
  if (monitor.history.length > 60) {
    monitor.history.shift();
  }
}

function createApp({ dataFile = path.join(__dirname, 'data', 'monitors.json'),
  probe: injectedProbe, logger = console, config = {} } = {}) {
  const checkerTimers = [];
  const probe = injectedProbe || realProbe;
  const app = express();
  app.disable('x-powered-by');
  const DATA_FILE = dataFile;
  const CHECK_INTERVAL = config.checkInterval || 30000;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // In-memory state
  let monitors = [];
  let groupOrder = [];           // 自訂的群組順序
  let lastGlobalCheck = null;
  let isChecking = false;

  function archiveCorruptDataFile() {
    if (!fs.existsSync(DATA_FILE)) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = `${DATA_FILE}.corrupt-${stamp}`;

    try {
      fs.copyFileSync(DATA_FILE, backupFile);
      logger.error(`Corrupt data file copied to ${backupFile}`);
    } catch (e) {
      logger.error('Failed to copy corrupt data file:', e.message);
    }
  }

  function loadFromFile() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.monitors)) {
          monitors = data.monitors.map(m => ({
            id: m.id || generateId(m.ip),
            ip: m.ip,
            name: m.name || m.ip,
            group: m.group || 'server',
            status: m.status || 'unknown',
            responseTime: m.responseTime ?? null,
            lastCheck: m.lastCheck || null,
            history: Array.isArray(m.history) ? m.history.slice(-60) : [],
            totalChecks: m.totalChecks || 0,
            upChecks: m.upChecks || 0,
            notes: m.notes || ''
          }));
          lastGlobalCheck = data.lastGlobalCheck || null;
          groupOrder = Array.isArray(data.groupOrder) ? data.groupOrder : [];
          logger.log(`Loaded ${monitors.length} monitors from ${DATA_FILE}`);
          return;
        }
      }
    } catch (e) {
      logger.error('Failed to load data file:', e.message);
      archiveCorruptDataFile();
    }

    // No seed data — start completely empty for open-source safety
    monitors = [];
    groupOrder = [];
    lastGlobalCheck = null;
    logger.log('No monitor data found. Starting with an empty list.');
  }

  function saveToFile() {
    let tempFile = null;

    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const payload = {
        monitors,
        groupOrder,
        lastGlobalCheck,
        savedAt: new Date().toISOString()
      };

      tempFile = path.join(dir, `.monitors.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tempFile, DATA_FILE);
      return true;
    } catch (e) {
      logger.error('Failed to save data:', e.message);
      if (tempFile && fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch (unlinkErr) {
          logger.error('Failed to remove incomplete data file:', unlinkErr.message);
        }
      }
      return false;
    }
  }

  async function runAllChecks(isManual = false) {
    if (isChecking) return false;
    isChecking = true;

    try {
      logger.log(`[${new Date().toISOString()}] Running checks for ${monitors.length} monitors...`);

      const tasks = monitors.map(async (m) => {
        const result = await probe(m.ip);
        updateMonitor(m, result);
      });

      await Promise.all(tasks);

      lastGlobalCheck = new Date().toISOString();
      const saved = saveToFile();
      if (!saved) {
        logger.error('Checks completed but results could not be saved.');
        return false;
      }

      logger.log('Checks completed.');
      return true;
    } finally {
      isChecking = false;
    }
  }

  // 取得目前所有使用的群組（支援自訂順序）
  function getAllGroups() {
    const groupSet = new Set(monitors.map(m => m.group || 'server'));
    let groups = Array.from(groupSet);

    if (groupOrder.length > 0) {
      // 使用自訂順序
      const ordered = [];
      const remaining = new Set(groups);

      // 先按照 groupOrder 排列已存在的群組
      groupOrder.forEach(g => {
        if (remaining.has(g)) {
          ordered.push(g);
          remaining.delete(g);
        }
      });

      // 剩下的群組（新建立的）按中文排序補在後面
      const rest = Array.from(remaining).sort((a, b) =>
        (a || '').localeCompare(b || '', 'zh-Hant')
      );

      groups = [...ordered, ...rest];
    } else {
      // 預設行為：server 第一，其餘中文排序
      const serverIndex = groups.indexOf('server');
      if (serverIndex > -1) {
        groups.splice(serverIndex, 1);
        groups.unshift('server');
      }
      groups.sort((a, b) => {
        if (a === 'server') return -1;
        if (b === 'server') return 1;
        return (a || '').localeCompare(b || '', 'zh-Hant');
      });
    }

    return groups;
  }

  function getSortedMonitors() {
    const groups = getAllGroups();
    const grouped = {};
    groups.forEach(g => { grouped[g] = []; });

    monitors.forEach(m => {
      const g = m.group || 'server';
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(m);
    });

    // 每組內部排序
    Object.keys(grouped).forEach(g => {
      grouped[g].sort((a, b) => (a.name || a.ip).localeCompare(b.name || b.ip, 'zh-Hant'));
    });

    // 展平成陣列，並帶上可讀的 groupLabel（預設用 group 名稱）
    const result = [];
    // 相容舊資料：把 legacy group key 轉成好看的中文
    const legacyMap = {
      nas: 'NAS',
      edge: '邊緣版',
      printer: '印表機'
    };

    groups.forEach(g => {
      const label = g === 'server' ? '伺服器' : (legacyMap[g] || g);
      grouped[g].forEach(m => {
        result.push({ ...m, groupLabel: label });
      });
    });

    return result;
  }

  function getStats() {
    const total = monitors.length;
    const up = monitors.filter(m => m.status === 'up').length;
    const down = monitors.filter(m => m.status === 'down').length;
    const unknown = total - up - down;

    let avgUptime = 0;
    if (total > 0) {
      const uptimes = monitors.map(m => {
        if (!m.totalChecks || m.totalChecks === 0) return 100;
        return (m.upChecks / m.totalChecks) * 100;
      });
      avgUptime = uptimes.reduce((a, b) => a + b, 0) / total;
    }

    return {
      total,
      up,
      down,
      unknown,
      avgUptime: Math.round(avgUptime * 10) / 10,
      lastGlobalCheck
    };
  }

  // === REST API ===

  // Get all monitors + stats
  app.get('/api/monitors', (req, res) => {
    res.json({
      monitors: getSortedMonitors(),
      stats: getStats(),
      isChecking
    });
  });

  // Add new monitor
  app.post('/api/monitors', (req, res) => {
    const { ip, name, group, notes } = req.body;
    if (!ip || typeof ip !== 'string') {
      return res.status(400).json({ error: 'IP is required' });
    }

    const cleanIp = normalizeIpv4(ip);
    if (!cleanIp) {
      return res.status(400).json({ error: 'Invalid IP format' });
    }

    const id = generateId(cleanIp);

    if (monitors.some(m => m.id === id)) {
      return res.status(409).json({ error: 'Monitor with this IP already exists' });
    }

    const newMonitor = {
      id,
      ip: cleanIp,
      name: name?.trim() ? name.trim() : cleanIp,
      group: group?.trim() ? group.trim() : 'server',
      status: 'unknown',
      responseTime: null,
      lastCheck: null,
      history: [],
      totalChecks: 0,
      upChecks: 0,
      notes: typeof notes === 'string' ? notes.trim() : ''
    };

    monitors.push(newMonitor);
    if (!saveToFile()) {
      monitors.pop();
      return res.status(500).json(dataWriteError());
    }

    res.status(201).json(newMonitor);
  });

  // Update monitor (name / group)
  app.put('/api/monitors/:id', (req, res) => {
    const { id } = req.params;
    const { name, group } = req.body;

    const monitor = monitors.find(m => m.id === id);
    if (!monitor) return res.status(404).json({ error: 'Not found' });

    const previous = {
      name: monitor.name,
      group: monitor.group,
      notes: monitor.notes
    };

    if (name && typeof name === 'string') monitor.name = name.trim();
    if (group && typeof group === 'string' && group.trim()) {
      monitor.group = group.trim();
    }
    if (typeof req.body.notes === 'string') {
      monitor.notes = req.body.notes.trim();
    }

    if (!saveToFile()) {
      Object.assign(monitor, previous);
      return res.status(500).json(dataWriteError());
    }

    res.json(monitor);
  });

  // Delete monitor
  app.delete('/api/monitors/:id', (req, res) => {
    const { id } = req.params;
    const idx = monitors.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    const [removed] = monitors.splice(idx, 1);
    if (!saveToFile()) {
      monitors.splice(idx, 0, removed);
      return res.status(500).json(dataWriteError());
    }

    res.json({ success: true });
  });

  // === 群組順序管理 ===

  // 取得目前群組順序
  app.get('/api/groups/order', (req, res) => {
    res.json({ order: groupOrder });
  });

  // 更新群組順序
  app.put('/api/groups/order', (req, res) => {
    const { order } = req.body;

    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order 必須是陣列' });
    }

    const previousOrder = groupOrder.slice();

    // 只保留目前實際存在的群組
    const existingGroups = new Set(monitors.map(m => m.group || 'server'));
    groupOrder = order.filter(g => existingGroups.has(g));

    // 把新出現但不在 order 裡的群組補上去（放在最後）
    monitors.forEach(m => {
      const g = m.group || 'server';
      if (!groupOrder.includes(g)) {
        groupOrder.push(g);
      }
    });

    if (!saveToFile()) {
      groupOrder = previousOrder;
      return res.status(500).json(dataWriteError());
    }

    res.json({ success: true, order: groupOrder });
  });

  // Force check single monitor
  app.post('/api/monitors/:id/check', async (req, res) => {
    const { id } = req.params;
    const monitor = monitors.find(m => m.id === id);
    if (!monitor) return res.status(404).json({ error: 'Not found' });

    const result = await probe(monitor.ip);
    updateMonitor(monitor, result);
    if (!saveToFile()) {
      return res.status(500).json(dataWriteError());
    }

    const label = monitor.group === 'server' ? '伺服器' : monitor.group;
    res.json({
      ...monitor,
      groupLabel: label || '伺服器'
    });
  });

  // Force check all
  app.post('/api/check-all', async (req, res) => {
    if (isChecking) {
      return res.status(429).json({ error: 'Check already in progress' });
    }

    const saved = await runAllChecks();
    if (!saved) {
      return res.status(500).json(dataWriteError());
    }

    res.json({
      success: true,
      stats: getStats(),
      monitors: getSortedMonitors()
    });
  });

  // Simple health
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, monitors: monitors.length, lastCheck: lastGlobalCheck });
  });

  // Start background checker
  function startChecker() {
    // First check shortly after start
    if (checkerTimers.length) return;
    checkerTimers.push(
      setTimeout(() => {
        runAllChecks().catch(logger.error);
      }, 1500),
      setInterval(() => {
        runAllChecks().catch(logger.error);
      }, CHECK_INTERVAL)
    );
  }

  function stopChecker() {
    checkerTimers.forEach(timer => { clearTimeout(timer); clearInterval(timer); });
    checkerTimers.length = 0;
  }
  loadFromFile();
  return { app, startChecker, stopChecker, close: stopChecker };
}
module.exports = { createApp };
