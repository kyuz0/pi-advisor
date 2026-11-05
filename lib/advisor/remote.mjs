import { connect, createServer } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
const LIMIT = 128 * 1024;
const METHODS = new Set(['ask','status','state','sessions','inspect','recover','acknowledge']);
const FIELDS = new Set(['mode','question','context','provider','model','advisorRef','purpose','tier','effort','reason']);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export function validateRequest(message) {
  if (!object(message) || Object.keys(message).some(k => !['method','context','params'].includes(k)) || !METHODS.has(message.method)) throw new Error('Unsupported advisor request');
  const c = message.context;
  if (!object(c) || typeof c.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(c.sessionId) || !Array.isArray(c.runIds) || c.runIds.length > 4096 || c.runIds.some(x => typeof x !== 'string' || x.length > 128)) throw new Error('Invalid session context');
  // One companion belongs to one sandbox. Never resolve caller-supplied paths.
  const context = { cwd: '/work', sessionId: c.sessionId, runIds: c.runIds };
  const p = message.params ?? {};
  if (!object(p)) throw new Error('Invalid parameters');
  const allowed = message.method === 'ask' ? FIELDS : new Set(message.method === 'status' ? ['refreshQuota'] : message.method === 'acknowledge' ? ['runId'] : []);
  if (Object.keys(p).some(k => !allowed.has(k))) throw new Error('Unsupported parameter');
  if (message.method === 'ask') {
    if (Object.values(p).some(v => typeof v !== 'string')) throw new Error('Advisor arguments must be text');
    if (!['consult','start','resume'].includes(p.mode) || !p.question?.trim()) throw new Error('Supply a mode and question');
    if (p.provider && !['codex','agy','claude'].includes(p.provider)) throw new Error('Provider not enabled');
    if (Buffer.byteLength((p.question ?? '') + (p.context ?? '')) > 49152) throw new Error('Advisor context exceeds 48 KiB');
  }
  if (p.refreshQuota !== undefined && typeof p.refreshQuota !== 'boolean') throw new Error('Invalid refreshQuota');
  if (message.method === 'acknowledge' && (typeof p.runId !== 'string' || p.runId.length > 128)) throw new Error('Invalid run ID');
  return { method: message.method, context, params: p };
}
export class RemoteAdvisorService {
  constructor(socketPath, { timeoutMs = 660000 } = {}) { this.socketPath = socketPath; this.timeoutMs = timeoutMs; this.active = new Set(); }
  request(method, context, params = {}, { signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Advisor cancelled'));
      const socket = connect(this.socketPath); this.active.add(socket);
      let buffer = '', bytes = 0, settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true;
        signal?.removeEventListener('abort', abort); this.active.delete(socket); socket.destroy();
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new Error('Advisor cancelled; check usage before retrying'));
      signal?.addEventListener('abort', abort, { once: true });
      socket.setTimeout(this.timeoutMs, () => finish(new Error('Advisor timed out; check usage before retrying')));
      socket.on('error', e => finish(new Error(`Advisor connection failed: ${e.code ?? e.message}`)));
      socket.on('close', () => finish(new Error('Advisor connection closed before completion; check usage before retrying')));
      socket.on('connect', () => {
        const data = JSON.stringify({ method, context: { sessionId: context?.sessionId ?? 'inspection', runIds: context?.runIds ?? [] }, params }) + '\n';
        if (Buffer.byteLength(data) > LIMIT) return finish(new Error('Advisor request too large'));
        socket.write(data);
      });
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4 * 1024 * 1024) return finish(new Error('Advisor response too large'));
        buffer += chunk;
        for (let at; (at = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'progress') onProgress?.(event.text);
            else if (event.type === 'result') finish(null, event.value);
            else if (event.type === 'error') finish(new Error(event.message));
            else throw new Error('Invalid advisor response');
          } catch (e) { finish(e); }
        }
      });
    });
  }
  ask(c,p,o) { return this.request('ask',c,p,o); }
  status(c,{refreshQuota=true,signal}={}) { return this.request('status',c,{refreshQuota},{signal}); }
  state(c) { return this.request('state',c); }
  sessions(c) { return this.request('sessions',c); }
  inspect(signal) { return this.request('inspect',null,{}, {signal}); }
  recover(c) { return this.request('recover',c); }
  acknowledge(c,runId) { return this.request('acknowledge',c,{runId}); }
  cancel() { for (const socket of this.active) socket.destroy(); }
}
export async function serveAdvisor(socketPath, service) {
  let busy = false;
  const connections = new Set();
  const server = createServer(socket => {
    connections.add(socket);
    const controller = new AbortController();
    let buffer = '', received = false;
    const send = value => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
    socket.on('error', () => controller.abort());
    socket.on('close', () => { controller.abort(); connections.delete(socket); });
    socket.setTimeout(10000, () => socket.destroy());
    socket.setEncoding('utf8');
    socket.on('data', async chunk => {
      if (received) { socket.destroy(); return; }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > LIMIT) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      received = true; socket.setTimeout(0);
      let acquired = false;
      try {
        if (buffer.indexOf('\n') !== buffer.length - 1) throw new Error('One request per connection');
        const {method,context,params} = validateRequest(JSON.parse(buffer));
        if (busy) throw new Error('An advisor operation is already running');
        busy = acquired = true;
        const opts = {signal:controller.signal,onProgress:text => send({type:'progress',text})};
        let value;
        if (method === 'ask') value = await service.ask(context,params,opts);
        else if (method === 'status') value = await service.status(context,{...opts,...params});
        else if (method === 'inspect') value = await service.inspect(controller.signal);
        else if (method === 'acknowledge') value = await service.acknowledge(context,params.runId);
        else value = await service[method](context);
        send({type:'result',value:value ?? null});
      } catch (e) { send({type:'error',message:e.message}); }
      finally { if (acquired) busy = false; socket.end(); }
    });
  });
  try { const old = await lstat(socketPath); if (!old.isSocket()) throw new Error('Advisor path is not a socket'); await unlink(socketPath); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const previous = process.umask(0o077);
  try { await new Promise((resolve,reject) => { server.once('error',reject); server.listen(socketPath,resolve); }); }
  finally { process.umask(previous); }
  await chmod(socketPath,0o600);
  server.stop = () => { for (const socket of connections) socket.destroy(); service.cancel(); return new Promise(resolve => server.close(resolve)); };
  return server;
}
