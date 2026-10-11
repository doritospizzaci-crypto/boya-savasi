'use strict';

// Oyunun tüm kuralları sunucuda çalışır. İstemci sadece "şu hücreye dokundum" der;
// tur süresi, hız sınırı, bomba hakkı ve skor burada hesaplanır.

const CFG = Object.freeze({
  cols: 12,
  rows: 12,
  play: 60000,
  rest: 8000,
  bombEvery: 6,
  bombMax: 3,
  inks: 12,
  maxPlayers: 12,
});
const N = CFG.cols * CFG.rows;
const CYCLE = CFG.play + CFG.rest;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_NAMES = ['Kaya', 'Deniz'];

// Saniyede 20 boyama, en fazla 30'luk ani yığılma.
const BUCKET_MAX = 30;
const BUCKET_PER_MS = 0.02;

function roundInfo(now) {
  const id = Math.floor(now / CYCLE);
  const t = now - id * CYCLE;
  const playing = t < CFG.play;
  return { id, t, playing, left: playing ? CFG.play - t : CYCLE - t };
}

function blastCells(i) {
  const r = Math.floor(i / CFG.cols);
  const c = i % CFG.cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < CFG.rows && cc >= 0 && cc < CFG.cols) out.push(rr * CFG.cols + cc);
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

class Room {
  constructor(code, isPublic, bots) {
    this.code = code;
    this.isPublic = !!isPublic;
    this.bots = !!bots;
    this.players = new Map();
    this.nextId = 1;
    this.cells = new Int16Array(N).fill(-1);
    this.round = -1;
    this.playing = false;
    this.pending = new Map();
    this.lastPhase = 0;
    this.lastResult = null;
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
    for (let i = 0; i < N; i++) {
      const o = this.cells[i];
      if (o >= 0) s.set(o, (s.get(o) || 0) + 1);
    }
    return s;
  }

  // Tur geçişlerini zamana göre uygular. Her işlemden önce çağrılır.
  sync(now) {
    const info = roundInfo(now);
    if (info.id !== this.round) this._newRound(info);
    else if (this.playing && !info.playing) this._endRound(info);
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
      p.meDirty = true;
    }
    this.broadcast({ t: 'n', r: info.id, pl: info.playing, left: info.left });
  }

  _endRound(info) {
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
    for (let i = 0; i < N; i++) {
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
    if (Number.isInteger(color) && color >= 0 && color < CFG.inks && !used.has(color)) chosen = color;
    if (chosen < 0) {
      for (let c = 0; c < CFG.inks; c++) {
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
      tokens: BUCKET_MAX,
      tokAt: now,
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
    if (this.humans() >= CFG.maxPlayers) return null;
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
    const info = roundInfo(now);
    return {
      t: 'hi',
      id: p.id,
      code: this.code,
      cfg: CFG,
      r: this.round,
      pl: this.playing,
      left: info.left,
      cells: Array.from(this.cells),
      players: this.playerList(),
      b: p.bombs,
      k: p.taps,
      res: this.playing ? null : this.lastResult,
    };
  }

  paint(pid, i, bomb, now) {
    this.sync(now);
    const p = this.players.get(pid);
    if (!p || !this.playing) return false;
    if (!Number.isInteger(i) || i < 0 || i >= N) return false;

    p.tokens = Math.min(BUCKET_MAX, p.tokens + (now - p.tokAt) * BUCKET_PER_MS);
    p.tokAt = now;
    if (p.tokens < 1) return false;
    p.tokens -= 1;

    let list;
    if (bomb && p.bombs > 0) {
      list = blastCells(i);
      p.bombs--;
    } else {
      list = [i];
      p.taps++;
      if (p.taps % CFG.bombEvery === 0 && p.bombs < CFG.bombMax) p.bombs++;
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
    for (const p of this.players.values()) {
      if (!p.bot || now < p.nextAct) continue;
      p.nextAct = now + 250 + Math.random() * 250;
      let target = -1;
      if (Math.random() < 0.65) {
        const owned = [];
        for (let i = 0; i < N; i++) if (this.cells[i] === p.id) owned.push(i);
        if (owned.length) {
          const base = owned[Math.floor(Math.random() * owned.length)];
          const r = Math.floor(base / CFG.cols);
          const c = base % CFG.cols;
          const d = [[-1, 0], [1, 0], [0, -1], [0, 1]][Math.floor(Math.random() * 4)];
          const rr = r + d[0];
          const cc = c + d[1];
          if (rr >= 0 && rr < CFG.rows && cc >= 0 && cc < CFG.cols) target = rr * CFG.cols + cc;
        }
      }
      if (target < 0) target = Math.floor(Math.random() * N);
      this.paint(p.id, target, p.bombs > 0 && Math.random() < 0.25, now);
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
      if (p.meDirty) {
        p.meDirty = false;
        if (p.send) p.send(JSON.stringify({ t: 'm', b: p.bombs, k: p.taps }));
      }
    }
    if (now - this.lastPhase >= 1000) {
      this.lastPhase = now;
      const info = roundInfo(now);
      this.broadcast({ t: 'p', r: this.round, pl: this.playing, left: info.left });
    }
  }
}

class Lobby {
  constructor() {
    this.rooms = new Map();
  }

  _freshCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  // Hızlı oyun: en kalabalık, dolmamış herkese açık odaya gir; yoksa yenisini aç.
  quick() {
    let best = null;
    for (const r of this.rooms.values()) {
      if (!r.isPublic) continue;
      const h = r.humans();
      if (h > 0 && h < CFG.maxPlayers && (!best || h > best.humans())) best = r;
    }
    if (!best) {
      best = new Room(this._freshCode(), true, false);
      this.rooms.set(best.code, best);
    }
    return best;
  }

  // Botlarla oyna: her oyuncuya ayrı, listelenmeyen, botlu bir oda açılır.
  solo() {
    const r = new Room(this._freshCode(), false, true);
    this.rooms.set(r.code, r);
    return r;
  }

  // Özel oda: kod ile girilir, yoksa oluşturulur, hızlı oyunda listelenmez, bot yoktur.
  byCode(code) {
    let r = this.rooms.get(code);
    if (!r) {
      r = new Room(code, false, false);
      this.rooms.set(code, r);
    }
    return r;
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
    let players = 0;
    for (const r of this.rooms.values()) players += r.humans();
    return { rooms: this.rooms.size, players };
  }
}

module.exports = { CFG, N, CYCLE, roundInfo, blastCells, cleanName, Room, Lobby };
