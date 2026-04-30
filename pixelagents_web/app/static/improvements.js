// improvements.js
// ────────────────────────────────────────────────────────────────────
// Renders the Continuous Improvement queue — pending proposals from
// the agent fleet (detection rules from the Detection Engineer,
// preamble + agent-instructions edits from the SOC Manager). Server-
// side filtering on /api/changes/pending hides changes the user
// can't act on, so detection engineers only see detection-rule
// items here while SOC managers see everything.

(function () {
  'use strict';

  const ROOT_ID = 'aisoc-improvements-root';
  const POLL_MS = 4000;

  const css = `
    #${ROOT_ID} { font: 14px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    #${ROOT_ID} .ci-empty {
      padding: 60px 20px;
      text-align: center;
      color: #6b7280;
      font-style: italic;
      border: 1px dashed #cbd5e1;
      border-radius: 8px;
      background: #f9fafb;
    }
    #${ROOT_ID} .ci-err {
      padding: 14px 16px;
      background: rgba(239,68,68,0.08);
      border: 1px solid rgba(239,68,68,0.4);
      border-radius: 6px;
      color: #991b1b;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      margin-bottom: 16px;
    }
    #${ROOT_ID} .ci-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-left: 4px solid #facc15;
      border-radius: 8px;
      padding: 16px 18px;
      margin-bottom: 14px;
    }
    #${ROOT_ID} .ci-card.kind-detection-rule       { border-left-color: #f59e0b; }
    #${ROOT_ID} .ci-card.kind-knowledge-preamble   { border-left-color: #7c3aed; }
    #${ROOT_ID} .ci-card.kind-agent-instructions   { border-left-color: #0099cc; }
    #${ROOT_ID} .ci-head {
      display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
      margin-bottom: 10px;
    }
    #${ROOT_ID} .ci-kind {
      flex-shrink: 0;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(0,153,204,0.14);
      color: #1e3a8a;
    }
    #${ROOT_ID} .ci-card.kind-detection-rule     .ci-kind { background: rgba(245,158,11,0.20); color: #92400e; }
    #${ROOT_ID} .ci-card.kind-knowledge-preamble .ci-kind { background: rgba(124,58,237,0.16); color: #4c1d95; }
    #${ROOT_ID} .ci-card.kind-agent-instructions .ci-kind { background: rgba(0,153,204,0.16); color: #1e3a8a; }
    #${ROOT_ID} .ci-title {
      flex: 1;
      min-width: 0;
      font-size: 15px;
      font-weight: 700;
      color: #1f2937;
    }
    #${ROOT_ID} .ci-by {
      font-size: 12px;
      color: #6b7280;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #${ROOT_ID} .ci-target {
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #1e3a8a;
    }
    #${ROOT_ID} .ci-rationale {
      margin: 8px 0 12px;
      font-size: 13px;
      color: #1f2937;
      line-height: 1.5;
    }
    #${ROOT_ID} .ci-section { margin-top: 12px; }
    #${ROOT_ID} .ci-label {
      font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: #6b7280; margin-bottom: 4px;
    }
    #${ROOT_ID} .ci-content {
      padding: 10px 12px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      font-size: 12.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      color: #1f2937;
      max-height: 320px;
      overflow-y: auto;
    }
    #${ROOT_ID} .ci-content.proposed {
      background: rgba(34,197,94,0.06);
      border-color: rgba(34,197,94,0.30);
    }
    #${ROOT_ID} .ci-content.mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    #${ROOT_ID} .ci-actions {
      margin-top: 14px;
      display: flex; gap: 10px; flex-wrap: wrap; align-items: stretch;
    }
    #${ROOT_ID} .ci-actions textarea {
      flex: 1 1 100%;
      resize: vertical;
      min-height: 56px;
      max-height: 200px;
      padding: 8px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      box-sizing: border-box;
      color: #1f2937;
    }
    #${ROOT_ID} .ci-actions textarea:focus {
      outline: none; border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .ci-actions button {
      padding: 7px 16px;
      border-radius: 4px;
      font: 600 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      cursor: pointer;
      border: 1px solid #cbd5e1;
      background: #f9fafb;
      color: #1f2937;
    }
    #${ROOT_ID} .ci-actions button:disabled {
      opacity: 0.5; cursor: not-allowed;
    }
    #${ROOT_ID} .ci-actions button.approve {
      background: #facc15; border-color: #ca8a04; color: #1f2937;
    }
    #${ROOT_ID} .ci-actions button.approve:hover:not(:disabled) {
      background: #eab308;
    }
    #${ROOT_ID} .ci-actions button.reject  { color: #991b1b; }
    #${ROOT_ID} .ci-actions button.reject:hover:not(:disabled) {
      background: rgba(239,68,68,0.10);
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  const STATE = {
    changes: [],
    notes: {},        // change id -> draft note
    sending: new Set(),
    error: '',
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function kindLabel(k) {
    return ({
      'detection-rule': 'Detection rule',
      'knowledge-preamble': 'Preamble',
      'agent-instructions': 'Agent prompt',
    })[k] || k || 'Change';
  }

  function asText(v) {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
  }

  function renderCard(c) {
    const id = c.id;
    const kindCls = `kind-${escapeHtml(c.kind || 'unknown')}`;
    const sending = STATE.sending.has(id);
    const note = STATE.notes[id] || '';
    const proposedText = asText(c.proposed);
    const currentText = asText(c.current);
    const monoCls = c.kind === 'detection-rule' ? ' mono' : '';

    let html = `<div class="ci-card ${kindCls}">`;
    html += `<div class="ci-head">`;
    html += `<span class="ci-kind">${escapeHtml(kindLabel(c.kind))}</span>`;
    if (c.target && c.kind !== 'knowledge-preamble') {
      html += `<span class="ci-target">${escapeHtml(c.target)}</span>`;
    }
    html += `<span class="ci-title">${escapeHtml(c.title || '(untitled change)')}</span>`;
    html += `<span class="ci-by">${escapeHtml(c.proposed_by || 'unknown')}</span>`;
    html += `</div>`;

    if (c.rationale) {
      html += `<p class="ci-rationale">${escapeHtml(c.rationale)}</p>`;
    }
    html += `<div class="ci-section">`;
    html += `<div class="ci-label">Proposed</div>`;
    html += `<div class="ci-content proposed${monoCls}">${escapeHtml(proposedText)}</div>`;
    html += `</div>`;
    if (currentText) {
      html += `<div class="ci-section">`;
      html += `<div class="ci-label">Current (for comparison)</div>`;
      html += `<div class="ci-content${monoCls}">${escapeHtml(currentText)}</div>`;
      html += `</div>`;
    } else if (c.kind === 'detection-rule') {
      html += `<div class="ci-section" style="color:#6b7280;font-size:12px;">`
            + `(net-new rule — no current state to compare against)`
            + `</div>`;
    }
    html += `<div class="ci-actions">`;
    html += `<textarea data-note="${escapeHtml(id)}" `
          + `placeholder="Optional note (sent with Approve / Reject)…" `
          + `${sending ? 'disabled' : ''}>${escapeHtml(note)}</textarea>`;
    html += `<button class="approve" data-approve="${escapeHtml(id)}" ${sending ? 'disabled' : ''}>${sending ? 'Sending…' : 'Approve'}</button>`;
    html += `<button class="reject"  data-reject="${escapeHtml(id)}"  ${sending ? 'disabled' : ''}>Reject</button>`;
    html += `</div>`;

    html += `</div>`;
    return html;
  }

  function render() {
    let body = '';
    if (STATE.error) {
      body += `<div class="ci-err">${escapeHtml(STATE.error)}</div>`;
    }
    if (!STATE.changes.length) {
      body += `<div class="ci-empty">Nothing pending right now. Proposed changes from the Detection Engineer and SOC Manager agents will appear here.</div>`;
    } else {
      for (const c of STATE.changes) body += renderCard(c);
    }
    root.innerHTML = body;

    root.querySelectorAll('[data-note]').forEach((ta) => {
      ta.addEventListener('input', () => {
        STATE.notes[ta.getAttribute('data-note')] = ta.value;
      });
    });
    root.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', () => onDecision(btn.getAttribute('data-approve'), 'approve'));
    });
    root.querySelectorAll('[data-reject]').forEach((btn) => {
      btn.addEventListener('click', () => onDecision(btn.getAttribute('data-reject'), 'reject'));
    });
  }

  async function onDecision(id, decision) {
    if (STATE.sending.has(id)) return;
    STATE.sending.add(id);
    render();
    try {
      const note = STATE.notes[id] || '';
      const r = await fetch(
        `/api/changes/${encodeURIComponent(id)}/${decision}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        },
      );
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        STATE.error = `Failed to ${decision} change ${id}: ${text || r.status}`;
        return;
      }
      // Optimistic remove; the next poll reconciles.
      STATE.changes = STATE.changes.filter((c) => c.id !== id);
      delete STATE.notes[id];
      STATE.error = '';
    } catch (e) {
      STATE.error = `Network error: ${e.message || e}`;
    } finally {
      STATE.sending.delete(id);
      render();
    }
  }

  async function poll() {
    try {
      const r = await fetch('/api/changes/pending', { credentials: 'same-origin' });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        STATE.error = `Failed to load pending changes: HTTP ${r.status} ${text.slice(0, 200)}`;
        render();
        return;
      }
      const data = await r.json();
      STATE.changes = (data && data.changes) || [];
      STATE.error = '';
      render();
    } catch (e) {
      STATE.error = `Network error: ${e.message || e}`;
      render();
    }
  }

  poll();
  setInterval(poll, POLL_MS);
})();
