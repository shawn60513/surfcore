import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pickSpeakLine, sapiScript, shouldSpeak, speakableText, synthesizeWav } from '../src/tts.js';

const NL = String.fromCharCode(10);

// 1) 該唸的、不該唸的
assert.equal(pickSpeakLine('第一句' + NL + '最後一句噢'), '最後一句噢');
assert.equal(pickSpeakLine('', ), '');
assert.equal(shouldSpeak('在～'), true);
assert.equal(shouldSpeak('嗯'), true);
assert.equal(shouldSpeak('😴😴😴'), false);
assert.equal(shouldSpeak('x'.repeat(200)), false);
assert.equal(shouldSpeak('我'.repeat(81)), false);
assert.equal(shouldSpeak('我'.repeat(80)), true);

// 2) 清掉不該唸的東西
assert.equal(speakableText('看這個 https://example.com/a 很好笑'), '看這個  很好笑'.replace('  ', ' '));
assert.equal(speakableText('**粗體** 跟 `code`'), '粗體 跟 code');
assert.equal(speakableText('```js' + NL + 'const a = 1;' + NL + '```好'), '好');
assert.equal(speakableText('   '), '');

// 3) 生成的 PowerShell 腳本：引號轉義、參數夾在合理範圍
const script = sapiScript("他說'你好'", { voicePath: 'C:\\tmp\\a.wav', rate: 99, volume: -5 });
assert.ok(script.includes("'他說''你好'''"));
assert.ok(script.includes('$s.Rate = 10'));
assert.ok(script.includes('$s.Volume = 0'));
assert.ok(script.includes('SetOutputToWaveFile(\'C:\\tmp\\a.wav\')'));

// 4) 合成成功：假 spawn 產出檔案
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'));
  const fakeSpawn = (exe, args) => {
    assert.ok(exe.toLowerCase().includes('powershell'));
    assert.ok(args.includes('-NoProfile'));
    const child = new EventEmitter();
    setTimeout(() => {
      const target = scriptPathFromArgs(args);
      fs.writeFileSync(target, Buffer.alloc(4096, 1));
      child.emit('close', 0);
    }, 5);
    return child;
  };
  const file = await synthesizeWav('你好呀', { outDir: dir, spawnImpl: fakeSpawn });
  assert.ok(file.endsWith('.wav'));
  assert.ok(fs.statSync(file).size > 1024);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5) 空文字直接拒絕，不啟動行程
{
  let called = false;
  await assert.rejects(
    () => synthesizeWav('   ', { spawnImpl: () => { called = true; return new EventEmitter(); } }),
    (error) => error.code === 'tts.empty-text',
  );
  assert.equal(called, false);
}

// 6) 退出碼非 0 / 檔案太小 → 明確的錯誤碼
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'));
  const dying = (exe, args) => {
    const child = new EventEmitter();
    setTimeout(() => {
      const target = scriptPathFromArgs(args);
      fs.writeFileSync(target, Buffer.alloc(10, 1));
      child.emit('close', 1);
    }, 5);
    return child;
  };
  await assert.rejects(() => synthesizeWav('哈', { outDir: dir, spawnImpl: dying }), (e) => e.code === 'tts.exit');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 7) 逾時會 kill 並報 tts.timeout（用假的 child 記錄 kill）
{
  let killed = false;
  const hang = () => {
    const child = new EventEmitter();
    child.kill = () => { killed = true; };
    return child;
  };
  await assert.rejects(
    () => synthesizeWav('你好', { spawnImpl: hang, timeoutMs: 30 }),
    (e) => e.code === 'tts.timeout',
  );
  assert.equal(killed, true);
}

console.log('test-tts: 7 组断言通过');

function scriptPathFromArgs(args) {
  const script = args.join(' ');
  const match = script.match(/SetOutputToWaveFile\('((?:[^']|'')+)'\)/);
  if (!match) throw new Error('腳本裡找不到輸出檔');
  return match[1].replace(/''/g, "'");
}
