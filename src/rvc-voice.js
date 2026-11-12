import { spawn } from 'node:child_process';

/**
 * 換聲工人（RVC）的 Node 端包裝。
 *
 * python 那邊模型只載一次、用一行一個 JSON 的 stdin/stdout 跟我說話，
 * 所以每句只付「換聲」的時間（實測 3–4 秒的音檔約 2.6–3.3 秒），
 * 不用每句重載 55MB 的 .pth。
 *
 * 失敗一律回 null —— 語音是錦上添花，不該把回覆本身拖垮。
 */

const STDERR_TAIL = 400;

export function createRvcVoice({
  pythonPath,
  workerPath,
  modelDir = '',
  cwd = '',
  env = {},
  spawnImpl = spawn,
  timeoutMs = 120_000,
  logger = () => {},
} = {}) {
  if (!pythonPath || !workerPath) throw new Error('rvc-voice: pythonPath / workerPath 不可為空');

  let child = null;
  let ready = false;
  let starting = null;
  let nextId = 1;
  let stderrTail = '';
  const pending = new Map();
  let chain = Promise.resolve();

  function handleLine(line) {
    const text = String(line).trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.ready) {
      ready = true;
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve({ ok: true, ms: Number(msg.ms) || 0 });
    else entry.resolve({ ok: false, error: String(msg.error ?? 'unknown'), where: msg.where ? String(msg.where) : '' });
  }

  function wire(proc) {
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    });
    proc.stderr?.setEncoding?.('utf8');
    proc.stderr?.on?.('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
    });
    const fail = (reason) => {
      if (child !== proc) return;
      child = null;
      ready = false;
      starting = null;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, error: reason });
      }
      pending.clear();
      logger(`rvc-voice: 工人結束（${reason}）${stderrTail ? `：${stderrTail.split('\n').filter(Boolean).at(-1)}` : ''}`);
    };
    proc.on('exit', (code) => fail(`exit ${code}`));
    proc.on('error', (error) => fail(String(error?.message ?? error)));
  }

  function start() {
    if (child) return starting ?? Promise.resolve(true);
    if (starting) return starting;
    starting = new Promise((resolve) => {
      let proc;
      try {
        proc = spawnImpl(pythonPath, [workerPath], {
          cwd: cwd || undefined,
          env: { ...process.env, ...env, ...(modelDir ? { RVC_MODEL_DIR: modelDir } : {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        starting = null;
        logger(`rvc-voice: 起不來（${error?.message ?? error}）`);
        resolve(false);
        return;
      }
      child = proc;
      wire(proc);
      const deadline = setTimeout(() => {
        if (!ready) {
          logger('rvc-voice: 等模型載入超時');
          try { proc.kill(); } catch {}
          starting = null;
          resolve(false);
        }
      }, timeoutMs);
      const tick = setInterval(() => {
        if (ready) {
          clearInterval(tick);
          clearTimeout(deadline);
          starting = null;
          resolve(true);
        }
      }, 50);
      proc.on('exit', () => {
        clearInterval(tick);
        clearTimeout(deadline);
      });
    });
    return starting;
  }

  /** 把一個 wav 換成她的音色；成功回 { ok:true, ms }，失敗回 { ok:false, error }。 */
  function convert({ input, output, f0up = 0, indexRate = 0.75, protect = 0.33, rmsMixRate = 1, filterRadius = 3 } = {}) {
    const job = async () => {
      const ok = await start();
      if (!ok) return { ok: false, error: 'worker-not-started' };
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'timeout' });
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        const line = JSON.stringify({
          id,
          in: input,
          out: output,
          f0up,
          index: indexRate,
          protect,
          rms: rmsMixRate,
          filter: filterRadius,
        });
        try {
          child.stdin.write(line + '\n');
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ ok: false, error: String(error?.message ?? error) });
        }
      });
    };
    const result = chain.then(job, job);
    chain = result.then(() => undefined, () => undefined);
    return result;
  }

  function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    ready = false;
    try { proc.stdin.write(String.fromCharCode(10)); } catch {}
    try { proc.stdin.end(); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} }, 200);
  }

  return { convert, start, stop, get alive() { return Boolean(child) && ready; } };
}
