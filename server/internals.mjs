// Stampa il contenuto di chrome://on-device-internals del Chrome headless del bridge.
import { CDP } from './cdp.mjs';

const port = +(process.env.GN_CDP_PORT || 9222);
const t = await (await fetch(`http://127.0.0.1:${port}/json/new?chrome://chrome-urls`, { method: 'PUT' })).json();
const c = new CDP();
await c.connect(t.webSocketDebuggerUrl);
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);
// Abilita le pagine di debug interne (equivale al pulsante in chrome://chrome-urls)
await c.send('Runtime.evaluate', { userGesture: true, expression: `(() => {
  const find = n => { for (const el of n.querySelectorAll('*')) { if (/^(CR-BUTTON|BUTTON)$/.test(el.tagName) && /enable/i.test(el.textContent)) return el;
    if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; } } };
  find(document)?.click(); })()` });
await sleep(500);
await c.send('Page.navigate', { url: 'chrome://on-device-internals' });
await sleep(4000);
// La pagina usa shadow DOM: raccoglie il testo attraversando le shadow root
const expr = `(() => { const out = []; const walk = n => { if (n.shadowRoot) walk(n.shadowRoot);
  for (const ch of n.childNodes) { if (ch.nodeType === 3) { const s = ch.textContent.trim(); if (s) out.push(s); } else walk(ch); } };
  walk(document.body); return out.join('\\n'); })()`;
const { result } = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(result.value);
await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
process.exit(0);
