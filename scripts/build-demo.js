const fs = require('node:fs');
const path = require('node:path');

// Publish only frontend assets, never runtime data, logs, or environment files.
const root = path.join(__dirname, '..');
const output = path.join(root, 'demo-dist');
fs.mkdirSync(output, { recursive: true });
const source = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const marker = '<!-- DEMO_CONFIG -->';
if (!source.includes(marker)) throw new Error('Dashboard is missing the demo configuration marker');
const html = source.replace(marker, '<script>window.HOST_MONITOR_DEMO = true;</script>')
  .replace('<title>主機監測系統</title>', '<title>Host Monitor · Interactive Demo</title>');
fs.writeFileSync(path.join(output, 'index.html'), html);
fs.copyFileSync(path.join(root, 'public/demo.js'), path.join(output, 'demo.js'));
fs.copyFileSync(path.join(root, 'public/api.js'), path.join(output, 'api.js'));
fs.copyFileSync(path.join(root, 'public/shared.js'), path.join(output, 'shared.js'));
fs.copyFileSync(path.join(root, 'public/styles.css'), path.join(output, 'styles.css'));
fs.writeFileSync(path.join(output, '.nojekyll'), '');
console.log('Static demo built in demo-dist/');
