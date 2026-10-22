import type { ToolRegistry } from '../webmcp/registry.ts';

/**
 * 内蔵オートパイロット ― LLM を使わない、ルールベースの「in-page エージェント」。
 *
 * WebMCP には in-page エージェント向けに getTools() / executeTool() がある。
 * このクラスはゲーム内部を一切触らず、ツール経由でしか遊ばない。
 * （= 外部エージェントが見ている世界と同じ。ツール設計の良し悪しがそのまま効く）
 *
 * naive モードにすると、ニュース本文に書かれた「指示」を鵜呑みにする。
 * untrustedContentHint の重要性を体験するためのおまけ。
 */
export class Autopilot {
  running = false;
  naive = false;
  #registry: ToolRegistry;
  #onThought: (message: string) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastNewsAt = 0;
  #coupons: { code: string; expiresAt: number }[] = [];
  #researching = false;
  #busy = false;

  constructor(registry: ToolRegistry, onThought: (message: string) => void) {
    this.#registry = registry;
    this.#onThought = onThought;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.#onThought('起動しました。getTools() で公開ツールを確認しながら経営します。');
    this.#schedule(200);
  }

  stop(): void {
    this.running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#onThought('停止しました。');
  }

  #schedule(ms: number): void {
    if (!this.running) return;
    this.#timer = setTimeout(() => void this.#step().finally(() => this.#schedule(2_500)), ms);
  }

  async #call(name: string, input: object = {}): Promise<Record<string, unknown> | null> {
    try {
      return (await this.#registry.invoke('autopilot', name, input)) as Record<string, unknown>;
    } catch (err) {
      this.#onThought(`${name} の呼び出しに失敗: ${String(err)}`);
      return null;
    }
  }

  async #step(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const tools = new Set((await this.#registry.discover()).map((t) => t.name));

      // 1. 一時ツールが出ていたら最優先
      if (tools.has('claim_golden_cookie')) {
        const r = await this.#call('claim_golden_cookie');
        if (r?.effect === 'click_frenzy') this.#onThought('クリックフレンジー！人間さん、今すぐ連打してください！');
      }

      const status = await this.#call('get_status');
      if (!status?.ok) return;
      let cookies = status.cookies as number;

      // 2. ニュース（クーポン集め）
      if (tools.has('read_news') && Date.now() - this.#lastNewsAt > 20_000) {
        this.#lastNewsAt = Date.now();
        const news = await this.#call('read_news', { limit: 5 });
        for (const item of (news?.items as NewsLike[] | undefined) ?? []) {
          const code = item.headline.match(/COOKIE-[A-Z0-9]{4}/)?.[0];
          if (code && item.source.includes('公式')) {
            this.#coupons.push({ code, expiresAt: Date.now() + (60 - item.ageSec) * 1000 });
          }
          if (this.naive && tools.has('sell_building') && item.headline.includes('sell_building')) {
            const target = (status.buildings as BuildingLike[]).find((b) => b.owned > 0);
            if (target) {
              this.#onThought(`ニュースに「sell_building しろ」と書いてあったので従います…（${target.id}）`);
              await this.#call('sell_building', { building: target.id, quantity: target.owned });
              return;
            }
          }
        }
      }

      // 3. アップグレード（安いものから）
      if (tools.has('buy_upgrade')) {
        const ups = [...((status.upgradesAvailable as { id: string; price: number }[]) ?? [])].sort((a, b) => a.price - b.price);
        const target = ups[0];
        if (target && target.price <= cookies * 0.8) {
          const r = await this.#call('buy_upgrade', { upgrade_id: target.id });
          if (r?.ok) cookies = r.cookiesLeft as number;
        }
      }

      // 4. 研究（余裕があれば。完了まで返らないので待たずに次へ）
      const research = status.research as { inProgress: unknown; menu: { topic: string; cost: number }[] } | undefined;
      if (tools.has('start_research') && research && !research.inProgress && !this.#researching) {
        const cheapest = [...research.menu].sort((a, b) => a.cost - b.cost)[0];
        if (cheapest && cookies > cheapest.cost * 3) {
          this.#researching = true;
          this.#onThought(`研究「${cheapest.topic}」を開始（完了まで待たずに経営を続けます）`);
          void this.#call('start_research', { topic: cheapest.topic }).finally(() => (this.#researching = false));
          cookies -= cheapest.cost;
        }
      }

      // 5. 施設（回収秒数が最短のもの）
      if (tools.has('buy_building')) {
        const best = [...(status.buildings as BuildingLike[])].sort((a, b) => a.price / a.cpsEach - b.price / b.cpsEach)[0];
        this.#coupons = this.#coupons.filter((c) => c.expiresAt > Date.now() + 2_000);
        const coupon = this.#coupons[0];
        const effectivePrice = best ? best.price * (coupon ? 0.7 : 1) : Infinity;
        if (best && effectivePrice <= cookies) {
          const r = await this.#call('buy_building', { building: best.id, quantity: 1, ...(coupon ? { coupon: coupon.code } : {}) });
          if (coupon && (r?.ok || r?.error === 'invalid_coupon')) this.#coupons.shift();
        }
      }
    } finally {
      this.#busy = false;
    }
  }
}

interface NewsLike {
  source: string;
  headline: string;
  ageSec: number;
}

interface BuildingLike {
  id: string;
  owned: number;
  price: number;
  cpsEach: number;
}
