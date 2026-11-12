import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createGsvVoice } from '../src/gsv-voice.js';

/**
 * 原生語音工人（GPT-SoVITS）的離線測試：用假的 child process 演一遍協議。
 * 真實音質與速度只能在真機聽/量，這裡只驗「它講錯話時會不會拖垮回覆」。
 */

function fakeWorker({ respond = true, failFirst = false, ready = true, reply = null } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  const state = { spawns: 0, requests: 0, ended: false, args: null };
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
        if (req.cmd === 'stop') continue;
        const shouldFail = failFirst && state.requests === 1;
        setTimeout(() => {
          const payload = shouldFail
            ? { id: req.id, ok: false, error: 'boom', where: 'worker.py line 1' }
            : reply ?? { id: req.id, ok: true, ms: 4300, dur: 3.8, sr: 48000 };
          proc.stdout.write(JSON.stringify(payload) + '\n');
        }, 1);
      }
    },
    end() {
      state.ended = true;
    },
  };
  proc.kill = () => proc.emit('exit', 0);
  if (ready) setTimeout(() => proc.stdout.write(JSON.stringify({ ready: true, device: 'cuda', version: 'v4' }) + '\n'), 1);
  state.spawnImpl = (command, args) => {
    state.spawns += 1;
    state.args = args;
    return proc;
  };
  return state;
}

{
  // 1) 正常：兩句話共用同一個工人，回傳毫秒與時長
  const fake = fakeWorker();
  const voice = createGsvVoice({
    pythonPath: 'py',
    workerPath: 'worker.py',
    configPath: 'tts.yaml',
    packDir: 'pack',
    spawnImpl: fake.spawnImpl,
    timeoutMs: 2000,
  });
  const first = await voice.speak({ text: '在嘛。', output: 'a.wav' });
  const second = await voice.speak({ text: '晚安。', output: 'b.wav' });
  assert.equal(first.ok, true, '第一句應成功');
  assert.equal(first.ms, 4300);
  assert.equal(first.dur, 3.8);
  assert.equal(second.ok, true);
  assert.equal(fake.spawns, 1, '兩句只起一個工人');
  assert.deepEqual(fake.args, ['worker.py', 'tts.yaml', 'pack', 'zh'], '參數照約定傳給 python');
  voice.stop();
  console.log('1) 正常合成：共用工人、回傳毫秒與時長 ✓');
}

{
  // 2) 工人回報失敗：把錯誤與位置原樣帶回來，不吞
  const fake = fakeWorker({ failFirst: true });
  const voice = createGsvVoice({ pythonPath: 'py', workerPath: 'w.py', spawnImpl: fake.spawnImpl, timeoutMs: 2000 });
  const res = await voice.speak({ text: '嗨', output: 'a.wav' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'boom');
  assert.match(res.where, /worker\.py/);
  voice.stop();
  console.log('2) 合成失敗：錯誤與 traceback 位置都帶回來 ✓');
}

{
  // 3) 工人不講話：超時回 timeout，不無限等
  const fake = fakeWorker({ respond: false });
  const voice = createGsvVoice({ pythonPath: 'py', workerPath: 'w.py', spawnImpl: fake.spawnImpl, timeoutMs: 60 });
  const started = Date.now();
  const res = await voice.speak({ text: '嗨', output: 'a.wav' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
  assert.ok(Date.now() - started < 2000, '超時要真的提早回來');
  voice.stop();
  console.log('3) 工人不理人：超時回 timeout ✓');
}

{
  // 4) 起不來（spawn 直接拋）：回 worker-not-started，不拋給上層
  const voice = createGsvVoice({
    pythonPath: 'py',
    workerPath: 'w.py',
    spawnImpl: () => {
      throw new Error('nope');
    },
    timeoutMs: 500,
  });
  const res = await voice.speak({ text: '嗨', output: 'a.wav' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'worker-not-started');
  voice.stop();
  console.log('4) 工人起不來：回 worker-not-started ✓');
}

{
  // 5) 參數沒給：直接拋（這是程式寫錯，不該靜默）
  assert.throws(() => createGsvVoice({ pythonPath: 'py' }), /pythonPath \/ workerPath/);
  console.log('5) 缺 pythonPath/workerPath：直接拋錯 ✓');
}

console.log('test-gsv-voice: 5 组断言通过');
