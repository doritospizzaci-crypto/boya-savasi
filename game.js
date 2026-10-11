'use strict';

// Oyunun tüm kuralları sunucuda çalışır. İstemci sadece "şu hücreye dokundum" der;
// tur süresi, mürekkep, bomba hakkı ve skor burada hesaplanır.

// Her modun kuralları burada. Sayıları değiştirmek yeterli, başka yerde ayar yok.
//  inkTank   : arka arkaya kaç hücre boyanabilir
//  inkRefill : tank boşalınca kaç ms beklenir (sonra tank tamamen dolar)
const BASE = { bombEvery: 6, bombMax: 3, inkTank: 3, inkRefill: 1000, inks: 24 };
const MODES = Object.freeze({
  classic: Object.freeze(Object.assign(
    { id: 'classic', name: 'Klasik', cols: 12, rows: 12, play: 60000, rest: 8000, maxPlayers: 12 }, BASE)),
  arena: Object.freeze(Object.assign(
    { id: 'arena', name: 'Arena', cols: 20, rows: 20, play: 90000, rest: 10000, maxPlayers: 24 }, BASE)),
});
const CFG = MODES.classic;

function modeOf(id) {
  return Object.prototype.hasOwnProperty.call(MODES, id) ? MODES[id] : MODES.classic;
}

// Ağ gecikmesi dalgalansa da dürüst oyuncu reddedilmesin diye sunucu beklemeyi biraz kısa tutar.
const LOCK_SLACK_MS = 150;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_NAMES = ['Kaya', 'Deniz'];
const DAY_MS = 86400000;
const TOP_MAX_NAMES = 1000;

function roundInfo(now, cfg) {
  cfg = cfg || CFG;
  const cycle = cfg.play + cfg.rest;
  const id = Math.floor(now / cycle);
  const t = now - id * cycle;
  const playing = t < cfg.play;
  return { id, t, playing, left: playing ? cfg.play - t : cycle - t };
}

function blastCells(cfg, i) {
  const r = Math.floor(i / cfg.cols);
  const c = i % cfg.cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < cfg.rows && cc >= 0 && cc < cfg.cols) out.push(rr * cfg.cols + cc);
    }
  }
  return out;
}

function cleanName(s) {
  const str = String(s == null ? '' : s);
  let out = '';
  for (let j = 0; j < str.length; j++) {
    const c = str.charCodeAt(j);
    if (
      c < 32 || c === 127 ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x2028 && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x206f) ||
      c === 0xfeff
    ) continue;
    out += str.charAt(j);
  }
  return Array.from(out.trim()).slice(0, 14).join('');
}

// Türkiye saatine göre gün numarası (gün gece yarısı değişir).
function dayKey(now) {
  return Math.floor((now + 3 * 3600000) / DAY_MS);
}

class Room {
  constructor(code, isPublic, bots, mode) {
    this.code = code;
    this.isPublic = !!isPublic;
    this.bots = !!bots;
    this.cfg = modeOf(mode);
    this.N = this.cfg.cols * this.cfg.rows;
    this.players = new Map();
    this.nextId = 1;
    this.cells = new Int16Array(this.N).fill(-1);
    this.round = -1;
    this.playing = false;
    this.pending = new Map();
    this.lastPhase = 0;
    this.lastResult = null;
    this.onWin = null;
  }

  humans() {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot) n++;
    return n;
  }

  hasBots() {
    for (const p of this.players.values()) if (p.bot) return true;
    return false;
  }

  playerList() {
    return Array.from(this.players.values(), (p) => ({
      id: p.id, n: p.name, c: p.color, b: p.bot ? 1 : 0, w: p.wins,
    }));
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) if (p.send) p.send(s);
  }

  scores() {
    const s = new Map();
    for (let i = 0; i < this.N; i++) {
      const o = this.cells[i];
      if (o >= 0) s.set(o, (s.get(o) || 0) + 1);
    }
    return s;
  }

  // Tur geçişlerini zamana göre uygular. Her işlemden önce çağrılır.
  sync(now) {
    const info = roundInfo(now, this.cfg);
    if (info.id !== this.round) this._newRound(info);
    else if (this.playing && !info.playing) this._endRound(info, now);
  }

  _newRound(info) {
    this.round = info.id;
    this.playing = info.playing;
    this.cells.fill(-1);
    this.pending.clear();
    this.lastResult = null;
    for (const p of this.players.values()) {
      p.taps = 0;
      p.bombs = 0;
      p.ink = this.cfg.inkTank;
      p.lockUntil = 0;
      p.meDirty = true;
    }
    this.broadcast({ t: 'n', r: info.id, pl: info.playing, left: info.left });
  }

  _endRound(info, now) {
    this.playing = false;
    const sc = this.scores();
    let top = 0;
    for (const v of sc.values()) if (v > top) top = v;
    const ids = [];
    if (top > 0) {
      for (const [id, v] of sc) {
        if (v === top && this.players.has(id)) {
          ids.push(id);
          this.players.get(id).wins++;
        }
      }
    }
    // Günlük şampiyonlar listesi sadece herkese açık, botsuz ve en az 2 gerçek oyunculu odalardan beslenir.
    if (this.onWin && this.isPublic && !this.bots && this.humans() >= 2) {
      for (const id of ids) {
        const p = this.players.get(id);
        if (p && !p.bot) this.onWin(p.name, now);
      }
    }
    this.lastResult = {
      t: 'w',
      ids,
      score: top,
      wins: Array.from(this.players.values(), (p) => [p.id, p.wins]),
    };
    this.broadcast(this.lastResult);
    this.broadcast({ t: 'p', r: this.round, pl: false, left: info.left });
  }

  _clearCellsOf(id) {
    for (let i = 0; i < this.N; i++) {
      if (this.cells[i] === id) {
        this.cells[i] = -1;
        this.pending.set(i, -1);
      }
    }
  }

  _add({ name, color, bot, send }, now) {
    const used = new Set();
    for (const p of this.players.values()) used.add(p.color);
    let chosen = -1;
    if (Number.isInteger(color) && color >= 0 && color < this.cfg.inks && !used.has(color)) chosen = color;
    if (chosen < 0) {
      for (let c = 0; c < this.cfg.inks; c++) {
        if (!used.has(c)) { chosen = c; break; }
      }
    }
    if (chosen < 0) chosen = 0;
    const p = {
      id: this.nextId++,
      name: cleanName(name) || 'Oyuncu',
      color: chosen,
      bot: !!bot,
      send: bot ? null : send,
      taps: 0,
      bombs: 0,
      wins: 0,
      ink: this.cfg.inkTank,
      lockUntil: 0,
      meDirty: false,
      nextAct: now + 500,
    };
    this.players.set(p.id, p);
    return p;
  }

  _removeBots() {
    let removed = false;
    for (const p of Array.from(this.players.values())) {
      if (p.bot) {
        this.players.delete(p.id);
        this._clearCellsOf(p.id);
        removed = true;
      }
    }
    return removed;
  }

  // Sadece botlu odalarda: tek insan varsa iki bot eklenir; ikinci insan gelince çıkarılır.
  _ensureBots(now) {
    if (!this.bots) return;
    const h = this.humans();
    if (h === 1 && !this.hasBots()) {
      BOT_NAMES.forEach((n) => this._add({ name: n, bot: true }, now));
    } else if (h >= 2) {
      this._removeBots();
    }
  }

  addHuman({ name, color, send }, now) {
    this.sync(now);
    if (this.humans() >= this.cfg.maxPlayers) return null;
    this._removeBots();
    const p = this._add({ name, color, bot: false, send }, now);
    this._ensureBots(now);
    p.send(JSON.stringify(this.hello(p, now)));
    this.broadcast({ t: 'pl', p: this.playerList() });
    return p;
  }

  removePlayer(id, now) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this._clearCellsOf(id);
    this._ensureBots(now);
    this.broadcast({ t: 'pl', p: this.playerList() });
  }

  hello(p, now) {
    const info = roundInfo(now, this.cfg);
    this._refill(p, now);
    return {
      t: 'hi',
      id: p.id,
      code: this.code,
      cfg: this.cfg,
      r: this.round,
      pl: this.playing,
      left: info.left,
      cells: Array.from(this.cells),
      players: this.playerList(),
      b: p.bombs,
      k: p.taps,
      i: p.ink,
      l: p.lockUntil ? Math.max(0, p.lockUntil - now) : 0,
      res: this.playing ? null : this.lastResult,
    };
  }

  // Bekleme süresi dolduysa tank tamamen dolar.
  _refill(p, now) {
    if (p.lockUntil && now >= p.lockUntil) {
      p.ink = this.cfg.inkTank;
      p.lockUntil = 0;
    }
  }

  // Reddedilen boyama istemcide görünmüş olabilir; gerçek durumu geri bildirip düzeltir.
  _resync(p, i, bomb) {
    if (p.bot) return;
    const list = bomb ? blastCells(this.cfg, i) : [i];
    for (const c of list) this.pending.set(c, this.cells[c]);
    p.meDirty = true;
  }

  // Bir boyama isteği. Mürekkep kuralı:
  //  - Her hücre 1 mürekkep harcar; tank boşalınca inkRefill kadar beklenir, sonra tank dolar.
  //  - Bomba tankın tamamını harcar (tank dolu olmalı) ve 3x3 alanı boyar.
  paint(pid, i, bomb, now) {
    this.sync(now);
    const p = this.players.get(pid);
    if (!p) return false;
    if (!Number.isInteger(i) || i < 0 || i >= this.N) return false;
    if (!this.playing) {
      this._resync(p, i, bomb);
      return false;
    }
    this._refill(p, now);
    if (p.lockUntil) {
      this._resync(p, i, bomb);
      return false;
    }

    let list;
    if (bomb && p.bombs > 0) {
      if (p.ink < this.cfg.inkTank) {
        this._resync(p, i, bomb);
        return false;
      }
      list = blastCells(this.cfg, i);
      p.bombs--;
      p.ink = 0;
    } else {
      list = [i];
      p.taps++;
      if (p.taps % this.cfg.bombEvery === 0 && p.bombs < this.cfg.bombMax) p.bombs++;
      p.ink--;
    }
    if (p.ink <= 0) {
      p.ink = 0;
      p.lockUntil = now + Math.max(0, this.cfg.inkRefill - LOCK_SLACK_MS);
    }
    for (const c of list) {
      if (this.cells[c] !== pid) {
        this.cells[c] = pid;
        this.pending.set(c, pid);
      }
    }
    p.meDirty = true;
    return true;
  }

  _botAct(now) {
    const { cols, rows } = this.cfg;
    for (const p of this.players.values()) {
      if (!p.bot || now < p.nextAct) continue;
      // Botlar da mürekkep kuralına uyar: üç boyama, sonra bekleme.
      p.nextAct = now + 120 + Math.random() * 180;
      let target = -1;
      if (Math.random() < 0.65) {
        const owned = [];
        for (let i = 0; i < this.N; i++) if (this.cells[i] === p.id) owned.push(i);
        if (owned.length) {
          const base = owned[Math.floor(Math.random() * owned.length)];
          const r = Math.floor(base / cols);
          const c = base % cols;
          const d = [[-1, 0], [1, 0], [0, -1], [0, 1]][Math.floor(Math.random() * 4)];
          const rr = r + d[0];
          const cc = c + d[1];
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) target = rr * cols + cc;
        }
      }
      if (target < 0) target = Math.floor(Math.random() * this.N);
      this.paint(p.id, target, p.bombs > 0 && p.ink === this.cfg.inkTank && Math.random() < 0.5, now);
    }
  }

  tick(now) {
    this.sync(now);
    if (this.playing) this._botAct(now);

    if (this.pending.size) {
      const c = Array.from(this.pending);
      this.pending.clear();
      this.broadcast({ t: 'c', c });
    }
    for (const p of this.players.values()) {
      this._refill(p, now);
      if (p.meDirty) {
        p.meDirty = false;
        if (p.send) {
          p.send(JSON.stringify({
            t: 'm', b: p.bombs, k: p.taps, i: p.ink, l: p.lockUntil ? Math.max(0, p.lockUntil - now) : 0,
          }));
        }
      }
    }
    if (now - this.lastPhase >= 1000) {
      this.lastPhase = now;
      const info = roundInfo(now, this.cfg);
      this.broadcast({ t: 'p', r: this.round, pl: this.playing, left: info.left });
    }
  }
}

class Lobby {
  constructor(opts) {
    opts = opts || {};
    this.rooms = new Map();
    this.maxTotal = opts.maxPlayers || 400;
    this.top = new Map();
    this.topDay = -1;
  }

  humans() {
    let n = 0;
    for (const r of this.rooms.values()) n += r.humans();
    return n;
  }

  isFull() {
    return this.humans() >= this.maxTotal;
  }

  _freshCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  _make(code, isPublic, bots, mode) {
    const r = new Room(code, isPublic, bots, mode);
    r.onWin = (name, now) => this.recordWin(name, now);
    this.rooms.set(code, r);
    return r;
  }

  // Rastgele oyuncularla: seçilen moddaki en kalabalık, dolmamış herkese açık odaya gir; yoksa yenisini aç.
  quick(mode) {
    const cfg = modeOf(mode);
    let best = null;
    for (const r of this.rooms.values()) {
      if (!r.isPublic || r.cfg !== cfg) continue;
      const h = r.humans();
      if (h > 0 && h < cfg.maxPlayers && (!best || h > best.humans())) best = r;
    }
    return best || this._make(this._freshCode(), true, false, cfg.id);
  }

  // Botlarla oyna: her oyuncuya ayrı, listelenmeyen, botlu bir oda açılır.
  solo(mode) {
    return this._make(this._freshCode(), false, true, mode);
  }

  // Özel oda: kod ile girilir, yoksa oluşturulur, hızlı oyunda listelenmez.
  // Var olan odaya girerken odanın kendi modu geçerlidir.
  byCode(code, mode, bots) {
    return this.rooms.get(code) || this._make(code, false, !!bots, mode);
  }

  recordWin(name, now) {
    const day = dayKey(now);
    if (day !== this.topDay) {
      this.top.clear();
      this.topDay = day;
    }
    if (!this.top.has(name) && this.top.size >= TOP_MAX_NAMES) return;
    this.top.set(name, (this.top.get(name) || 0) + 1);
  }

  // Bugünün en çok tur kazananları. Bellekte tutulur; sunucu yeniden başlayınca sıfırlanır.
  topList(now, limit) {
    if (dayKey(now) !== this.topDay) return [];
    return Array.from(this.top, ([n, w]) => ({ n, w }))
      .sort((a, b) => (b.w - a.w) || (a.n < b.n ? -1 : (a.n > b.n ? 1 : 0)))
      .slice(0, limit || 10);
  }

  tick(now) {
    for (const [code, r] of this.rooms) {
      if (r.humans() === 0) {
        this.rooms.delete(code);
        continue;
      }
      r.tick(now);
    }
  }

  stats() {
    const byMode = {};
    for (const id of Object.keys(MODES)) byMode[id] = { rooms: 0, players: 0 };
    let players = 0;
    for (const r of this.rooms.values()) {
      const h = r.humans();
      players += h;
      byMode[r.cfg.id].rooms++;
      byMode[r.cfg.id].players += h;
    }
    return { rooms: this.rooms.size, players, maxPlayers: this.maxTotal, byMode };
  }
}

module.exports = { CFG, MODES, modeOf, roundInfo, blastCells, cleanName, dayKey, Room, Lobby };
