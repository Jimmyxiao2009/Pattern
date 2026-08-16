<script lang="ts">
  import {onMount} from 'svelte';
  import {Archive, Eye, Pencil, RefreshCw, Search, Sparkles, Trash2, X} from 'lucide-svelte';
  import PageHeader from './PageHeader.svelte';
  import {runtime} from './runtime';
  import type {PatternRecord, PatternEvidenceRecord, PatternStatus, PatternCategory} from '@pattern/protocol';

  let {notify}: {notify: (message: string) => void} = $props();

  let patterns = $state<PatternRecord[]>([]);
  let query = $state('');
  let statusFilter = $state<string>('all');
  let categoryFilter = $state<string>('all');
  let offline = $state(false);
  let consolidatedAt = $state<number | null>(null);

  // detail drawer state
  let detail = $state<{pattern: PatternRecord; evidence: PatternEvidenceRecord[]; memoryTexts: Record<string, string>} | null>(null);
  let editing = $state<PatternRecord | null>(null);
  let editText = $state('');

  const statusLabels: Record<PatternStatus, string> = {
    candidate: '候选',
    active: '已确立',
    weakening: '减弱中',
    contradicted: '被反驳',
    archived: '已归档',
  };
  const categoryLabels: Record<PatternCategory, string> = {
    behavior: '行为',
    preference: '偏好',
    relationship: '关系',
    state: '状态',
    work_style: '工作方式',
    communication: '交流方式',
    routine: '习惯',
    other: '其他',
  };

  const visible = $derived(
    patterns
      .filter((p) => statusFilter === 'all' || p.status === statusFilter)
      .filter((p) => categoryFilter === 'all' || p.category === categoryFilter),
  );

  const statusCounts = $derived({
    active: patterns.filter((p) => p.status === 'active').length,
    candidate: patterns.filter((p) => p.status === 'candidate').length,
    weakening: patterns.filter((p) => p.status === 'weakening').length,
  });

  async function refresh() {
    const connected = await runtime.connect();
    offline = !connected;
    if (!connected) return;
    const res = await runtime.request<any>({
      type: 'pattern.list',
      id: crypto.randomUUID(),
      query: query.trim() || null,
      limit: 200,
    });
    if (res.type === 'pattern.list.result') patterns = res.items || [];
  }

  onMount(() => {
    void refresh();
    return runtime.on((message: any) => {
      if (message.type === 'pattern.changed') void refresh();
    });
  });

  async function openDetail(pattern: PatternRecord) {
    if (!(await runtime.connect())) {
      notify('运行时未连接');
      return;
    }
    const res = await runtime.request<any>({type: 'pattern.get', id: crypto.randomUUID(), patternId: pattern.id});
    if (res.type !== 'pattern.get.result' || !res.pattern) {
      notify('无法读取 Pattern 详情');
      return;
    }
    // fetch source memory texts for explainability
    const memoryTexts: Record<string, string> = {};
    const memRes = await runtime.request<any>({type: 'memory.list', id: crypto.randomUUID(), query: null});
    if (memRes.type === 'memory.list.result') {
      for (const item of memRes.items || []) memoryTexts[item.id] = item.text;
    }
    detail = {pattern: res.pattern, evidence: res.pattern.evidence || [], memoryTexts};
  }

  async function archivePattern(pattern: PatternRecord) {
    if (!(await runtime.connect())) return;
    const res = await runtime.request<any>({type: 'pattern.archive', id: crypto.randomUUID(), patternId: pattern.id});
    if (res.type === 'pattern.archive.result' && res.ok) {
      notify('Pattern 已归档');
      if (detail?.pattern.id === pattern.id) detail = null;
      await refresh();
    }
  }

  async function deletePattern(pattern: PatternRecord) {
    if (!(await runtime.connect())) return;
    const res = await runtime.request<any>({type: 'pattern.delete', id: crypto.randomUUID(), patternId: pattern.id});
    if (res.type === 'pattern.delete.result' && res.ok) {
      notify('Pattern 已删除');
      if (detail?.pattern.id === pattern.id) detail = null;
      await refresh();
    }
  }

  async function consolidate() {
    if (!(await runtime.connect())) return;
    const res = await runtime.request<any>({type: 'pattern.consolidate', id: crypto.randomUUID()});
    if (res.type === 'pattern.consolidate.result') {
      consolidatedAt = res.at;
      notify(`固化完成：升级 ${res.promoted} · 减弱 ${res.weakened} · 反驳 ${res.contradicted} · 归档 ${res.archived} · 合并 ${res.merged}`);
      await refresh();
    }
  }

  function openEdit(pattern: PatternRecord) {
    editing = pattern;
    editText = pattern.text;
  }

  async function saveEdit() {
    if (!editing || !editText.trim()) return;
    if (!(await runtime.connect())) return;
    const res = await runtime.request<any>({
      type: 'pattern.update',
      id: crypto.randomUUID(),
      patternId: editing.id,
      text: editText.trim(),
    });
    if (res.type === 'pattern.update.result') {
      notify('描述已更新');
      editing = null;
      await refresh();
    }
  }

  function confidenceTone(confidence: number) {
    if (confidence >= 0.66) return 'green';
    if (confidence >= 0.4) return 'amber';
    return 'dim';
  }

  function formatDate(ts: number) {
    return new Date(ts * 1000).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
  }
</script>

<section class="view patterns-view">
  <PageHeader
    eyebrow="Pattern"
    title="长期认识"
    subtitle="从大量记忆中逐渐形成的对用户的稳定认识。每一条都附带证据，可解释为什么这么认为。"
  >
    <button class="quiet-button" onclick={() => void refresh()}><RefreshCw size={14} />刷新</button>
    <button class="primary-button" onclick={() => void consolidate()}><Sparkles size={14} />固化 Pattern</button>
  </PageHeader>

  {#if offline}
    <p class="settings-note" style="padding:0 42px 12px">运行时未连接，列表可能不是最新状态。</p>
  {/if}

  <div class="proactive-overview">
    <article>
      <span class="overview-icon green"><Eye size={16} /></span>
      <div><strong>{statusCounts.active}</strong><small>已确立</small></div>
    </article>
    <article>
      <span class="overview-icon blue"><Search size={16} /></span>
      <div><strong>{statusCounts.candidate}</strong><small>候选中</small></div>
    </article>
    <article>
      <span class="overview-icon amber"><Sparkles size={16} /></span>
      <div><strong>{statusCounts.weakening}</strong><small>减弱中</small></div>
    </article>
  </div>

  <div class="toolbar">
    <label class="search-box"><Search size={15} /><input bind:value={query} oninput={() => void refresh()} placeholder="搜索 Pattern" /></label>
    <div class="filters">
      {#each [['all', '全部'], ['active', '已确立'], ['candidate', '候选'], ['weakening', '减弱'], ['contradicted', '被反驳'], ['archived', '已归档']] as [value, label]}
        <button class:active={statusFilter === value} onclick={() => statusFilter = value}>{label}</button>
      {/each}
    </div>
  </div>

  {#if consolidatedAt}
    <div class="consolidation">
      <span>✦</span>
      <div>
        <strong>最近 Pattern 固化</strong>
        <p>{new Date(consolidatedAt * 1000).toLocaleString('zh-CN')} 完成了候选升级、置信度衰减与重复合并。</p>
      </div>
    </div>
  {/if}

  <div class="pattern-grid">
    {#each visible as pattern (pattern.id)}
      <article class="pattern-card" class:dim={pattern.status === 'archived' || pattern.status === 'contradicted'}>
        <div class="pattern-card-head">
          <span
            class="badge"
            class:green={pattern.status === 'active'}
            class:blue={pattern.status === 'candidate'}
            class:amber={pattern.status === 'weakening'}
            class:danger={pattern.status === 'contradicted'}
            class:dim={pattern.status === 'archived'}
          >{statusLabels[pattern.status]}</span>
          <span class="badge dim">{categoryLabels[pattern.category] || pattern.category}</span>
          <span class="badge {confidenceTone(pattern.confidence)}" title="置信度">
            {Math.round(pattern.confidence * 100)}%
          </span>
        </div>
        <p class="pattern-text">{pattern.text}</p>
        <footer>
          <span>{pattern.evidenceCount} 条证据 · 最近观察 {formatDate(pattern.lastObservedAt)}</span>
          <button class="text-action" title="查看证据" aria-label="查看证据" onclick={() => openDetail(pattern)}><Eye size={13} /></button>
          <button class="text-action" title="编辑描述" aria-label="编辑描述" onclick={() => openEdit(pattern)}><Pencil size={13} /></button>
          <button class="text-action" title="归档" aria-label="归档" onclick={() => archivePattern(pattern)}><Archive size={13} /></button>
          <button title="删除" aria-label="删除 Pattern" onclick={() => deletePattern(pattern)}><Trash2 size={13} /></button>
        </footer>
      </article>
    {:else}
      <div class="blank-state">
        <div class="blank-mark">◈</div>
        <h3>{query || statusFilter !== 'all' ? '没有匹配的 Pattern' : '还没有形成 Pattern'}</h3>
        <p>Pattern 会从你的长期记忆中自动浮现。多聊一些生活与工作，让她慢慢认识你。</p>
      </div>
    {/each}
  </div>
</section>

{#if detail}
  <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) detail = null; }}>
    <div class="memory-editor pattern-detail" role="dialog" aria-modal="true" aria-labelledby="pattern-detail-title">
      <header>
        <div>
          <p class="eyebrow">Pattern · 证据</p>
          <h2 id="pattern-detail-title">{detail.pattern.text}</h2>
        </div>
        <button aria-label="关闭" onclick={() => (detail = null)}><X size={16} /></button>
      </header>
      <div class="pattern-detail-meta">
        <span class="badge">{statusLabels[detail.pattern.status]}</span>
        <span class="badge {confidenceTone(detail.pattern.confidence)}">置信度 {Math.round(detail.pattern.confidence * 100)}%</span>
        <span class="badge dim">最近观察 {formatDate(detail.pattern.lastObservedAt)}</span>
      </div>
      {#if detail.evidence.length}
        <ul class="pattern-evidence">
          {#each detail.evidence as ev (ev.id)}
            <li class:supports={ev.relation === 'supports'} class:contradicts={ev.relation === 'contradicts'}>
              <span class="ev-relation">{ev.relation === 'supports' ? '支持' : '反对'}</span>
              <span class="ev-text">{detail.memoryTexts[ev.memoryId] || '（原始记忆已失效）'}</span>
              <time>{formatDate(ev.createdAt)}</time>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="settings-note">这条 Pattern 暂时没有关联证据。</p>
      {/if}
      <footer>
        <button onclick={() => detail && archivePattern(detail.pattern)}>归档</button>
        <button onclick={() => (detail = null)}>关闭</button>
      </footer>
    </div>
  </div>
{/if}

{#if editing}
  <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) editing = null; }}>
    <div class="memory-editor" role="dialog" aria-modal="true" aria-labelledby="pattern-edit-title">
      <header>
        <div>
          <p class="eyebrow">Pattern · 编辑</p>
          <h2 id="pattern-edit-title">修改描述</h2>
        </div>
        <button aria-label="关闭" onclick={() => (editing = null)}><X size={16} /></button>
      </header>
      <label>
        一句稳定的、可观察的描述
        <textarea bind:value={editText} rows="4" maxlength="400" placeholder="例如：用户在项目冲刺阶段容易推迟睡眠"></textarea>
        <small class="field-help">描述应是可观察的行为或习惯，而不是诊断或评价。</small>
      </label>
      <footer>
        <button onclick={() => (editing = null)}>取消</button>
        <button class="primary-button" onclick={saveEdit}>保存</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .pattern-grid{display:flex;flex-direction:column;gap:8px;padding:0 42px 24px}
  .pattern-card{display:flex;flex-direction:column;gap:10px;padding:16px 18px;background:var(--surface);border:1px solid var(--line);border-radius:8px;transition:border-color .15s ease}
  .pattern-card:hover{border-color:var(--line-strong)}
  .pattern-card.dim{opacity:.55}
  .pattern-card-head{display:flex;align-items:center;gap:6px}
  .pattern-text{margin:0;font-size:13.5px;line-height:1.55;color:var(--ink)}
  .pattern-card footer{display:flex;align-items:center;gap:8px}
  .pattern-card footer span{flex:1;font-size:10.5px;color:var(--faint)}
  .pattern-card footer button{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;color:var(--faint)}
  .pattern-card footer button:hover{color:var(--ink);background:var(--surface-3)}
  .pattern-detail-meta{display:flex;gap:6px;flex-wrap:wrap}
  .pattern-evidence{display:flex;flex-direction:column;gap:8px;margin:4px 0 0;padding:0;list-style:none;max-height:320px;overflow:auto}
  .pattern-evidence li{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:6px;background:var(--surface-2)}
  .pattern-evidence li.supports{border-left:2px solid var(--green,#5dbd8a)}
  .pattern-evidence li.contradicts{border-left:2px solid var(--danger)}
  .ev-relation{font-size:10px;font-weight:600;letter-spacing:.4px}
  .pattern-evidence li.supports .ev-relation{color:var(--green,#5dbd8a)}
  .pattern-evidence li.contradicts .ev-relation{color:var(--danger)}
  .ev-text{font-size:12.5px;line-height:1.5;color:var(--ink)}
  .pattern-evidence time{font-size:10px;color:var(--faint)}
</style>
