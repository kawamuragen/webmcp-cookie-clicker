import './style.css';
import { Autopilot } from './agent/autopilot.ts';
import { APPROVAL_LIMITS, BUILDINGS, GOAL_LIFETIME, GRANTS, RESEARCH, UPGRADES, type GrantId } from './game/data.ts';
import { APPROVAL_TIMEOUT_MS, Game, type GameLog } from './game/engine.ts';
import { clearSavedState, loadState, saveState } from './game/state.ts';
import { buildToolSpecs } from './game/tools.ts';
import { clock, esc, fmt, fmtDuration, fmtRate, patch } from './ui/format.ts';
import { LogPanel, type LogCategory } from './ui/log.ts';
import { detectWebMcp } from './webmcp/detect.ts';
import { ToolRegistry, type RegistryEvent } from './webmcp/registry.ts';
import { exampleFor } from './webmcp/schema.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ───────── 初期化 ─────────

const env = detectWebMcp();
const game = new Game(loadState() ?? undefined);
const registry = new ToolRegistry(env);
const log = new LogPanel($('log'));
const autopilot = new Autopilot(registry, (m) => log.tool('🦾', `<span class="thought">${esc(m)}</span>`));

// WebMCP の状態バッジ
const badge = $('webmcp-badge');
badge.textContent = env.mode === 'shim' ? '⚠️ WebMCP 非対応（shim で動作）' : `✅ ${env.mode}.modelContext`;
badge.className = `badge badge-${env.mode}`;
badge.title = `${env.label}\ngetTools/executeTool: ${env.canDiscover ? 'あり' : 'なし'}`;

log.tool('🔌', `WebMCP 検出: <b>${esc(env.label)}</b>${env.canDiscover ? '' : '（getTools/executeTool なし：手動操作は直接呼び出し）'}`);
if (env.mode === 'navigator') {
  log.tool('⚠️', '<code>navigator.modelContext</code> は非推奨です。Chrome 150 以降は <code>document.modelContext</code> を使います。');
}

// ───────── イベント配線 ─────────

const updating = new Set<string>();
let toolchangeCount = 0;

registry.addEventListener('registry', (e) => {
  const ev = (e as CustomEvent<RegistryEvent>).detail;
  switch (ev.type) {
    case 'call':
      log.call(ev.record);
      // 呼び出しで状態が変わったら、次の tick を待たずにツール定義を更新する
      // （古い enum のまま次の呼び出しが来る時間を短くする）
      if (ev.record.status !== 'pending') queueMicrotask(tick);
      break;
    case 'registered':
      if (updating.delete(ev.name)) {
        log.tool('🔁', `<code>${esc(ev.name)}</code> を再登録（description / inputSchema が変化 → rev ${ev.revision}）`);
      } else {
        log.tool('➕', `<code>${esc(ev.name)}</code> を登録 <span class="muted">registerTool()</span>`);
      }
      break;
    case 'unregistered':
      if (ev.reason === 'updated') updating.add(ev.name);
      else log.tool('➖', `<code>${esc(ev.name)}</code> を登録解除 <span class="muted">AbortController.abort()</span>`);
      break;
    case 'register-failed':
      log.tool('❌', `<code>${esc(ev.name)}</code> の登録に失敗: ${esc(ev.message)}`);
      break;
  }
});

env.provider.addEventListener('toolchange', () => {
  toolchangeCount++;
  $('toolchange-count').textContent = String(toolchangeCount);
});
env.provider.addEventListener('toolcancel', (e) => {
  const name = (e as Event & { toolName?: string }).toolName ?? '?';
  log.tool('🛑', `toolcancel: <code>${esc(name)}</code> の実行がエージェント側でキャンセルされた`);
});

game.addEventListener('game-log', (e) => log.game((e as CustomEvent<GameLog>).detail));

// クッキー
$('big-cookie').addEventListener('click', (e) => {
  const gain = game.click();
  spawnFloater(e as MouseEvent, `+${fmtRate(gain)}`);
});

// data-action によるイベント委譲
document.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  switch (action) {
    case 'buy-grant':
      game.purchaseGrant(id as GrantId);
      break;
    case 'toggle-grant':
      game.toggleGrant(id as GrantId);
      break;
    case 'approve':
    case 'reject':
      game.resolveApproval(Number(id), action === 'approve');
      break;
    case 'cancel-research':
      game.cancelResearch();
      break;
    case 'golden':
      game.claimGolden('human');
      break;
  }
  tick();
});

// 決裁上限
const limitSelect = $<HTMLSelectElement>('approval-limit');
limitSelect.innerHTML = APPROVAL_LIMITS.map(
  (v) => `<option value="${v}">${Number.isFinite(v) ? `${v.toLocaleString()} 枚` : '上限なし（承認不要）'}</option>`,
).join('');
limitSelect.value = String(game.state.approvalLimit);
limitSelect.addEventListener('change', () => {
  game.setApprovalLimit(Number(limitSelect.value));
  game.log({ icon: '📝', message: `決裁上限を ${limitSelect.selectedOptions[0].text} に変更（buy_building の説明文が書き換わる）` });
});

// ログのフィルタ
document.querySelectorAll<HTMLInputElement>('[data-filter]').forEach((cb) =>
  cb.addEventListener('change', () => log.setFilter(cb.dataset.filter as LogCategory, cb.checked)),
);
$('clear-log').addEventListener('click', () => log.clear());

// 手動オペレーション
const manualTool = $<HTMLSelectElement>('manual-tool');
const manualInput = $<HTMLTextAreaElement>('manual-input');
const manualResult = $('manual-result');
manualTool.addEventListener('change', fillManualExample);
$('manual-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = manualTool.value;
  if (!name) return;
  let input: object;
  try {
    input = manualInput.value.trim() ? JSON.parse(manualInput.value) : {};
  } catch (err) {
    manualResult.textContent = `JSON の形式が不正です: ${String(err)}`;
    return;
  }
  manualResult.textContent = '実行中…（承認待ちや長時間実行のツールはしばらく返りません）';
  try {
    const result = await registry.invoke('manual', name, input);
    manualResult.textContent = JSON.stringify(result, null, 2);
  } catch (err) {
    manualResult.textContent = `エラー: ${String(err)}`;
  }
});

$<HTMLInputElement>('autopilot').addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).checked) autopilot.start();
  else autopilot.stop();
});
$<HTMLInputElement>('autopilot-naive').addEventListener('change', (e) => {
  autopilot.naive = (e.target as HTMLInputElement).checked;
});
const devMode = $<HTMLInputElement>('dev-mode');
devMode.checked = game.state.devMode;
devMode.addEventListener('change', () => {
  game.state.devMode = devMode.checked;
});

// confirm() はブラウザ埋め込み環境で使えないことがあるので、2回押しで確定する
const resetButton = $<HTMLButtonElement>('reset');
let resetArmedUntil = 0;
resetButton.addEventListener('click', () => {
  if (Date.now() > resetArmedUntil) {
    resetArmedUntil = Date.now() + 4_000;
    resetButton.textContent = 'もう一度押すと消去';
    setTimeout(() => {
      if (Date.now() >= resetArmedUntil) resetButton.textContent = 'リセット';
    }, 4_000);
    return;
  }
  window.removeEventListener('beforeunload', save);
  clearSavedState();
  location.reload();
});

const save = () => saveState(game.state);
window.addEventListener('beforeunload', save);
setInterval(save, 5_000);

// ───────── 描画 ─────────

let lastTicker = -1;
const openTools = new Set<string>();
$('tools').addEventListener(
  'toggle',
  (e) => {
    const d = e.target as HTMLDetailsElement;
    const name = d.dataset.tool;
    if (!name) return;
    if (d.open) openTools.add(name);
    else openTools.delete(name);
  },
  true,
);

function render(now: number): void {
  const s = game.state;
  $('cookies').textContent = fmt(s.cookies);
  $('cps').textContent = fmtRate(game.cps(now));
  $('click-power').textContent = fmtRate(game.clickPower(now));
  $('play-time').textContent = fmtDuration(s.goalReachedAtMs ?? s.playMs);
  const progress = Math.min(1, s.lifetime / GOAL_LIFETIME);
  $('goal-bar').style.width = `${progress * 100}%`;
  $('goal-text').textContent =
    s.goalReachedAtMs !== null ? `🏆 達成！（${fmtDuration(s.goalReachedAtMs)}）` : `${(progress * 100).toFixed(1)}%`;
  document.title = `${fmt(s.cookies)} 枚 | WebMCP Cookie Clicker`;

  patch(
    $('effects'),
    game.effects.map((e) => `<span class="effect">✨ ${esc(e.label)} あと${Math.ceil((e.until - now) / 1000)}秒</span>`).join(''),
  );

  renderGolden(now);
  renderApprovals(now);
  renderGrants();
  renderBuildings();
  renderResearch(now);
  renderUpgrades();
  renderStats();
  renderTools(now);
  renderManualOptions();

  const latest = game.news.at(-1);
  if (latest && latest.id !== lastTicker) {
    lastTicker = latest.id;
    $('ticker-text').innerHTML = `<b class="news-src">［${esc(latest.source)}］</b>${esc(latest.headline)}`;
    $('ticker-text').className = `news-${latest.kind}`;
  }
}

function renderGolden(now: number): void {
  const g = game.golden;
  patch(
    $('golden-layer'),
    g
      ? `<button class="golden" data-action="golden" type="button" style="left:${g.x * 100}%;top:${g.y * 100}%" aria-label="金のクッキー">🍪</button>`
      : '',
  );
  const btn = $('golden-layer').querySelector<HTMLElement>('.golden');
  if (btn && g) btn.style.opacity = String(Math.min(1, (g.expiresAt - now) / 3000));
}

function renderApprovals(now: number): void {
  const el = $('approvals');
  patch(
    el,
    game.approvals
      .map(
        (a) => `
      <div class="approval" data-id="${a.id}">
        <div class="approval-title">📝 承認依頼 <code>${esc(a.tool)}</code></div>
        <div class="approval-summary">${esc(a.summary)}</div>
        <div class="bar small"><div class="approval-bar"></div></div>
        <div class="approval-actions">
          <button type="button" data-action="approve" data-id="${a.id}">承認</button>
          <button type="button" class="ghost" data-action="reject" data-id="${a.id}">却下</button>
          <span class="approval-left muted"></span>
        </div>
      </div>`,
      )
      .join(''),
  );
  for (const a of game.approvals) {
    const card = el.querySelector<HTMLElement>(`.approval[data-id="${a.id}"]`);
    if (!card) continue;
    const left = Math.max(0, a.expiresAt - now);
    card.querySelector<HTMLElement>('.approval-bar')!.style.width = `${(left / APPROVAL_TIMEOUT_MS) * 100}%`;
    card.querySelector<HTMLElement>('.approval-left')!.textContent = `あと${Math.ceil(left / 1000)}秒（エージェントは応答待ち）`;
  }
}

function renderGrants(): void {
  const s = game.state;
  patch(
    $('grants'),
    GRANTS.map((g) => {
      const slot = s.grants[g.id];
      const tools = g.tools.map((t) => `<code>${t}</code>`).join(' ');
      if (slot.owned) {
        return `<li class="grant owned ${slot.enabled ? 'on' : 'off'}">
          <div class="grant-main"><b>${esc(g.name)}</b> ${tools}<div class="lesson">学べること: ${esc(g.lesson)}</div></div>
          <button type="button" class="ghost small" data-action="toggle-grant" data-id="${g.id}">${slot.enabled ? '取り上げる' : '再委譲'}</button>
        </li>`;
      }
      const met = g.requires(s);
      const affordable = s.cookies >= g.cost;
      return `<li class="grant ${met ? '' : 'locked'}">
        <div class="grant-main"><b>${met ? esc(g.name) : '？？？'}</b> ${met ? tools : ''}
          <div class="lesson">${met ? `学べること: ${esc(g.lesson)}` : `解放条件: ${esc(g.requirementText)}`}</div></div>
        <button type="button" data-action="buy-grant" data-id="${g.id}" ${met && affordable ? '' : 'disabled'}>${fmt(g.cost)} 枚で委譲</button>
      </li>`;
    }).join(''),
  );
}

function renderBuildings(): void {
  const rows = BUILDINGS.map((b) => {
    if (!game.isUnlocked(b)) return `<tr class="locked"><td>❔ ？？？</td><td class="num">-</td><td class="num">-</td><td class="num">-</td></tr>`;
    const owned = game.state.buildings[b.id];
    return `<tr title="${esc(b.flavor)}">
      <td>${b.emoji} ${esc(b.name)} <code class="muted">${b.id}</code></td>
      <td class="num">${owned}</td>
      <td class="num">${fmt(game.price(b.id))}</td>
      <td class="num">${fmtRate(owned * game.buildingCpsEach(b.id))}</td>
    </tr>`;
  });
  patch($('buildings'), rows.join(''));
}

function renderResearch(now: number): void {
  const r = game.research;
  if (!game.state.grants.research.owned) {
    patch($('research'), '');
    return;
  }
  const levels = RESEARCH.map((d) => `${esc(d.name)} Lv${game.state.research[d.id]}`).join(' / ');
  if (!r) {
    patch($('research'), `<h3>研究</h3><div class="muted">${levels}</div>`);
    return;
  }
  const name = RESEARCH.find((d) => d.id === r.topic)!.name;
  patch(
    $('research'),
    `<h3>研究</h3><div class="muted">${levels}</div>
     <div class="research-job">🧪 ${esc(name)} Lv${r.level + 1} を研究中 <span class="research-left"></span>
       <button type="button" class="ghost small" data-action="cancel-research">中止</button></div>
     <div class="bar small"><div class="research-bar"></div></div>`,
  );
  const pct = Math.min(1, (now - r.startedAt) / (r.endsAt - r.startedAt));
  $('research').querySelector<HTMLElement>('.research-bar')!.style.width = `${pct * 100}%`;
  $('research').querySelector<HTMLElement>('.research-left')!.textContent = `あと${Math.ceil((r.endsAt - now) / 1000)}秒`;
}

function renderUpgrades(): void {
  const available = game.availableUpgrades();
  const owned = UPGRADES.filter((u) => game.owns(u.id));
  patch(
    $('upgrades'),
    [
      ...available.map(
        (u) => `<li class="upgrade avail"><b>${esc(u.name)}</b> <code class="muted">${u.id}</code> ${fmt(u.price)} 枚<div class="muted">${esc(u.effectText)}</div></li>`,
      ),
      owned.length
        ? `<li class="owned-list">${owned.map((u) => `<span class="chip" title="${esc(u.effectText)}">✔ ${esc(u.name)}</span>`).join('')}</li>`
        : '',
    ].join('') || '<li class="muted">まだありません</li>',
  );
}

function renderStats(): void {
  const st = game.state.stats;
  const rows: [string, string][] = [
    ['ツール呼び出し', `${st.toolCalls} 回`],
    ['払った手数料', `${fmt(st.feesPaid)} 枚`],
    ['金のクッキー', `人間 ${st.goldenByHuman} / エージェント ${st.goldenByAgent}`],
    ['承認 / 却下', `${st.approvalsApproved} / ${st.approvalsRejected}`],
    ['インジェクション', `耐えた ${st.injectionsResisted} / 釣られた ${st.injectionsFallen}${game.injectionWatch ? '（監視中…）' : ''}`],
    ['クリック', `${game.state.clicks} 回`],
  ];
  if (st.cheats) rows.push(['🧪 チート', `${st.cheats} 回`]);
  patch($('stats'), rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join(''));
}

function renderTools(now: number): void {
  const entries = registry.entries;
  $('tool-count').textContent = String(entries.length);
  patch(
    $('tools'),
    entries
      .map(({ spec, revision, registeredAt }) => {
        const a = spec.annotations ?? {};
        const badges = [
          a.readOnlyHint && '<span class="tag tag-ro">readOnly</span>',
          a.consequentialHint && '<span class="tag tag-cons">consequential</span>',
          a.untrustedContentHint && '<span class="tag tag-untrusted">untrustedContent</span>',
          a.debugging && '<span class="tag tag-debug">debugging</span>',
          spec.expiresAt && `<span class="tag tag-temp">⏳ ${Math.max(0, Math.ceil((spec.expiresAt - now) / 1000))}秒で消滅</span>`,
        ]
          .filter(Boolean)
          .join('');
        return `<li class="tool">
          <details data-tool="${spec.name}"${openTools.has(spec.name) ? ' open' : ''}>
            <summary><code class="tool-name">${spec.name}</code> <span class="tool-title">${esc(spec.title)}</span>${badges}
              <span class="muted rev">rev${revision} · ${clock(registeredAt)}</span></summary>
            ${spec.lesson ? `<div class="lesson">💡 ${esc(spec.lesson)}</div>` : ''}
            <div class="io"><b>description</b><pre>${esc(spec.description)}</pre></div>
            <div class="io"><b>inputSchema</b><pre>${esc(JSON.stringify(spec.inputSchema, null, 2))}</pre></div>
          </details>
        </li>`;
      })
      .join(''),
  );
}

function renderManualOptions(): void {
  const names = registry.entries.map((e) => e.spec.name);
  const current = manualTool.value;
  if (patch(manualTool, names.map((n) => `<option value="${n}">${n}</option>`).join(''))) {
    manualTool.value = names.includes(current) ? current : names[0] ?? '';
    if (manualTool.value !== current) fillManualExample();
  }
  const spec = registry.entries.find((e) => e.spec.name === manualTool.value)?.spec;
  patch($('manual-desc'), spec ? esc(spec.description) : '');
}

function fillManualExample(): void {
  const spec = registry.entries.find((e) => e.spec.name === manualTool.value)?.spec;
  manualInput.value = JSON.stringify(exampleFor(spec?.inputSchema), null, 0);
}

function spawnFloater(e: MouseEvent, text: string): void {
  const el = document.createElement('span');
  el.className = 'floater';
  el.textContent = text;
  const stage = $('big-cookie').parentElement!;
  const rect = stage.getBoundingClientRect();
  const x = e.clientX ? e.clientX - rect.left : rect.width / 2;
  const y = e.clientY ? e.clientY - rect.top : rect.height / 2;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  stage.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

// ───────── メインループ ─────────

function tick(): void {
  const now = Date.now();
  game.tick(now);
  registry.sync(buildToolSpecs(game, now));
  render(now);
}

setInterval(tick, 100);
tick();
