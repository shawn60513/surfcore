import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 讓她有聲音——用 Windows 內建的 SAPI（離線，不需要 key、不需要網路）。
 *
 * 這台機器上裝了 `Microsoft Hanhan Desktop`（zh-TW 女聲），
 * 所以文字 → wav 全部在本機做完，再當附件丟到 Discord。
 */

export const DEFAULT_VOICE = 'Microsoft Hanhan Desktop';

/** 去掉不該唸出來的東西：程式碼、連結、markdown 符號。 */
export function speakableText(text, maxChars = 200) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, Math.trunc(maxChars)));
}

/** 這句話值不值得配語音：太長的、純 emoji／標點的不唸。 */
export function shouldSpeak(text, { maxChars = 80 } = {}) {
  const body = speakableText(text, 10_000);
  if (!body) return false;
  if (body.length > maxChars) return false;
  return /[\p{Script=Han}A-Za-z]/u.test(body);
}

/** 只唸最後一句——整串唸起來像有聲書，不像在聊天。 */
export function pickSpeakLine(text, maxChars = 80) {
  const lines = String(text ?? '')
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter(Boolean);
  return speakableText(lines.at(-1) ?? '', maxChars);
}

/** 產生 PowerShell 腳本：把一句話唸成 wav。 */
export function sapiScript(text, { voicePath, rate = 2, volume = 100 } = {}) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  return [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SelectVoice(${quote(DEFAULT_VOICE)})`,
    `$s.Rate = ${Number.isFinite(rate) ? Math.max(-10, Math.min(10, Math.trunc(rate))) : 2}`,
    `$s.Volume = ${Number.isFinite(volume) ? Math.max(0, Math.min(100, Math.trunc(volume))) : 100}`,
    `$s.SetOutputToWaveFile(${quote(voicePath)})`,
    `$s.Speak(${quote(text)})`,
    '$s.Dispose()',
  ].join('; ');
}

function powershellExe() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 文字 → wav 檔（回傳路徑）。呼叫端負責刪。
 * @param {object} opts
 * @param {typeof spawn} [opts.spawnImpl] 測試時注入假的 spawn
 */
export function synthesizeWav(text, {
  outDir = os.tmpdir(),
  voice = DEFAULT_VOICE,
  rate = 2,
  volume = 100,
  timeoutMs = 20_000,
  spawnImpl = spawn,
} = {}) {
  const body = speakableText(text, 300);
  if (!body) {
    return Promise.reject(Object.assign(new Error('沒有可以唸的字'), { code: 'tts.empty-text' }));
  }
  const file = path.join(outDir, `aimisi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  const script = sapiScript(body, { voicePath: file, rate, volume });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(powershellExe(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      reject(Object.assign(new Error(`唸不出來：${error?.message ?? error}`), { code: 'tts.spawn' }));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(Object.assign(new Error('唸這段話逾時'), { code: 'tts.timeout' }));
    }, Math.max(1000, Math.trunc(timeoutMs)));

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`唸不出來：${error?.message ?? error}`), { code: 'tts.spawn' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try { fs.unlinkSync(file); } catch {}
        reject(Object.assign(new Error(`語音引擎退出（code=${code}）`), { code: 'tts.exit' }));
        return;
      }
      let size = 0;
      try { size = fs.statSync(file).size; } catch {}
      if (size < 1024) {
        try { fs.unlinkSync(file); } catch {}
        reject(Object.assign(new Error('語音檔是空的'), { code: 'tts.empty' }));
        return;
      }
      resolve(file);
    });
  });
}
