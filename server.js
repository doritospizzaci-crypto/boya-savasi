'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Lobby, cleanName } = require('./game');

// Sadece bu sayfalar sunulur; sunucu kodu ve diğer dosyalar dışarıya açılmaz.
const PAGES = { '/': 'index.html', '/index.html': 'index.html' };
// Mobil operatörlerde onlarca kişi aynı IP adresini paylaşır, bu yüzden sınır geniş tutulur.
const DEFAULT_MAX_CONN_PER_IP = 40;
// Saniyede 150'den fazla mesaj yok sayılır; 600'ü geçerse bağlantı kesilir.
// Hızlı sürükleyen bir parmak bile bunun altında kalır, kesme sadece saldırı içindir.
const SOFT_MSGS_PER_SEC = 150;
const HARD_MSGS_PER_SEC = 600;
const CODE_RE = /^[A-Z0-9]{3,8}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function securityHeaders(extra) {
  return Object.assign({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }, extra);
}

function clientIp(req) {
  // Proxy (Render, Fly, Railway) kendi eklediği adresi sona yazar; sahte başlıklara karşı sonuncuyu al.
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) {
    const parts = xf.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function makeStaticHandler(getStats) {
  return function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, securityHeaders({ Allow: 'GET, HEAD' }));
      res.end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (e) {
      res.writeHead(400, securityHeaders());
      res.end('Bad request');
      return;
    }
    if (pathname === '/healthz') {
      res.writeHead(200, securityHeaders({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }));
      res.end(JSON.stringify(Object.assign({ ok: true }, getStats())));
      return;
    }
    const page = Object.prototype.hasOwnProperty.call(PAGES, pathname) ? PAGES[pathname] : null;
    if (!page) {
      res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('Bulunamadı');
      return;
    }
    const file = path.join(__dirname, page);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
        res.end('Bulunamadı');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, securityHeaders({
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      }));
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  };
}

function start(opts) {
  opts = opts || {};
  const port = opts.port !== undefined ? opts.port : (Number(process.env.PORT) || 3000);
  const host = opts.host || '0.0.0.0';
  const lobby = new Lobby();
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const server = http.createServer(makeStaticHandler(() => lobby.stats()));
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024,
    verifyClient: (info) => !allowed.length || allowed.includes(info.origin),
  });

  const ipCount = new Map();
  const maxPerIp = opts.maxPerIp || DEFAULT_MAX_CONN_PER_IP;

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const open = ipCount.get(ip) || 0;
    if (open >= maxPerIp) {
      ws.close(1013, 'busy');
      return;
    }
    ipCount.set(ip, open + 1);

    let room = null;
    let player = null;
    let windowStart = Date.now();
    let msgs = 0;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const joinTimer = setTimeout(() => {
      if (!player) ws.close(1008, 'join timeout');
    }, 10000);

    function send(s) {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > 1e6) {
        ws.terminate();
        return;
      }
      ws.send(s);
    }

    ws.on('message', (data) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        msgs = 0;
      }
      msgs++;
      if (msgs > HARD_MSGS_PER_SEC) {
        ws.close(1008, 'too fast');
        return;
      }
      if (msgs > SOFT_MSGS_PER_SEC) return;
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch (e) {
        return;
      }
      if (!m || typeof m !== 'object') return;

      if (m.t === 'join' && !player) {
        let target;
        const code = typeof m.code === 'string' ? m.code.toUpperCase() : '';
        if (m.mode === 'solo') target = lobby.solo();
        else if (m.mode === 'code' && CODE_RE.test(code)) target = lobby.byCode(code);
        else target = lobby.quick();
        const p = target.addHuman({
          name: cleanName(m.n),
          color: Number.isInteger(m.c) ? m.c : -1,
          send,
        }, now);
        if (!p) {
          send(JSON.stringify({ t: 'err', m: 'full' }));
          return;
        }
        room = target;
        player = p;
      } else if (m.t === 'paint' && player) {
        room.paint(player.id, m.i, m.b === true, now);
      } else if (m.t === 'paints' && player && Array.isArray(m.c)) {
        // Hızlı sürüklemede istemci boyamaları toplu gönderir.
        const n = Math.min(m.c.length, 40);
        for (let k = 0; k < n; k++) room.paint(player.id, m.c[k], false, now);
      }
    });

    ws.on('close', (code, reason) => {
      // Render panelindeki Logs sekmesinde bağlantıların neden koptuğu görünür.
      console.log('[kapanış] kod=' + code + ' neden=' + String(reason || '') + ' oyuncu=' + (player ? player.name : '-'));
      clearTimeout(joinTimer);
      const left = (ipCount.get(ip) || 1) - 1;
      if (left <= 0) ipCount.delete(ip);
      else ipCount.set(ip, left);
      if (room && player) room.removePlayer(player.id, Date.now());
    });

    ws.on('error', () => {});
  });

  const gameTimer = setInterval(() => lobby.tick(Date.now()), 100);
  const pingTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* bağlantı zaten kopmuş */ }
    });
  }, 20000);

  function close() {
    clearInterval(gameTimer);
    clearInterval(pingTimer);
    wss.clients.forEach((ws) => ws.terminate());
    return new Promise((resolve) => {
      wss.close(() => server.close(() => resolve()));
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({ server, lobby, port: server.address().port, close });
    });
  });
}

if (require.main === module) {
  start().then((s) => {
    console.log('Boya Savaşı http://localhost:' + s.port + ' adresinde çalışıyor');
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
}

module.exports = { start };
