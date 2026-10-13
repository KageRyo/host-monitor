const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

function loadEnvFile(file = path.join(__dirname, '.env'), env = process.env, logger = console) {
  if (!fs.existsSync(file)) return;
  let contents;
  try { contents = fs.readFileSync(file, 'utf8'); }
  catch { logger.warn('Failed to load .env file'); return; }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals < 1) continue;
    const key = trimmed.slice(0, equals).trim();
    if (!key || Object.hasOwn(env, key)) continue;
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  }
}

function readIntegerEnv(name, defaultValue, minValue, maxValue = Number.MAX_SAFE_INTEGER, env = process.env, logger = console) {
  const raw = env[name];
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < minValue || value > maxValue) {
    logger.warn(`Invalid ${name}; using default ${defaultValue}`);
    return defaultValue;
  }
  return value;
}
function readBooleanEnv(name, defaultValue, env = process.env) {
  if (env[name] === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(env[name].trim().toLowerCase());
}
function readConfig(env = process.env, logger = console) {
  const integer = (name, fallback, min, max) => readIntegerEnv(name, fallback, min, max, env, logger);
  const host = env.HOST === undefined ? '0.0.0.0' : env.HOST.trim();
  if (!net.isIPv4(host)) throw new Error('Invalid HOST; expected an IPv4 bind address');
  if (env.AUTH_ENABLED !== undefined && !['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'].includes(env.AUTH_ENABLED.trim().toLowerCase())) {
    throw new Error('Invalid AUTH_ENABLED; expected a boolean');
  }
  const authEnabled = readBooleanEnv('AUTH_ENABLED', false, env);
  const authUsername = env.AUTH_USERNAME || '';
  const authPassword = env.AUTH_PASSWORD || '';
  if (authEnabled && (!authUsername.trim() || /[:\x00-\x1f\x7f]/.test(authUsername) || !authPassword || /[\x00-\x1f\x7f]/.test(authPassword))) {
    throw new Error('AUTH_ENABLED requires a valid AUTH_USERNAME and nonempty AUTH_PASSWORD');
  }
  return {
    host,
    authEnabled,
    authUsername,
    authPassword,
    port: integer('PORT', 3000, 1, 65535),
    checkInterval: integer('CHECK_INTERVAL', 30000, 1000, 2147483647),
    probeConcurrency: integer('PROBE_CONCURRENCY', 5, 1),
    maxMonitors: integer('MAX_MONITORS', 100, 1),
    manualCheckLimit: integer('MANUAL_CHECK_LIMIT', 10, 1),
    webhookEnabled: readBooleanEnv('WEBHOOK_ENABLED', false, env),
    webhookInitialDown: readBooleanEnv('WEBHOOK_INITIAL_DOWN', false, env),
    webhookInitialDownThreshold: integer('WEBHOOK_INITIAL_DOWN_THRESHOLD', 1, 1),
    webhookUrl: env.WEBHOOK_URL || '',
    webhookTimeoutMs: integer('WEBHOOK_TIMEOUT_MS', 5000, 1, 2147483647)
  };
}
module.exports = { loadEnvFile, readIntegerEnv, readBooleanEnv, readConfig };
