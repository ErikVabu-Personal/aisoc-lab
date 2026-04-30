// config.js
// ────────────────────────────────────────────────────────────────────
// Renders agent telemetry as human-readable cards with a per-card
// "Show raw JSON" toggle. Backed by /api/agents/state.

(function () {
  'use strict';

  const ROOT_ID = 'aisoc-config-root';
  const POLL_MS = 4000;

  const css = `
    #${ROOT_ID} { font: 14px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    #${ROOT_ID} .agents {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 16px;
    }
    #${ROOT_ID} .card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 18px 20px;
    }
    #${ROOT_ID} .card .head {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 12px;
    }
    #${ROOT_ID} .card .name {
      flex: 1;
      font-size: 16px; font-weight: 700;
      color: #1f2937;
      text-transform: capitalize;
    }
    #${ROOT_ID} .card .dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: #9ca3af;
      flex-shrink: 0;
    }
    /* Coherent agent palette across config + sidebar:
         .idle    = online, not working   -> solid green
         .reading = actively working      -> pulsing blue
         .error   = something went wrong  -> red                        */
    #${ROOT_ID} .card .dot.idle {
      background: #10b981;
    }
    #${ROOT_ID} .card .dot.reading {
      background: #0099cc;
      box-shadow: 0 0 0 0 rgba(0,153,204,0.55);
      animation: aisoc-config-active-pulse 1.6s ease-out infinite;
    }
    @keyframes aisoc-config-active-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(0,153,204,0.55); }
      70%  { box-shadow: 0 0 0 8px rgba(0,153,204,0);  }
      100% { box-shadow: 0 0 0 0 rgba(0,153,204,0);  }
    }
    #${ROOT_ID} .card .dot.error  { background: #ef4444; }
    #${ROOT_ID} .card .pill {
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 999px;
      color: #6b7280;
      background: #f3f4f6;
    }
    /* Pills mirror the dot palette: idle=green, reading=blue, error=red. */
    #${ROOT_ID} .card .pill.idle    { color: #065f46; background: rgba(16,185,129,0.16); }
    #${ROOT_ID} .card .pill.reading { color: #1e3a8a; background: rgba(0,153,204,0.16); }
    #${ROOT_ID} .card .pill.error   { color: #991b1b; background: rgba(239,68,68,0.16); }

    #${ROOT_ID} .card dl {
      margin: 0;
      display: grid;
      grid-template-columns: max-content 1fr;
      column-gap: 14px; row-gap: 6px;
    }
    #${ROOT_ID} .card dt {
      color: #6b7280;
      font-size: 12px; font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      align-self: center;
    }
    #${ROOT_ID} .card dd {
      margin: 0;
      color: #1f2937;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      word-break: break-word;
    }
    #${ROOT_ID} .card dd.muted { color: #9ca3af; font-style: italic; font-family: inherit; }

    /* Per-agent model dropdown row. Sits above the toggle button row
       so the LLM choice is the most prominent control on the card. */
    #${ROOT_ID} .card .model-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid #f3f4f6;
      flex-wrap: wrap;
    }
    #${ROOT_ID} .card .model-row .model-label {
      flex: 0 0 auto;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #6b7280;
    }
    #${ROOT_ID} .card .model-row .model-select {
      flex: 1 1 200px;
      min-width: 180px;
      padding: 5px 8px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #1f2937;
      background: #ffffff;
      cursor: pointer;
    }
    #${ROOT_ID} .card .model-row .model-select:focus {
      outline: none;
      border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .card .model-row .model-select:disabled {
      opacity: 0.55;
      cursor: wait;
      background: #f3f4f6;
    }
    #${ROOT_ID} .card .model-row .model-hint {
      flex: 1 1 100%;
      font-size: 11px;
      color: #9ca3af;
    }
    #${ROOT_ID} .card .model-row .model-status {
      flex: 1 1 100%;
      font-size: 11px;
    }
    #${ROOT_ID} .card .model-row .model-status.saving { color: #6b7280; font-style: italic; }
    #${ROOT_ID} .card .model-row .model-status.ok     { color: #065f46; }
    #${ROOT_ID} .card .model-row .model-status.error  {
      color: #991b1b;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Per-agent CONFIDENCE_THRESHOLD slider row. Sits right under the
       Model dropdown so model + behavioural dials are clustered. */
    #${ROOT_ID} .card .temp-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #f3f4f6;
      flex-wrap: wrap;
    }
    #${ROOT_ID} .card .temp-row .temp-label {
      flex: 0 0 auto;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #6b7280;
    }
    #${ROOT_ID} .card .temp-row .temp-input {
      -webkit-appearance: none;
      appearance: none;
      flex: 1 1 200px;
      min-width: 160px;
      height: 5px;
      border-radius: 999px;
      background: linear-gradient(to right, #fbbf24 0%, #cbd5e1 50%, #10b981 100%);
      outline: none;
      cursor: pointer;
      padding: 0;
    }
    #${ROOT_ID} .card .temp-row .temp-input:disabled { opacity: 0.55; cursor: wait; }
    #${ROOT_ID} .card .temp-row .temp-input::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 18px; height: 18px;
      border-radius: 50%;
      background: #ffffff;
      border: 2px solid #0099cc;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0,0,0,0.18);
    }
    #${ROOT_ID} .card .temp-row .temp-input::-moz-range-thumb {
      width: 18px; height: 18px;
      border-radius: 50%;
      background: #ffffff;
      border: 2px solid #0099cc;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0,0,0,0.18);
    }
    #${ROOT_ID} .card .temp-row .temp-value {
      flex: 0 0 auto;
      font-size: 12px;
      font-weight: 700;
      color: #0099cc;
      font-variant-numeric: tabular-nums;
      min-width: 110px;
    }
    #${ROOT_ID} .card .temp-row .temp-hint {
      flex: 1 1 100%;
      font-size: 11px;
      color: #9ca3af;
    }

    /* SOC Manager-only review-interval input. Same row layout as
       .temp-row above. */
    #${ROOT_ID} .card .interval-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #f3f4f6;
      flex-wrap: wrap;
      font-size: 12px;
      color: #1f2937;
    }
    #${ROOT_ID} .card .interval-row .interval-label {
      flex: 0 0 auto;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #6b7280;
    }
    #${ROOT_ID} .card .interval-row .interval-input {
      width: 70px;
      padding: 4px 8px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #1f2937;
      background: #ffffff;
    }
    #${ROOT_ID} .card .interval-row .interval-input:focus {
      outline: none;
      border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .card .interval-row .interval-input:disabled {
      opacity: 0.55;
      cursor: wait;
      background: #f3f4f6;
    }
    #${ROOT_ID} .card .interval-row .interval-state {
      flex: 0 0 auto;
      color: #6b7280;
      font-style: italic;
    }
    #${ROOT_ID} .card .interval-row .interval-hint {
      flex: 1 1 100%;
      font-size: 11px;
      color: #9ca3af;
    }

    #${ROOT_ID} .card .toggle {
      display: flex;
      justify-content: flex-end;
      margin-top: 14px;
    }
    #${ROOT_ID} .card .toggle button {
      background: transparent;
      border: 1px solid #cbd5e1;
      color: #0099cc;
      font-weight: 600;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
    }
    #${ROOT_ID} .card .toggle button:hover {
      background: #f0f9ff;
      border-color: #0099cc;
    }
    #${ROOT_ID} .card pre {
      margin: 12px 0 0;
      padding: 12px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
      overflow-x: auto;
      max-height: 320px;
    }
    /* Instructions panel — same shell as raw-JSON pre, but the body is
       prose (markdown source) so use a system stack and let it wrap. */
    #${ROOT_ID} .card pre.instr {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1f2937;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 480px;
    }
    /* Editable variant of the instructions panel. Shares the wrapped-
       prose look of pre.instr but allows resize and accepts input. */
    #${ROOT_ID} .card textarea.instr-edit {
      width: 100%;
      box-sizing: border-box;
      margin: 12px 0 0;
      padding: 12px;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1f2937;
      resize: vertical;
      min-height: 200px;
      max-height: 600px;
    }
    #${ROOT_ID} .card textarea.instr-edit:focus {
      outline: none;
      border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .card .instr-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    #${ROOT_ID} .card .instr-actions button.save {
      background: #0099cc;
      color: #ffffff;
      border: 1px solid #0099cc;
    }
    #${ROOT_ID} .card .instr-actions button.save:hover:not(:disabled) {
      background: #33b0dd;
    }
    #${ROOT_ID} .card .instr-actions button.save:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    #${ROOT_ID} .card .instr-status {
      font-size: 12px;
      flex: 1;
    }
    #${ROOT_ID} .card .instr-status.saving { color: #6b7280; font-style: italic; }
    #${ROOT_ID} .card .instr-status.ok     { color: #065f46; }
    #${ROOT_ID} .card .instr-status.error  {
      color: #991b1b;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }

    #${ROOT_ID} .empty,
    #${ROOT_ID} .err {
      padding: 24px;
      text-align: center;
      color: #6b7280;
      font-style: italic;
    }
    #${ROOT_ID} .err {
      color: #991b1b; font-style: normal;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  // Track which agent cards have raw JSON expanded across re-renders.
  const expanded = new Set();
  // Track which agent cards have role-specific instructions expanded.
  const expandedInstructions = new Set();
  // Track which agent cards are in INSTRUCTION-EDIT mode (mutually
  // exclusive with the read-only expanded state — entering edit mode
  // implies expanded).
  const editingInstructions = new Set();
  // {agent_name: draft_text} — preserved across renders so a user's
  // typing doesn't get clobbered by the 60s background re-fetch.
  const editDrafts = {};
  // {agent_name: {state: 'saving'|'ok'|'error', message: str}} — most
  // recent save outcome, surfaced in the panel.
  const editStatus = {};
  // {slug: instructions_text} populated by fetchInstructions(); used by
  // both renderAgent (per-agent expander) and the Generic card IIFE.
  let agentInstructions = {};
  // {slug: deployment_name} — currently bound model for each agent,
  // sourced from the same GET /api/foundry/agents/instructions call.
  let agentModels = {};
  // Available Foundry model deployments — loaded once from
  // /api/foundry/deployments. Each entry: {name, model, version,
  // label, description}.
  let availableDeployments = [];
  let availableDeploymentsLoadedAt = 0;
  // Per-agent inline status from a model-change POST. Map slug ->
  // {state: 'saving'|'ok'|'error', message: str}.
  const modelStatus = {};
  // Slugs whose model-change POST is in flight. Disables the dropdown
  // until the request resolves so a fast double-click can't fire two
  // version creates back-to-back.
  const modelSaving = new Set();
  // SOC Manager review-interval state. value_sec, the value the user
  // is currently typing toward, and an in-flight flag.
  let socMgrIntervalSec = null;
  let socMgrIntervalPending = null;
  let socMgrIntervalSaving = false;
  // Per-agent CONFIDENCE_THRESHOLD slider value (0–100). Populated
  // from /api/agent_temperature, written via POST /api/agent_temperature/{slug}.
  const agentTemps = {};
  // Slugs with a temperature-change POST in flight + the value the
  // user is currently dragging towards. Same UX shape as setupSlider:
  // we render the pending value immediately so the thumb doesn't snap
  // back during the round trip.
  const tempSaving = new Set();
  const tempPending = {};

  // ── Generic instructions card state ────────────────────────────────
  // These are referenced by renderGenericInstructions() which is
  // (transitively) called from the top-level setup code further down.
  // `let` bindings sit in the temporal dead zone until their
  // declaration is reached, so they MUST be declared before the
  // setup call — moving them here avoids "Cannot access 'giLoadedAt'
  // before initialization" at module load.
  let giOpen = false;
  let giCommon = '';
  let giError = '';
  let giLoadedAt = 0;
  // Editing the shared preamble (fans out to all four agents).
  let giEditing = false;
  let giDraft = null;
  // {state: 'saving'|'ok'|'error', message: str,
  //  perAgent?: {slug: 'pending'|'ok'|'error'}}
  let giSaveStatus = null;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function fmtTs(t) {
    if (t == null || !Number(t)) return null;
    const d = new Date(Number(t) * 1000);
    return d.toLocaleString();
  }

  function fmtAgo(t) {
    if (t == null || !Number(t)) return null;
    const sec = Math.floor(Date.now() / 1000) - Number(t);
    if (sec < 0)   return 'just now';
    if (sec < 60)  return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  // /api/agents/state returns each agent as
  //   {id, status, tool_name, last_start_ts, last_event_type, ...}
  // — wrap so the rest of this file can keep using readable accessors.
  function statusOf(a) { return (a && a.status) || 'idle'; }
  function nameOf(a)   { return (a && (a.id || a.agent)) || '?'; }

  function renderAgent(a) {
    const name = String(nameOf(a));
    const status = statusOf(a);
    const lastEvent = a.last_event_type || '—';
    const lastStart = a.last_start_ts ? `${fmtTs(a.last_start_ts)} (${fmtAgo(a.last_start_ts)})` : null;
    const toolName = a.tool_name || null;
    const showRaw = expanded.has(name);

    let html = '<div class="card">';
    html += '<div class="head">';
    html += `<span class="dot ${status}"></span>`;
    html += `<span class="name">${escapeHtml(name)}</span>`;
    html += `<span class="pill ${status}">${escapeHtml(status)}</span>`;
    html += '</div>';

    html += '<dl>';
    html += `<dt>Last event</dt><dd>${escapeHtml(lastEvent)}</dd>`;
    html += `<dt>Last start</dt>`;
    html += lastStart ? `<dd>${escapeHtml(lastStart)}</dd>` : '<dd class="muted">never</dd>';
    if (toolName) {
      html += `<dt>Tool name</dt><dd>${escapeHtml(toolName)}</dd>`;
    }
    if (a.message) {
      html += `<dt>Message</dt><dd>${escapeHtml(a.message)}</dd>`;
    }
    html += '</dl>';

    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const currentModel = agentModels[slug] || '';
    const saving = modelSaving.has(slug);
    const mStatus = modelStatus[slug];
    if (availableDeployments.length || currentModel) {
      // Build the select.
      // - If the catalog includes the bound model, render it normally.
      // - If the catalog is non-empty but the bound model isn't in it
      //   (rare — an agent points at a deployment that was removed
      //   from tfvars), surface the bound model as a disabled "(not
      //   in catalog)" option so the operator sees the truth.
      // - If the catalog is empty entirely (Terraform hasn't re-applied
      //   yet, so AISOC_AVAILABLE_MODEL_DEPLOYMENTS is absent), render
      //   just the bound model without the scary "(not in catalog)"
      //   label — there's no catalog to be "not in".
      const options = (availableDeployments || []).slice();
      const haveCurrent = options.some((d) => d.name === currentModel);
      if (!haveCurrent && currentModel) {
        const empty = options.length === 0;
        options.unshift({
          name: currentModel,
          label: empty ? currentModel : `${currentModel} (not in catalog)`,
          description: empty
            ? 'Catalog not available yet — re-apply Phase 3 Terraform to populate the dropdown.'
            : '',
        });
      }
      html += '<div class="model-row">';
      html += `<label class="model-label" for="model-${escapeHtml(slug)}">Model</label>`;
      html += `<select class="model-select" id="model-${escapeHtml(slug)}" `
            + `data-model-select="${escapeHtml(slug)}" ${saving ? 'disabled' : ''}>`;
      if (!options.length) {
        html += `<option value="">(no deployments configured)</option>`;
      }
      for (const opt of options) {
        const sel = opt.name === currentModel ? 'selected' : '';
        const lbl = opt.label || opt.name;
        const title = opt.description || '';
        html += `<option value="${escapeHtml(opt.name)}" ${sel} `
              + `title="${escapeHtml(title)}">${escapeHtml(lbl)}</option>`;
      }
      html += `</select>`;
      if (mStatus && mStatus.message) {
        html += `<span class="model-status ${escapeHtml(mStatus.state || '')}">`
              + `${escapeHtml(mStatus.message)}</span>`;
      } else {
        html += `<span class="model-hint">Changes apply on next agent run.</span>`;
      }
      html += '</div>';
    }

    // Per-agent CONFIDENCE_THRESHOLD slider. Always render so the
    // operator can dial each agent independently — even triage's
    // value goes onto the request body, though triage's prompt
    // explicitly forbids ask_human so the dial is a no-op there.
    {
      const tempVal = (tempPending[slug] != null)
        ? tempPending[slug]
        : (agentTemps[slug] != null ? agentTemps[slug] : 50);
      const tempBand = tempVal < 34 ? 'cautious' : (tempVal < 67 ? 'balanced' : 'confident');
      const tempBusy = tempSaving.has(slug);
      html += '<div class="temp-row">';
      html += `<label class="temp-label" for="temp-${escapeHtml(slug)}">Temperature</label>`;
      html += `<input type="range" class="temp-input" id="temp-${escapeHtml(slug)}" `
            + `data-temp-input="${escapeHtml(slug)}" `
            + `min="0" max="100" step="5" value="${escapeHtml(String(tempVal))}" `
            + `${tempBusy ? 'disabled' : ''}>`;
      html += `<span class="temp-value" data-temp-value="${escapeHtml(slug)}">`
            + `${escapeHtml(String(tempVal))}% · ${escapeHtml(tempBand)}</span>`;
      html += `<span class="temp-hint">Lower = ask humans often · Higher = act on its own</span>`;
      html += '</div>';
    }

    // SOC Manager-only: review interval input. Drives the periodic
    // run loop on the server. 0 disables; minimum non-zero is 60s.
    if (slug === 'soc-manager') {
      const intVal = (socMgrIntervalPending != null)
        ? socMgrIntervalPending
        : (socMgrIntervalSec != null ? socMgrIntervalSec : 3600);
      const intMin = Math.floor(intVal / 60);
      const intBusy = socMgrIntervalSaving;
      html += '<div class="interval-row">';
      html += `<label class="interval-label" for="interval-${escapeHtml(slug)}">Review every</label>`;
      html += `<input type="number" class="interval-input" id="interval-${escapeHtml(slug)}" `
            + `data-interval-input="soc-manager" min="0" step="1" `
            + `value="${escapeHtml(String(intMin))}" `
            + `${intBusy ? 'disabled' : ''}> minutes`;
      const lbl = (intVal === 0)
        ? '· disabled'
        : `· next sleep up to ${Math.round(intVal / 60)}m`;
      html += `<span class="interval-state">${escapeHtml(lbl)}</span>`;
      html += `<span class="interval-hint">0 disables the periodic review loop. Manual /api/soc_manager/review still works either way. 60s minimum when enabled.</span>`;
      html += '</div>';
    }

    const showInstr = expandedInstructions.has(name);
    const editing = editingInstructions.has(name);
    const instr = agentInstructions[slug];
    const hasInstr = typeof instr === 'string' && instr.length > 0;
    // (`status` is already in scope above as the agent's lifecycle
    // state from /api/agents/state — use a distinct name here.)
    const editState = editStatus[name];

    html += '<div class="toggle">';
    if (hasInstr || agentInstructions.__loaded) {
      const label = hasInstr
        ? (showInstr ? 'Hide instructions' : 'Show instructions')
        : 'No instructions';
      const disabled = hasInstr ? '' : 'disabled';
      html += `<button data-instr="${escapeHtml(name)}" ${disabled}>${label}</button>`;
      // Edit button only shows when the panel is expanded AND we have
      // content AND we're not already editing.
      if (showInstr && hasInstr && !editing) {
        html += `<button data-instr-edit="${escapeHtml(name)}">Edit</button>`;
      }
    }
    html += `<button data-agent="${escapeHtml(name)}">${showRaw ? 'Hide raw JSON' : 'Show raw JSON'}</button>`;
    html += '</div>';

    if (showInstr && editing) {
      // Editor — pre-fill the textarea with the current draft (which
      // defaults to the role-tail content the user is editing).
      const draft = editDrafts[name] != null ? editDrafts[name] : (instr || '');
      const saving = editState && editState.state === 'saving';
      const statusCls = editState ? editState.state : '';
      const statusMsg = editState ? editState.message : '';
      html += `<textarea class="instr-edit" data-instr-textarea="${escapeHtml(name)}" `
            + `${saving ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>`;
      html += '<div class="instr-actions">';
      html += `<button class="save" data-instr-save="${escapeHtml(name)}" `
            + `${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button>`;
      html += `<button data-instr-cancel="${escapeHtml(name)}" `
            + `${saving ? 'disabled' : ''}>Cancel</button>`;
      if (statusMsg) {
        html += `<span class="instr-status ${escapeHtml(statusCls)}">${escapeHtml(statusMsg)}</span>`;
      } else {
        html += `<span class="instr-status" style="color:#6b7280">`
              + `Editing the role-specific tail (the shared preamble is preserved)</span>`;
      }
      html += '</div>';
    } else if (showInstr && hasInstr) {
      html += `<pre class="instr">${escapeHtml(instr)}</pre>`;
      // Surface the most recent save outcome below the read-only view
      // (e.g. "Saved version 2" stays visible after the editor closes).
      if (editState && editState.state === 'ok') {
        html += `<div class="instr-status ok" style="margin-top:8px;font-size:12px;">`
              + `${escapeHtml(editState.message)}</div>`;
      }
    }
    if (showRaw) {
      html += `<pre>${escapeHtml(JSON.stringify(a, null, 2))}</pre>`;
    }
    html += '</div>';
    return html;
  }

  function render(agents) {
    if (!agents || !agents.length) {
      root.innerHTML = '<div class="empty">No agents reporting yet. Run a workflow to populate this page.</div>';
      return;
    }

    // ── Preserve focus + selection across re-renders ────────────────
    // The /api/agents/state poll fires every 4s and the instructions
    // background fetch fires every 60s; both call render() which does
    // an innerHTML wipe and would otherwise yank focus out of any
    // open instructions-edit textarea mid-typing.
    const active = document.activeElement;
    let focusKey = null;
    let selStart = 0;
    let selEnd = 0;
    let scrollTop = 0;
    if (active && active.tagName === 'TEXTAREA') {
      focusKey = active.getAttribute('data-instr-textarea');
      if (focusKey) {
        try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
        scrollTop = active.scrollTop;
      }
    }

    let body = '<div class="agents">';
    for (const a of agents) body += renderAgent(a);
    body += '</div>';
    root.innerHTML = body;

    if (focusKey) {
      const sel = `textarea[data-instr-textarea="${focusKey.replace(/"/g, '\\"')}"]`;
      const ta = root.querySelector(sel);
      if (ta) {
        try {
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(selStart, selEnd);
          ta.scrollTop = scrollTop;
        } catch (_) { /* best-effort */ }
      }
    }

    root.querySelectorAll('.card .toggle button[data-agent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = btn.dataset.agent;
        if (expanded.has(n)) expanded.delete(n);
        else expanded.add(n);
        render(window.__AISOC_AGENTS_LAST || []);
      });
    });
    root.querySelectorAll('.card .toggle button[data-instr]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = btn.dataset.instr;
        if (expandedInstructions.has(n)) {
          expandedInstructions.delete(n);
          // Closing the panel also exits edit mode and forgets the
          // draft — reasonable demo-grade behaviour.
          editingInstructions.delete(n);
          delete editDrafts[n];
        } else {
          expandedInstructions.add(n);
        }
        render(window.__AISOC_AGENTS_LAST || []);
      });
    });
    root.querySelectorAll('.card .toggle button[data-instr-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = btn.dataset.instrEdit;
        editingInstructions.add(n);
        // Seed the draft with the current role-tail content.
        const slug = String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (editDrafts[n] == null) {
          editDrafts[n] = agentInstructions[slug] || '';
        }
        // Clear any previous status when entering a fresh edit session.
        delete editStatus[n];
        render(window.__AISOC_AGENTS_LAST || []);
      });
    });
    root.querySelectorAll('[data-instr-textarea]').forEach((ta) => {
      ta.addEventListener('input', () => {
        editDrafts[ta.getAttribute('data-instr-textarea')] = ta.value;
      });
    });
    root.querySelectorAll('[data-instr-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = btn.getAttribute('data-instr-cancel');
        editingInstructions.delete(n);
        delete editDrafts[n];
        delete editStatus[n];
        render(window.__AISOC_AGENTS_LAST || []);
      });
    });
    root.querySelectorAll('[data-instr-save]').forEach((btn) => {
      btn.addEventListener('click', () => {
        onInstructionsSave(btn.getAttribute('data-instr-save'));
      });
    });
    // Per-agent model dropdown — POSTs on change. Skips if the user
    // selected the current value (re-binding to the same model is a
    // no-op but would still spend a Foundry version create).
    root.querySelectorAll('[data-model-select]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const slug = sel.getAttribute('data-model-select');
        const newModel = sel.value;
        if (!newModel || newModel === (agentModels[slug] || '')) return;
        onAgentModelChange(slug, newModel);
      });
    });

    // SOC Manager review interval — minutes input, commits on blur
    // or Enter. Empty value = no-op. Keep the UX simple; this isn't
    // a hot path (operator changes it rarely).
    root.querySelectorAll('[data-interval-input="soc-manager"]').forEach((input) => {
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (!isFinite(v)) return;
        onSocMgrIntervalChange(v);
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const v = Number(input.value);
          if (isFinite(v)) onSocMgrIntervalChange(v);
        }
      });
    });

    // Per-agent temperature slider — live-update the inline label on
    // `input` (every drag step) but only commit (POST) on `change`
    // (release). Same UX as the global slider was before.
    root.querySelectorAll('[data-temp-input]').forEach((input) => {
      input.addEventListener('input', () => {
        const slug = input.getAttribute('data-temp-input');
        const v = Number(input.value);
        tempPending[slug] = v;
        const valEl = root.querySelector(`[data-temp-value="${slug}"]`);
        if (valEl) {
          const band = v < 34 ? 'cautious' : (v < 67 ? 'balanced' : 'confident');
          valEl.textContent = `${v}% · ${band}`;
        }
      });
      input.addEventListener('change', () => {
        const slug = input.getAttribute('data-temp-input');
        const v = Number(input.value);
        if (v === (agentTemps[slug] || 50)) {
          delete tempPending[slug];
          return;
        }
        onAgentTemperatureChange(slug, v);
      });
    });
  }

  // ── Save handler ───────────────────────────────────────────────────
  // Concatenates the shared common preamble with the user's edited
  // role-tail, then POSTs the FULL instructions blob to Foundry. The
  // server doesn't have to do any splitting — it just persists what
  // we send (preserving the agent's existing model + tools wiring).
  async function onInstructionsSave(name) {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const draft = editDrafts[name] != null ? editDrafts[name] : '';
    if (!draft.trim()) {
      editStatus[name] = { state: 'error', message: 'Cannot save empty instructions' };
      render(window.__AISOC_AGENTS_LAST || []);
      return;
    }
    // Reconstruct the full instructions: common preamble (if any) +
    // blank-line separator + role tail. Matches the format the
    // Phase-2 deploy script writes.
    const fullInstructions = giCommon
      ? `${giCommon}\n\n${draft}`
      : draft;

    editStatus[name] = { state: 'saving', message: 'Saving to Foundry…' };
    render(window.__AISOC_AGENTS_LAST || []);

    try {
      const r = await fetch(
        `/api/foundry/agents/${encodeURIComponent(slug)}/instructions`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instructions: fullInstructions }),
        },
      );
      const respText = await r.text();
      let data;
      try { data = respText ? JSON.parse(respText) : {}; } catch (_) { data = { raw: respText }; }

      if (!r.ok) {
        // Server packs structured errors into data.detail. Pull a
        // readable message out of it.
        let msg = `HTTP ${r.status}`;
        const detail = data && data.detail;
        if (typeof detail === 'string') {
          msg = `${msg}: ${detail}`;
        } else if (detail && typeof detail === 'object') {
          msg = `${msg}: ${detail.error || ''}\n${detail.body || ''}`.trim();
        } else if (data && data.raw) {
          msg = `${msg}: ${data.raw.slice(0, 500)}`;
        }
        editStatus[name] = { state: 'error', message: msg };
        render(window.__AISOC_AGENTS_LAST || []);
        return;
      }

      const newVer = data && (data.new_version || data.agent);
      editStatus[name] = {
        state: 'ok',
        message: newVer ? `Saved (new version: ${newVer})` : 'Saved',
      };
      // Exit edit mode + drop the draft. Keep status visible — it'll
      // show under the refreshed read-only block.
      editingInstructions.delete(name);
      delete editDrafts[name];
      render(window.__AISOC_AGENTS_LAST || []);

      // Re-fetch instructions so the read-only view reflects the new
      // content. The server already busted its cache on POST, but
      // this is what populates agentInstructions client-side.
      fetchAgentInstructions();
    } catch (e) {
      editStatus[name] = {
        state: 'error',
        message: `Network error: ${e.message || e}`,
      };
      render(window.__AISOC_AGENTS_LAST || []);
    }
  }

  async function poll() {
    try {
      const r = await fetch('/api/agents/state', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const agents = (data && data.agents) || [];
      window.__AISOC_AGENTS_LAST = agents;
      render(agents);
    } catch (e) {
      root.innerHTML = `<div class="err">Failed to load agents: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  poll();
  setInterval(poll, POLL_MS);

  // ── Toggle + slider widgets ───────────────────────────────────────
  // Auto-pickup is a binary on/off toggle (state from /api/auto_pickup).
  // Agent temperature is a 0–100 slider (state from
  // /api/agent_temperature) that biases how readily the investigator
  // and reporter reach for ask_human mid-flow. Both have matching
  // read-only badges on the Live Agent View rendered by
  // auto_pickup_badge.js.
  injectToggleStyles();
  injectSliderStyles();

  setupToggle({
    rootId: 'aisoc-auto-pickup-root',
    apiPath: '/api/auto_pickup',
    title: 'Automated alert pickup',
    desc:
      '<strong>On by default.</strong> PixelAgents continuously monitors '
      + 'Microsoft Sentinel for new incidents and triggers the orchestration '
      + 'workflow automatically. If a workflow run fails, the incident is '
      + 'marked seen and <strong>not</strong> retried — the human analyst '
      + 'takes over from there. Disable this only if you want fully manual '
      + 'control (e.g., for a maintenance window).',
    renderState: (s) => {
      const intervalTxt = s.interval_sec ? `${Math.round(s.interval_sec)}s` : '—';
      const checkTxt = s.last_check_ts ? fmtAgoLocal(s.last_check_ts) : 'never';
      return (
        `Poll every ${escapeHtml(intervalTxt)} · last check ${escapeHtml(checkTxt)}`
        + ` · ${escapeHtml(String(s.seen_count || 0))} incident(s) seen`
      );
    },
  });

  // Agent temperature is now per-agent — each agent card renders its
  // own inline slider via renderAgent() / renderAgentTemperatureRow().
  // Loaded once at boot from /api/agent_temperature so dropdowns
  // pre-fill correctly.
  fetchAgentTemperatures();
  setInterval(fetchAgentTemperatures, 8000);

  fetchSocMgrInterval();
  setInterval(fetchSocMgrInterval, 30_000);

  // ── User management (soc-manager only on the server side) ─────────
  // Renders into #aisoc-user-management-root. Lets the SOC manager
  // add / remove users and edit role assignments. Server persists
  // changes in-memory only; durable roster lives in AISOC_USERS_JSON
  // wired in via Terraform.
  injectUserManagementStyles();
  setupUserManagement();
  setInterval(fetchUsers, 8000);

  // ── Generic instructions / context (read-only) ────────────────────
  // Renders the shared preamble (common.md, identical across all
  // agents) as a single card. Per-agent role-specific instructions are
  // rendered inline on each agent card via the "Show instructions"
  // toggle (see renderAgent).
  injectGenericInstructionsStyles();
  setupGenericInstructions();

  // Also kick off the fetch — populates `agentInstructions` so the
  // per-agent "Show instructions" buttons can light up.
  fetchAgentInstructions();
  setInterval(fetchAgentInstructions, 60000);

  // Foundry model-deployment catalog — loaded once at boot. The list
  // doesn't change between deploys (it's pinned to whatever Terraform
  // built), so a one-shot fetch is enough for the demo. A 5-minute
  // re-poll catches any post-deploy edits while keeping the request
  // count low.
  fetchDeployments();
  setInterval(fetchDeployments, 5 * 60_000);

  // ── Generic instructions card ─────────────────────────────────────
  function injectGenericInstructionsStyles() {
    if (document.getElementById('aisoc-generic-instr-styles')) return;
    const css = `
      #aisoc-generic-instructions-root { margin-bottom: 16px; }
      #aisoc-generic-instructions-root .gi-card {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 16px 20px;
      }
      #aisoc-generic-instructions-root .gi-head {
        display: flex; align-items: baseline; gap: 12px;
        margin-bottom: 6px;
      }
      #aisoc-generic-instructions-root .gi-title {
        font-size: 15px; font-weight: 700; color: #1f2937;
      }
      #aisoc-generic-instructions-root .gi-sub {
        font-size: 12px; color: #6b7280; flex: 1;
      }
      #aisoc-generic-instructions-root .gi-toggle {
        background: transparent;
        border: 1px solid #cbd5e1;
        color: #0099cc;
        font-weight: 600;
        font-size: 12px;
        padding: 4px 10px;
        border-radius: 4px;
        cursor: pointer;
      }
      #aisoc-generic-instructions-root .gi-toggle:hover {
        background: #f0f9ff; border-color: #0099cc;
      }
      #aisoc-generic-instructions-root .gi-toggle:disabled {
        opacity: 0.5; cursor: not-allowed;
      }
      #aisoc-generic-instructions-root .gi-body {
        margin-top: 10px;
        padding: 12px;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        font-size: 13px;
        line-height: 1.5;
        color: #1f2937;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 480px;
        overflow-y: auto;
      }
      #aisoc-generic-instructions-root .gi-empty {
        color: #6b7280; font-style: italic; font-size: 13px;
      }
      #aisoc-generic-instructions-root .gi-err {
        color: #991b1b; font-size: 13px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      /* Editor for the shared preamble. */
      #aisoc-generic-instructions-root textarea.gi-edit {
        width: 100%;
        box-sizing: border-box;
        margin-top: 10px;
        padding: 12px;
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        color: #1f2937;
        resize: vertical;
        min-height: 200px;
        max-height: 600px;
      }
      #aisoc-generic-instructions-root textarea.gi-edit:focus {
        outline: none;
        border-color: #0099cc;
        box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
      }
      #aisoc-generic-instructions-root .gi-edit-warning {
        margin-top: 8px;
        padding: 8px 12px;
        background: rgba(245,158,11,0.08);
        border: 1px solid rgba(245,158,11,0.4);
        border-radius: 6px;
        color: #92400e;
        font-size: 12px;
      }
      #aisoc-generic-instructions-root .gi-edit-actions {
        display: flex;
        gap: 8px;
        margin-top: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      #aisoc-generic-instructions-root .gi-edit-actions button.save {
        background: #0099cc;
        color: #ffffff;
        border: 1px solid #0099cc;
        padding: 4px 14px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
      }
      #aisoc-generic-instructions-root .gi-edit-actions button.save:hover:not(:disabled) {
        background: #33b0dd;
      }
      #aisoc-generic-instructions-root .gi-edit-actions button.save:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      #aisoc-generic-instructions-root .gi-save-status {
        font-size: 12px;
        flex: 1;
      }
      #aisoc-generic-instructions-root .gi-save-status.saving { color: #6b7280; font-style: italic; }
      #aisoc-generic-instructions-root .gi-save-status.ok { color: #065f46; }
      #aisoc-generic-instructions-root .gi-save-status.error {
        color: #991b1b;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      /* Per-agent progress badges shown during a fan-out save. */
      #aisoc-generic-instructions-root .gi-progress {
        margin-top: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      #aisoc-generic-instructions-root .gi-progress .pa {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 2px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid #cbd5e1;
        background: #f9fafb;
        color: #6b7280;
      }
      #aisoc-generic-instructions-root .gi-progress .pa.pending {
        background: #f3f4f6; color: #6b7280;
      }
      #aisoc-generic-instructions-root .gi-progress .pa.ok {
        background: rgba(34,197,94,0.10);
        border-color: rgba(34,197,94,0.5);
        color: #166534;
      }
      #aisoc-generic-instructions-root .gi-progress .pa.error {
        background: rgba(239,68,68,0.10);
        border-color: rgba(239,68,68,0.5);
        color: #991b1b;
      }
    `;
    const style = document.createElement('style');
    style.id = 'aisoc-generic-instr-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // (Generic-instructions card state — giOpen / giCommon / giError /
  // giLoadedAt — is declared near the top of the IIFE so render*
  // helpers can access it before this point in the file.)

  function setupGenericInstructions() {
    const r = document.getElementById('aisoc-generic-instructions-root');
    if (!r) return;
    renderGenericInstructions();
  }

  function renderGenericInstructions() {
    const r = document.getElementById('aisoc-generic-instructions-root');
    if (!r) return;

    // ── Focus preservation across re-renders ────────────────────────
    // The save fan-out re-renders this card after every agent — we
    // don't want that to yank the user's textarea focus.
    const active = document.activeElement;
    const wasGiTa = active && active.getAttribute && active.getAttribute('data-gi-textarea');
    let selStart = 0, selEnd = 0, scrollTop = 0;
    if (wasGiTa) {
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
      scrollTop = active.scrollTop;
    }

    const ageTxt = giLoadedAt
      ? ` · loaded ${escapeHtml(fmtAgoLocal(giLoadedAt) || '')}`
      : '';
    const hasCommon = typeof giCommon === 'string' && giCommon.length > 0;

    let headRight = '';
    if (giEditing) {
      // While editing the head buttons are subdued — Save/Cancel live
      // in the editor below. Don't render Show/Hide or Edit here.
    } else {
      headRight += `<button class="gi-toggle" id="gi-toggle-btn" ${hasCommon ? '' : 'disabled'}>`
                 + `${giOpen ? 'Hide' : (hasCommon ? 'Show' : 'Loading…')}`
                 + `</button>`;
      if (giOpen && hasCommon) {
        headRight += ` <button class="gi-toggle" id="gi-edit-btn" `
                   + `style="margin-left:6px;">Edit</button>`;
      }
    }

    let body = `
      <div class="gi-card">
        <div class="gi-head">
          <span class="gi-title">Generic instructions / context</span>
          <span class="gi-sub">Shared preamble loaded from each Foundry agent's deployed instructions${ageTxt}</span>
          ${headRight}
        </div>
    `;

    if (giEditing) {
      const draft = giDraft != null ? giDraft : (giCommon || '');
      const saving = giSaveStatus && giSaveStatus.state === 'saving';
      const slugs = (window.__AISOC_AGENTS_LAST || [])
        .map((a) => (a && (a.id || a.agent)) || '').filter(Boolean);
      body += `<textarea class="gi-edit" data-gi-textarea="common" ${saving ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>`;
      body += `<div class="gi-edit-warning">`
            + `<strong>Heads up:</strong> Saving will create a new version on `
            + `<strong>${slugs.length}</strong> agents in Foundry `
            + `(${escapeHtml(slugs.join(', '))}). Each gets the new common preamble + that agent's existing role-specific tail.`
            + `</div>`;
      body += '<div class="gi-edit-actions">';
      body += `<button class="save" id="gi-save-btn" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save to Foundry'}</button>`;
      body += `<button class="gi-toggle" id="gi-cancel-btn" ${saving ? 'disabled' : ''}>Cancel</button>`;
      if (giSaveStatus && giSaveStatus.message) {
        body += `<span class="gi-save-status ${escapeHtml(giSaveStatus.state)}">${escapeHtml(giSaveStatus.message)}</span>`;
      }
      body += '</div>';
      // Per-agent badges during a fan-out.
      if (giSaveStatus && giSaveStatus.perAgent) {
        body += '<div class="gi-progress">';
        for (const slug of Object.keys(giSaveStatus.perAgent)) {
          const st = giSaveStatus.perAgent[slug];
          const sym = st === 'ok' ? '✓' : (st === 'error' ? '✗' : '·');
          body += `<span class="pa ${escapeHtml(st)}">${sym} ${escapeHtml(slug)}</span>`;
        }
        body += '</div>';
      }
    } else if (giError) {
      body += `<div class="gi-err">Failed to load instructions: ${escapeHtml(giError)}</div>`;
    } else if (giOpen && hasCommon) {
      body += `<div class="gi-body">${escapeHtml(giCommon)}</div>`;
      // Surface the most recent save outcome below the read-only view.
      if (giSaveStatus && giSaveStatus.state === 'ok') {
        body += `<div class="gi-save-status ok" style="margin-top:8px;">${escapeHtml(giSaveStatus.message)}</div>`;
      }
    } else if (giOpen && !hasCommon) {
      body += `<div class="gi-empty">No shared preamble found. Either the agents are not yet deployed, or each agent's instructions diverge entirely (no common prefix).</div>`;
    }
    body += '</div>';
    r.innerHTML = body;

    // Wire up handlers.
    const toggleBtn = document.getElementById('gi-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        giOpen = !giOpen;
        renderGenericInstructions();
      });
    }
    const editBtn = document.getElementById('gi-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        giEditing = true;
        if (giDraft == null) giDraft = giCommon || '';
        giSaveStatus = null;
        renderGenericInstructions();
      });
    }
    const cancelBtn = document.getElementById('gi-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        giEditing = false;
        giDraft = null;
        giSaveStatus = null;
        renderGenericInstructions();
      });
    }
    const saveBtn = document.getElementById('gi-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', onCommonInstructionsSave);
    }
    const ta = r.querySelector('textarea[data-gi-textarea="common"]');
    if (ta) {
      ta.addEventListener('input', () => { giDraft = ta.value; });
    }

    // Restore focus on the textarea if we had it before the wipe.
    if (wasGiTa) {
      const newTa = r.querySelector(`textarea[data-gi-textarea="${wasGiTa}"]`);
      if (newTa) {
        try {
          newTa.focus({ preventScroll: true });
          newTa.setSelectionRange(selStart, selEnd);
          newTa.scrollTop = scrollTop;
        } catch (_) { /* best-effort */ }
      }
    }
  }

  // ── Common-preamble save (fans out to every roster agent) ─────────
  // Each agent's stored instructions = common + "\n\n" + role_tail. To
  // change just the common part we need to re-concat per-agent and
  // POST a new version to each. Sequential rather than parallel so
  // partial failures are easy to surface (and the user can see which
  // ones succeeded before the failure).
  async function onCommonInstructionsSave() {
    const draft = giDraft != null ? giDraft : '';
    if (!draft.trim()) {
      giSaveStatus = { state: 'error', message: 'Cannot save an empty common preamble' };
      renderGenericInstructions();
      return;
    }

    const slugs = (window.__AISOC_AGENTS_LAST || [])
      .map((a) => (a && (a.id || a.agent)) || '').filter(Boolean);
    if (!slugs.length) {
      giSaveStatus = { state: 'error', message: 'No agents loaded yet — refresh and try again' };
      renderGenericInstructions();
      return;
    }

    const ok = window.confirm(
      `This will create a new version on ${slugs.length} agents in Foundry:\n  ${slugs.join(', ')}\n\n`
      + `Each gets: new common preamble + that agent's existing role-specific tail.\n\n`
      + `The change is live immediately for any incoming workflow runs. Continue?`
    );
    if (!ok) return;

    // Initial state: every agent is "pending" until we hit it.
    const perAgent = {};
    for (const slug of slugs) perAgent[slug] = 'pending';
    giSaveStatus = { state: 'saving', message: 'Saving…', perAgent };
    renderGenericInstructions();

    const errors = [];
    for (const slug of slugs) {
      giSaveStatus.message = `Saving ${slug}…`;
      renderGenericInstructions();

      // Use whatever role tail we have on file for this agent. If
      // it's missing (agent not yet hydrated), skip — better than
      // wiping the role with empty.
      const roleTail = agentInstructions[slug];
      if (typeof roleTail !== 'string') {
        perAgent[slug] = 'error';
        errors.push(`${slug}: no role-tail loaded; refresh /config and retry`);
        renderGenericInstructions();
        continue;
      }

      const fullInstructions = roleTail
        ? `${draft}\n\n${roleTail}`
        : draft;

      try {
        const r = await fetch(
          `/api/foundry/agents/${encodeURIComponent(slug)}/instructions`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instructions: fullInstructions }),
          },
        );
        if (!r.ok) {
          let msg = `HTTP ${r.status}`;
          try {
            const j = await r.json();
            const detail = j && j.detail;
            if (typeof detail === 'string') msg += `: ${detail}`;
            else if (detail) msg += `: ${detail.error || ''} ${detail.body || ''}`.trim();
          } catch (_) { /* keep msg */ }
          perAgent[slug] = 'error';
          errors.push(`${slug}: ${msg}`);
        } else {
          perAgent[slug] = 'ok';
        }
      } catch (e) {
        perAgent[slug] = 'error';
        errors.push(`${slug}: ${e.message || e}`);
      }
      renderGenericInstructions();
    }

    if (errors.length === 0) {
      giSaveStatus = {
        state: 'ok',
        message: `Saved ${slugs.length} agents`,
        perAgent,
      };
      giEditing = false;
      giDraft = null;
      renderGenericInstructions();
      // Pull fresh content so the read-only view shows the new common.
      fetchAgentInstructions();
    } else {
      giSaveStatus = {
        state: 'error',
        message:
          `${slugs.length - errors.length}/${slugs.length} succeeded; failures:\n`
          + errors.join('\n'),
        perAgent,
      };
      // Stay in edit mode so the user can retry.
      renderGenericInstructions();
    }
  }

  async function fetchSocMgrInterval() {
    try {
      const r = await fetch('/api/soc_manager/review_interval', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      if (typeof data.value_sec === 'number' && socMgrIntervalPending == null) {
        socMgrIntervalSec = data.value_sec;
        render(window.__AISOC_AGENTS_LAST || []);
      }
    } catch (_) { /* ignore */ }
  }

  async function onSocMgrIntervalChange(newMinutes) {
    const newSec = Math.max(0, Math.floor(newMinutes * 60));
    if (newSec > 0 && newSec < 60) {
      // Clamp to the server's minimum so we don't ship an obvious
      // 400 the operator has to read in dev tools.
      alert('Minimum interval is 1 minute (or 0 to disable).');
      return;
    }
    if (newSec === socMgrIntervalSec) return;
    if (socMgrIntervalSaving) return;
    socMgrIntervalSaving = true;
    socMgrIntervalPending = newSec;
    render(window.__AISOC_AGENTS_LAST || []);
    try {
      const r = await fetch('/api/soc_manager/review_interval', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value_sec: newSec }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        alert(`Failed to update SOC Manager review interval: ${text || r.status}`);
        return;
      }
      const data = await r.json();
      socMgrIntervalSec = (typeof data.value_sec === 'number') ? data.value_sec : newSec;
      socMgrIntervalPending = null;
    } catch (e) {
      alert(`Network error updating SOC Manager review interval: ${e.message || e}`);
    } finally {
      socMgrIntervalSaving = false;
      render(window.__AISOC_AGENTS_LAST || []);
    }
  }

  async function fetchAgentTemperatures() {
    try {
      const r = await fetch('/api/agent_temperature', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      const agents = (data && data.agents) || {};
      for (const slug of Object.keys(agents)) {
        // Don't clobber a value the user is currently dragging.
        if (tempPending[slug] != null) continue;
        const v = agents[slug] && agents[slug].value;
        if (typeof v === 'number') agentTemps[slug] = v;
      }
      render(window.__AISOC_AGENTS_LAST || []);
    } catch (_) { /* ignore */ }
  }

  async function onAgentTemperatureChange(slug, newValue) {
    if (!slug || newValue == null) return;
    if (tempSaving.has(slug)) return;
    tempSaving.add(slug);
    tempPending[slug] = newValue;
    render(window.__AISOC_AGENTS_LAST || []);
    try {
      const r = await fetch(
        `/api/agent_temperature/${encodeURIComponent(slug)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: newValue }),
        },
      );
      if (!r.ok) {
        // Resync from server on failure so the slider snaps back.
        const fresh = await fetch(
          `/api/agent_temperature/${encodeURIComponent(slug)}`,
          { credentials: 'same-origin' },
        ).then((rr) => rr.ok ? rr.json() : null).catch(() => null);
        if (fresh && typeof fresh.value === 'number') agentTemps[slug] = fresh.value;
      } else {
        agentTemps[slug] = newValue;
      }
    } catch (_) {
      // Same fallback — pull current state, give up the optimistic update.
      try {
        const fresh = await fetch(
          `/api/agent_temperature/${encodeURIComponent(slug)}`,
          { credentials: 'same-origin' },
        ).then((rr) => rr.ok ? rr.json() : null);
        if (fresh && typeof fresh.value === 'number') agentTemps[slug] = fresh.value;
      } catch (__) { /* ignore */ }
    } finally {
      tempSaving.delete(slug);
      delete tempPending[slug];
      render(window.__AISOC_AGENTS_LAST || []);
    }
  }

  async function fetchDeployments() {
    try {
      const r = await fetch('/api/foundry/deployments', { credentials: 'same-origin' });
      if (!r.ok) {
        // 403 (non-soc-manager) or 502 (Foundry hiccup) — leave the
        // current list intact and try again later.
        return;
      }
      const data = await r.json();
      const list = (data && data.deployments) || [];
      if (Array.isArray(list)) {
        availableDeployments = list;
        availableDeploymentsLoadedAt = Math.floor(Date.now() / 1000);
        // Re-render the agents grid so the dropdown options refresh.
        render(window.__AISOC_AGENTS_LAST || []);
      }
    } catch (_) { /* ignore — transient */ }
  }

  async function onAgentModelChange(slug, newModel) {
    if (!slug || !newModel) return;
    if (modelSaving.has(slug)) return;
    modelSaving.add(slug);
    modelStatus[slug] = { state: 'saving', message: 'Saving model change to Foundry…' };
    render(window.__AISOC_AGENTS_LAST || []);
    try {
      const r = await fetch(
        `/api/foundry/agents/${encodeURIComponent(slug)}/model`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: newModel }),
        },
      );
      const text = await r.text().catch(() => '');
      let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        const detail = data && data.detail;
        if (typeof detail === 'string') msg += `: ${detail}`;
        else if (detail && typeof detail === 'object') {
          msg += `: ${detail.error || ''} ${detail.body || ''}`.trim();
        } else if (data && data.raw) {
          msg += `: ${data.raw.slice(0, 300)}`;
        }
        modelStatus[slug] = { state: 'error', message: msg };
        return;
      }
      const ver = data && (data.new_version || '');
      agentModels[slug] = newModel;
      modelStatus[slug] = {
        state: 'ok',
        message: ver ? `Now using ${newModel} (version ${ver})` : `Now using ${newModel}`,
      };
      // Re-fetch instructions so the read-only side reflects the
      // new bound model on subsequent renders.
      fetchAgentInstructions();
    } catch (e) {
      modelStatus[slug] = { state: 'error', message: `Network error: ${e.message || e}` };
    } finally {
      modelSaving.delete(slug);
      render(window.__AISOC_AGENTS_LAST || []);
    }
  }

  async function fetchAgentInstructions() {
    try {
      const r = await fetch('/api/foundry/agents/instructions',
                            { credentials: 'same-origin' });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${text ? `: ${text}` : ''}`);
      }
      const data = await r.json();
      giCommon = (data && typeof data.common === 'string') ? data.common : '';
      giError = '';
      giLoadedAt = Math.floor(Date.now() / 1000);

      const map = {};
      const models = {};
      for (const a of (data && data.agents) || []) {
        if (!a || !a.slug) continue;
        map[a.slug] = a.instructions || '';
        if (typeof a.model === 'string' && a.model) {
          models[a.slug] = a.model;
        }
      }
      // Sentinel field so renderAgent can distinguish "loaded but empty"
      // from "still loading".
      map.__loaded = true;
      agentInstructions = map;
      agentModels = models;

      renderGenericInstructions();
      // Re-render the agents grid so the per-agent buttons appear /
      // refresh.
      render(window.__AISOC_AGENTS_LAST || []);
    } catch (e) {
      giError = String(e.message || e);
      // Don't drop previously-loaded agentInstructions on transient
      // errors — keeps the per-agent buttons usable while we retry.
      renderGenericInstructions();
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────
  function fmtAgoLocal(t) {
    if (t == null || !Number(t)) return null;
    const sec = Math.floor(Date.now() / 1000) - Number(t);
    if (sec < 0)   return 'just now';
    if (sec < 60)  return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  function injectToggleStyles() {
    if (document.getElementById('aisoc-toggle-styles')) return;
    const css = `
      .aisoc-toggle-root { margin-bottom: 16px; }
      .aisoc-toggle-root .ap-card {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 16px 20px;
        display: flex; align-items: center; gap: 16px;
        flex-wrap: wrap;
      }
      .aisoc-toggle-root .ap-info { flex: 1; min-width: 240px; }
      .aisoc-toggle-root .ap-title {
        font-size: 15px; font-weight: 700; color: #1f2937;
        margin-bottom: 4px;
      }
      .aisoc-toggle-root .ap-desc {
        font-size: 13px; color: #6b7280; line-height: 1.4;
      }
      .aisoc-toggle-root .ap-state {
        margin-top: 8px;
        font-size: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #6b7280;
      }
      .aisoc-toggle-root .ap-state .ev { color: #1f2937; }
      .aisoc-toggle-root .ap-switch {
        position: relative;
        width: 56px; height: 30px;
        background: #d1d5db;
        border-radius: 999px;
        cursor: pointer;
        transition: background 0.15s ease;
        flex-shrink: 0;
      }
      .aisoc-toggle-root .ap-switch.on { background: #10b981; }
      .aisoc-toggle-root .ap-switch.busy { opacity: 0.6; cursor: wait; }
      .aisoc-toggle-root .ap-switch::after {
        content: '';
        position: absolute;
        top: 3px; left: 3px;
        width: 24px; height: 24px;
        background: #ffffff;
        border-radius: 50%;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        transition: left 0.15s ease;
      }
      .aisoc-toggle-root .ap-switch.on::after { left: 29px; }
      .aisoc-toggle-root .ap-label {
        font-size: 13px; font-weight: 700;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        min-width: 36px;
        text-align: left;
      }
      .aisoc-toggle-root .ap-switch.on + .ap-label { color: #065f46; }
    `;
    const style = document.createElement('style');
    style.id = 'aisoc-toggle-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Generic two-state toggle backed by GET/POST {apiPath} returning at
  // least { enabled: bool, last_event?, last_event_ts? }. Renders into
  // the element with id=opts.rootId and polls every 5s.
  function setupToggle(opts) {
    const root = document.getElementById(opts.rootId);
    if (!root) return;
    root.classList.add('aisoc-toggle-root');

    let state = { enabled: false, last_event: null, last_event_ts: null };
    let busy = false;

    function r() {
      const onCls = state.enabled ? 'on' : '';
      const busyCls = busy ? 'busy' : '';
      const label = state.enabled ? 'ON' : 'OFF';
      const extraState = (typeof opts.renderState === 'function')
        ? opts.renderState(state) : '';
      const evTxt = state.last_event
        ? `<span class="ev">${escapeHtml(state.last_event)}</span>`
            + (state.last_event_ts ? ` · ${escapeHtml(fmtAgoLocal(state.last_event_ts) || '')}` : '')
        : 'no events yet';

      const btnId = opts.rootId + '-btn';
      root.innerHTML = `
        <div class="ap-card">
          <div class="ap-info">
            <div class="ap-title">${escapeHtml(opts.title)}</div>
            <div class="ap-desc">${opts.desc}</div>
            <div class="ap-state">
              ${extraState}<br>
              Last event: ${evTxt}
            </div>
          </div>
          <div class="ap-switch ${onCls} ${busyCls}" id="${escapeHtml(btnId)}"
               role="switch" aria-checked="${state.enabled}"
               tabindex="0"></div>
          <div class="ap-label">${label}</div>
        </div>
      `;
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.addEventListener('click', toggle);
        btn.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle();
          }
        });
      }
    }

    async function poll() {
      try {
        const resp = await fetch(opts.apiPath, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        state = await resp.json();
        r();
      } catch (e) {
        root.innerHTML = `
          <div class="ap-card">
            <div class="ap-info">
              <div class="ap-title">${escapeHtml(opts.title)}</div>
              <div class="ap-desc" style="color:#991b1b">
                Failed to load: ${escapeHtml(e.message || String(e))}
              </div>
            </div>
          </div>
        `;
      }
    }

    async function toggle() {
      if (busy) return;
      busy = true;
      const desired = !state.enabled;
      r();
      try {
        const resp = await fetch(opts.apiPath, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: desired }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        state = await resp.json();
      } catch (e) {
        try {
          const resp = await fetch(opts.apiPath, { credentials: 'same-origin' });
          if (resp.ok) state = await resp.json();
        } catch (_) { /* ignore */ }
        alert(`Failed to update ${opts.title}: ` + (e.message || String(e)));
      } finally {
        busy = false;
        r();
      }
    }

    poll();
    setInterval(poll, 5000);
  }

  // ── Slider widget (agent temperature) ─────────────────────────────
  // Renders a horizontal slider card backed by GET/POST {apiPath}
  // returning at least { value: int (0..100), last_event?, last_event_ts? }.
  // Saves on `change` (release) only — not `input` — so a drag doesn't
  // generate a flurry of POSTs.
  function injectSliderStyles() {
    if (document.getElementById('aisoc-slider-styles')) return;
    const css = `
      .aisoc-slider-root { margin-bottom: 16px; }
      .aisoc-slider-root .sl-card {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 16px 20px;
      }
      .aisoc-slider-root .sl-head {
        display: flex; align-items: baseline; gap: 12px;
        margin-bottom: 4px;
      }
      .aisoc-slider-root .sl-title {
        font-size: 15px; font-weight: 700; color: #1f2937;
        flex: 1;
      }
      .aisoc-slider-root .sl-value {
        font-size: 15px; font-weight: 700; color: #0099cc;
        font-variant-numeric: tabular-nums;
      }
      .aisoc-slider-root .sl-desc {
        font-size: 13px; color: #6b7280; line-height: 1.4;
        margin-bottom: 14px;
      }
      .aisoc-slider-root .sl-desc code {
        background: #f3f4f6;
        padding: 1px 4px;
        border-radius: 3px;
        font-size: 12px;
      }
      .aisoc-slider-root .sl-track {
        position: relative;
        display: grid;
        grid-template-columns: max-content 1fr max-content;
        align-items: center;
        gap: 12px;
      }
      .aisoc-slider-root .sl-end {
        font-size: 12px; font-weight: 600;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .aisoc-slider-root .sl-input {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 6px;
        border-radius: 999px;
        background: linear-gradient(to right, #fbbf24 0%, #cbd5e1 50%, #10b981 100%);
        outline: none;
        cursor: pointer;
      }
      .aisoc-slider-root .sl-input:disabled { opacity: 0.5; cursor: wait; }
      .aisoc-slider-root .sl-input::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: #ffffff;
        border: 2px solid #0099cc;
        cursor: pointer;
        box-shadow: 0 1px 3px rgba(0,0,0,0.18);
      }
      .aisoc-slider-root .sl-input::-moz-range-thumb {
        width: 22px; height: 22px;
        border-radius: 50%;
        background: #ffffff;
        border: 2px solid #0099cc;
        cursor: pointer;
        box-shadow: 0 1px 3px rgba(0,0,0,0.18);
      }
      .aisoc-slider-root .sl-state {
        margin-top: 10px;
        font-size: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #6b7280;
      }
      .aisoc-slider-root .sl-state .ev { color: #1f2937; }
    `;
    const style = document.createElement('style');
    style.id = 'aisoc-slider-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function setupSlider(opts) {
    const root = document.getElementById(opts.rootId);
    if (!root) return;
    root.classList.add('aisoc-slider-root');

    const min = Number(opts.min != null ? opts.min : 0);
    const max = Number(opts.max != null ? opts.max : 100);
    const step = Number(opts.step != null ? opts.step : 1);

    let state = { value: 50, last_event: null, last_event_ts: null };
    let busy = false;
    // The value the user is currently dragging towards. We render that
    // immediately even while the POST is in-flight, so the thumb doesn't
    // visually snap back to the old value during the round-trip.
    let pendingValue = null;

    function r() {
      const shown = pendingValue != null ? pendingValue : Number(state.value || 0);
      const evTxt = state.last_event
        ? `<span class="ev">${escapeHtml(state.last_event)}</span>`
            + (state.last_event_ts ? ` · ${escapeHtml(fmtAgoLocal(state.last_event_ts) || '')}` : '')
        : 'no events yet';
      const inputId = opts.rootId + '-input';
      root.innerHTML = `
        <div class="sl-card">
          <div class="sl-head">
            <span class="sl-title">${escapeHtml(opts.title)}</span>
            <span class="sl-value">${escapeHtml(String(shown))}%</span>
          </div>
          <div class="sl-desc">${opts.desc}</div>
          <div class="sl-track">
            <span class="sl-end">${escapeHtml(opts.leftLabel || String(min))}</span>
            <input type="range" class="sl-input" id="${escapeHtml(inputId)}"
                   min="${min}" max="${max}" step="${step}" value="${shown}"
                   ${busy ? 'disabled' : ''}>
            <span class="sl-end">${escapeHtml(opts.rightLabel || String(max))}</span>
          </div>
          <div class="sl-state">Last event: ${evTxt}</div>
        </div>
      `;
      const input = document.getElementById(inputId);
      if (input) {
        // Live-update the displayed value while dragging, but only
        // commit (POST) on release.
        input.addEventListener('input', () => {
          pendingValue = Number(input.value);
          const valEl = root.querySelector('.sl-value');
          if (valEl) valEl.textContent = `${pendingValue}%`;
        });
        input.addEventListener('change', () => {
          commit(Number(input.value));
        });
      }
    }

    async function poll() {
      try {
        const resp = await fetch(opts.apiPath, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const fresh = await resp.json();
        // Don't clobber a value the user is currently dragging.
        if (pendingValue != null && !busy) pendingValue = null;
        state = fresh;
        r();
      } catch (e) {
        root.innerHTML = `
          <div class="sl-card">
            <div class="sl-head"><span class="sl-title">${escapeHtml(opts.title)}</span></div>
            <div class="sl-desc" style="color:#991b1b">
              Failed to load: ${escapeHtml(e.message || String(e))}
            </div>
          </div>
        `;
      }
    }

    async function commit(value) {
      if (busy) return;
      busy = true;
      pendingValue = value;
      r();
      try {
        const resp = await fetch(opts.apiPath, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        state = await resp.json();
        pendingValue = null;
      } catch (e) {
        try {
          const resp = await fetch(opts.apiPath, { credentials: 'same-origin' });
          if (resp.ok) {
            state = await resp.json();
            pendingValue = null;
          }
        } catch (_) { /* ignore */ }
        alert(`Failed to update ${opts.title}: ` + (e.message || String(e)));
      } finally {
        busy = false;
        r();
      }
    }

    poll();
    setInterval(poll, 5000);
  }

  // ── User management ───────────────────────────────────────────────
  // Renders a card listing every configured user with their roles.
  // Soc-manager-only on the server side; if a non-manager somehow
  // hits /config (shouldn't happen — the server bounces them), the
  // GET /api/users call returns 403 and we surface that gracefully.
  let umUsers = [];
  let umKnownRoles = [];
  let umMe = '';
  let umError = '';
  let umAdding = false;          // true when the inline "add user" form is open
  let umAddDraft = { email: '', password: '', roles: [] };
  let umEditing = null;          // email currently being edited (or null)
  let umEditDraft = null;        // {email, password, roles} for the edit form
  let umBusy = new Set();        // emails for which a POST/DELETE is in-flight
  let umStatus = '';             // last-action message shown under the card
  let umStatusKind = '';         // 'ok' | 'error'

  function injectUserManagementStyles() {
    if (document.getElementById('aisoc-user-management-styles')) return;
    const css = `
      #aisoc-user-management-root { margin-bottom: 16px; }
      #aisoc-user-management-root .um-card {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 16px 20px;
      }
      #aisoc-user-management-root .um-head {
        display: flex; align-items: baseline; gap: 12px;
        margin-bottom: 8px;
      }
      #aisoc-user-management-root .um-title {
        font-size: 15px; font-weight: 700; color: #1f2937;
        flex: 1;
      }
      #aisoc-user-management-root .um-sub {
        font-size: 12px; color: #6b7280;
      }
      #aisoc-user-management-root .um-actions {
        display: flex; gap: 6px; flex-wrap: wrap;
      }
      #aisoc-user-management-root button {
        padding: 5px 12px;
        border-radius: 4px;
        font: 600 12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        cursor: pointer;
        background: #f9fafb;
        color: #1f2937;
        border: 1px solid #cbd5e1;
      }
      #aisoc-user-management-root button:hover:not(:disabled) {
        background: #f3f4f6;
        border-color: #94a3b8;
      }
      #aisoc-user-management-root button:disabled {
        opacity: 0.55; cursor: not-allowed;
      }
      #aisoc-user-management-root button.primary {
        background: #0099cc;
        border-color: #0099cc;
        color: #ffffff;
      }
      #aisoc-user-management-root button.primary:hover:not(:disabled) {
        background: #33b0dd;
      }
      #aisoc-user-management-root button.danger {
        color: #991b1b;
      }
      #aisoc-user-management-root button.danger:hover:not(:disabled) {
        background: rgba(239,68,68,0.10);
        border-color: rgba(239,68,68,0.5);
      }
      #aisoc-user-management-root table.um-tbl {
        width: 100%;
        border-collapse: collapse;
        margin-top: 8px;
      }
      #aisoc-user-management-root table.um-tbl th {
        font-size: 11px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.05em;
        color: #6b7280;
        text-align: left;
        padding: 6px 8px;
        border-bottom: 1px solid #e5e7eb;
      }
      #aisoc-user-management-root table.um-tbl td {
        font-size: 13px;
        color: #1f2937;
        padding: 8px;
        border-bottom: 1px solid #f3f4f6;
        vertical-align: middle;
      }
      #aisoc-user-management-root table.um-tbl tr:last-child td { border-bottom: none; }
      #aisoc-user-management-root .um-email {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12.5px;
      }
      #aisoc-user-management-root .um-pill {
        display: inline-block;
        padding: 2px 8px;
        margin: 1px 4px 1px 0;
        border-radius: 999px;
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: rgba(0,153,204,0.14);
        color: #1e3a8a;
      }
      #aisoc-user-management-root .um-pill.role-soc-manager       { background: rgba(124,58,237,0.16); color: #4c1d95; }
      #aisoc-user-management-root .um-pill.role-detection-engineer { background: rgba(245,158,11,0.18); color: #92400e; }
      #aisoc-user-management-root .um-pill.role-soc-analyst        { background: rgba(16,185,129,0.16); color: #065f46; }
      #aisoc-user-management-root .um-pill.online {
        background: rgba(16,185,129,0.16); color: #065f46;
      }
      #aisoc-user-management-root .um-self {
        font-size: 11px; color: #6b7280; font-style: italic;
        margin-left: 6px;
      }
      #aisoc-user-management-root .um-form {
        margin-top: 12px;
        padding: 12px;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
      }
      #aisoc-user-management-root .um-form .row {
        display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
        margin-bottom: 8px;
      }
      #aisoc-user-management-root .um-form label {
        font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
        text-transform: uppercase; color: #6b7280;
        flex: 0 0 110px;
      }
      #aisoc-user-management-root .um-form input[type=text],
      #aisoc-user-management-root .um-form input[type=password],
      #aisoc-user-management-root .um-form input[type=email] {
        flex: 1;
        min-width: 240px;
        padding: 6px 9px;
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #1f2937;
        background: #ffffff;
      }
      #aisoc-user-management-root .um-form input:focus {
        outline: none;
        border-color: #0099cc;
        box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
      }
      #aisoc-user-management-root .um-roles {
        display: flex; gap: 14px; flex-wrap: wrap;
      }
      #aisoc-user-management-root .um-roles label.cb {
        flex: 0 0 auto;
        font: 12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        color: #1f2937;
        text-transform: none;
        letter-spacing: 0;
        font-weight: 500;
        display: inline-flex; align-items: center; gap: 5px;
        cursor: pointer;
      }
      #aisoc-user-management-root .um-status {
        margin-top: 8px;
        font-size: 12px;
      }
      #aisoc-user-management-root .um-status.ok    { color: #065f46; }
      #aisoc-user-management-root .um-status.error {
        color: #991b1b;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #aisoc-user-management-root .um-empty {
        font-size: 13px; color: #6b7280; font-style: italic;
        padding: 8px 0;
      }
    `;
    const style = document.createElement('style');
    style.id = 'aisoc-user-management-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function setupUserManagement() {
    const root = document.getElementById('aisoc-user-management-root');
    if (!root) return;
    fetchUsers();
  }

  async function fetchUsers() {
    try {
      const r = await fetch('/api/users', { credentials: 'same-origin' });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 240)}` : ''}`);
      }
      const data = await r.json();
      umUsers = (data && data.users) || [];
      umKnownRoles = (data && data.known_roles) || [];
      umMe = (data && data.me) || '';
      umError = '';
      renderUserManagement();
    } catch (e) {
      umError = String(e.message || e);
      renderUserManagement();
    }
  }

  function roleLabel(role) {
    return ({
      'soc-manager':         'SOC manager',
      'detection-engineer':  'Detection engineer',
      'soc-analyst':         'SOC analyst',
    })[role] || role;
  }

  function renderUserManagement() {
    const root = document.getElementById('aisoc-user-management-root');
    if (!root) return;

    if (umError) {
      root.innerHTML = `
        <div class="um-card">
          <div class="um-head">
            <span class="um-title">User management</span>
          </div>
          <div class="um-status error">Failed to load: ${escapeHtml(umError)}</div>
        </div>
      `;
      return;
    }

    let html = '<div class="um-card">';
    html += '<div class="um-head">';
    html += '<span class="um-title">User management</span>';
    html += '<span class="um-sub">In-memory edits — durable roster lives in <code>AISOC_USERS_JSON</code>.</span>';
    html += '<div class="um-actions">';
    if (!umAdding && !umEditing) {
      html += `<button class="primary" id="um-add-btn">+ Add user</button>`;
    }
    html += '</div></div>';

    // Table of users.
    if (!umUsers.length) {
      html += '<div class="um-empty">No users configured.</div>';
    } else {
      html += '<table class="um-tbl"><thead><tr>'
            + '<th>Email</th><th>Roles</th><th>Status</th><th></th>'
            + '</tr></thead><tbody>';
      for (const u of umUsers) {
        const isEditing = umEditing === u.email;
        const busy = umBusy.has(u.email);
        html += `<tr>`;
        html += `<td><span class="um-email">${escapeHtml(u.email)}</span>`;
        if (u.is_self) html += `<span class="um-self">(you)</span>`;
        html += `</td>`;
        html += `<td>`;
        if ((u.roles || []).length === 0) {
          html += `<span style="font-size:11px;color:#9ca3af;">No roles</span>`;
        } else {
          for (const r of (u.roles || [])) {
            html += `<span class="um-pill role-${escapeHtml(r)}">${escapeHtml(roleLabel(r))}</span>`;
          }
        }
        html += `</td>`;
        html += `<td>${u.online
          ? '<span class="um-pill online">Online</span>'
          : '<span style="font-size:11px;color:#9ca3af;">Offline</span>'}</td>`;
        html += `<td style="text-align:right;white-space:nowrap;">`;
        if (!isEditing && !umAdding) {
          html += `<button data-um-edit="${escapeHtml(u.email)}" ${busy ? 'disabled' : ''}>Edit</button> `;
          const delTitle = u.is_self ? 'You cannot remove yourself.' : '';
          html += `<button class="danger" data-um-delete="${escapeHtml(u.email)}" `
                + `${(busy || u.is_self) ? 'disabled' : ''} `
                + `title="${escapeHtml(delTitle)}">Remove</button>`;
        }
        html += `</td>`;
        html += `</tr>`;
        if (isEditing) {
          html += `<tr><td colspan="4">${renderUmFormRow('edit')}</td></tr>`;
        }
      }
      html += '</tbody></table>';
    }

    if (umAdding) {
      html += renderUmFormRow('add');
    }

    if (umStatus) {
      html += `<div class="um-status ${escapeHtml(umStatusKind)}">${escapeHtml(umStatus)}</div>`;
    }

    html += '</div>';
    root.innerHTML = html;

    // Wire handlers.
    const addBtn = document.getElementById('um-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => {
      umAdding = true; umAddDraft = { email: '', password: '', roles: [] };
      umStatus = ''; umStatusKind = '';
      renderUserManagement();
    });
    root.querySelectorAll('[data-um-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const email = btn.getAttribute('data-um-edit');
        const u = umUsers.find((x) => x.email === email);
        if (!u) return;
        umEditing = email;
        umEditDraft = { email, password: '', roles: [...(u.roles || [])] };
        umStatus = ''; umStatusKind = '';
        renderUserManagement();
      });
    });
    root.querySelectorAll('[data-um-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const email = btn.getAttribute('data-um-delete');
        if (!confirm(`Remove ${email}? This drops their session immediately.`)) return;
        onDeleteUser(email);
      });
    });

    // Form-input wiring.
    const draft = umAdding ? umAddDraft : (umEditing ? umEditDraft : null);
    if (draft) {
      const emailInput = root.querySelector('[data-um-input="email"]');
      if (emailInput) emailInput.addEventListener('input', () => { draft.email = emailInput.value; });
      const pwInput = root.querySelector('[data-um-input="password"]');
      if (pwInput) pwInput.addEventListener('input', () => { draft.password = pwInput.value; });
      root.querySelectorAll('[data-um-role]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const role = cb.getAttribute('data-um-role');
          if (cb.checked) {
            if (!draft.roles.includes(role)) draft.roles.push(role);
          } else {
            draft.roles = draft.roles.filter((r) => r !== role);
          }
        });
      });
      const saveBtn = root.querySelector('[data-um-save]');
      if (saveBtn) saveBtn.addEventListener('click', () => onSaveUser(umAdding ? 'add' : 'edit'));
      const cancelBtn = root.querySelector('[data-um-cancel]');
      if (cancelBtn) cancelBtn.addEventListener('click', () => {
        umAdding = false; umEditing = null; umEditDraft = null;
        renderUserManagement();
      });
    }
  }

  function renderUmFormRow(mode) {
    const draft = mode === 'add' ? umAddDraft : umEditDraft;
    const isAdd = mode === 'add';
    let html = `<div class="um-form">`;
    html += `<div class="row"><label>Email</label>`;
    html += `<input type="email" data-um-input="email" value="${escapeHtml(draft.email || '')}" `
          + `${isAdd ? '' : 'disabled'} placeholder="alice@example.com"></div>`;
    html += `<div class="row"><label>Password</label>`;
    html += `<input type="password" data-um-input="password" value="${escapeHtml(draft.password || '')}" `
          + `placeholder="${isAdd ? 'Required for new users' : 'Leave blank to keep current'}"></div>`;
    html += `<div class="row"><label>Roles</label><div class="um-roles">`;
    for (const r of umKnownRoles) {
      const checked = (draft.roles || []).includes(r) ? 'checked' : '';
      html += `<label class="cb"><input type="checkbox" data-um-role="${escapeHtml(r)}" ${checked}> ${escapeHtml(roleLabel(r))}</label>`;
    }
    html += `</div></div>`;
    html += `<div class="row" style="justify-content:flex-end;margin-bottom:0;">`;
    html += `<button data-um-cancel>Cancel</button> `;
    html += `<button class="primary" data-um-save>${isAdd ? 'Add user' : 'Save changes'}</button>`;
    html += `</div></div>`;
    return html;
  }

  async function onSaveUser(mode) {
    const draft = mode === 'add' ? umAddDraft : umEditDraft;
    if (!draft) return;
    const email = (draft.email || '').trim().toLowerCase();
    if (!email) {
      umStatus = 'Email is required.'; umStatusKind = 'error';
      renderUserManagement();
      return;
    }
    umBusy.add(email);
    umStatus = 'Saving…'; umStatusKind = 'ok';
    renderUserManagement();
    try {
      const r = await fetch('/api/users', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password: draft.password || '',
          roles: draft.roles || [],
        }),
      });
      const text = await r.text().catch(() => '');
      let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
      if (!r.ok) {
        const detail = (data && data.detail) || data.raw || `HTTP ${r.status}`;
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }
      umAdding = false; umEditing = null; umEditDraft = null;
      umStatus = `Saved ${email}`; umStatusKind = 'ok';
      await fetchUsers();
    } catch (e) {
      umStatus = String(e.message || e); umStatusKind = 'error';
      renderUserManagement();
    } finally {
      umBusy.delete(email);
    }
  }

  async function onDeleteUser(email) {
    umBusy.add(email);
    umStatus = `Removing ${email}…`; umStatusKind = 'ok';
    renderUserManagement();
    try {
      const r = await fetch(`/api/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const text = await r.text().catch(() => '');
      let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
      if (!r.ok) {
        const detail = (data && data.detail) || data.raw || `HTTP ${r.status}`;
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }
      umStatus = `Removed ${email}`; umStatusKind = 'ok';
      await fetchUsers();
    } catch (e) {
      umStatus = String(e.message || e); umStatusKind = 'error';
      renderUserManagement();
    } finally {
      umBusy.delete(email);
    }
  }
})();
