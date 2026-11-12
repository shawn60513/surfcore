import { spawn } from 'node:child_process';

/**
 * GPT-SoVITS v4（愛彌絲 Aemeath.3.0）常駐合成工人的 Node 端包裝。
 *
 * 跟 `rvc-voice.js` 同一套設計：python 那邊模型只載一次、一行一個 JSON 的 stdin/stdout，
 * 每句只付合成時間（RTX 5060 上約 4–5 秒 / 3–4 秒音檔），不用每句重載 220MB 權重。
 *
 * 這裡是「原生中文、她的音色」的正路；失敗一律回 { ok:false }，上層再退回 SAPI。
 */

const STDERR_TAIL = 400;

export function createGsvVoice({
  pythonPath,
  workerPath,
  configPath = '',
  packDir = '',
  lang = 'zh',
  spawnImpl = spawn,
  timeoutMs = 180_000,
  logger = () => {},
} = {}) {
  if (!pythonPath || !workerPath) throw new Error('gsv-voice: pythonPath / workerPath 不可為空');

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
      logger(`gsv-voice: 模型已載入（${msg.device ?? '?'} / ${msg.version ?? '?'}）`);
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve({ ok: true, ms: Number(msg.ms) || 0, dur: Number(msg.dur) || 0, sr: Number(msg.sr) || 0 });
    else entry.resolve({ ok: false, error: String(msg.error ?? 'unknown'), where: msg.where ? String(msg.where) : '' });
  }

  function fail(reason) {
    child = null;
    ready = false;
    starting = null;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: reason });
    }
    pending.clear();
    logger(`gsv-voice: 工人結束（${reason}）${stderrTail ? `：${stderrTail.split('\n').filter(Boolean).at(-1)}` : ''}`);
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
    proc.on('exit', (code) => { if (child === proc) fail(`exit ${code}`); });
    proc.on('error', (error) => { if (child === proc) fail(String(error?.message ?? error)); });
  }

  function start() {
    if (child) return starting ?? Promise.resolve(ready);
    if (starting) return starting;
    starting = new Promise((resolve) => {
      let proc;
      const args = [workerPath];
      if (configPath) args.push(configPath);
      if (packDir) args.push(packDir);
      if (lang) args.push(lang);
      try {
        proc = spawnImpl(pythonPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
      } catch (error) {
        starting = null;
        logger(`gsv-voice: 起不來（${error?.message ?? error}）`);
        resolve(false);
        return;
      }
      child = proc;
      wire(proc);
      const deadline = setTimeout(() => {
        if (!ready) {
          logger('gsv-voice: 等模型載入超時');
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

  /** 合成一句話到 `output`；成功回 { ok:true, ms, dur }，失敗回 { ok:false, error }。 */
  function speak({ text, output, speed = 1 } = {}) {
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
        const line = JSON.stringify({ id, text, out: output, speed });
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
    try { proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n'); } catch {}
    try { proc.stdin.end(); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} }, 500);
  }

  return { speak, start, stop, get alive() { return Boolean(child) && ready; } };
}
