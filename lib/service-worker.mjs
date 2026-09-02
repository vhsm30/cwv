// The Worker model. `sw.js` cannot be imported into Node (a top-level self.addEventListener
// throws), so this is the one parser of its source: the Shell, the cache name and its Generation,
// the events it handles, and whether it does either of the two things that would make a Run
// reload its page or measure a Worker-served one. The Performance Contract reads these values;
// nothing else in the repository should look at the Worker's bytes.

import { readFile } from 'node:fs/promises';

const STRING = /'([^'\\]*)'|"([^"\\]*)"/g;
const strings = (text) => [...text.matchAll(STRING)].map((m) => m[1] ?? m[2]);

function closingBrace(text, open) {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '{') depth += 1;
    if (text[at] === '}' && (depth -= 1) === 0) return at;
  }
  return text.length;
}

// The span of the body of the handler registered for one event, or null when there is none.
function handlerBody(source, event) {
  const at = source.search(new RegExp('addEventListener\\(\\s*[\'"]' + event + '[\'"]'));
  if (at === -1) return null;
  const start = source.indexOf('{', at);
  return { start, end: closingBrace(source, start) };
}

// The Generation a script's filename carries (app.v2.min.js -> 2), or null when it carries none.
export function scriptGeneration(url) {
  const match = /\.v(\d+)\.min\.js$/.exec(url ?? '');
  return match ? Number(match[1]) : null;
}

export async function loadServiceWorker(url) {
  const source = await readFile(url, 'utf8');
  const shell = /\bSHELL\s*=\s*\[([^\]]*)\]/.exec(source);
  const cache = /\bCACHE\s*=\s*('[^']*'|"[^"]*")/.exec(source);
  const cacheName = cache ? strings(cache[1])[0] : null;
  const generation = /v(\d+)$/.exec(cacheName ?? '');
  const message = handlerBody(source, 'message');
  const skipsWaiting = [...source.matchAll(/\bskipWaiting\s*\(/g)].map((m) => m.index);
  return {
    source,
    shell: shell ? strings(shell[1]) : [],
    cacheName,
    generation: generation ? Number(generation[1]) : null,
    handlers: [...source.matchAll(/addEventListener\(\s*['"](\w+)['"]/g)].map((m) => m[1]),
    claimsClients: /\bclients\.claim\s*\(/.test(source),
    // skipWaiting() belongs only to the message handler, where the Notice asks for it.
    skipsWaitingAtInstall: skipsWaiting.some((at) => !message || at < message.start || at > message.end),
  };
}
