import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Always return partial output, including on cancellation or transport failure.
export function runProcess(command, args, { cwd, env, input, signal, timeoutMs = 600000, maxBytes = 2097152, onLine, onStart } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', pending = '', bytes = 0, reason = null, timer, killTimer, child;
    const decoder = new StringDecoder('utf8');
    const stop = why => {
      reason ??= why;
      if (!child?.pid) return;
      const kill = sig => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, sig); } catch {} };
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 1500);
    };
    const abort = () => stop('cancelled');
    if (signal?.aborted) { resolve({ code: null, reason: 'cancelled', stdout, stderr }); return; }
    try { child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], shell: false }); }
    catch (e) { resolve({ code: null, reason: 'spawn_error', stdout, stderr: e.message }); return; }
    const send = value => { if (!child.stdin.destroyed) child.stdin.write(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`); };
    child.stdin.on('error', () => {});
    child.once('spawn', () => {
      try { onStart?.(send, () => child.stdin.end(), stop); if (input !== undefined) child.stdin.end(input); }
      catch (e) { stop(`protocol_error: ${e.message}`); }
    });
    child.on('error', e => { reason = 'spawn_error'; stderr = e.message; });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { stop('output_limit'); return; }
      const text = decoder.write(chunk); stdout += text; pending += text;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        try { if (line.trim()) onLine?.(line, send, stop); } catch (e) { stop(`protocol_error: ${e.message}`); }
      }
    });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) stop('output_limit'); else stderr = (stderr + chunk.toString()).slice(-16384); });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('close', (code, terminationSignal) => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      pending += decoder.end();
      if (pending.trim() && !reason) { try { onLine?.(pending, send, stop); } catch { reason = 'protocol_error'; } }
      resolve({ code, terminationSignal, reason, stdout, stderr });
    });
  });
}
