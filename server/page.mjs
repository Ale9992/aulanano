// Uso: node page.mjs <url chrome://...> [espressione JS da eseguire dopo il caricamento]
// Apre la pagina nel Chrome headless del bridge e ne stampa il testo (anche dentro shadow DOM).
import { CDP } from './cdp.mjs';

const [url, js] = process.argv.slice(2);
const port = +(process.env.GN_CDP_PORT || 9222);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' })).json();
const c = new CDP();
await c.connect(t.webSocketDebuggerUrl);
await sleep(3000);
if (js) {
  const r = await c.send('Runtime.evaluate', { expression: js, userGesture: true, awaitPromise: true, returnByValue: true });
  console.log('JS =>', JSON.stringify(r.result?.value ?? r.exceptionDetails?.exception?.description));
  await sleep(3000);
}
const { result } = await c.send('Runtime.evaluate', { returnByValue: true, expression: `(() => { const out = [];
  const walk = n => { if (n.shadowRoot) walk(n.shadowRoot);
    for (const ch of n.childNodes) { if (ch.nodeType === 3) { const s = ch.textContent.trim(); if (s) out.push(s); } else walk(ch); } };
  walk(document.body); return out.join(' | '); })()` });
console.log(result.value);
await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
process.exit(0);
