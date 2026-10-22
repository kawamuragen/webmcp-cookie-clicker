import { describe, expect, it, vi } from 'vitest';
import { LocalModelContext } from '../src/webmcp/shim.ts';
import { ToolRegistry, type ToolSpec } from '../src/webmcp/registry.ts';

function makeRegistry() {
  const provider = new LocalModelContext();
  const registry = new ToolRegistry({ mode: 'shim', provider, canDiscover: true, label: 'test' });
  return { provider, registry };
}

const spec = (over: Partial<ToolSpec> = {}): ToolSpec => ({
  name: 'echo',
  title: 'Echo',
  description: 'echo input',
  inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  run: (input) => ({ ok: true, input }),
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ToolRegistry', () => {
  it('sync で登録し、getTools から見える', async () => {
    const { provider, registry } = makeRegistry();
    registry.sync([spec()]);
    await flush();
    expect((await provider.getTools()).map((t) => t.name)).toEqual(['echo']);
  });

  it('spec から消えたツールは AbortSignal で登録解除される', async () => {
    const { provider, registry } = makeRegistry();
    const changes = vi.fn();
    provider.addEventListener('toolchange', changes);
    registry.sync([spec()]);
    await flush();
    registry.sync([]);
    await flush();
    expect(await provider.getTools()).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('description が変わると同じ名前で再登録される', async () => {
    const { provider, registry } = makeRegistry();
    registry.sync([spec()]);
    await flush();
    registry.sync([spec({ description: 'changed' })]);
    await flush();
    const tools = await provider.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe('changed');
    expect(registry.entries[0].revision).toBe(2);
  });

  it('同じ signature なら再登録しない', async () => {
    const { registry } = makeRegistry();
    registry.sync([spec()]);
    registry.sync([spec()]);
    await flush();
    expect(registry.entries[0].revision).toBe(1);
  });

  it('invoke は executeTool 経由で呼び出し元を記録する', async () => {
    const { registry } = makeRegistry();
    const calls: string[] = [];
    registry.addEventListener('registry', (e) => {
      const d = (e as CustomEvent).detail;
      if (d.type === 'call' && d.record.status !== 'pending') calls.push(d.record.source);
    });
    registry.sync([spec()]);
    await flush();
    const result = await registry.invoke('autopilot', 'echo', { n: 2 });
    expect(result).toEqual({ ok: true, input: { n: 2 } });
    expect(calls).toEqual(['autopilot']);
  });

  it('入力がスキーマ違反なら理由つきのエラーオブジェクトを返す（reject しない）', async () => {
    const { registry } = makeRegistry();
    registry.sync([spec()]);
    await flush();
    const result = (await registry.invoke('manual', 'echo', { n: 0, extra: true })) as { error: string; details: string[] };
    expect(result.error).toBe('invalid_input');
    expect(result.details.join('\n')).toMatch(/1 以上/);
    expect(result.details.join('\n')).toMatch(/未知のパラメータ/);
  });

  it('例外は internal_error として返る', async () => {
    const { registry } = makeRegistry();
    registry.sync([spec({ run: () => { throw new Error('boom'); } })]);
    await flush();
    expect(await registry.invoke('manual', 'echo', {})).toMatchObject({ ok: false, error: 'internal_error' });
  });
});
