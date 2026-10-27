import { currentEntities, dateInZone, shiftDate } from './sync-model.js';

export function zonedTime(date, time, zone) {
  const target = Date.parse(`${date}T${time}:00Z`);
  let value = target;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(value)).map(p => [p.type, p.value]));
    const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const next = value + target - represented;
    if (next === value) break;
    value = next;
  }
  return value;
}

export function dueReminders(doc, now = Date.now()) {
  if (doc.local.settings?.remindersEnabled === false) return [];
  const zone = doc.sync.timeZone, today = dateInZone(zone, new Date(now));
  const current = currentEntities(doc), local = doc.local.reminders || {}, due = [];
  for (const r of current.values()) {
    const t = r.payload;
    if (r.entityType !== 'task' || r.deleted || t.archivedAt || !t.time || (t.kind !== 'daily' && t.completed)) continue;
    const dates = t.kind === 'daily' ? [shiftDate(today, -1), today, shiftDate(today, 1)] : [t.scheduledDate];
    for (const date of dates) {
      if (t.kind === 'daily' && ((t.createdAt && date < dateInZone(zone, new Date(t.createdAt))) || current.get(`completion:${t.id}/${date}`)?.payload.completed)) continue;
      const lead = t.remindLeadMinutes || 0, key = `${t.id}/${date}/${t.time}/${lead}`;
      const snooze = local.snoozes?.[key];
      if (local.delivered?.[key] && !snooze) continue;
      // Honor already delivered reminders from pre-0.5 data, but allow a changed lead time.
      if (!snooze && !lead && doc.receipts?.[`${t.id}/${date}/${t.time}`]) continue;
      const at = zonedTime(date, t.time, zone) - lead * 60000;
      if (now >= (snooze || at)) due.push({ key, taskId: t.id, title: t.title, time: t.time, date, at, lead, snoozed: !!snooze });
    }
  }
  return due;
}

export function createReminderRunner({ getDoc, permission, send, persist, onDelivered = () => {}, onError = () => {} }) {
  let running = false;
  return async function check(now = Date.now()) {
    if (running) return;
    running = true;
    try {
      const due = dueReminders(getDoc(), now);
      if (!due.length) return;
      if (!await permission()) { onError('系统通知未获授权，请在系统设置中允许“悬浮待办”的通知；待提醒任务会保留。'); return; }
      for (const item of due) {
        // Permission and notification awaits may overlap edits, sync or completion.
        if (!dueReminders(getDoc(), now).some(r => r.key === item.key)) continue;
        await send({ title: '悬浮待办 · 待办提醒', body: `${item.date} ${item.time}　${item.title}${item.lead ? `（提前 ${item.lead} 分钟）` : ''}` });
        const doc = getDoc();
        const state = doc.local.reminders ||= { delivered: {}, snoozes: {} };
        state.delivered ||= {}; state.snoozes ||= {};
        const previous = state.delivered[item.key], snoozedUntil = state.snoozes[item.key];
        state.delivered[item.key] = { ...item, sentAt: now };
        delete state.snoozes[item.key];
        try { await persist(); }
        catch (error) {
          if (previous) state.delivered[item.key] = previous; else delete state.delivered[item.key];
          if (snoozedUntil) state.snoozes[item.key] = snoozedUntil;
          throw error;
        }
        onDelivered(item);
      }
      onError('');
    } catch (error) { onError(`提醒发送或保存失败，将稍后重试：${error.message || error}`); }
    finally { running = false; }
  };
}

export function snoozeReminder(doc, item, minutes = 10, now = Date.now()) {
  const local = doc.local.reminders ||= { delivered: {}, snoozes: {} };
  (local.snoozes ||= {})[item.key] = now + minutes * 60000;
}
