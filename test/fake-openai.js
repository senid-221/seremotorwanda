/* A stand-in for an OpenAI-compatible chat endpoint.

   The contract is what matters, not the model: POST <base>/v1/chat/completions with a Bearer key, a
   JSON body carrying model + messages, and a reply whose choices[0].message.content is the text. The
   real assistant code is unchanged by which server answers, so pointing AI_BASE_URL here exercises the
   same network path, the same parsing and the same refusals a live key would. */
import http from 'node:http';

export const AI_TEST_KEY = 'scratch-openai-key';
export const AI_TEST_MODEL = 'gpt-4o-test';

const REPLY = {
  ok: JSON.stringify({
    ask: 'Muraho! Ni SEREMOTO, nakozwe na IRAGUHA Vincent. Intara yawe?',
    note: '',
  }),
  answer: JSON.stringify({
    ask: 'Akarere kawe?',
    note: 'Hari abamotari 2 bari hafi muri 2 km.',
  }),
  prose: 'Muri make, mbese uri hehe?',
  long: JSON.stringify({ ask: 'I'.repeat(400), note: '' }),
  hostile: JSON.stringify({ ask: 'Uringe https://example.com <b>kora</b>', note: '' }),
};

export async function startFakeOpenai() {
  const calls = [];
  let mode = 'ok';
  let key = AI_TEST_KEY;

  const server = await new Promise((resolve) => {
    const made = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/__mode') {
          mode = url.searchParams.get('mode') || 'ok';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ mode }));
          return;
        }
        if (url.pathname === '/__key') {
          key = url.searchParams.get('key') ?? key;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ set: url.searchParams.get('key') !== null }));
          return;
        }
        if (url.pathname === '/__calls') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(calls));
          return;
        }
        if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }));
          return;
        }
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        const auth = String(req.headers.authorization || '');
        calls.push({ auth, body, path: url.pathname });
        if (auth !== `Bearer ${key}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
          return;
        }
        if (mode === 'down') {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('The model service is overloaded');
          return;
        }
        if (mode === 'html') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html>gateway timeout</html>');
          return;
        }
        if (mode === 'nochoices') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'chatcmpl-scratch' }));
          return;
        }
        const content = REPLY[mode] ?? REPLY.ok;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-scratch',
          model: body?.model || AI_TEST_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content } }],
        }));
      });
    });
    made.listen(0, '127.0.0.1', () => resolve(made));
  });

  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}/v1`,
    calls,
    mode: () => mode,
    async setMode(next) {
      await fetch(`http://127.0.0.1:${address.port}/__mode?mode=${encodeURIComponent(next)}`, { signal: AbortSignal.timeout(4000) });
      mode = next;
    },
    async setKey(next) {
      await fetch(`http://127.0.0.1:${address.port}/__key?key=${encodeURIComponent(next)}`, { signal: AbortSignal.timeout(4000) });
      key = next;
    },
    lastCall: () => calls[calls.length - 1] || null,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
