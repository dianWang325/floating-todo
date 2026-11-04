// A selection is a draft only: task persistence stays with the existing form.
export function attachTimelineSelection(root, { hourHeight, onSelect, isBusy }) {
  let drag = null, frame = 0;
  const timeLabel = minute => minute === 1440 ? '24:00' : `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const minuteAt = (canvas, y, limit = 1440) => Math.max(0, Math.min(limit, Math.round((y - canvas.getBoundingClientRect().top) / hourHeight() * 4) * 15));

  function paint() {
    if (!drag?.moved) return;
    const end = minuteAt(drag.canvas, drag.y);
    drag.start = Math.min(drag.anchor, end, 1425);
    drag.end = Math.max(drag.start + 15, drag.anchor, end);
    if (!drag.preview) {
      drag.preview = document.createElement('div');
      drag.preview.className = 'time-selection';
      drag.preview.setAttribute('role', 'status');
      drag.canvas.append(drag.preview);
    }
    drag.preview.style.top = `${drag.start * hourHeight() / 60}px`;
    drag.preview.style.height = `${(drag.end - drag.start) * hourHeight() / 60}px`;
    drag.preview.textContent = `${timeLabel(drag.start)} — ${timeLabel(drag.end)}`;
    drag.preview.setAttribute('aria-label', `${drag.canvas.dataset.date} ${drag.preview.textContent}`);
  }

  function scrollFrame() {
    frame = 0;
    if (!drag?.moved) return;
    const scroller = drag.canvas.closest('.time-grid-scroll');
    const rect = scroller.getBoundingClientRect();
    const top = Math.max(rect.top, scroller.querySelector('.time-grid-sticky').getBoundingClientRect().bottom);
    const velocity = drag.y < top + 28 ? -Math.min(12, (top + 28 - drag.y) / 3) : drag.y > rect.bottom - 28 ? Math.min(12, (drag.y - rect.bottom + 28) / 3) : 0;
    if (velocity) scroller.scrollTop += velocity;
    paint();
    frame = requestAnimationFrame(scrollFrame);
  }

  function cancel() {
    if (!drag) return;
    const pointerId = drag.pointerId;
    drag.preview?.remove(); drag = null;
    cancelAnimationFrame(frame); frame = 0;
    if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
  }
  function down(event) {
    const canvas = event.target.closest('.time-day-canvas');
    if (!canvas || event.target.closest('.time-block') || drag || isBusy() || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    drag = { canvas, pointerId: event.pointerId, anchor: minuteAt(canvas, event.clientY, 1425), originY: event.clientY, y: event.clientY, moved: false };
    root.setPointerCapture(event.pointerId);
  }
  function move(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    // A missed pointerup must never leave a pending selection behind.
    if (!(event.buttons & 1)) { cancel(); return; }
    drag.y = event.clientY;
    if (Math.abs(drag.y - drag.originY) > 4) drag.moved = true;
    paint();
    if (drag.moved && !frame) frame = requestAnimationFrame(scrollFrame);
  }
  function up(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.y = event.clientY; paint();
    const selected = { day: drag.canvas.dataset.date, time: timeLabel(drag.moved ? drag.start : drag.anchor), duration: drag.moved ? drag.end - drag.start : undefined };
    cancel();
    onSelect(selected);
  }
  function pointerCancel(event) { if (drag?.pointerId === event.pointerId) cancel(); }
  function visibility() { if (document.hidden) cancel(); }
  root.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', pointerCancel);
  root.addEventListener('lostpointercapture', pointerCancel);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', visibility);
  return {
    get active() { return !!drag; }, cancel,
    destroy() {
      cancel();
      root.removeEventListener('pointerdown', down);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', pointerCancel);
      root.removeEventListener('lostpointercapture', pointerCancel);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
