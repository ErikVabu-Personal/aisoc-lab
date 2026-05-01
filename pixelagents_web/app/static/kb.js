/* kb.js — Configuration → Knowledge.
 *
 * Renders one card per Foundry IQ knowledge base, with:
 *   - label + description
 *   - current document count (read from /api/kb/stats)
 *   - last-indexer-run timestamp + status
 *   - which agents query this KB
 *   - a "Refresh now" button that POSTs /api/kb/refresh/<name>
 *
 * Soc-manager-only. The page just won't render for other roles.
 */

(function () {
  'use strict';

  const ROOT_SEL = '#aisoc-kb-root';

  // ---- helpers -----------------------------------------------------

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'onclick') e.addEventListener('click', v);
        else if (v != null) e.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function fmtCount(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString();
  }

  function fmtRelative(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const diff = Date.now() - t;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
  }

  function setStatus(card, kind, text) {
    const slot = card.querySelector('[data-status]');
    if (!slot) return;
    slot.textContent = text;
    slot.dataset.kind = kind || '';
  }

  // ---- API ---------------------------------------------------------

  async function fetchStats() {
    const r = await fetch('/api/kb/stats', { credentials: 'same-origin' });
    if (!r.ok) {
      throw new Error(`/api/kb/stats returned ${r.status}`);
    }
    return await r.json();
  }

  async function triggerRefresh(kbName) {
    const r = await fetch(`/api/kb/refresh/${encodeURIComponent(kbName)}`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`refresh failed: HTTP ${r.status} ${txt.slice(0, 200)}`);
    }
    return await r.json();
  }

  // ---- rendering ---------------------------------------------------

  function renderCard(kb) {
    const head = el('div', { class: 'kb-card-head' },
      el('div', { class: 'kb-title' },
        el('span', { class: 'kb-label' }, kb.label || kb.name),
        el('span', { class: 'kb-name' }, kb.name),
      ),
      el('div', { 'data-status': '', class: 'kb-status' }),
    );

    const stats = el('div', { class: 'kb-stats' },
      el('div', { class: 'kb-stat' },
        el('div', { class: 'kb-stat-label' }, 'Documents'),
        el('div', { class: 'kb-stat-value' }, fmtCount(kb.doc_count)),
      ),
      el('div', { class: 'kb-stat' },
        el('div', { class: 'kb-stat-label' }, 'Last indexer run'),
        el('div', { class: 'kb-stat-value' },
          kb.last_run && kb.last_run.ended
            ? `${kb.last_run.status || '?'} · ${fmtRelative(kb.last_run.ended)}`
            : (kb.last_run && kb.last_run.status) || '—'
        ),
      ),
      el('div', { class: 'kb-stat' },
        el('div', { class: 'kb-stat-label' }, 'Index'),
        el('div', { class: 'kb-stat-value kb-mono' }, kb.index || '—'),
      ),
    );

    const desc = kb.description
      ? el('p', { class: 'kb-desc' }, kb.description)
      : null;

    const agents = (kb.agents && kb.agents.length)
      ? el('div', { class: 'kb-agents' },
          el('span', { class: 'kb-agents-label' }, 'Used by:'),
          ...kb.agents.map(a => el('span', { class: 'kb-agent-pill' }, a)),
        )
      : null;

    const refreshBtn = el('button', {
      class: 'kb-refresh-btn',
      type: 'button',
      onclick: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'Refreshing…';
        setStatus(card, 'pending', 'indexer triggered');
        try {
          await triggerRefresh(kb.name);
          // The indexer takes ~30-60s to drain. Re-fetch stats
          // after a short delay so the count updates.
          setStatus(card, 'pending', 'indexer running… (counts update in ~30s)');
          setTimeout(() => { reloadStats(); }, 30 * 1000);
        } catch (e) {
          setStatus(card, 'error', String(e.message || e));
        } finally {
          btn.disabled = false;
          btn.textContent = orig;
        }
      },
    }, 'Refresh now');

    const err = kb.error
      ? el('div', { class: 'kb-error' }, kb.error)
      : null;

    const card = el('div', { class: 'kb-card' },
      head,
      desc,
      stats,
      agents,
      err,
      el('div', { class: 'kb-actions' }, refreshBtn),
    );
    return card;
  }

  function renderAll(payload) {
    const root = document.querySelector(ROOT_SEL);
    if (!root) return;
    root.innerHTML = '';

    const meta = el('div', { class: 'kb-meta' },
      el('div', { class: 'kb-meta-info' },
        el('span', { class: 'kb-meta-label' }, 'Search service:'),
        ' ',
        el('span', { class: 'kb-mono' }, payload.service || payload.endpoint || '—'),
        // Diagnostic hints — small, muted. Surfaces whether the page
        // is reading env vars or falling back. If something looks
        // off (no docs, no service), this tells you which side of
        // the pipeline to check.
        ...(payload.descriptors_source === 'builtin'
          ? [el('span', { class: 'kb-meta-hint' },
              ' · descriptors: builtin defaults (env var unset or empty)')]
          : []),
        ...(payload.endpoint_source === 'arm-fallback'
          ? [el('span', { class: 'kb-meta-hint' },
              ' · endpoint resolved via ARM (env var unset)')]
          : []),
        ...(payload.endpoint_source === 'missing'
          ? [el('span', { class: 'kb-meta-hint kb-meta-warn' },
              ' · WARNING: Search endpoint not found (env var unset, ARM lookup failed)')]
          : []),
      ),
      el('button', {
        type: 'button',
        class: 'kb-reload-btn',
        onclick: () => reloadStats(),
      }, 'Reload counts'),
    );
    root.appendChild(meta);

    const list = el('div', { class: 'kb-list' });
    const kbs = payload.knowledge_bases || [];
    if (kbs.length === 0) {
      list.appendChild(el('div', { class: 'kb-empty' },
        'No knowledge bases configured.'));
    } else {
      for (const kb of kbs) list.appendChild(renderCard(kb));
    }
    root.appendChild(list);
  }

  async function reloadStats() {
    const root = document.querySelector(ROOT_SEL);
    if (!root) return;
    root.innerHTML = '<p class="kb-loading">Loading knowledge bases…</p>';
    try {
      const data = await fetchStats();
      renderAll(data);
    } catch (e) {
      root.innerHTML = '';
      root.appendChild(el('div', { class: 'kb-error' },
        `Failed to load: ${e.message || e}`));
    }
  }

  // ---- styles (scoped) --------------------------------------------

  const style = document.createElement('style');
  style.textContent = `
    #aisoc-kb-root .kb-loading { color: #6a7e94; }

    #aisoc-kb-root .kb-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 18px;
      padding: 10px 14px;
      background: #f6f8fb;
      border: 1px solid rgba(14,37,65,0.10);
      border-radius: 3px;
      font-size: 13px;
    }
    #aisoc-kb-root .kb-meta-info { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
    #aisoc-kb-root .kb-meta-label { color: #6a7e94; }
    #aisoc-kb-root .kb-meta-hint { color: #6a7e94; font-size: 11.5px; }
    #aisoc-kb-root .kb-meta-warn { color: #a63427; font-weight: 600; }
    #aisoc-kb-root .kb-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #aisoc-kb-root .kb-reload-btn {
      margin-left: auto;
      padding: 5px 12px;
      border: 1px solid rgba(14,37,65,0.18);
      background: #ffffff;
      border-radius: 3px;
      font-size: 12px;
      cursor: pointer;
    }
    #aisoc-kb-root .kb-reload-btn:hover {
      border-color: #2c5680;
      color: #2c5680;
    }

    #aisoc-kb-root .kb-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
      gap: 14px;
    }
    #aisoc-kb-root .kb-card {
      background: #ffffff;
      border: 1px solid rgba(14,37,65,0.12);
      border-radius: 4px;
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    #aisoc-kb-root .kb-card-head {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    #aisoc-kb-root .kb-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #aisoc-kb-root .kb-label {
      font-weight: 600;
      font-size: 15px;
      color: #0e2541;
    }
    #aisoc-kb-root .kb-name {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11.5px;
      color: #6a7e94;
    }
    #aisoc-kb-root .kb-status {
      margin-left: auto;
      font-size: 11.5px;
      color: #6a7e94;
      max-width: 50%;
      text-align: right;
    }
    #aisoc-kb-root .kb-status[data-kind="pending"] { color: #b07406; }
    #aisoc-kb-root .kb-status[data-kind="error"] { color: #a63427; }

    #aisoc-kb-root .kb-desc {
      margin: 0;
      color: #2a4566;
      font-size: 13px;
      line-height: 1.45;
    }
    #aisoc-kb-root .kb-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      padding: 10px 12px;
      background: #f6f8fb;
      border: 1px solid rgba(14,37,65,0.08);
      border-radius: 3px;
    }
    #aisoc-kb-root .kb-stat-label {
      color: #6a7e94;
      font-size: 10.5px;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      font-weight: 600;
    }
    #aisoc-kb-root .kb-stat-value {
      font-size: 16px;
      font-weight: 600;
      color: #0e2541;
      margin-top: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.01em;
      word-break: break-word;
    }

    #aisoc-kb-root .kb-agents {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      font-size: 12px;
    }
    #aisoc-kb-root .kb-agents-label {
      color: #6a7e94;
      margin-right: 4px;
    }
    #aisoc-kb-root .kb-agent-pill {
      padding: 2px 8px;
      background: rgba(44,86,128,0.10);
      color: #2c5680;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 500;
      letter-spacing: 0.01em;
    }

    #aisoc-kb-root .kb-error {
      padding: 8px 12px;
      color: #a63427;
      background: rgba(166,52,39,0.06);
      border: 1px solid rgba(166,52,39,0.30);
      border-radius: 3px;
      font-size: 12px;
    }
    #aisoc-kb-root .kb-actions {
      display: flex;
      justify-content: flex-end;
    }
    #aisoc-kb-root .kb-refresh-btn {
      padding: 6px 14px;
      border: 1px solid #2c5680;
      background: #ffffff;
      color: #2c5680;
      border-radius: 3px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    #aisoc-kb-root .kb-refresh-btn:hover {
      background: #2c5680;
      color: #ffffff;
    }
    #aisoc-kb-root .kb-refresh-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    #aisoc-kb-root .kb-empty {
      padding: 18px;
      text-align: center;
      color: #6a7e94;
      border: 1px dashed rgba(14,37,65,0.15);
      border-radius: 3px;
    }
  `;
  document.head.appendChild(style);

  // ---- boot --------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reloadStats);
  } else {
    reloadStats();
  }
})();
