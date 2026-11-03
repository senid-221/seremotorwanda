/* A tiny in-memory S3 endpoint for the test suites. It accepts the presigned PUT, HEAD and GET that the
   API signs, so document uploads can be exercised end to end without cloud credentials or network. */
import http from 'node:http';

export async function startFakeS3() {
  const objects = new Map();
  const bucket = 'assets';

  const server = http.createServer((req, res) => {
    /* A real bucket used from a browser must answer CORS preflight for the signed PUT. */
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'PUT, GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Type');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const match = pathname.match(/^\/([^/]+)\/(.+)$/);
    if (!match || match[1] !== bucket) {
      res.statusCode = 404;
      return res.end();
    }
    const key = match[2];
    const object = objects.get(key);

    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        objects.set(key, { body, contentType: req.headers['content-type'] || 'application/octet-stream' });
        res.setHeader('ETag', '"fake"');
        res.end();
      });
      return undefined;
    }
    if (req.method === 'HEAD') {
      if (!object) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('Content-Length', object.body.length);
      res.setHeader('Content-Type', object.contentType);
      return res.end();
    }
    if (req.method === 'GET') {
      if (!object) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('Content-Length', object.body.length);
      res.setHeader('Content-Type', object.contentType);
      return res.end(object.body);
    }
    res.statusCode = 405;
    return res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    objects,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
