'use strict';

// Статический сервер для разработки без зависимостей:
//   node tools/serve.js [порт]   (по умолчанию 8080)
// Отдаёт файлы проекта с Cache-Control: no-store, чтобы после правки кода
// обновление страницы всегда показывало свежую версию.
//
// Заголовки COOP/COEP делают страницу "изолированной" (crossOriginIsolated):
// только в ней браузер даёт SharedArrayBuffer, а на нём держится
// многопоточная симуляция (js/sim/threads.js). Без них игра работает, но в
// одном потоке. Чужих ресурсов страница не грузит, так что require-corp ей
// ничего не ломает.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2]) || 8080;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Диагностика страницы (js/main.js: зависания, ошибки) — POST /__diag,
// строкой в diag.log в корне проекта и в консоль сервера.
const DIAG_LOG = path.join(ROOT, 'diag.log');

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__diag') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      const line = new Date().toISOString() + ' ' + body.replace(/\s+/g, ' ').slice(0, 4000);
      fs.appendFile(DIAG_LOG, line + '\n', () => {});
      console.log('[диагностика]', line);
      res.writeHead(204);
      res.end();
    });
    return;
  }
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}/`));
