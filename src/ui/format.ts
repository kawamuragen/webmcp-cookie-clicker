/** 表示用の数値フォーマット（ツールの返り値は生の数値のまま返す：エージェントは計算するので） */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  if (n < 10_000) return Math.floor(n).toLocaleString('ja-JP');
  const units: [number, string][] = [
    [1e12, '兆'],
    [1e8, '億'],
    [1e4, '万'],
  ];
  for (const [v, u] of units) {
    if (n >= v) {
      const x = n / v;
      return `${x.toFixed(x < 100 ? 2 : 1)}${u}`;
    }
  }
  return String(Math.floor(n));
}

export function fmtRate(n: number): string {
  return n < 100 ? n.toFixed(1) : fmt(n);
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour12: false });
}

export function esc(s: unknown): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** innerHTML が変わったときだけ書き換える（クリック中のボタンを壊さないため） */
const lastHtml = new WeakMap<Element, string>();

export function patch(el: Element, html: string): boolean {
  if (lastHtml.get(el) === html) return false;
  lastHtml.set(el, html);
  el.innerHTML = html;
  return true;
}
