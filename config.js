const fs = require('node:fs');
const path = require('node:path');

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
  return {
    port: integer('PORT', 3000, 1, 65535),
    checkInterval: integer('CHECK_INTERVAL', 30000, 1000, 2147483647),
  };
}
module.exports = { loadEnvFile, readIntegerEnv, readBooleanEnv, readConfig };
