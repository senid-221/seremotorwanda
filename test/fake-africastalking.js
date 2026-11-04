/* A tiny in-memory stand-in for Africa's Talking's /version1/messaging.

   It answers in the shape the real gateway answers: HTTP 201 with an SMSMessageData body whose
   Recipients entry carries a numeric statusCode beside the status word and a messageId. It also
   reproduces the two refusals that made the live failure undiagnosable — the plain-text 401 a bad
   API key gets (not JSON at all) and the Rejected recipient an unregistered sender ID gets — so the
   adapter can be gated against what the provider really says without a key, credit or the network. */
import http from 'node:http';

export const AT_TEST_KEY = 'scratch-africastalking-key';
export const AT_TEST_USER = 'scratch-user';
export const AT_TEST_SENDER = 'SERE';

const body = (statusCode, message, recipients) => JSON.stringify({
  SMSMessageData: { Message: message, ErrorCode: statusCode === 101 ? 0 : statusCode, Recipients: recipients },
});

export async function startFakeAfricastalking() {
  const calls = [];
  let mode = 'ok';

  const server = http.createServer((req, res) => {
    const send = (status, payload, type = 'application/json') => {
      res.statusCode = status;
      res.setHeader('Content-Type', type);
      res.end(payload);
    };

    if (req.url.startsWith('/__mode')) {
      mode = new URL(req.url, 'http://localhost').searchParams.get('mode') || 'ok';
      send(200, JSON.stringify({ mode }));
      return undefined;
    }

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(raw).entries());
      calls.push({ key: req.headers.apikey || '', form });

      if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== '/version1/messaging') {
        send(404, body(404, 'no such endpoint', []));
        return;
      }
      if (req.headers.apikey !== AT_TEST_KEY || form.username !== AT_TEST_USER) {
        send(401, 'The supplied authentication is invalid', 'text/plain; charset=UTF-8');
        return;
      }
      if (!form.to) {
        send(400, body(400, 'Missing parameter to', []));
        return;
      }
      if (mode === 'down') {
        send(500, 'Gateway timeout', 'text/plain; charset=UTF-8');
        return;
      }
      if (mode === 'gibberish') {
        send(201, '<html>the gateway is talking HTML</html>', 'text/html; charset=UTF-8');
        return;
      }
      if (mode === 'empty') {
        send(201, body(0, 'Nothing queued', []));
        return;
      }
      if (mode === 'wordless') {
        send(201, body(101, 'Sent to 1/1 Total Cost: RWF 3.0000', [{
          statusCode: 101,
          number: form.to,
          cost: 'RWF 3.0000',
          messageId: `ATXid_scratch_${calls.length}`,
        }]));
        return;
      }
      if (mode === 'rejected') {
        send(201, body(0, 'Sent to 0/1 Total Cost: RWF 0.0000', [{
          statusCode: 400,
          number: form.to,
          status: 'Rejected',
          cost: 'RWF 0.0000',
          errorMessage: `Invalid sender id ${form.from || '(none)'} — rejected by gateway`,
          messageId: null,
        }]));
        return;
      }

      /* The accepted answer, verbatim in shape: a numeric code and a word, and the message id the
         dispute is opened with. */
      send(201, body(101, 'Sent to 1/1 Total Cost: RWF 3.0000', [{
        statusCode: 101,
        number: form.to,
        status: 'Success',
        cost: 'RWF 3.0000',
        messageId: `ATXid_scratch_${calls.length}`,
      }]));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    messagingUrl: `${base}/version1/messaging`,
    calls,
    setMode: async (next) => { await fetch(`${base}/__mode?mode=${next}`); },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
