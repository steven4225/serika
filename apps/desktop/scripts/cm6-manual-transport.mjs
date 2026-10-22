import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

export const modelId = 'deepseek/deepseek-v4.1-flash-fast';
export const prices = { input: 0.16, cachedInput: 0.02, output: 0.58 };

// The real key stays in this parent process; Electron only receives the loopback token.
export async function startTransport({ root, credential, respond, observe = async () => {} }) {
  const token = randomUUID();
  const log = row => appendFile(`${root}/requests.jsonl`, JSON.stringify(row) + '\n', { mode: 0o600 });
  const pending = new Set();
  const server = createServer((req, res) => {
    const task = handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  async function handle(req, res) {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403); res.end(); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const id = randomUUID();
    await log({ id, event: 'started', at: new Date().toISOString(), model: body.model, mock: !!respond });
    try {
      await observe();
      const response = respond ? await respond(body) : await fetch(`${credential.baseURL}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${credential.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) {
        await log({ id, event: 'finished', status: 'http-error-usage-unknown', httpStatus: response.status, usage: null, costUsd: null });
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"Upstream failed; response withheld"}}'); return;
      }
      res.writeHead(200, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' });
      const returned = [];
      for await (const chunk of response.body) { returned.push(Buffer.from(chunk)); res.write(chunk); }
      const text = Buffer.concat(returned).toString('utf8');
      const frames = body.stream ? text.split('\n').filter(line => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
        .map(line => JSON.parse(line.slice(5))) : [JSON.parse(text)];
      const usage = frames.findLast(frame => frame.usage)?.usage;
      const input = usage?.prompt_tokens, output = usage?.completion_tokens;
      const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
      const known = [input, output, cacheRead].every(n => Number.isSafeInteger(n) && n >= 0) && cacheRead <= input;
      const costUsd = respond ? 0 : known ? ((input - cacheRead) * prices.input + cacheRead * prices.cachedInput + output * prices.output) / 1e6 : null;
      await log({ id, event: 'finished', at: new Date().toISOString(), status: known ? 'returned' : 'usage-unknown',
        usage: known ? { input, output, cacheRead } : null, providerUsage: usage ?? null, costUsd });
      res.end();
    } catch {
      await log({ id, event: 'finished', at: new Date().toISOString(), status: 'transport-or-decoding-unknown', usage: null, costUsd: null });
      if (!res.headersSent) res.writeHead(502); res.end();
    }
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { token, url: `http://127.0.0.1:${server.address().port}/v1`, async close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...pending]);
  } };
}
