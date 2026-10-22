import type {
  ModelContextLike,
  ModelContextRegisterToolOptions,
  ModelContextTool,
  RegisteredTool,
} from './types.ts';

/**
 * WebMCP 非対応ブラウザ用の最小実装。
 *
 * グローバル（document.modelContext）には生やさない。外部のエージェントや拡張機能が
 * 「本物の WebMCP がある」と誤認しないよう、このアプリの中だけで使う。
 * 仕様のふるまい（signal による登録解除・toolchange / toolactivated / toolcancel イベント・
 * 結果の JSON 文字列化）をなぞっているので、ネイティブ版と同じコードで扱える。
 */
export class LocalModelContext extends EventTarget implements ModelContextLike {
  #tools = new Map<string, ModelContextTool>();

  async registerTool(
    tool: ModelContextTool,
    options: ModelContextRegisterToolOptions = {},
  ): Promise<void> {
    if (!tool.name || !tool.description) {
      throw new TypeError('name と description は空にできません');
    }
    if (this.#tools.has(tool.name)) {
      throw new DOMException(`ツール "${tool.name}" は登録済みです`, 'InvalidStateError');
    }
    if (options.signal?.aborted) return;
    this.#tools.set(tool.name, tool);
    options.signal?.addEventListener(
      'abort',
      () => {
        if (this.#tools.get(tool.name) === tool) {
          this.#tools.delete(tool.name);
          this.dispatchEvent(new Event('toolchange'));
        }
      },
      { once: true },
    );
    this.dispatchEvent(new Event('toolchange'));
  }

  async getTools(): Promise<RegisteredTool[]> {
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema ? structuredClone(t.inputSchema) : undefined,
      annotations: t.annotations ? { ...t.annotations } : undefined,
      origin: globalThis.location?.origin,
    }));
  }

  async executeTool(
    registered: RegisteredTool,
    input: object = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const tool = this.#tools.get(registered.name);
    if (!tool) throw new DOMException(`ツール "${registered.name}" が見つかりません`, 'NotFoundError');
    // 仕様同様、入力は JSON を経由して渡す（関数や循環参照は渡せない）
    const inputObject = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    this.dispatchEvent(toolEvent('toolactivated', tool.name));

    const controller = new AbortController();
    const onCancel = () => {
      controller.abort();
      this.dispatchEvent(toolEvent('toolcancel', tool.name));
    };
    options.signal?.addEventListener('abort', onCancel, { once: true });
    try {
      const result = await tool.execute(inputObject, { signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException('キャンセルされました', 'AbortError');
      return JSON.stringify(result ?? null);
    } finally {
      options.signal?.removeEventListener('abort', onCancel);
    }
  }
}

function toolEvent(type: string, toolName: string): Event {
  const ev = new Event(type);
  Object.defineProperty(ev, 'toolName', { value: toolName });
  return ev;
}
