export const PANEL_MIN = { width: 220, height: 180 };
export const PANEL_DEFAULT = { width: 420, height: 680 };
export const PANEL_MAX = { width: 7680, height: 4320 };
// Sizes include the 12px transparent shadow gutter on each edge.
export const BAR_SIZE = { width: 188, height: 68 };
export const CAPTURE_SIZE = { width: 340, height: 252 };

export function isCompact({ width, height }) {
  return width < 300 || height < 280;
}

export function anchoredBounds(frame, size, workArea) {
  const scale = frame.scale;
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  let x = frame.x + frame.width - width;
  let y = frame.y;
  if (workArea) {
    x = Math.max(workArea.position.x, Math.min(x, workArea.position.x + workArea.size.width - width));
    y = Math.max(workArea.position.y, Math.min(y, workArea.position.y + workArea.size.height - height));
  }
  return { x: Math.round(x), y: Math.round(y), width, height, scale };
}

// The top-right corner remains anchored during a southwest resize. All cursor
// and frame coordinates are physical pixels, including on scaled displays.
export function southwestResize(frame, start, pointer) {
  const minWidth = Math.round(PANEL_MIN.width * frame.scale);
  const minHeight = Math.round(PANEL_MIN.height * frame.scale);
  const width = Math.round(Math.max(minWidth, Math.min(PANEL_MAX.width * frame.scale, frame.width - (pointer.x - start.x))));
  const height = Math.round(Math.max(minHeight, Math.min(PANEL_MAX.height * frame.scale, frame.height + (pointer.y - start.y))));
  const x = frame.x + frame.width - width;
  const bounds = { ...frame, x, width, height };
  const collapse = width === minWidth && height === minHeight
    && pointer.x > x + width / 2 && pointer.y < frame.y + height / 2;
  return { bounds, collapse };
}
