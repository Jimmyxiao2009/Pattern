<script lang="ts">
  type UsageMetric = {
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    requests: number;
    contextWindow?: number;
    balance?: string;
    cost?: number;
    costCurrency?: string;
    lastRequest?: {
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      durationMs?: number;
      cost?: number;
      costCurrency?: string;
      at: number;
    };
    updatedAt: number;
  };

  let {metric, demo = false}: {metric: UsageMetric | null; demo?: boolean} = $props();

  const formatTokens = (value: number | undefined) => {
    if (!Number.isFinite(value)) return '—';
    if ((value || 0) >= 1_000_000) return `${((value || 0) / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if ((value || 0) >= 1_000) return `${((value || 0) / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return Math.round(value || 0).toLocaleString('en-US');
  };
  const formatPercent = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(value >= 10 ? 0 : 2).replace(/\.00$/, '')}%`;
  const formatDuration = (value: number | undefined) => {
    if (!Number.isFinite(value)) return '—';
    const seconds = (value || 0) / 1000;
    return seconds < 1 ? `${Math.max(1, Math.round(value || 0))}毫秒` : `${seconds.toFixed(seconds >= 10 ? 0 : 1).replace(/\.0$/, '')}秒`;
  };
  const formatCost = (value: number | undefined, currency?: string) => {
    if (value === undefined || !Number.isFinite(value)) return '未提供';
    const symbol = (currency || '').toUpperCase() === 'CNY' ? '¥' : (currency || '').toUpperCase() === 'USD' ? '$' : `${currency || ''} `;
    return `${symbol}${value.toFixed(value < 0.01 ? 4 : 2)}`;
  };

  const totalTokens = $derived(metric ? metric.inputTokens + metric.outputTokens : 0);
  const contextWindow = $derived(metric?.contextWindow || 0);
  const contextRatio = $derived(contextWindow ? Math.min(1, totalTokens / contextWindow) : 0);
  const remaining = $derived(contextWindow ? Math.max(0, contextWindow - totalTokens) : 0);
  const aggregateHit = $derived(metric && metric.inputTokens > 0 ? (metric.cachedTokens / metric.inputTokens) * 100 : null);
  const lastHit = $derived(metric?.lastRequest && metric.lastRequest.inputTokens > 0 ? (metric.lastRequest.cachedTokens / metric.lastRequest.inputTokens) * 100 : null);
</script>

<article class="usage-card" class:usage-demo={demo}>
  <header class="usage-card-head">
    <div>
      <p class="usage-eyebrow">{demo ? '演示数据 · 模型用量' : '模型用量'}</p>
      <h3>{metric ? `${formatTokens(totalTokens)} / ${formatTokens(contextWindow)}` : '— / —'} <span>{metric ? formatPercent(contextRatio * 100) : '—'}</span></h3>
    </div>
    {#if metric}<small title={`${metric.provider} · ${metric.model}`}>{metric.model}</small>{:else}<small>连接运行时后显示真实数据</small>{/if}
  </header>
  <div class="usage-track" aria-label="上下文占用">
    <i class="usage-fill" style={`width: ${Math.max(contextRatio * 100, metric && totalTokens ? 1 : 0)}%`}></i>
    <i class="usage-marker" style="left: 30%"></i>
    <i class="usage-marker" style="left: 80%"></i>
  </div>
  <dl class="usage-rows">
    <div><dt>距压缩</dt><dd>{metric ? formatTokens(remaining) : '—'}</dd></div>
    <div><dt>请求数</dt><dd>{metric ? metric.requests.toLocaleString('en-US') : '—'}</dd></div>
    <div><dt>运行时间</dt><dd>{formatDuration(metric?.lastRequest?.durationMs)}</dd></div>
    <div><dt>{metric?.lastRequest ? '本次命中' : '缓存命中'}</dt><dd>{formatPercent(metric?.lastRequest ? lastHit : aggregateHit)}</dd></div>
    <div><dt>本次费用</dt><dd>{formatCost(metric?.lastRequest?.cost, metric?.lastRequest?.costCurrency)}</dd></div>
    <div><dt>累计费用</dt><dd>{formatCost(metric?.cost, metric?.costCurrency)}</dd></div>
    <div><dt>余额</dt><dd class:usage-accent={!!metric?.balance}>{metric?.balance || '未查询'}</dd></div>
  </dl>
  {#if demo}<p class="usage-footnote">演示预览不调用模型，也不会读取账户余额。</p>{:else if metric && !metric.lastRequest}<p class="usage-footnote">当前费用由服务商 usage 返回决定；未提供时不会估算。</p>{/if}
</article>
