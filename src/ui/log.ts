import type { GameLog } from '../game/engine.ts';
import type { CallRecord, CallSource } from '../webmcp/registry.ts';
import { clock, esc } from './format.ts';

export type LogCategory = 'call' | 'tool' | 'game';

const SOURCE_LABEL: Record<CallSource, string> = {
  agent: '🤖 エージェント',
  autopilot: '🦾 オートパイロット',
  manual: '🧑 手動',
};

const STATUS_ICON = { pending: '⏳', ok: '✅', error: '⚠️', cancelled: '🛑' } as const;

const MAX_ENTRIES = 300;

/** 右側の「エージェントログ」。新しいものが上 */
export class LogPanel {
  #list: HTMLElement;
  #calls = new Map<number, HTMLElement>();
  #filters: Record<LogCategory, boolean> = { call: true, tool: true, game: true };

  constructor(list: HTMLElement) {
    this.#list = list;
  }

  setFilter(category: LogCategory, on: boolean): void {
    this.#filters[category] = on;
    this.#list.classList.toggle(`hide-${category}`, !on);
  }

  clear(): void {
    this.#list.innerHTML = '';
    this.#calls.clear();
  }

  call(record: CallRecord): void {
    let el = this.#calls.get(record.id);
    if (!el) {
      el = document.createElement('li');
      el.className = 'log-entry log-call';
      el.dataset.category = 'call';
      this.#calls.set(record.id, el);
      this.#prepend(el);
    }
    const duration = record.endedAt ? `${record.endedAt - record.startedAt}ms` : '実行中…';
    const result = record.result as Record<string, unknown> | undefined;
    const fee = typeof result?.fee === 'number' ? `<span class="fee">手数料 ${result.fee}</span>` : '';
    const error = record.status === 'error' && typeof result?.error === 'string' ? `<span class="err">${esc(result.error)}</span>` : '';
    const wasOpen = el.querySelector('details')?.open ?? false;
    el.dataset.status = record.status;
    el.innerHTML = `
      <div class="log-head">
        <span class="time">${clock(record.startedAt)}</span>
        <span class="src src-${record.source}">${SOURCE_LABEL[record.source]}</span>
        <code class="tool-name">${esc(record.tool)}</code>
        <span class="status">${STATUS_ICON[record.status]}</span>
        <span class="dur">${duration}</span>${fee}${error}
      </div>
      <details${wasOpen ? ' open' : ''}>
        <summary>入出力</summary>
        <div class="io"><b>input</b><pre>${esc(JSON.stringify(record.input, null, 2))}</pre></div>
        <div class="io"><b>result</b><pre>${record.status === 'pending' ? '（応答待ち）' : esc(JSON.stringify(record.result, null, 2))}</pre></div>
      </details>`;
  }

  tool(icon: string, html: string): void {
    this.#line('tool', icon, html);
  }

  game(entry: GameLog): void {
    this.#line('game', entry.icon, esc(entry.message), entry.tone);
  }

  #line(category: LogCategory, icon: string, html: string, tone: GameLog['tone'] = 'info'): void {
    const el = document.createElement('li');
    el.className = `log-entry log-${category} tone-${tone}`;
    el.dataset.category = category;
    el.innerHTML = `<span class="time">${clock(Date.now())}</span><span class="icon">${icon}</span><span class="msg">${html}</span>`;
    this.#prepend(el);
  }

  #prepend(el: HTMLElement): void {
    this.#list.prepend(el);
    while (this.#list.children.length > MAX_ENTRIES) {
      const last = this.#list.lastElementChild as HTMLElement;
      for (const [id, node] of this.#calls) if (node === last) this.#calls.delete(id);
      last.remove();
    }
  }
}
