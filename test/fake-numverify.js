/* A tiny in-memory numverify endpoint for the test suites. It answers the same JSON shape the real
   api.apilayer.com/numverify service does, so the phone screening can be exercised end to end — pass,
   fail, outage and an unreadable body — without a key, a quota or the network. */
import http from 'node:http';

export const NUMVERIFY_TEST_KEY = 'scratch-numverify-key';

export async function startFakeNumverify() {
  const calls = [];
  let mode = 'ok';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/__mode') {
      mode = url.searchParams.get('mode') || 'ok';
      res.end(JSON.stringify({ mode }));
      return undefined;
    }

    const number = url.searchParams.get('number') || '';
    calls.push({ number, key: url.searchParams.get('access_key') || '' });

    if (url.pathname !== '/validate') {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: { code: 303, info: 'no such endpoint' } }));
      return undefined;
    }
    if (url.searchParams.get('access_key') !== NUMVERIFY_TEST_KEY) {
      res.statusCode = 401;
      res.end(JSON.stringify({ success: false, errors: { code: 104, info: 'Access key is invalid or has been revoked' } }));
      return undefined;
    }
    if (mode === 'down') {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, errors: { code: 105, info: 'Your quota is exhausted' } }));
      return undefined;
    }
    if (mode === 'gibberish') {
      res.end(JSON.stringify({ result: 'something else entirely' }));
      return undefined;
    }

    /* Numbers on the 078 range are "known to the plan"; anything else comes back invalid. */
    const live = number.startsWith('+25078');
    res.end(JSON.stringify({
      valid: live,
      number: live ? number.slice(1) : '',
      country_name: 'Rwanda',
      country_code: 'RW',
      locale_number: live ? number.slice(4) : '',
      format_e164: number,
      format_international: live ? `+250 ${number.slice(4, 7)} ${number.slice(7, 9)} ${number.slice(9)}` : '',
      carrier: live ? 'MTN Rwanda' : '',
      line_type: live ? 'GSM' : '',
      location: live ? 'Kigali' : '',
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    calls,
    setMode: async (next) => { await fetch(`${base}/__mode?mode=${next}`); },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
