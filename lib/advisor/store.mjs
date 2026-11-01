import { mkdir, open, readFile, rename, rm, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = text => createHash('sha256').update(text).digest('hex');
export async function atomicJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, path); } finally { await rm(temp, { force: true }); }
}
export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function sessionIdentity(cwd, sessionId) {
  if (!sessionId) throw new Error('Advisor requires a Pi session ID.');
  return { project: await realpath(cwd), sessionId, key: hash(`${await realpath(cwd)}\0${sessionId}`) };
}
export class Store {
  constructor(root) { this.root = root; }
  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); await mkdir(join(this.root, 'sessions'), { recursive: true, mode: 0o700 }); }
  path(identity) { return join(this.root, 'sessions', `${identity.key}.json`); }
  async load(identity) {
    await this.init();
    return readJSON(this.path(identity), { version: 1, ...identity, runs: [], advisors: {} });
  }
  async save(state) { await atomicJSON(this.path(state), state); }
  async lock() {
    await this.init();
    const path = join(this.root, 'active.lock');
    let handle;
    try { handle = await open(path, 'wx', 0o600); } catch (e) {
      if (e.code === 'EEXIST') throw new Error('An advisor operation is running, or its process stopped unexpectedly. Use /advisor recover after that process has exited.');
      throw e;
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close();
    return () => rm(path, { force: true });
  }
  async recoverLock() {
    const path = join(this.root, 'active.lock');
    const owner = await readJSON(path, null);
    if (!owner) return;
    try { process.kill(owner.pid, 0); throw new Error('The lock owner is still running. Cancel the advisor or close its Pi process first.'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    const before = await stat(path); const current = await readJSON(path, null);
    if (current?.pid !== owner.pid || (await stat(path)).ino !== before.ino) throw new Error('Lock changed; retry recovery.');
    await rm(path);
  }
}
