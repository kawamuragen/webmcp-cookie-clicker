import type { WebMcpEnvironment } from './detect.ts';
import { validateInput } from './schema.ts';
import type { JsonSchema, ModelContextTool, RegisteredTool, ToolAnnotations } from './types.ts';

/** 誰がツールを呼んだか。ネイティブ経由の呼び出しは区別できないので既定は 'agent' */
export type CallSource = 'agent' | 'autopilot' | 'manual';

export interface ToolContext {
  signal: AbortSignal;
  source: CallSource;
}

/** ゲーム側が宣言する「今あるべきツール」 */
export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  /** UI 表示用：このツールが自動的に消える予定時刻 */
  expiresAt?: number;
  /** UI 表示用：このツールで学べる WebMCP の概念 */
  lesson?: string;
  run(input: Record<string, unknown>, ctx: ToolContext): unknown;
}

export interface RegisteredEntry {
  spec: ToolSpec;
  signature: string;
  registeredAt: number;
  revision: number;
}

export type CallStatus = 'pending' | 'ok' | 'error' | 'cancelled';

export interface CallRecord {
  id: number;
  tool: string;
  source: CallSource;
  input: unknown;
  startedAt: number;
  endedAt?: number;
  status: CallStatus;
  result?: unknown;
}

export type RegistryEvent =
  | { type: 'registered'; name: string; revision: number }
  | { type: 'unregistered'; name: string; reason: 'removed' | 'updated' }
  | { type: 'register-failed'; name: string; message: string }
  | { type: 'call'; record: CallRecord };

/**
 * ToolSpec の配列を受け取り、WebMCP 側の登録状態をそれに合わせる（宣言的な差分適用）。
 *
 * ポイント:
 * - description / inputSchema は登録後に変更できない。変えたいときは
 *   AbortController で一度登録解除して、同じ name で登録し直す（= toolchange が発火）。
 * - すべての execute をラップして、入力検証・ログ・例外→エラーオブジェクト化を共通化する。
 *   仕様上、execute が reject するとエージェントには「tool rejected」としか伝わらないため、
 *   失敗理由はエラーオブジェクトとして resolve で返す方がエージェントに優しい。
 */
export class ToolRegistry extends EventTarget {
  readonly env: WebMcpEnvironment;
  #entries = new Map<string, RegisteredEntry & { controller: AbortController; execute: ModelContextTool['execute'] }>();
  #expected = new Map<string, symbol[]>();
  #sources = new Map<symbol, CallSource>();
  #nextCallId = 1;
  #revisions = new Map<string, number>();
  #order: string[] = [];

  constructor(env: WebMcpEnvironment) {
    super();
    this.env = env;
  }

  /** 最後に sync() された順（＝ゲーム側が宣言した順）で返す */
  get entries(): RegisteredEntry[] {
    return [...this.#entries.values()].sort((a, b) => this.#order.indexOf(a.spec.name) - this.#order.indexOf(b.spec.name));
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** 望ましいツール一覧に登録状態を合わせる */
  sync(specs: ToolSpec[]): void {
    const wanted = new Map(specs.map((s) => [s.name, s]));
    this.#order = specs.map((s) => s.name);
    for (const [name, entry] of this.#entries) {
      const next = wanted.get(name);
      if (!next) this.#unregister(name, 'removed');
      else if (signatureOf(next) !== entry.signature) this.#unregister(name, 'updated');
      else entry.spec = next; // run クロージャ等は最新に差し替え（登録し直しは不要）
    }
    for (const spec of specs) {
      if (!this.#entries.has(spec.name)) this.#register(spec);
    }
  }

  #register(spec: ToolSpec): void {
    const controller = new AbortController();
    const revision = (this.#revisions.get(spec.name) ?? 0) + 1;
    this.#revisions.set(spec.name, revision);
    const execute: ModelContextTool['execute'] = (input, options) => this.#execute(spec.name, input, options.signal);
    const entry = {
      spec,
      signature: signatureOf(spec),
      registeredAt: Date.now(),
      revision,
      controller,
      execute,
    };
    this.#entries.set(spec.name, entry);

    const tool: ModelContextTool = {
      name: spec.name,
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: spec.annotations,
      execute,
    };
    // 古い実装では registerTool が同期で void を返すので Promise.resolve で包む
    Promise.resolve()
      .then(() => this.env.provider.registerTool(tool, { signal: controller.signal }))
      .then(() => {
        if (!controller.signal.aborted) this.#emit({ type: 'registered', name: spec.name, revision });
      })
      .catch((err: unknown) => {
        if (this.#entries.get(spec.name)?.controller === controller) this.#entries.delete(spec.name);
        this.#emit({ type: 'register-failed', name: spec.name, message: String(err) });
      });
  }

  #unregister(name: string, reason: 'removed' | 'updated'): void {
    const entry = this.#entries.get(name);
    if (!entry) return;
    this.#entries.delete(name);
    entry.controller.abort(); // ← これが現行仕様の「登録解除」
    // signal 非対応の古い実装向けフォールバック
    if (this.env.mode !== 'shim' && typeof this.env.provider.unregisterTool === 'function') {
      try {
        this.env.provider.unregisterTool(name);
      } catch {
        /* signal で既に解除済み */
      }
    }
    this.#emit({ type: 'unregistered', name, reason });
  }

  /** すべての登録を解除（ページ離脱時など） */
  dispose(): void {
    for (const name of [...this.#entries.keys()]) this.#unregister(name, 'removed');
  }

  async #execute(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const token = this.#expected.get(name)?.shift();
    const source = (token && this.#sources.get(token)) ?? 'agent';
    if (token) this.#sources.delete(token);

    const record: CallRecord = {
      id: this.#nextCallId++,
      tool: name,
      source,
      input,
      startedAt: Date.now(),
      status: 'pending',
    };
    this.#emit({ type: 'call', record });

    const finish = (status: CallStatus, result: unknown) => {
      record.status = status;
      record.result = result;
      record.endedAt = Date.now();
      this.#emit({ type: 'call', record });
      return result;
    };

    const spec = this.#entries.get(name)?.spec;
    if (!spec) {
      return finish('error', { ok: false, error: 'tool_unavailable', message: `${name} は現在公開されていません。get_status で状況を確認してください。` });
    }
    const errors = validateInput(spec.inputSchema, input ?? {});
    if (errors.length) {
      return finish('error', { ok: false, error: 'invalid_input', details: errors });
    }
    try {
      const result = await spec.run(input ?? {}, { signal, source });
      if (signal.aborted) return finish('cancelled', result);
      const ok = !(isObject(result) && result.ok === false);
      return finish(ok ? 'ok' : 'error', result);
    } catch (err) {
      return finish('error', { ok: false, error: 'internal_error', message: String(err) });
    }
  }

  /** 公開中のツールを「エージェント側の視点」で取得する（getTools() があればそれを使う） */
  async discover(): Promise<RegisteredTool[]> {
    const { provider, canDiscover } = this.env;
    if (canDiscover && provider.getTools) {
      const tools = await provider.getTools();
      return tools.filter((t) => !t.window || t.window === window);
    }
    return this.entries.map(({ spec }) => ({
      name: spec.name,
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: spec.annotations,
    }));
  }

  /**
   * in-page から（デバッグパネルや内蔵オートパイロットが）ツールを呼ぶ。
   * ネイティブ WebMCP があれば getTools() → executeTool() という「エージェントと同じ経路」を通す。
   */
  async invoke(source: CallSource, name: string, input: object = {}, signal?: AbortSignal): Promise<unknown> {
    const { provider, canDiscover } = this.env;
    if (!canDiscover || !provider.getTools || !provider.executeTool) {
      // getTools が無い古い実装：登録済みの execute を直接呼ぶ
      const entry = this.#entries.get(name);
      if (!entry) throw new Error(`${name} は登録されていません`);
      const token = this.#expect(name, source);
      return entry.execute(input as Record<string, unknown>, { signal: signal ?? new AbortController().signal }).finally(
        () => this.#forget(name, token),
      );
    }
    const tools = await provider.getTools();
    const tool = tools.find((t: RegisteredTool) => t.name === name && (!t.window || t.window === window));
    if (!tool) throw new Error(`${name} は登録されていません`);
    const token = this.#expect(name, source);
    try {
      const json = await provider.executeTool(tool, input, { signal });
      return json === null || json === undefined ? null : JSON.parse(json);
    } finally {
      this.#forget(name, token);
    }
  }

  #expect(name: string, source: CallSource): symbol {
    const token = Symbol(name);
    this.#sources.set(token, source);
    const queue = this.#expected.get(name) ?? [];
    queue.push(token);
    this.#expected.set(name, queue);
    return token;
  }

  /** execute まで到達せずに失敗した呼び出しの予約を消す（次の呼び出しの誤判定を防ぐ） */
  #forget(name: string, token: symbol): void {
    const queue = this.#expected.get(name);
    if (!queue) return;
    const i = queue.indexOf(token);
    if (i >= 0) queue.splice(i, 1);
    this.#sources.delete(token);
  }

  #emit(detail: RegistryEvent): void {
    this.dispatchEvent(new CustomEvent<RegistryEvent>('registry', { detail }));
  }
}

function signatureOf(spec: ToolSpec): string {
  return JSON.stringify([spec.title, spec.description, spec.inputSchema, spec.annotations ?? {}]);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
