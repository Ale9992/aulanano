// Client CDP (Chrome DevTools Protocol) minimale su WebSocket, senza dipendenze.
import http from 'node:http';
import crypto from 'node:crypto';

export class CDP {
  constructor() { this.id = 0; this.pending = new Map(); this.buf = Buffer.alloc(0); this.frag = null; }
  connect(wsUrl) {
    const u = new URL(wsUrl);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: u.hostname, port: u.port, path: u.pathname,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
      });
      req.on('upgrade', (_res, sock, head) => {
        this.sock = sock; this.buf = head;
        sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
        sock.on('close', () => { for (const p of this.pending.values()) p.rej(new Error('CDP chiuso')); this.onclose?.(); });
        sock.on('error', () => {});
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }
  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      this.buf = b.subarray(off + len);
      if (op === 0x8) { this.sock.end(); return; }
      if (op === 0x9) { this.frame(0xA, payload); continue; }
      if (op === 0x0 || op === 0x1 || op === 0x2) {
        this.frag = op === 0x0 ? Buffer.concat([this.frag || Buffer.alloc(0), payload]) : payload;
        if (fin) { const msg = JSON.parse(this.frag.toString('utf8')); this.frag = null; this.onmsg(msg); }
      }
    }
  }
  frame(op, data) {
    const len = data.length;
    let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = 0x80 | len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); }
    h[0] = 0x80 | op;
    const mask = crypto.randomBytes(4), p = Buffer.from(data);
    for (let i = 0; i < p.length; i++) p[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([h, mask, p]));
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.frame(0x1, Buffer.from(JSON.stringify({ id, method, params })));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  onmsg(m) {
    if (m.id) {
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      if (m.error) p?.rej(new Error(m.error.message)); else p?.res(m.result);
    } else this.onevent?.(m);
  }
}
