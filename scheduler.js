// One queue for automatic and manual probes. Object identity prevents a deleted
// and recreated monitor with the same IP from receiving an old probe result.
function createProbeScheduler({ concurrency, run }) {
  const jobs = new Map();
  const queue = [];
  let active = 0;
  function drain() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      Promise.resolve().then(() => run(job.monitor)).then(job.resolve, job.reject).finally(() => {
        active--;
        jobs.delete(job.monitor);
        drain();
      });
    }
  }
  function enqueue(monitor) {
    if (jobs.has(monitor)) return jobs.get(monitor);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    jobs.set(monitor, promise);
    queue.push({ monitor, resolve, reject });
    drain();
    return promise;
  }
  return { enqueue, has: monitor => jobs.has(monitor) };
}

function createManualLimiter({ limit, now = Date.now }) {
  let start = null, count = 0;
  return function acquire() {
    const time = now();
    if (start === null || time >= start + 60000) { start = time; count = 0; }
    if (count >= limit) return Math.max(1, Math.ceil((start + 60000 - time) / 1000));
    count++;
    return 0;
  };
}
module.exports = { createProbeScheduler, createManualLimiter };
