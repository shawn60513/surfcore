// 看門狗：bridge（3100 控制台埠）沒在聽就把它拉起來。
// 由兩個計畫任務呼叫：登入時一次、每 5 分鐘一次（透過 bridge-watchdog.vbs，視窗全隱藏）。
//
// 為什麼是 Node 不是 PowerShell：PowerShell 冷啟動要 0.5–1 秒、還要開一個 conhost，
// 使用者看片/玩遊戲時會感覺得到那一下卡頓。Node 這支大約 40–80ms，而且不碰視窗焦點。
//
// 只做「沒跑就啟動」，不改任何設定；bridge 活著的時候它什麼都不做。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3100;
const LOG = path.join(root, 'state', 'watchdog.log');
const LOCK = path.join(root, 'state', 'bridge.lock');
const PID_FILE = path.join(root, 'state', 'bridge.pid');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(message) {
  try {
    fs.appendFileSync(LOG, `${stamp()} ${message}\r\n`, 'utf8');
  } catch {}
}

/** 埠在聽＝bridge 活著。只連一下、不送任何資料。 */
function portListening(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (await portListening(PORT)) return; // 活著：什麼都不做

  // 埠沒在聽：可能剛崩，也可能上一次啟動還在 boot，先給 5 秒冷卻
  try {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < 5000) return;
  } catch {}

  // 殘留的鎖要先清（進程不在了，鎖留著只會讓新進程 exit 2）
  let lockPid = null;
  try {
    const text = fs.readFileSync(LOCK, 'utf8').trim();
    if (/^\d+$/.test(text)) lockPid = Number(text);
  } catch {}
  if (lockPid != null) {
    if (pidAlive(lockPid)) return; // 進程還在，只是還沒開始聽：不要插手
    try {
      fs.rmSync(LOCK, { force: true });
      log(`清掉殘留的 bridge.lock（${lockPid} 已經不在了）`);
    } catch {}
  }

  log('準備拉起 bridge（3100 沒在聽）');
  let child;
  try {
    child = spawn(process.execPath, ['src/bridge.js'], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (error) {
    log(`拉起 bridge 失敗：${error?.message ?? error}`);
    return;
  }

  await sleep(4000);
  if (child.exitCode == null && child.pid) {
    try {
      fs.writeFileSync(PID_FILE, String(child.pid), 'ascii');
    } catch {}
    log(`bridge 沒在跑，已拉起 PID ${child.pid}`);
  } else {
    log('嘗試拉起 bridge，但進程 4 秒內就退出了（請看 state/bridge.log）');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log(`看門狗本身出錯：${error?.message ?? error}`);
    process.exit(0); // 看門狗失敗不該變成計畫任務的紅色錯誤
  });
