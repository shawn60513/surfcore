import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRvcVoice } from '../src/rvc-voice.js';

/**
 * 換聲工人的離線測試：不真的起 python，用假的 child process 演一遍協議。
 * 真實速度/品質在真機跑（test-rvc-voice 只驗「說錯話時會不會拖垮回覆」）。
 */

function fakeWorker({ respond = true, failFirst = false, ready = true } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  const state = { spawns: 0, requests: 0, ended: false, killed: false };
  state.proc = proc;
  proc.stdin = {
    write(chunk) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        state.requests += 1;
        if (!respond) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        const shouldFail = failFirst && state.requests === 1;
        setTimeout(() => {
          proc.stdout.write(
            JSON.stringify(shouldFail ? { id: req.id, ok: false, error: 'boom' } : { id: req.id, ok: true, ms: 7 }) +
              '\n',
          );
        }, 1);
      }
    },
    end() {
      state.ended = true;
    },
  };
  proc.kill = () => {
    state.killed = true;
    proc.emit('exit', 0);
  };
  if (ready) {
    setTimeout(() => proc.stdout.write(JSON.stringify({ ready: true }) + '\n'), 1);
  }
  state.spawnImpl = () => {
    state.spawns += 1;
    return proc;
  };
  return state;
}

{
  // 1) 正常：兩次轉換共用同一個工人，結果帶毫秒
  const fake = fakeWorker();
  const voice = createRvcVoice({
    pythonPath: 'py',
    workerPath: 'worker.py',
    spawnImpl: fake.spawnImpl,
    timeoutMs: 5000,
  });
  const a = await voice.convert({ input: 'a.wav', output: 'a.rvc.wav' });
  const b = await voice.convert({ input: 'b.wav', output: 'b.rvc.wav' });
  assert.equal(a.ok, true);
  assert.equal(a.ms, 7);
  assert.equal(b.ok, true);
  assert.equal(fake.spawns, 1, '工人只該起一次');
  assert.equal(fake.requests, 2);
  voice.stop();
  assert.equal(fake.ended, true, 'stop() 要收掉 stdin');
}

{
  // 2) 工人回報失敗：要回 ok:false 並帶原因，不能丟例外
  const fake = fakeWorker({ failFirst: true });
  const voice = createRvcVoice({ pythonPath: 'py', workerPath: 'w.py', spawnImpl: fake.spawnImpl });
  const r = await voice.convert({ input: 'a.wav', output: 'b.wav' });
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
  voice.stop();
}

{
  // 3) 工人不理人：超時要回 timeout，而且不會卡住後面的請求
  const fake = fakeWorker({ respond: false });
  const voice = createRvcVoice({ pythonPath: 'py', workerPath: 'w.py', spawnImpl: fake.spawnImpl, timeoutMs: 120 });
  const r = await voice.convert({ input: 'a.wav', output: 'b.wav' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  voice.stop();
}

{
  // 4) 起不來（spawn 直接拋）：回 worker-not-started，不炸
  const voice = createRvcVoice({
    pythonPath: 'py',
    workerPath: 'w.py',
    spawnImpl: () => {
      throw new Error('no such file');
    },
    timeoutMs: 200,
  });
  const r = await voice.convert({ input: 'a.wav', output: 'b.wav' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'worker-not-started');
}

{
  // 5) 沒給 python/worker：建立時就要擋下來
  assert.throws(() => createRvcVoice({}), /pythonPath/);
}

console.log('test-rvc-voice: 5 组断言通过');
