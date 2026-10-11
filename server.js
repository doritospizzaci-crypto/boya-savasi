'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Lobby, cleanName } = require('./game');

// Mobil operatörlerde onlarca kişi aynı IP adresini paylaşır, bu yüzden sınır geniş tutulur.
const DEFAULT_MAX_CONN_PER_IP = 40;
// Aynı anda en fazla bu kadar oyuncu alınır (RAM ve işlemci korunsun diye). MAX_PLAYERS ile değişir.
const DEFAULT_MAX_PLAYERS = 400;
// Saniyede 150'den fazla mesaj yok sayılır; 600'ü geçerse bağlantı kesilir.
const SOFT_MSGS_PER_SEC = 150;
const HARD_MSGS_PER_SEC = 600;
const CODE_RE = /^[A-Z0-9]{3,8}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

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

// Sitenin dışarıdan görünen adresi (paylaşım görseli, sitemap vb. için). PUBLIC_URL ile sabitlenebilir.
function originOf(req) {
  const fixed = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(fixed)) return fixed;
  const first = (v) => String(v || '').split(',')[0].trim();
  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host);
  if (!HOST_RE.test(host)) return '';
  const xfp = first(req.headers['x-forwarded-proto']).toLowerCase();
  const local = /^(localhost|127\.|\[?::1)/.test(host);
  const proto = xfp === 'http' || xfp === 'https' ? xfp : (local ? 'http' : 'https');
  return proto + '://' + host;
}

function makeHandler(lobby, lagInfo) {
  const cache = new Map();
  function readCached(name) {
    if (cache.has(name)) return cache.get(name);
    let buf = null;
    try { buf = fs.readFileSync(path.join(__dirname, name)); } catch (e) { buf = null; }
    cache.set(name, buf);
    return buf;
  }

  const gsv = String(process.env.GOOGLE_SITE_VERIFICATION || '').replace(/[^A-Za-z0-9_-]/g, '');

  function renderIndex(origin) {
    const raw = readCached('index.html');
    if (!raw) return null;
    const hasOg = !!readCached('og.png');
    const ogTags = hasOg
      ? '<meta property="og:image" content="' + origin + '/og.png">' +
        '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' +
        '<meta name="twitter:image" content="' + origin + '/og.png">'
      : '';
    return raw.toString('utf8')
      .replace(/__ORIGIN__/g, origin)
      .replace('<!--OGIMG-->', ogTags)
      .replace('<!--GSV-->', gsv ? '<meta name="google-site-verification" content="' + gsv + '">' : '');
  }

  function send(res, req, status, headers, body) {
    res.writeHead(status, securityHeaders(headers));
    res.end(req.method === 'HEAD' ? undefined : body);
  }

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
      send(res, req, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request');
      return;
    }

    if (pathname === '/healthz') {
      const mem = process.memoryUsage();
      send(res, req, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        JSON.stringify(Object.assign({
          ok: true,
          uptimeSec: Math.round(process.uptime()),
          rssMb: Math.round(mem.rss / 1048576),
          lagMs: lagInfo.recent(),
        }, lobby.stats())));
      return;
    }
    if (pathname === '/top') {
      send(res, req, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        JSON.stringify({ top: lobby.topList(Date.now(), 10) }));
      return;
    }
    if (pathname === '/robots.txt') {
      const origin = originOf(req);
      send(res, req, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        'User-agent: *\nAllow: /\nDisallow: /top\nDisallow: /healthz\n' + (origin ? 'Sitemap: ' + origin + '/sitemap.xml\n' : ''));
      return;
    }
    if (pathname === '/sitemap.xml') {
      const origin = originOf(req);
      send(res, req, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        '<url><loc>' + origin + '/</loc></url></urlset>\n');
      return;
    }
    if (pathname === '/og.png') {
      const png = readCached('og.png');
      if (!png) {
        send(res, req, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bulunamadı');
        return;
      }
      send(res, req, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }, png);
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      const html = renderIndex(originOf(req));
      if (html === null) {
        send(res, req, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bulunamadı');
        return;
      }
      send(res, req, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, html);
      return;
    }
    // Sunucu kodu ve diğer dosyalar dışarıya açılmaz.
    send(res, req, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bulunamadı');
  };
}

// Olay döngüsü gecikmesi: sunucu yetişemiyorsa burada görünür (/healthz içinde lagMs).
function startLagMonitor() {
  const ring = new Array(20).fill(0);
  let k = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const n = Date.now();
    ring[k++ % ring.length] = Math.max(0, n - last - 500);
    last = n;
  }, 500);
  timer.unref();
  return { recent: () => Math.max.apply(null, ring), stop: () => clearInterval(timer) };
}

function start(opts) {
  opts = opts || {};
  const port = opts.port !== undefined ? opts.port : (Number(process.env.PORT) || 3000);
  const host = opts.host || '0.0.0.0';
  const maxPlayers = opts.maxPlayers || Number(process.env.MAX_PLAYERS) || DEFAULT_MAX_PLAYERS;
  const maxPerIp = opts.maxPerIp || Number(process.env.MAX_PER_IP) || DEFAULT_MAX_CONN_PER_IP;
  const lobby = new Lobby({ maxPlayers });
  const lag = startLagMonitor();
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const server = http.createServer(makeHandler(lobby, lag));
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024,
    verifyClient: (info) => !allowed.length || allowed.includes(info.origin),
  });

  const ipCount = new Map();

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const open = ipCount.get(ip) || 0;
    if (open >= maxPerIp || wss.clients.size > maxPlayers * 2) {
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
        if (lobby.isFull()) {
          send(JSON.stringify({ t: 'err', m: 'busy' }));
          return;
        }
        const gm = typeof m.gm === 'string' ? m.gm : 'classic';
        const code = typeof m.code === 'string' ? m.code.toUpperCase() : '';
        let target;
        if (m.mode === 'solo') target = lobby.solo(gm);
        else if (m.mode === 'code' && CODE_RE.test(code)) target = lobby.byCode(code, gm, m.bots === true);
        else target = lobby.quick(gm);
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
        const n = Math.min(m.c.length, 40);
        for (let k = 0; k < n; k++) room.paint(player.id, m.c[k], false, now);
      }
    });

    ws.on('close', (code, reason) => {
      // Sadece olağan dışı kapanışlar kaydedilir; Render'daki Logs sekmesinde nedeni görünür.
      if (code === 1008 || code === 1009 || code === 1011 || code === 1013) {
        console.log('[kapanış] kod=' + code + ' neden=' + String(reason || '') + ' oyuncu=' + (player ? player.name : '-'));
      }
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
    lag.stop();
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

module.exports = { start, originOf };
