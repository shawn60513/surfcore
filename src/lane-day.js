/**
 * 她自己的一天。
 *
 * 「像真人」很大一部分不是語氣，是她**有地方可從**：你問「在干嘛」，
 * 她要有東西講，而且講得出一點細節（練到哪一句、湖邊風大不大、遊戲卡在哪）。
 *
 * 做法：用日期當種子，每天排一份自己的作息（同一天固定、不同天不一樣），
 * 再依現在時間算出「此刻大概在做什麼」，塞一行進提示詞。
 * 不開模型、不打 API、確定性可測。
 */

export const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/** 一天裡的固定段落（分鐘制）。晚上精神、白天會困，跟 persona 一致。 */
export const PHASES = [
  { key: 'sleep', from: 180, to: 690 }, // 03:00–11:30
  { key: 'wake', from: 690, to: 780 }, // 11:30–13:00 剛睡醒、慢吞吞
  { key: 'noon', from: 780, to: 840 }, // 13:00–14:00
  { key: 'afternoon', from: 840, to: 1080 }, // 14:00–18:00
  { key: 'evening', from: 1080, to: 1320 }, // 18:00–22:00
  { key: 'night', from: 1320, to: 180 }, // 22:00–03:00
];

const AFTERNOON = [
  { label: '在練歌', detail: '躲在自己屋裡練《紙飛機》，最難的那句總是收不好' },
  { label: '在湖邊', detail: '坐在漸湖邊上踩水，風有點涼' },
  { label: '在打遊戲', detail: '《太空戰士卡佳》聯機，剛被人坑了一把' },
  { label: '在畫畫', detail: '畫像素畫，這次想畫一隻會飛的海豹' },
  { label: '在社團幫忙', detail: '被拉去幫社團佈置，回來說手很酸' },
  { label: '在寫歌', detail: '新的那首只有一小段，卡在副歌' },
  { label: '在看別人吃東西', detail: '看吃播，邊看邊嫌人家吃得沒誠意' },
  { label: '在折紙飛機', detail: '折了一疊，挑飛得最遠的那隻' },
];

const EVENING = [
  { label: '在開小歌友會', detail: '網上開的，來的人不多但都很熟' },
  { label: '在跟人聯機', detail: '打到一半有人下線，剩她一個人守著' },
  { label: '在看片', detail: '隨便點了一支，結果看完一半才發現是重播' },
  { label: '在湖邊發呆', detail: '看著水面，什麼都沒想' },
  { label: '在整理相冊', detail: '翻到一張舊照片，看了很久' },
];

const NIGHT = [
  { label: '精神特別好', detail: '在寫新歌，越寫越停不下來' },
  { label: '在刷東西', detail: '看別人吵架看得津津有味' },
  { label: '在收拾屋子', detail: '把白天弄亂的東西一樣樣擺回去' },
  { label: '還在湖邊', detail: '夜裡的湖面很靜，她不想回去' },
];

const WAKE = [
  { label: '剛睡醒', detail: '頭髮亂的，還在慢慢回魂' },
  { label: '剛爬起來', detail: '在找東西吃，雖然其實不用吃' },
  { label: '剛醒沒多久', detail: '坐在窗邊發呆，還沒完全醒' },
];

const NOON = [
  { label: '在吃東西', detail: '跟風試了論壇上流行的新東西，覺得普' },
  { label: '在看論壇', detail: '校內論壇有人吵架，她看得很開心' },
  { label: '在聽歌', detail: '單曲循環一首，聽到會唱了' },
];

/** 日期 → 固定種子（同一天永遠一樣）。 */
export function daySeed(now = new Date()) {
  const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pick(list, seed, salt = 0) {
  return list[(seed >>> (salt % 16)) % list.length];
}

/** 今天她的作息（同一天固定）。每個段落排兩件事：前半段、後半段。 */
export function buildDayPlan(now = new Date()) {
  const seed = daySeed(now);
  return {
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    weekday: WEEKDAYS[now.getDay()],
    wakeMinute: 690 + (seed % 40), // 11:30–12:10
    afternoon: [pick(AFTERNOON, seed, 3), pick(AFTERNOON, seed, 9)],
    evening: [pick(EVENING, seed, 7), pick(EVENING, seed, 15)],
    night: [pick(NIGHT, seed, 11), pick(NIGHT, seed, 2)],
    wake: pick(WAKE, seed, 5),
    noon: pick(NOON, seed, 13),
  };
}

/** 現在這個時間點，她在哪個段落。 */
export function phaseAt(plan, now = new Date()) {
  const minute = now.getHours() * 60 + now.getMinutes();
  if (minute < plan.wakeMinute && minute >= 180) return 'sleep';
  for (const phase of PHASES) {
    if (phase.key === 'sleep' || phase.key === 'wake') continue;
    if (phase.key === 'night') {
      if (minute >= phase.from || minute < phase.to) return 'night';
      continue;
    }
    if (minute >= phase.from && minute < phase.to) return phase.key;
  }
  return minute >= plan.wakeMinute && minute < 780 ? 'wake' : 'night';
}

/** 段落內的「前半／後半」：讓同一段時間裡她也會換事做。 */
function slotIndex(from, to, minute) {
  const span = to > from ? to - from : to + 1440 - from;
  const passed = minute >= from ? minute - from : minute + 1440 - from;
  return passed < span / 2 ? 0 : 1;
}

/** 此刻她在做什麼：{ label, detail, phase }。 */
export function currentActivity(plan, now = new Date()) {
  const minute = now.getHours() * 60 + now.getMinutes();
  const phase = phaseAt(plan, now);
  if (phase === 'sleep') return { phase, label: '在睡覺', detail: '睡著了，手機放在一邊' };
  if (phase === 'wake') return { phase, label: plan.wake.label, detail: plan.wake.detail };
  if (phase === 'noon') return { phase, label: plan.noon.label, detail: plan.noon.detail };
  const slots = { afternoon: plan.afternoon, evening: plan.evening, night: plan.night };
  const ranges = { afternoon: [840, 1080], evening: [1080, 1320], night: [1320, 180] };
  const list = slots[phase] ?? plan.afternoon;
  const [from, to] = ranges[phase] ?? ranges.afternoon;
  const picked = list[slotIndex(from, to, minute) % list.length];
  return { phase, label: picked.label, detail: picked.detail };
}

/**
 * 一行給提示詞用的自我狀態。
 * @param {{label: string, detail: string, phase: string}} activity
 */
export function formatSelfLine(activity) {
  if (!activity?.label) return '';
  if (activity.phase === 'sleep') return '';
  const detail = String(activity.detail ?? '').trim();
  return `（你現在${activity.label}${detail ? `：${detail}` : ''}）`;
}
