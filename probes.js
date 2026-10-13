const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const builders = require('ping/lib/builder/factory');
const parsers = require('ping/lib/parser/factory');

const executionError = () => ({ alive: null, rtt: null, error: 'probe_execution_failed' });

// Keep the existing cross-platform argument builders/parsers, but observe process failures.
function createSystemProbe({ execute = promisify(execFile), platform = process.platform } = {}) {
  return async ip => {
    try {
      const config = { timeout: 3, min_reply: 1, numeric: true, v6: false };
      const args = builders.createBuilder(platform).getCommandArguments(ip, config);
      const executable = builders.getExecutablePath(platform, false);
      let output;
      try {
        output = await execute(executable, args, { timeout: 5000, maxBuffer: 64 * 1024,
          windowsHide: true, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
      } catch (err) {
        // Linux/Windows use 1 for no replies; macOS uses 2. Other failures are tool errors.
        const unreachableCode = builders.isMacOS(platform) ? 2 : 1;
        if (err.code !== unreachableCode || err.killed || err.signal) return executionError();
        output = { stdout: err.stdout || '', stderr: err.stderr || '' };
      }
      if (output.stderr?.trim()) return executionError();
      const parser = parsers.createParser(ip, platform, config);
      output.stdout.split(/\r?\n/).forEach(line => parser.eat(line));
      const result = parser.getResult();
      // An unparseable result is not evidence that the target is down.
      if (!result.alive && Number(result.packetLoss) !== 100) return executionError();
      const time = Number(result.time);
      return { alive: result.alive, rtt: result.alive && Number.isFinite(time) && time >= 0 ? Math.round(time) : null };
    } catch {
      return executionError();
    }
  };
}

function normalizeProbeResult(result) {
  if (!result || result.error || typeof result.alive !== 'boolean') return executionError();
  return { alive: result.alive,
    rtt: result.alive && Number.isFinite(result.rtt) && result.rtt >= 0 ? Math.round(result.rtt) : null };
}

module.exports = { createSystemProbe, executionError, normalizeProbeResult };
