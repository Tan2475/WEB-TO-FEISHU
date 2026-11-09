const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, buffer) => {
    if (error) { res.writeHead(404); res.end(); return; }
    let data = buffer;
    if (pathname === '/popup/popup.html') {
      data = buffer.toString()
        .replace('<div class="space-y-4">', `<section><div role="tablist">
          <button id="overview" role="tab" aria-selected="true">达人概览</button>
          <button id="business" role="tab" aria-selected="false">商业能力</button>
          <button id="connected" role="tab" aria-selected="false">连接用户</button>
          </div><p class="demo-metric">达人概览数据</p><p id="write-log">尚未写入</p></section><div class="space-y-4">`)
        .replace('<script src="../shared/storage.js">', '<script src="../tests/fixtures/batch-bridge.js"></script><script src="../content/content.js"></script><script src="../shared/storage.js">');
    }
    if (pathname === '/options/options.html') data = buffer.toString().replace('<script src="../shared/storage.js">',
      '<script src="../tests/fixtures/options-bridge.js"></script><script src="../shared/storage.js">');
    res.setHeader('Content-Type', path.extname(file) === '.html' ? 'text/html; charset=utf-8' : path.extname(file) === '.css' ? 'text/css' : 'text/javascript; charset=utf-8');
    res.end(data);
  });
}).listen(8767, '127.0.0.1', () => console.log('Batch fixture: http://127.0.0.1:8767/popup/popup.html'));
