/**
 * WebMCP の型定義（2026-10 時点の Draft Community Group Report 準拠）
 * https://webmachinelearning.github.io/webmcp/
 *
 * 主な変更点（古い記事との違い）:
 * - 入口は `document.modelContext`。`navigator.modelContext` は Chrome 150 で非推奨の別名。
 * - `registerTool()` は Promise を返す。登録解除は `unregisterTool()` ではなく
 *   `registerTool(tool, { signal })` に渡した AbortSignal を abort する。
 * - `provideContext()` / `clearContext()` は廃止。
 * - テスト用だった `navigator.modelContextTesting` の役割は
 *   `getTools()` / `executeTool()`（in-page エージェント向けAPI）に統合された。
 */

export interface ToolAnnotations {
  /** 状態を変更しない（読み取り専用）ツール */
  readOnlyHint?: boolean;
  /** 返り値に信頼できない（第三者由来の）データが含まれる */
  untrustedContentHint?: boolean;
  /** 重大・不可逆な結果を伴う（購入、送金など）。クライアントが確認UIを出す目安 */
  consequentialHint?: boolean;
  /** 開発者向けツール */
  debugging?: boolean;
}

export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  examples?: unknown[];
}

export interface ToolExecuteCallbackOptions {
  /** エージェント側でツール実行がキャンセルされると abort される */
  signal: AbortSignal;
}

export type ToolExecuteCallback = (
  input: Record<string, unknown>,
  options: ToolExecuteCallbackOptions,
) => Promise<unknown>;

export interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchema;
  execute: ToolExecuteCallback;
  annotations?: ToolAnnotations;
}

export interface ModelContextRegisterToolOptions {
  /** 公開先のオリジン（iframe 階層向け） */
  exposedTo?: string[];
  /** abort するとツールが登録解除される */
  signal?: AbortSignal;
}

/** getTools() が返すツール情報 */
export interface RegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchema;
  window?: Window;
  origin?: string;
  annotations?: ToolAnnotations;
}

export interface ModelContextLike extends EventTarget {
  registerTool(
    tool: ModelContextTool,
    options?: ModelContextRegisterToolOptions,
  ): Promise<void> | void;
  getTools?(options?: { fromOrigins?: string[] }): Promise<RegisteredTool[]>;
  /** 結果は JSON 文字列で返る */
  executeTool?(
    tool: RegisteredTool,
    input?: object,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
  /** @deprecated 2026-04 にドラフトから削除。古い Chrome 用のフォールバックとしてのみ使う */
  unregisterTool?(name: string): void;
}

declare global {
  interface Document {
    readonly modelContext?: ModelContextLike;
  }
  interface Navigator {
    /** @deprecated Chrome 150 で非推奨。document.modelContext を使う */
    readonly modelContext?: ModelContextLike;
  }
}
