import { LocalModelContext } from './shim.ts';
import type { ModelContextLike } from './types.ts';

export type WebMcpMode = 'document' | 'navigator' | 'shim';

export interface WebMcpEnvironment {
  mode: WebMcpMode;
  /** ツールを登録する先（ネイティブ or shim） */
  provider: ModelContextLike;
  /** getTools / executeTool が使えるか（in-page エージェントやデバッグパネル用） */
  canDiscover: boolean;
  label: string;
}

/**
 * Feature detection。
 * 1. document.modelContext（現行仕様）
 * 2. navigator.modelContext（Chrome 149 以前・非推奨の別名）
 * 3. どちらも無ければアプリ内 shim（ゲームは普通に遊べる）
 */
export function detectWebMcp(): WebMcpEnvironment {
  const fromDocument = typeof document !== 'undefined' ? document.modelContext : undefined;
  if (fromDocument) {
    return {
      mode: 'document',
      provider: fromDocument,
      canDiscover: hasDiscovery(fromDocument),
      label: 'document.modelContext（ネイティブ）',
    };
  }
  const fromNavigator = typeof navigator !== 'undefined' ? navigator.modelContext : undefined;
  if (fromNavigator) {
    return {
      mode: 'navigator',
      provider: fromNavigator,
      canDiscover: hasDiscovery(fromNavigator),
      label: 'navigator.modelContext（旧API・非推奨）',
    };
  }
  return {
    mode: 'shim',
    provider: new LocalModelContext(),
    canDiscover: true,
    label: 'ローカルshim（WebMCP非対応ブラウザ）',
  };
}

function hasDiscovery(mc: ModelContextLike): boolean {
  return typeof mc.getTools === 'function' && typeof mc.executeTool === 'function';
}
