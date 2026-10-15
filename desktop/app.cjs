// AulaNano - launcher desktop (sperimentale).
// Installa se stesso (Windows), trova o installa Google Chrome, prepara un profilo
// dedicato con i flag di Gemini Nano e apre l'interfaccia come finestra app.
// Funziona anche su macOS/Linux per sviluppo. Nessuna dipendenza esterna.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');

const APP = 'AulaNano';
const APP_NAME = 'AulaNano';
const VERSION = '1.0.0';
const PORT = 47811;
const MIN_FREE_GB = 22;
const IS_WIN = process.platform === 'win32';
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), IS_WIN ? 'AppData/Local' : '.local/share');
const CONFIG_DIR = path.join(LOCALAPPDATA, APP);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const INSTALL_DIR = path.join(LOCALAPPDATA, 'Programs', APP);
const EXE_NAME = `${APP}.exe`;

const FLAGS = [
  'optimization-guide-on-device-model@2', // Enabled BypassPerfRequirement
  'prompt-api-for-gemini-nano@1',
  'prompt-api-for-gemini-nano-multimodal-input@1',
  'summarization-api-for-gemini-nano@1',
  'writer-api-for-gemini-nano@1',
  'rewriter-api-for-gemini-nano@1',
  'proofreader-api-for-gemini-nano@1',
];
const CPU_FEATURES = '--enable-features=OnDeviceModelForceCpuBackend,OnDeviceModelCpuBackend';

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- risorse (incluse nell'exe o lette da disco in sviluppo) ---------------- */
function asset(name) {
  try {
    const sea = require('node:sea');
    if (sea.isSea()) return sea.getAsset(name, 'utf8');
  } catch {}
  return fs.readFileSync(path.join(__dirname, '..', 'web', name), 'utf8');
}
const isPackaged = () => { try { return require('node:sea').isSea(); } catch { return false; } };

/* ---------------- configurazione ---------------- */
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/* ---------------- spazio disco ---------------- */
function freeGB(dir) {
  try { const s = fs.statfsSync(dir); return (s.bavail * s.bsize) / 2 ** 30; } catch { return 0; }
}
function chooseDataDir(cfg) {
  if (cfg.dataDir) return cfg.dataDir;
  const candidates = [CONFIG_DIR];
  if (IS_WIN) for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${l}:\\`;
    if (fs.existsSync(root)) candidates.push(path.join(root, APP));
  }
  const scored = candidates.map(dir => ({ dir, free: freeGB(path.parse(dir).root === dir ? dir : existingAncestor(dir)) }));
  // Preferisci la cartella utente se ha spazio, altrimenti il disco con più spazio libero
  const preferred = scored[0].free >= MIN_FREE_GB + 3 ? scored[0] : scored.sort((a, b) => b.free - a.free)[0];
  return preferred.dir;
}
function existingAncestor(p) {
  while (!fs.existsSync(p)) { const up = path.dirname(p); if (up === p) break; p = up; }
  return p;
}

/* ---------------- installazione (solo Windows, exe pacchettizzato) ---------------- */
function ps(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true });
}
const psq = s => `'${String(s).replace(/'/g, "''")}'`;
function shortcutPaths() {
  const appData = process.env.APPDATA || '';
  const desktop = path.join(os.homedir(), 'Desktop');
  return [
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`),
    path.join(desktop, `${APP_NAME}.lnk`),
  ];
}
const UNINSTALL_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP}`;

function install() {
  const target = path.join(INSTALL_DIR, EXE_NAME);
  log(`Installazione in ${INSTALL_DIR}`);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.copyFileSync(process.execPath, target);
  for (const lnk of shortcutPaths()) {
    fs.mkdirSync(path.dirname(lnk), { recursive: true });
    ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psq(lnk)}); $s.TargetPath=${psq(target)}; $s.WorkingDirectory=${psq(INSTALL_DIR)}; $s.Description=${psq(APP_NAME)}; $s.Save()`);
  }
  const reg = (name, type, value) => spawnSync('reg.exe', ['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', value, '/f'], { windowsHide: true });
  reg('DisplayName', 'REG_SZ', APP_NAME);
  reg('DisplayVersion', 'REG_SZ', VERSION);
  reg('Publisher', 'REG_SZ', APP_NAME);
  reg('InstallLocation', 'REG_SZ', INSTALL_DIR);
  reg('DisplayIcon', 'REG_SZ', target);
  reg('UninstallString', 'REG_SZ', `"${target}" --uninstall`);
  reg('NoModify', 'REG_DWORD', '1');
  reg('NoRepair', 'REG_DWORD', '1');
  log(`Installato: trovi «${APP_NAME}» nel menu Start e sul Desktop.`);
  spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
}

async function uninstall() {
  console.log(`\nDisinstallazione di ${APP_NAME}.`);
  const cfg = loadConfig();
  await killChromeProfile(cfg);
  for (const lnk of shortcutPaths()) fs.rmSync(lnk, { force: true });
  spawnSync('reg.exe', ['delete', UNINSTALL_KEY, '/f'], { windowsHide: true });
  for (const dir of [cfg.dataDir, CONFIG_DIR].filter(Boolean)) {
    log(`Rimuovo ${dir} (profilo Chrome dedicato e modello Gemini Nano)`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // L'exe in uso non può cancellarsi da solo: lo fa cmd dopo che siamo usciti
  spawn('cmd.exe', ['/c', `ping 127.0.0.1 -n 3 >nul & rmdir /s /q "${INSTALL_DIR}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log('Disinstallazione completata. Google Chrome non è stato rimosso.');
  await sleep(2500);
}

/* ---------------- Google Chrome ---------------- */
function findChrome() {
  const c = [];
  if (IS_WIN) {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean))
      c.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const hive of ['HKCU', 'HKLM']) {
      const r = spawnSync('reg.exe', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, '/ve'], { encoding: 'utf8', windowsHide: true });
      const m = r.stdout && r.stdout.match(/REG_SZ\s+(.+chrome\.exe)/i);
      if (m) c.push(m[1].trim().replace(/^"|"$/g, ''));
    }
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  } else {
    c.push('/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
  }
  if (process.env.GN_CHROME) c.unshift(process.env.GN_CHROME);
  return c.find(p => p && fs.existsSync(p)) || null;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res(a.trim().toLowerCase()); }));
}
async function installChrome() {
  if (!IS_WIN) throw new Error('Installa Google Chrome da https://www.google.com/chrome e riavvia.');
  console.log('\nGoogle Chrome non è installato: AulaNano usa il modello Gemini Nano integrato in Chrome.');
  console.log('Posso scaricarlo e installarlo dal sito ufficiale di Google. Installandolo accetti i');
  console.log('Termini di servizio di Google Chrome: https://www.google.com/chrome/terms\n');
  const a = await ask('Vuoi installare Google Chrome adesso? [s/N] ');
  if (a !== 's' && a !== 'si' && a !== 'sì' && a !== 'y') {
    spawn('cmd.exe', ['/c', 'start', '', 'https://www.google.com/chrome/'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    throw new Error('Installa Google Chrome dalla pagina che si è aperta, poi riavvia AulaNano.');
  }
  const url = 'https://dl.google.com/chrome/install/latest/chrome_installer.exe';
  const file = path.join(os.tmpdir(), 'chrome_installer.exe');
  log('Google Chrome non trovato: scarico l\'installer ufficiale da dl.google.com…');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download di Chrome fallito (HTTP ${res.status})`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  log('Installo Google Chrome (può richiedere qualche minuto)…');
  spawnSync(file, ['/silent', '/install'], { windowsHide: true });
  for (let i = 0; i < 120; i++) {
    const p = findChrome();
    if (p) { log('Google Chrome installato.'); return p; }
    await sleep(5000);
  }
  throw new Error('Installazione di Chrome non completata. Installalo a mano da https://www.google.com/chrome');
}

function chromeVersion(exe) {
  if (IS_WIN) {
    const r = ps(`(Get-Item ${psq(exe)}).VersionInfo.ProductVersion`);
    return (r.stdout || '').trim();
  }
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  return (r.stdout || '').replace(/[^\d.]/g, '');
}

function prepareProfile(profile) {
  fs.mkdirSync(profile, { recursive: true });
  const f = path.join(profile, 'Local State');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  st.browser = st.browser || {};
  const cur = (st.browser.enabled_labs_experiments || []).filter(x => !FLAGS.some(fl => fl.split('@')[0] === x.split('@')[0]));
  st.browser.enabled_labs_experiments = [...cur, ...FLAGS];
  fs.writeFileSync(f, JSON.stringify(st));
}

let chromeProc = null, relaunching = false;
function launchChrome(state) {
  const profile = path.join(state.dataDir, 'profile');
  prepareProfile(profile);
  const args = [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    `--app=http://127.0.0.1:${state.port}/`, '--window-size=1200,900',
  ];
  if (state.cfg.forceCpu) args.push(CPU_FEATURES);
  log(`Apro ${APP_NAME}${state.cfg.forceCpu ? ' (modalità CPU)' : ''}…`);
  chromeProc = spawn(state.chrome, args, { stdio: 'ignore' });
  chromeProc.on('exit', () => {
    if (relaunching) return;
    log('Finestra chiusa. Arrivederci!');
    process.exit(0);
  });
}
async function killChromeProfile(cfg) {
  if (chromeProc) { relaunching = true; chromeProc.kill(); await sleep(1500); }
  // Chrome può lasciare processi figli: chiude quelli che usano il nostro profilo
  if (IS_WIN && cfg.dataDir) {
    ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like ${psq('*' + path.join(cfg.dataDir, 'profile') + '*')} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  }
}
async function relaunch(state) {
  await killChromeProfile(state.cfg);
  await sleep(1500);
  relaunching = false;
  launchChrome(state);
}

/* ---------------- server locale ---------------- */
function startServer(state) {
  const indexHtml = asset('index.html');
  const studioHtml = asset('studio.html');
  const server = http.createServer(async (req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    try {
      if (req.method === 'GET' && req.url === '/') {
        const inject = `<script>window.__APP=${JSON.stringify(info(state))}</script>\n<script>`;
        return send(200, 'text/html; charset=utf-8', indexHtml.replace('<script>', inject));
      }
      if (req.method === 'GET' && (req.url === '/studio' || req.url === '/studio.html')) return send(200, 'text/html; charset=utf-8', studioHtml);
      if (req.method === 'GET' && req.url === '/api/info') return send(200, 'application/json', JSON.stringify(info(state)));
      if (req.method === 'POST' && req.url === '/api/cpu-mode') {
        state.cfg.forceCpu = true; saveConfig(state.cfg);
        log('Passo alla modalità CPU e riavvio la finestra…');
        send(200, 'application/json', '{"ok":true}');
        return relaunch(state);
      }
      if (req.method === 'POST' && req.url === '/api/gpu-mode') {
        state.cfg.forceCpu = false; saveConfig(state.cfg);
        send(200, 'application/json', '{"ok":true}');
        return relaunch(state);
      }
      if (req.method === 'POST' && req.url === '/api/open') { launchChrome(state); return send(200, 'application/json', '{"ok":true}'); }
      send(404, 'text/plain', 'not found');
    } catch (e) { send(500, 'text/plain', String(e)); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(state.port, '127.0.0.1', () => resolve(server));
  });
}
function info(state) {
  return {
    version: VERSION, platform: `${os.type()} ${os.release()}`,
    ramGB: Math.round(os.totalmem() / 2 ** 30), cores: os.cpus().length,
    dataDir: state.dataDir, freeGB: Math.round(freeGB(existingAncestor(state.dataDir))), minFreeGB: MIN_FREE_GB,
    chrome: state.chromeVersion, forceCpu: !!state.cfg.forceCpu,
  };
}

/* ---------------- main ---------------- */
async function main() {
  process.title = APP_NAME;
  console.log(`${APP_NAME} ${VERSION}\nQuesta finestra mostra l'avanzamento: lasciala aperta mentre usi l'app.\n`);
  if (process.argv.includes('--uninstall')) return uninstall();

  // Primo avvio dell'exe scaricato: installa e rilancia la copia installata
  if (IS_WIN && isPackaged() && path.dirname(process.execPath).toLowerCase() !== INSTALL_DIR.toLowerCase() && !process.argv.includes('--portable')) {
    return install();
  }

  // Già in esecuzione? Apri solo una nuova finestra
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/open`, { method: 'POST' });
    if (r.ok) { log('Già in esecuzione: apro la finestra.'); return; }
  } catch {}

  const cfg = loadConfig();
  const state = { cfg, port: PORT };
  state.dataDir = chooseDataDir(cfg);
  if (!cfg.dataDir) { cfg.dataDir = state.dataDir; saveConfig(cfg); }
  fs.mkdirSync(state.dataDir, { recursive: true });
  const free = freeGB(state.dataDir);
  log(`Dati e modello in: ${state.dataDir} (${Math.round(free)} GB liberi)`);
  if (free < MIN_FREE_GB) log(`ATTENZIONE: Gemini Nano richiede almeno ${MIN_FREE_GB} GB liberi su questo disco.`);
  log(`Hardware: ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.cpus().length} core`);

  state.chrome = findChrome() || await installChrome();
  state.chromeVersion = chromeVersion(state.chrome);
  log(`Google Chrome ${state.chromeVersion}: ${state.chrome}`);

  await startServer(state);
  launchChrome(state);
}

main().catch(async e => {
  console.error('\nERRORE:', e.message);
  console.error('Premi Ctrl+C per chiudere.');
  await sleep(10 * 60 * 1000);
  process.exit(1);
});
