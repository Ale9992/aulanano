// AulaNano - bridge: avvia Chrome headless su questa macchina, esegue le API AI
// integrate (Gemini Nano) in una pagina "worker" e le espone via HTTP su 127.0.0.1.
// Pensato per un server personale raggiungibile tramite tunnel SSH.
// Nessuna dipendenza: Node >= 18. Configurazione tramite variabili d'ambiente (vedi .env.example).
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CDP } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GN_BASE || path.join(HERE, '..', 'data'); // Chrome estratto + profilo (~5 GB)
const PORT = +(process.env.GN_PORT || 8787);
const CDP_PORT = +(process.env.GN_CDP_PORT || 9222);
const CHROME = process.env.GN_CHROME
  || [`${BASE}/chrome/opt/google/chrome/chrome`, '/opt/google/chrome/chrome'].find(p => fs.existsSync(p))
  || `${BASE}/chrome/opt/google/chrome/chrome`;
const PROFILE = `${BASE}/profile`;
const WEB = process.env.GN_WEB || path.join(HERE, '..', 'web');
const STUDIO = `${WEB}/studio.html`;
const CHAT = `${WEB}/index.html`;
const LABEL = process.env.GN_LABEL || 'un server della tua rete'; // come viene descritto il server nell'interfaccia

// Equivalente di chrome://flags (nome@indice-opzione). I nomi sconosciuti vengono ignorati da Chrome.
const FLAGS = [
  'optimization-guide-on-device-model@2', // Enabled BypassPerfRequirement
  'prompt-api-for-gemini-nano@1',
  'prompt-api-for-gemini-nano-multimodal-input@1',
  'prompt-api@1',
  'prompt-api-multimodal-input@1',
  'summarization-api-for-gemini-nano@1',
  'writer-api-for-gemini-nano@1',
  'rewriter-api-for-gemini-nano@1',
  'proofreader-api-for-gemini-nano@1',
];

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------- profilo + Chrome ---------------- */
function prepareProfile() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const f = path.join(PROFILE, 'Local State');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  st.browser ??= {};
  const cur = (st.browser.enabled_labs_experiments || []).filter(
    x => !FLAGS.some(fl => fl.split('@')[0] === x.split('@')[0]));
  st.browser.enabled_labs_experiments = [...cur, ...FLAGS];
  fs.writeFileSync(f, JSON.stringify(st));
}

let chrome = null;
function startChrome() {
  prepareProfile();
  const args = [
    '--headless', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    // Chrome headless non usa la GPU: forza la variante CPU di Gemini Nano (nano_v3_cpu)
    '--enable-features=OnDeviceModelForceCpuBackend,OnDeviceModelCpuBackend,OnDeviceModelCpuAudioInput,OnDeviceModelCpuImageInput',
    ...(process.env.GN_CHROME_ARGS || '').split(' ').filter(Boolean),
    `http://127.0.0.1:${PORT}/worker`,
  ];
  log('avvio Chrome', CHROME);
  chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', d => {
    const s = d.toString();
    if (process.env.GN_CHROME_ARGS || /error|on.?device|optimization/i.test(s)) process.stderr.write(s);
  });
  chrome.on('exit', code => {
    log('Chrome terminato, codice', code, '- riavvio tra 3 s');
    cdp = null; chrome = null;
    setTimeout(() => { startChrome(); connectLoop(); }, 3000);
  });
}

/* ---------------- collegamento alla pagina worker ---------------- */
let cdp = null;
const listeners = new Map(); // id chiamata -> fn(evento)

async function connectLoop() {
  for (let i = 0; i < 60 && !cdp; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const t = list.find(x => x.type === 'page' && x.url.includes('/worker'));
      if (t) {
        const c = new CDP();
        await c.connect(t.webSocketDebuggerUrl);
        c.onevent = ev => {
          if (ev.method !== 'Runtime.bindingCalled' || ev.params.name !== '__emit') return;
          const msg = JSON.parse(ev.params.payload);
          listeners.get(msg.id)?.(msg);
          if (msg.type === 'result' || msg.type === 'error') listeners.delete(msg.id);
        };
        c.onclose = () => { if (cdp === c) cdp = null; };
        await c.send('Runtime.enable');
        await c.send('Runtime.addBinding', { name: '__emit' });
        await c.send('Page.reload'); // la binding è presente dal primo script
        await new Promise(r => setTimeout(r, 1500));
        cdp = c;
        log('collegato al worker');
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!cdp) log('impossibile collegarsi al worker');
}

function callWorker(req, onEvent) {
  if (!cdp) return Promise.reject(Object.assign(new Error('Chrome sul server non è ancora pronto'), { name: 'InvalidStateError' }));
  req.id ||= crypto.randomUUID();
  return new Promise((resolve, reject) => {
    listeners.set(req.id, msg => {
      if (msg.type === 'result') resolve(msg.data);
      else if (msg.type === 'error') reject(Object.assign(new Error(msg.data.message), { name: msg.data.name }));
      else onEvent?.(msg);
    });
    // userGesture: true fornisce l'attivazione utente richiesta per scaricare il modello
    cdp.send('Runtime.evaluate', { expression: `void __handle(${JSON.stringify(req)})`, userGesture: true })
      .catch(e => { listeners.delete(req.id); reject(e); });
  });
}

/* ---------------- server HTTP ---------------- */
const readBody = req => new Promise((res, rej) => {
  const parts = []; req.on('data', d => parts.push(d)); req.on('end', () => res(Buffer.concat(parts).toString('utf8'))); req.on('error', rej);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/worker') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(`${HERE}/worker.html`));
    }
    if (req.method === 'GET' && url.pathname === '/shim.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(`${HERE}/shim.js`));
    }
    const PAGES = { '/': CHAT, '/index.html': CHAT, '/studio': STUDIO, '/studio.html': STUDIO };
    if (req.method === 'GET' && PAGES[url.pathname]) {
      let apis = [], info = {};
      try { apis = await callWorker({ op: 'apis' }); info = await callWorker({ op: 'info' }); } catch {}
      const inject = `<script>window.__REMOTE=${JSON.stringify({ host: LABEL, apis, info })}</script><script src="/shim.js"></script>\n<script>`;
      const html = fs.readFileSync(PAGES[url.pathname], 'utf8').replace(/<script>/, inject);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ chrome: !!chrome, worker: !!cdp }));
    }
    if (req.method === 'POST' && url.pathname === '/api/call') {
      const call = JSON.parse(await readBody(req));
      call.id ||= crypto.randomUUID();
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      const line = o => res.write(JSON.stringify(o) + '\n');
      res.on('close', () => { // il client si è disconnesso a metà: interrompi
        if (!res.writableEnded && cdp) callWorker({ op: 'abort', target: call.id }).catch(() => {});
      });
      try { line({ type: 'result', data: await callWorker(call, line) }); }
      catch (e) { line({ type: 'error', data: { name: e.name || 'Error', message: e.message } }); }
      return res.end();
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    log('errore', e);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`bridge su http://127.0.0.1:${PORT}`);
  startChrome();
  connectLoop();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { chrome?.removeAllListeners('exit'); chrome?.kill(); process.exit(0); });
