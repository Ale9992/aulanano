// Caricato nel browser del client: sostituisce le API AI integrate con proxy
// che eseguono tutto sul server attraverso il bridge.
(() => {
  const R = window.__REMOTE || { apis: [] };
  let n = 0;
  const nid = () => 'c' + Date.now().toString(36) + (++n);

  async function call(req, onEvent) {
    req.id ||= nid();
    const r = await fetch('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    if (!r.ok) throw new DOMException(await r.text(), 'NetworkError');
    const rd = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'result') return ev.data;
        if (ev.type === 'error') throw new DOMException(ev.data.message, ev.data.name);
        onEvent?.(ev);
      }
    }
    throw new DOMException('Connessione con il server interrotta', 'NetworkError');
  }

  const blobToURL = b => new Promise((res, rej) => {
    const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b);
  });
  async function ser(x) {
    if (x instanceof Blob) return { __blob: await blobToURL(x) };
    if (Array.isArray(x)) return Promise.all(x.map(ser));
    if (x && typeof x === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(x)) {
        if (typeof v === 'function' || v instanceof AbortSignal) continue;
        o[k] = await ser(v);
      }
      return o;
    }
    return x;
  }
  function linkSignal(signal, id) {
    if (!signal) return;
    if (signal.aborted) throw signal.reason ?? new DOMException('Interrotto', 'AbortError');
    signal.addEventListener('abort', () => call({ op: 'abort', target: id }).catch(() => {}), { once: true });
  }

  class RemoteInstance {
    constructor(inst, props) { this._inst = inst; Object.assign(this, props); }
    async _once(method, input, options = {}) {
      const id = nid(); linkSignal(options.signal, id);
      const r = await call({ id, op: 'call', inst: this._inst, method, args: [await ser(input)], options: await ser(options), stream: false });
      Object.assign(this, r.props || {});
      return r.value;
    }
    _stream(method, input, options = {}) {
      const self = this, id = nid();
      return new ReadableStream({
        async start(ctrl) {
          try {
            linkSignal(options.signal, id);
            const r = await call({ id, op: 'call', inst: self._inst, method, args: [await ser(input)], options: await ser(options), stream: true },
              ev => { if (ev.type === 'chunk') ctrl.enqueue(ev.data); });
            Object.assign(self, r?.props || {});
            ctrl.close();
          } catch (e) { ctrl.error(e); }
        },
        cancel() { call({ op: 'abort', target: id }).catch(() => {}); },
      });
    }
    destroy() { call({ op: 'destroy', inst: this._inst }).catch(() => {}); }
  }
  const ONCE = ['prompt', 'append', 'measureInputUsage', 'measureContextUsage', 'summarize', 'translate', 'detect', 'write', 'rewrite', 'proofread'];
  const STREAM = ['promptStreaming', 'summarizeStreaming', 'translateStreaming', 'writeStreaming', 'rewriteStreaming'];
  for (const m of ONCE) RemoteInstance.prototype[m] = function (input, options) { return this._once(m, input, options); };
  for (const m of STREAM) RemoteInstance.prototype[m] = function (input, options) { return this._stream(m, input, options); };

  for (const name of R.apis) {
    window[name] = {
      async availability(opts = {}) { return call({ op: 'availability', api: name, opts: await ser(opts) }); },
      async params() { return call({ op: 'params' }); },
      async create(opts = {}) {
        const mon = new EventTarget();
        opts.monitor?.(mon);
        const id = nid(); linkSignal(opts.signal, id);
        const r = await call({ id, op: 'create', api: name, opts: await ser(opts) }, ev => {
          if (ev.type !== 'progress') return;
          const e = new Event('downloadprogress'); e.loaded = ev.data.loaded; e.total = ev.data.total;
          mon.dispatchEvent(e);
        });
        return new RemoteInstance(r.inst, r.props);
      },
    };
  }
  // Le API native del client non devono essere usate per errore
  for (const name of ['LanguageModel', 'Summarizer', 'Translator', 'LanguageDetector', 'Writer', 'Rewriter', 'Proofreader'])
    if (!R.apis.includes(name)) try { delete window[name]; } catch {}

  document.addEventListener('DOMContentLoaded', () => {
    const p = document.querySelector('header p');
    if (p) p.innerHTML = `<strong>Modalità remota:</strong> Gemini Nano gira su ${R.host} (${R.info?.ua?.match(/Chrome\/[\d.]+/)?.[0] || 'Chrome'} headless). ${R.apis.length ? '' : '⚠️ Bridge raggiunto ma Chrome sul server non risponde ancora: ricarica tra qualche secondo.'}`;
  });
})();
