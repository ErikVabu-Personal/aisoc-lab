// agent_comm.js
// ────────────────────────────────────────────────────────────────────
// Right-side "Agent Communication" sidebar for the Live Agent View.
// Replaces the floating chat drawer + HITL pop-up. Hosts:
//
//   - HITL notifications (questions agents have asked the human)
//   - Per-agent chat threads (human-initiated conversations)
//
// Both surface as collapsible items in a single list. Multiple items
// can be expanded simultaneously, and the list is sorted with HITL
// notifications first (they need attention).

(function () {
  'use strict';

  const ROOT_ID = 'aisoc-comm-root';
  const SIDEBAR_WIDTH = 380; // keep in sync with the index handler's CSS
  const POLL_HITL_MS = 2000;
  const POLL_AGENTS_MS = 4000;
  const POLL_ONLINE_MS = 4000;
  const POLL_DM_MS = 15000; // refresh ALL DM threads — drives row previews; sends happen in popups now
  const POLL_INCIDENT_MS = 1500; // current_incident — fast so the elapsed timer ticks
  const POLL_QUEUE_MS = 8000; // /api/sentinel/incidents — match dashboard cadence
  const POLL_CHANGES_MS = 3000; // /api/changes/pending — quick so approvals feel live
  const POLL_AGENT_HIST_MS = 15000; // refresh agent chat history for row previews
  const STREAM_PATH = (agent) => `/api/agents/${encodeURIComponent(agent)}/message/stream`;

  // ── Styles ──────────────────────────────────────────────────────────
  const css = `
    #${ROOT_ID} {
      position: fixed !important;
      top: 60px !important;
      right: 0 !important;
      bottom: 0 !important;
      width: ${SIDEBAR_WIDTH}px !important;
      background: var(--color-bg, #ffffff);
      border-left: 1px solid var(--color-border, #cbd5e1);
      box-shadow: -2px 0 12px rgba(0,0,0,0.04);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      font: 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: var(--color-text, #1f2937);
    }
    /*
      The vendored Pixel Agents bundle has a global "all-elements"
      font-family rule (FS Pixel Sans) that cascades into every
      descendant of the sidebar — chat bubbles, headers, buttons,
      placeholders all flip back to the pixel font once the bundle's
      stylesheet loads. Force the system stack on every descendant of
      the sidebar with !important so the vendor rule loses the
      cascade. Same pattern as #aisoc-nav.
    */
    #${ROOT_ID},
    #${ROOT_ID} * {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
    }
    #${ROOT_ID} > header {
      flex-shrink: 0;
      padding: 12px 18px;
      background: var(--color-accent, #0099cc);
      color: #ffffff;
      font-weight: 700;
      font-size: 15px;
      letter-spacing: 0.02em;
      border-bottom: 1px solid var(--color-border, #cbd5e1);
    }
    #${ROOT_ID} .sub {
      font-size: 11px; font-weight: 500; opacity: 0.85;
      margin-top: 2px;
    }
    #${ROOT_ID} .body {
      flex: 1; min-height: 0;
      overflow-y: auto;
      padding: 8px;
    }
    #${ROOT_ID} .item {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    #${ROOT_ID} .item.notif { border: 2px solid #facc15; }
    #${ROOT_ID} .item.notif.urgent {
      animation: aisoc-comm-pulse 2.4s ease-in-out infinite;
    }
    @keyframes aisoc-comm-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(250,204,21,0.0); }
      50%      { box-shadow: 0 0 0 4px rgba(250,204,21,0.30); }
    }
    #${ROOT_ID} .item .head {
      padding: 10px 12px;
      cursor: pointer;
      display: flex; align-items: center; gap: 8px;
      user-select: none;
    }
    #${ROOT_ID} .item.notif .head { background: rgba(250,204,21,0.18); color: #713f12; }
    #${ROOT_ID} .item .head .name { flex: 1; font-weight: 700; text-transform: capitalize; }
    #${ROOT_ID} .item .head .preview {
      flex: 1; color: #6b7280; font-size: 12px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${ROOT_ID} .item .head .badge {
      background: #facc15; color: #1f2937;
      font-size: 11px; font-weight: 700;
      padding: 2px 8px; border-radius: 999px;
      letter-spacing: 0.05em; text-transform: uppercase;
    }
    #${ROOT_ID} .item .head .chev { color: #9ca3af; flex-shrink: 0; }
    #${ROOT_ID} .item .head .dot {
      width: 8px; height: 8px; border-radius: 50%; background: #9ca3af;
      flex-shrink: 0;
    }
    /* Agent status dots — coherent with the human dots:
         .idle    = online but not actively working   -> solid green
         .reading = actively working / tool call open -> pulsing blue
         .error   = something went wrong              -> red (steady)
       Humans use .dot.online (pulsing green) for online and bare
       .dot (steady grey) for offline. Errors stay red across the
       board. */
    #${ROOT_ID} .item .head .dot.idle    { background: #10b981; }
    #${ROOT_ID} .item .head .dot.reading {
      background: #0099cc;
      box-shadow: 0 0 0 0 rgba(0,153,204,0.55);
      animation: aisoc-comm-active-pulse 1.6s ease-out infinite;
    }
    @keyframes aisoc-comm-active-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(0,153,204,0.55); }
      70%  { box-shadow: 0 0 0 6px rgba(0,153,204,0);  }
      100% { box-shadow: 0 0 0 0 rgba(0,153,204,0);  }
    }
    #${ROOT_ID} .item .head .dot.error   { background: #ef4444; }

    #${ROOT_ID} .item .body-content {
      border-top: 1px solid #f3f4f6;
      padding: 10px 12px;
      max-height: 50vh;
      overflow-y: auto;
    }

    /* HITL question content */
    #${ROOT_ID} .question {
      white-space: pre-wrap; word-wrap: break-word;
      font-size: 13px; color: #1f2937;
      margin: 0 0 10px;
    }
    #${ROOT_ID} .answer-form {
      display: flex; flex-direction: column; gap: 8px;
    }
    #${ROOT_ID} .answer-form textarea {
      resize: vertical; min-height: 56px; max-height: 200px;
      width: 100%;
      padding: 8px 10px;
      border: 1px solid #cbd5e1; border-radius: 4px;
      font: inherit;
      box-sizing: border-box;
    }
    #${ROOT_ID} .answer-form textarea:focus {
      outline: none; border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .answer-form .actions {
      display: flex; gap: 6px; flex-wrap: wrap;
    }
    #${ROOT_ID} .answer-form button {
      padding: 6px 14px; border-radius: 4px;
      border: 1px solid #cbd5e1; background: #f9fafb;
      font: inherit; font-weight: 600; font-size: 13px;
      cursor: pointer; color: #1f2937;
    }
    #${ROOT_ID} .answer-form button:hover { background: #e5e7eb; }
    #${ROOT_ID} .answer-form button.approve {
      background: #facc15; border-color: #ca8a04; color: #1f2937;
    }
    #${ROOT_ID} .answer-form button.approve:hover { background: #eab308; }
    #${ROOT_ID} .answer-form button.reject  { color: #991b1b; }
    #${ROOT_ID} .answer-form button.reject:hover { background: rgba(239,68,68,0.10); }
    #${ROOT_ID} .answer-form button:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Chat thread content */
    #${ROOT_ID} .messages {
      display: flex; flex-direction: column; gap: 6px;
      margin-bottom: 8px;
    }
    #${ROOT_ID} .msg {
      max-width: 92%;
      padding: 8px 12px;
      border-radius: 8px;
      white-space: pre-wrap; word-wrap: break-word;
      font-size: 15px;
      line-height: 1.45;
    }
    #${ROOT_ID} .msg.user      { align-self: flex-end;   background: #e0f2fe; border: 1px solid #0099cc; }
    #${ROOT_ID} .msg.assistant { align-self: flex-start; background: #f3f4f6; border: 1px solid #cbd5e1; }
    #${ROOT_ID} .msg.error     { align-self: flex-start; background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.5); color: #991b1b; }

    /* Typing indicator — shown inside an assistant bubble while we're
       streaming but haven't received the first delta yet. Three dots
       fade in/out in sequence, like iMessage / Slack. */
    #${ROOT_ID} .msg.assistant.typing {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 10px 12px;
      min-height: 18px;
    }
    #${ROOT_ID} .msg.assistant.typing .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #6b7280;
      opacity: 0.35;
      animation: aisoc-comm-typing 1.2s ease-in-out infinite;
    }
    #${ROOT_ID} .msg.assistant.typing .dot:nth-child(2) { animation-delay: 0.15s; }
    #${ROOT_ID} .msg.assistant.typing .dot:nth-child(3) { animation-delay: 0.30s; }
    @keyframes aisoc-comm-typing {
      0%, 80%, 100% { opacity: 0.35; transform: translateY(0); }
      40%           { opacity: 1;    transform: translateY(-2px); }
    }
    #${ROOT_ID} .compose {
      display: flex; gap: 6px;
    }
    #${ROOT_ID} .compose textarea {
      flex: 1; resize: none;
      padding: 7px 9px;
      border: 1px solid #cbd5e1; border-radius: 4px;
      font: inherit; min-height: 38px; max-height: 120px;
      box-sizing: border-box;
    }
    #${ROOT_ID} .compose textarea:focus {
      outline: none; border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .compose button {
      padding: 0 14px; border: none; border-radius: 4px;
      background: #0099cc; color: #ffffff; font-weight: 700;
      cursor: pointer;
    }
    #${ROOT_ID} .compose button:hover:not(:disabled) { background: #33b0dd; }
    #${ROOT_ID} .compose button:disabled { opacity: 0.5; cursor: not-allowed; }

    #${ROOT_ID} .err-line {
      margin: 6px 0 0;
      padding: 6px 8px;
      background: rgba(239,68,68,0.10);
      color: #991b1b;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      border-radius: 4px;
    }
    #${ROOT_ID} .empty-line {
      padding: 18px;
      text-align: center;
      color: #6b7280;
      font-style: italic;
      font-size: 13px;
    }
    #${ROOT_ID} h2.section {
      font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #6b7280;
      margin: 12px 12px 6px;
    }
    /* Active-incident banner at the very top of the sidebar body.
       Shown only when /api/current_incident reports a non-null
       incident_number. Click → /dashboard. The whole card pulses
       a subtle blue while a workflow is in flight so it's
       impossible to miss from across the room. */
    #${ROOT_ID} .active-banner {
      display: block;
      margin: 8px 8px 12px;
      padding: 10px 12px;
      background: rgba(0,153,204,0.10);
      border: 1px solid rgba(0,153,204,0.45);
      border-radius: 6px;
      cursor: pointer;
      text-decoration: none !important;  /* it's an <a>, kill default underline */
      color: inherit;
      transition: background 0.15s ease;
      animation: aisoc-banner-pulse 2.2s ease-in-out infinite;
    }
    @keyframes aisoc-banner-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(0,153,204,0.0); }
      50%      { box-shadow: 0 0 0 4px rgba(0,153,204,0.25); }
    }
    #${ROOT_ID} .active-banner:hover {
      background: rgba(0,153,204,0.16);
    }
    /* Top line: incident number + title together. Blue, bold, with
       a pulsing dot to anchor the "alive" feeling. Title is allowed
       to ellipsis when long. */
    #${ROOT_ID} .active-banner .ab-title {
      display: flex; align-items: center; gap: 8px;
      font-weight: 700;
      font-size: 13px;
      color: #1e3a8a;
    }
    #${ROOT_ID} .active-banner .ab-title .num {
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    #${ROOT_ID} .active-banner .ab-title .ab-titleText {
      flex: 1; min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      color: #1f2937;
    }
    /* Subtext: status · agent · elapsed. Muted grey, mono so the
       elapsed timer doesn't jitter as digits change width. */
    #${ROOT_ID} .active-banner .ab-meta {
      font-size: 11px;
      color: #6b7280;
      margin-top: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.02em;
    }
    /* Per-agent / per-human "owns #N" pill — blue ribbon next to the
       row name to mark who's currently holding the incident. */
    #${ROOT_ID} .item .head .owns-pill {
      flex-shrink: 0;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: rgba(0,153,204,0.16);
      color: #1e3a8a;
      font-variant-numeric: tabular-nums;
    }
    /* Highlight ring on the row currently owning the active incident
       — subtle so it doesn't fight with the dot pulse, but enough
       that you can scan to the right row at a glance. */
    #${ROOT_ID} .item.owns-active {
      box-shadow: 0 0 0 2px rgba(0,153,204,0.45) inset;
    }
    /* "My queue" rows — incidents currently owned by the signed-in
       user. Each row has a clickable link area (opens Sentinel) and
       a reassign button / dropdown on the right. */
    #${ROOT_ID} .queue-item {
      display: flex;
      align-items: stretch;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    #${ROOT_ID} .queue-item a {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      text-decoration: none !important;
      color: inherit;
      min-width: 0;  /* let qtitle ellipsis kick in */
    }
    #${ROOT_ID} .queue-item a:hover {
      background: #f9fafb;
    }
    /* Reassign button at the right end of the row. Click → swaps
       to a <select> (rendered in place of this button). */
    #${ROOT_ID} .queue-item .qreassign-btn {
      flex-shrink: 0;
      margin: 6px 8px 6px 0;
      padding: 4px 10px;
      background: transparent;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      color: #0099cc;
      font: 600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      cursor: pointer;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    #${ROOT_ID} .queue-item .qreassign-btn:hover {
      background: #f0f9ff;
      border-color: #0099cc;
    }
    #${ROOT_ID} .queue-item .qreassign-btn:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    #${ROOT_ID} .queue-item select.qreassign {
      flex-shrink: 0;
      margin: 6px 8px 6px 0;
      padding: 3px 6px;
      border: 1px solid #0099cc;
      border-radius: 4px;
      background: #ffffff;
      font: 12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #1f2937;
      cursor: pointer;
      max-width: 220px;
    }
    #${ROOT_ID} .queue-item select.qreassign:focus {
      outline: none;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .queue-item .qnum {
      font-weight: 700;
      color: #0e2a47;
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    #${ROOT_ID} .queue-item .qtitle {
      flex: 1;
      font-size: 13px;
      color: #1f2937;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${ROOT_ID} .queue-item .qsev {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      flex-shrink: 0;
      border: 1px solid transparent;
    }
    #${ROOT_ID} .queue-item .qsev.high          { color: #991b1b; background: rgba(239,68,68,0.12);  border-color: rgba(239,68,68,0.4); }
    #${ROOT_ID} .queue-item .qsev.medium        { color: #92400e; background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.4); }
    #${ROOT_ID} .queue-item .qsev.low           { color: #166534; background: rgba(34,197,94,0.12);  border-color: rgba(34,197,94,0.4); }
    #${ROOT_ID} .queue-item .qsev.informational { color: #1e40af; background: rgba(0,153,204,0.12);  border-color: rgba(0,153,204,0.4); }
    /* Pending-change rows — proposals from agents (Knowledge today,
       detection-engineer rule proposals coming) that need analyst
       Approve / Reject before they take effect. Visually distinct
       from incident queue rows so the "this needs my decision"
       affordance is obvious. */
    #${ROOT_ID} .change-item {
      background: #ffffff;
      border: 2px solid #facc15;
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    #${ROOT_ID} .change-item .ch-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(250,204,21,0.10);
      cursor: pointer;
      user-select: none;
    }
    #${ROOT_ID} .change-item .ch-head:hover {
      background: rgba(250,204,21,0.18);
    }
    #${ROOT_ID} .change-item .ch-kind {
      flex-shrink: 0;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(0,153,204,0.14);
      color: #1e3a8a;
    }
    #${ROOT_ID} .change-item .ch-title {
      flex: 1;
      min-width: 0;
      font-weight: 600;
      font-size: 13px;
      color: #1f2937;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${ROOT_ID} .change-item .ch-by {
      flex-shrink: 0;
      font-size: 11px;
      color: #6b7280;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #${ROOT_ID} .change-item .ch-chev {
      flex-shrink: 0;
      color: #9ca3af;
    }
    #${ROOT_ID} .change-item .ch-body {
      border-top: 1px solid rgba(250,204,21,0.4);
      padding: 12px;
      font-size: 12px;
      color: #1f2937;
    }
    #${ROOT_ID} .change-item .ch-rationale {
      margin: 0 0 12px;
      line-height: 1.45;
    }
    #${ROOT_ID} .change-item .ch-section {
      margin-top: 10px;
    }
    #${ROOT_ID} .change-item .ch-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #6b7280;
      margin-bottom: 4px;
    }
    #${ROOT_ID} .change-item .ch-content {
      padding: 8px 10px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 220px;
      overflow-y: auto;
      color: #1f2937;
    }
    #${ROOT_ID} .change-item .ch-content.proposed {
      background: rgba(34,197,94,0.06);
      border-color: rgba(34,197,94,0.3);
    }
    #${ROOT_ID} .change-item .ch-content.mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
    }
    #${ROOT_ID} .change-item .ch-actions {
      margin-top: 12px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    #${ROOT_ID} .change-item .ch-actions textarea {
      flex: 1 1 100%;
      resize: vertical;
      min-height: 40px;
      max-height: 140px;
      padding: 6px 8px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font: inherit;
      font-size: 12px;
      box-sizing: border-box;
    }
    #${ROOT_ID} .change-item .ch-actions textarea:focus {
      outline: none;
      border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .change-item .ch-actions button {
      padding: 6px 14px;
      border-radius: 4px;
      font: inherit;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      border: 1px solid #cbd5e1;
      background: #f9fafb;
      color: #1f2937;
    }
    #${ROOT_ID} .change-item .ch-actions button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    #${ROOT_ID} .change-item .ch-actions button.approve {
      background: #facc15;
      border-color: #ca8a04;
      color: #1f2937;
    }
    #${ROOT_ID} .change-item .ch-actions button.approve:hover:not(:disabled) {
      background: #eab308;
    }
    #${ROOT_ID} .change-item .ch-actions button.reject {
      color: #991b1b;
    }
    #${ROOT_ID} .change-item .ch-actions button.reject:hover:not(:disabled) {
      background: rgba(239,68,68,0.10);
    }
    /* Online-presence pulse — green dot on each online human's row. */
    #${ROOT_ID} .item .head .dot.online {
      background: #10b981;
      box-shadow: 0 0 0 0 rgba(16,185,129,0.5);
      animation: aisoc-comm-online-pulse 2.4s ease-out infinite;
    }
    @keyframes aisoc-comm-online-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(16,185,129,0.55); }
      70%  { box-shadow: 0 0 0 6px rgba(16,185,129,0);  }
      100% { box-shadow: 0 0 0 0 rgba(16,185,129,0);  }
    }
    #${ROOT_ID} .item .head .name.email {
      /* Don't title-case email addresses, and let them ellipsis when
         the display name is too long for the row. */
      text-transform: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Stacked human head: dot stays on the left, but the name +
       role pills + DM preview stack vertically inside .hum-info so
       the pills don't fight the email for horizontal space. */
    #${ROOT_ID} .item .head.head-stacked {
      align-items: flex-start;
    }
    #${ROOT_ID} .item .head .hum-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    #${ROOT_ID} .item .head .hum-info .name.email {
      /* Override the row-wide nowrap so the email always fits the
         column width even when long; the title attr still shows the
         full address on hover. */
      max-width: 100%;
    }
    #${ROOT_ID} .item .head .hum-info .preview {
      /* Preview is no longer competing with the name on a single
         row — drop the flex:1 it inherits and let it sit naturally
         below the role pills. */
      flex: none;
    }
    #${ROOT_ID} .item .head .role-pills-row {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    /* Role pills under a human's email. Coloured per role so a
       glance at the sidebar shows who can do what. */
    #${ROOT_ID} .item .head .role-pill {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: rgba(0,153,204,0.14);
      color: #1e3a8a;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${ROOT_ID} .item .head .role-pill.role-soc-manager       { background: rgba(124,58,237,0.16); color: #4c1d95; }
    #${ROOT_ID} .item .head .role-pill.role-detection-engineer { background: rgba(245,158,11,0.20); color: #92400e; }
    #${ROOT_ID} .item .head .role-pill.role-soc-analyst        { background: rgba(16,185,129,0.16); color: #065f46; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Floating chat-panel CSS ──────────────────────────────────────
  // Each .aisoc-chat-panel is a fixed-position, draggable, resizable
  // box that hosts an iframe pointing at /chat-popup. Replaces the
  // old window.open-based popups, which Chromium kept showing a URL
  // bar on. z-index sits below the sidebar (9999) so the sidebar
  // remains usable, but above the rest of the page.
  const panelCss = `
    .aisoc-chat-panel {
      position: fixed;
      top: 80px;
      left: 80px;
      width: 440px;
      height: 640px;
      min-width: 320px;
      min-height: 360px;
      max-width: 95vw;
      max-height: 95vh;
      background: #ffffff;
      border: 1px solid var(--color-border, #cbd5e1);
      border-radius: 8px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.18);
      z-index: 9000;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      /* Native browser resize on the bottom-right corner. */
      resize: both;
      font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    /*
      The vendored Pixel Agents bundle has a global "all-elements"
      rule that cascades the FS Pixel Sans font into every descendant
      it can reach (header, button, textarea, placeholders, etc).
      Floating panels are appended to document.body — outside the
      sidebar root that already overrides this — so we have to
      restate the override here too. Same pattern as #aisoc-comm-root.
      Note: the iframe inside chat panels has its own document; the
      vendor stylesheet doesn't reach across the iframe boundary, so
      this rule is enough.
    */
    .aisoc-chat-panel,
    .aisoc-chat-panel * {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
    }
    .aisoc-chat-panel.dragging {
      /* Disable transitions and pointer events on the iframe while
         dragging so the cursor doesn't get stolen by the iframe
         document. */
      user-select: none;
    }
    .aisoc-chat-panel.dragging > iframe {
      pointer-events: none;
    }
    .aisoc-chat-panel > header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: var(--color-accent, #0099cc);
      color: #ffffff;
      font-weight: 700;
      font-size: 14px;
      cursor: move;
      user-select: none;
    }
    .aisoc-chat-panel > header .title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-transform: capitalize;
    }
    .aisoc-chat-panel > header .title.email {
      text-transform: none;
    }
    .aisoc-chat-panel > header .badge {
      flex-shrink: 0;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.20);
      color: #ffffff;
    }
    .aisoc-chat-panel > header .close {
      flex-shrink: 0;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: rgba(255,255,255,0.16);
      color: #ffffff;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .aisoc-chat-panel > header .close:hover {
      background: rgba(255,255,255,0.30);
    }
    .aisoc-chat-panel > iframe {
      flex: 1;
      width: 100%;
      border: none;
      background: #ffffff;
    }
    /* Change-review variant: scrollable body div instead of an iframe.
       Restates the sidebar's .change-item content rules unscoped so
       they apply inside the panel too. */
    .aisoc-chat-panel.change-panel > .ch-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 14px 16px;
      font-size: 13px;
      color: #1f2937;
    }
    .aisoc-chat-panel.change-panel .ch-rationale {
      margin: 0 0 12px;
      line-height: 1.45;
    }
    .aisoc-chat-panel.change-panel .ch-section {
      margin-top: 12px;
    }
    .aisoc-chat-panel.change-panel .ch-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #6b7280;
      margin-bottom: 4px;
    }
    .aisoc-chat-panel.change-panel .ch-content {
      padding: 8px 10px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 280px;
      overflow-y: auto;
      color: #1f2937;
    }
    .aisoc-chat-panel.change-panel .ch-content.proposed {
      background: rgba(34,197,94,0.06);
      border-color: rgba(34,197,94,0.3);
    }
    .aisoc-chat-panel.change-panel .ch-content.mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    .aisoc-chat-panel.change-panel .ch-actions {
      margin-top: 14px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .aisoc-chat-panel.change-panel .ch-actions textarea {
      flex: 1 1 100%;
      resize: vertical;
      min-height: 56px;
      max-height: 200px;
      padding: 8px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      box-sizing: border-box;
      color: #1f2937;
    }
    .aisoc-chat-panel.change-panel .ch-actions textarea:focus {
      outline: none;
      border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    .aisoc-chat-panel.change-panel .ch-actions button {
      padding: 7px 16px;
      border-radius: 4px;
      font: 600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      cursor: pointer;
      border: 1px solid #cbd5e1;
      background: #f9fafb;
      color: #1f2937;
    }
    .aisoc-chat-panel.change-panel .ch-actions button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .aisoc-chat-panel.change-panel .ch-actions button.approve {
      background: #facc15;
      border-color: #ca8a04;
      color: #1f2937;
    }
    .aisoc-chat-panel.change-panel .ch-actions button.approve:hover:not(:disabled) {
      background: #eab308;
    }
    .aisoc-chat-panel.change-panel .ch-actions button.reject {
      color: #991b1b;
    }
    .aisoc-chat-panel.change-panel .ch-actions button.reject:hover:not(:disabled) {
      background: rgba(239,68,68,0.10);
    }
  `;
  const panelStyle = document.createElement('style');
  panelStyle.textContent = panelCss;
  document.head.appendChild(panelStyle);

  // ── State ───────────────────────────────────────────────────────────
  const STATE = {
    hitl: [],                    // [{id, agent, question, asked_at}]
    agents: [],                  // [{agent, state, ...}]
    users: [],                   // [{email, online, last_seen, ago_sec}] — full roster minus me
    me: '',                      // my email (from /api/sessions/online)
    currentIncident: null,       // {incident_number, started_at, title?, view_status?, phase?} or null
    incidents: [],               // [{number, title, severity, status, owner, view_status, ...}] — full Sentinel listing
    editingQueueOwner: null,     // string incident number whose owner-edit dropdown is open
    savingQueueOwner: null,      // string incident number whose reassign POST is in flight
    changes: [],                 // [{id, kind, proposed_by, title, rationale, current, proposed, ...}]
    expandedChanges: new Set(),  // change ids whose detail panel is open
    changeNotes: {},             // change_id -> draft note for approve/reject
    sendingChange: new Set(),    // change ids whose approve/reject POST is in flight
    expanded: new Set(),         // ids 'hitl-{qid}' or 'chat-{agent}' or 'dm-{email}'
    conversations: {},           // agent -> [{role, text, toolCalls?, streaming?, error?}]
    dmThreads: {},               // peer_email -> [{id, from, to, text, ts}]
    dmThreadsLoaded: new Set(),  // peers whose history we've fetched at least once
    drafts: { hitl: {}, chat: {}, dm: {} },
    sending: new Set(),          // ids currently sending
    chatErrors: {},              // agent -> string
    dmErrors: {},                // peer_email -> string
    historyLoaded: new Set(),    // agents whose history we've fetched at least once
    historyPolling: new Set(),   // agents we're actively re-polling (in-flight on server)
  };

  // ── Helpers ─────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function capitalize(s) {
    return String(s || '').replace(/^./, (c) => c.toUpperCase());
  }

  function token() {
    return (window.__PIXELAGENTS_CHAT && window.__PIXELAGENTS_CHAT.token) || '';
  }

  function authHeaders() {
    // Cookie auth covers it; the token is a defence-in-depth fallback if
    // the cookie isn't set yet.
    const t = token();
    return t ? { 'x-pixelagents-token': t } : {};
  }

  function lastMessagePreview(agent) {
    const conv = STATE.conversations[agent] || [];
    const last = conv[conv.length - 1];
    if (!last) return 'Click to start a conversation';
    const text = (last.text || '').replace(/\s+/g, ' ').trim();
    return text || (last.role === 'assistant' ? 'Agent is thinking…' : '…');
  }

  // /api/agents/state returns each agent as {id, status, tool_name, ...} —
  // wrap so the rest of this file can keep reading `agent` / `status`.
  function agentName(a) { return (a && (a.id || a.agent)) || ''; }
  function agentStatus(a) { return (a && a.status) || 'idle'; }

  // Returns the agent slug that currently "owns" the active incident
  // (i.e., is in reading state while a workflow is in flight) or
  // null. Heuristic: there's at most one CURRENT_INCIDENT, and during
  // an in-flight run exactly one agent is in the reading state.
  function activeOwnerAgent() {
    if (!STATE.currentIncident || STATE.currentIncident.incident_number == null) {
      return null;
    }
    if (STATE.currentIncident.phase && STATE.currentIncident.phase !== 'agentic') {
      // Server says the run already handed back to a human — no
      // agent currently "holds" the incident in the visual sense.
      return null;
    }
    for (const a of STATE.agents) {
      if (agentStatus(a) === 'reading') return agentName(a);
    }
    return null;
  }

  function fmtElapsed(secs) {
    const s = Math.max(0, Math.floor(secs));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), r = s % 60;
    return `${m}m${String(r).padStart(2, '0')}s`;
  }

  // ── My queue: incidents owned by the signed-in user ───────────────
  // Filter the full Sentinel incidents listing on owner == me, drop
  // anything closed (closed incidents aren't actionable). Sort by
  // last_modified so the most recent one bubbles up.
  function myQueueIncidents() {
    const me = (STATE.me || '').toLowerCase();
    if (!me || !STATE.incidents.length) return [];
    return STATE.incidents
      .filter((inc) => {
        const owner = String((inc && inc.owner) || '').toLowerCase();
        const status = String((inc && inc.status) || '').toLowerCase();
        return owner === me && status !== 'closed';
      })
      .slice()
      .sort((a, b) => {
        const ta = a.last_modified ? Date.parse(a.last_modified) : 0;
        const tb = b.last_modified ? Date.parse(b.last_modified) : 0;
        return tb - ta;
      });
  }

  // Same deep-link shape the dashboard uses for the incident-#
  // column. Returns null when arm_id is missing — fall back to the
  // dashboard so the row is still clickable (rare; only an issue
  // for incidents that lack the ARM id, which shouldn't happen in
  // practice).
  function sentinelPortalUrl(inc) {
    if (!inc || !inc.arm_id) return null;
    return `https://portal.azure.com/#asset/Microsoft_Azure_Security_Insights/Incident${inc.arm_id}`;
  }

  // Friendly label for the kind badge on each change row. Falls
  // through to the raw kind string when the server adds a new one
  // before the UI catches up.
  function changeKindLabel(kind) {
    if (kind === 'knowledge-preamble') return 'Preamble';
    if (kind === 'agent-instructions') return 'Agent prompt';
    if (kind === 'detection-rule')     return 'Detection rule';
    return kind || 'Change';
  }

  // Stringify the change's `proposed` for display. For knowledge-
  // preamble + agent-instructions it's already a string. For
  // detection-rule it arrives as an object (rule definition); pretty-
  // print as JSON so the analyst can read the KQL + tactics + etc.
  function changeProposedAsText(c) {
    const p = c.proposed;
    if (typeof p === 'string') return p;
    if (p == null) return '';
    try {
      return JSON.stringify(p, null, 2);
    } catch (_) {
      return String(p);
    }
  }
  function changeCurrentAsText(c) {
    const cur = c.current;
    if (typeof cur === 'string') return cur;
    if (cur == null) return '';
    try {
      return JSON.stringify(cur, null, 2);
    } catch (_) {
      return String(cur);
    }
  }

  // Sidebar row for a pending change. Clicking the row opens a
  // draggable in-page panel with the full proposal + Approve/Reject
  // controls; the row itself stays compact so the queue remains
  // scannable. Body content + handlers live in openChangePanel().
  function renderChangeItem(c) {
    const id = c.id;
    const kindLabel = changeKindLabel(c.kind);
    const proposedBy = c.proposed_by || 'unknown';
    const target = c.target || '';
    const title = c.title || '(untitled change)';

    let html = `<div class="change-item">`;
    html += `<div class="ch-head" data-change-popup="${escapeHtml(id)}">`;
    html += `<span class="ch-kind">${escapeHtml(kindLabel)}</span>`;
    if (target && c.kind !== 'knowledge-preamble') {
      // For agent-instructions show the agent slug; for detection-
      // rule the rule's display name (server populates target with
      // displayName when proposing).
      html += `<span class="ch-by" style="color:#1e3a8a;">${escapeHtml(target)}</span>`;
    }
    html += `<span class="ch-title">${escapeHtml(title)}</span>`;
    html += `<span class="ch-by">${escapeHtml(proposedBy)}</span>`;
    html += `<span class="ch-chev">▸</span>`;
    html += `</div>`;
    html += `</div>`;
    return html;
  }

  function renderMyQueueItem(inc) {
    const num = inc.number;
    const numStr = String(num);
    const title = (inc.title || '').toString();
    const sev = String(inc.severity || '').toLowerCase();
    const portal = sentinelPortalUrl(inc);
    const href = portal || '/dashboard';
    const targetAttr = portal ? ' target="_blank" rel="noopener"' : '';
    const tooltip = portal
      ? `Open #${num} in Microsoft Sentinel`
      : `Open #${num} on the dashboard`;
    const isEditing = STATE.editingQueueOwner === numStr;
    const isSaving = STATE.savingQueueOwner === numStr;

    let trailing = '';
    if (isEditing) {
      // Build the reassign options. STATE.users excludes self; add
      // self at the top of the human list (with a "(you)" badge)
      // since reassigning to yourself is a valid action.
      const allHumans = [];
      if (STATE.me) allHumans.push({ email: STATE.me, is_self: true });
      for (const u of STATE.users) allHumans.push(u);
      const userOpts = allHumans
        .map((u) => `<option value="${escapeHtml(u.email)}"`
                  + `${(inc.owner || '').toLowerCase() === u.email.toLowerCase() ? ' disabled' : ''}>`
                  + `${escapeHtml(u.email)}${u.is_self ? ' (you)' : ''}</option>`)
        .join('');
      trailing = `
        <select class="qreassign" data-queue-reassign="${numStr}" autofocus>
          <option value="">Cancel…</option>
          <option value="Triage Agent">⚡ Triage Agent (re-triage)</option>
          ${userOpts}
        </select>`;
    } else {
      trailing = `<button class="qreassign-btn" data-queue-open-reassign="${numStr}" `
               + `${isSaving ? 'disabled' : ''} title="Reassign incident">`
               + `${isSaving ? 'Saving…' : 'Reassign'}</button>`;
    }

    return `
      <div class="queue-item">
        <a href="${escapeHtml(href)}"${targetAttr} title="${escapeHtml(tooltip)}">
          <span class="qnum">#${num}</span>
          <span class="qtitle">${escapeHtml(title || '(no title)')}</span>
          ${sev ? `<span class="qsev ${escapeHtml(sev)}">${escapeHtml(inc.severity)}</span>` : ''}
        </a>
        ${trailing}
      </div>`;
  }

  // ── Floating chat panels ────────────────────────────────────────────
  // Replaces the old window.open() popups. Each panel is an absolute-
  // positioned <div> that hosts an iframe pointing at the existing
  // /chat-popup route, so we don't have to re-implement streaming +
  // history. The panels are draggable by their header and resizable
  // via the browser-native CSS `resize: both` corner. Multiple panels
  // can be open at once; clicking any panel raises it above its
  // siblings (still under the sidebar's z-index).
  const chatPanels = new Map(); // panelKey -> { el, iframe, lastZ }
  let nextZ = 9000;             // grows as panels are raised
  let cascadeOffset = 0;        // each new panel offsets so they stack visibly

  function panelKey(kind, id) { return `${kind}::${id}`; }

  function raisePanel(panelEl) {
    nextZ += 1;
    panelEl.style.zIndex = String(nextZ);
  }

  function closeChatPanel(key) {
    const rec = chatPanels.get(key);
    if (!rec) return;
    try { rec.el.remove(); } catch (_) { /* best-effort */ }
    chatPanels.delete(key);
  }

  // Wire the drag-on-header behaviour. Uses pointer events so it works
  // with mouse + touch + pen alike. While dragging we toggle the
  // .dragging class which disables pointer-events on the iframe — that
  // way the iframe document doesn't steal the pointer mid-drag (which
  // would make the panel "stick" to the cursor on iframe entry/exit).
  function attachDrag(panelEl, headerEl) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let pointerId = null;

    function onPointerDown(ev) {
      // Ignore drags that originate on a button (e.g. the close button).
      if (ev.target && ev.target.closest && ev.target.closest('button')) return;
      pointerId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = panelEl.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      panelEl.classList.add('dragging');
      headerEl.setPointerCapture(pointerId);
      raisePanel(panelEl);
      ev.preventDefault();
    }
    function onPointerMove(ev) {
      if (pointerId == null || ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let nextLeft = startLeft + dx;
      let nextTop = startTop + dy;
      // Keep at least 40px of the header inside the viewport so the
      // panel can always be grabbed back.
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = panelEl.offsetWidth, h = panelEl.offsetHeight;
      nextLeft = Math.max(-(w - 80), Math.min(vw - 40, nextLeft));
      nextTop  = Math.max(0,           Math.min(vh - 40, nextTop));
      panelEl.style.left = `${nextLeft}px`;
      panelEl.style.top  = `${nextTop}px`;
    }
    function onPointerUp(ev) {
      if (pointerId == null || ev.pointerId !== pointerId) return;
      try { headerEl.releasePointerCapture(pointerId); } catch (_) {}
      pointerId = null;
      panelEl.classList.remove('dragging');
    }
    headerEl.addEventListener('pointerdown', onPointerDown);
    headerEl.addEventListener('pointermove', onPointerMove);
    headerEl.addEventListener('pointerup', onPointerUp);
    headerEl.addEventListener('pointercancel', onPointerUp);
  }

  // Open a draggable in-page chat panel. If a panel for this key is
  // already open, raise it to the top instead of spawning a duplicate
  // (mirrors the old window.open named-window behaviour).
  function openChatPanel(kind, id) {
    const key = panelKey(kind, id);
    const existing = chatPanels.get(key);
    if (existing) {
      raisePanel(existing.el);
      return existing;
    }

    // noheader=1 tells chat_popup.js to suppress its own header — the
    // panel's draggable outer header already shows the title, so we
    // don't want it twice.
    const params = new URLSearchParams({ kind, id, noheader: '1' });
    const url = `/chat-popup?${params.toString()}`;

    const panel = document.createElement('div');
    panel.className = 'aisoc-chat-panel';
    // Cascade subsequent panels by ~30px down/right from the previous
    // so they stack visibly rather than landing exactly on top.
    const baseLeft = 80, baseTop = 80;
    panel.style.left = `${baseLeft + cascadeOffset}px`;
    panel.style.top  = `${baseTop + cascadeOffset}px`;
    cascadeOffset = (cascadeOffset + 30) % 240;

    const titleClass = (kind === 'human') ? 'title email' : 'title';
    const titleText = (kind === 'human') ? id : capitalize(id);
    const badgeText = (kind === 'human') ? 'Direct' : 'Agent';
    panel.innerHTML = `
      <header>
        <span class="badge">${escapeHtml(badgeText)}</span>
        <span class="${titleClass}" title="${escapeHtml(titleText)}">${escapeHtml(titleText)}</span>
        <button class="close" aria-label="Close" title="Close">&times;</button>
      </header>
      <iframe src="${escapeHtml(url)}" allow="clipboard-write"></iframe>
    `;
    document.body.appendChild(panel);
    raisePanel(panel);

    const headerEl = panel.querySelector('header');
    const closeBtn = panel.querySelector('button.close');
    const iframe = panel.querySelector('iframe');

    closeBtn.addEventListener('click', () => closeChatPanel(key));
    panel.addEventListener('mousedown', () => raisePanel(panel), true);
    attachDrag(panel, headerEl);

    chatPanels.set(key, { el: panel, iframe });
    return chatPanels.get(key);
  }

  // ── Change panels (proposed-changes review) ─────────────────────────
  // Same draggable + resizable shell as the chat panels, but the body
  // is a div (not an iframe) because the change content + approve /
  // reject controls are driven entirely by client-side STATE we
  // already poll. Each open panel has a render() function that we
  // call from the main render() pass so the panel reflects fresh
  // STATE.changes data.
  const changePanels = new Map(); // changeId -> { el, render }

  function _findChange(changeId) {
    return STATE.changes.find((c) => c && c.id === changeId) || null;
  }

  function closeChangePanel(changeId) {
    const rec = changePanels.get(changeId);
    if (!rec) return;
    try { rec.el.remove(); } catch (_) { /* best-effort */ }
    changePanels.delete(changeId);
  }

  // Re-render every open change panel from current STATE. Called from
  // the main render() pass so server-side updates (other analysts
  // approving / rejecting, agents withdrawing the proposal) are
  // reflected immediately. If the change has disappeared from
  // STATE.changes, the panel auto-closes — pending changes that turn
  // into history aren't actionable, so the panel can't usefully linger.
  function refreshChangePanels() {
    for (const [changeId, rec] of Array.from(changePanels.entries())) {
      const c = _findChange(changeId);
      if (!c) {
        closeChangePanel(changeId);
        continue;
      }
      rec.render(c);
    }
  }

  function _renderChangePanelBody(c) {
    const sending = STATE.sendingChange.has(c.id);
    const note = STATE.changeNotes[c.id] || '';
    const proposedText = changeProposedAsText(c);
    const currentText = changeCurrentAsText(c);
    const monoCls = c.kind === 'detection-rule' ? ' mono' : '';

    let html = '';
    if (c.rationale) {
      html += `<p class="ch-rationale">${escapeHtml(c.rationale)}</p>`;
    }
    html += `<div class="ch-section">`;
    html += `<div class="ch-label">Proposed</div>`;
    html += `<div class="ch-content proposed${monoCls}">${escapeHtml(proposedText)}</div>`;
    html += `</div>`;
    if (currentText) {
      html += `<div class="ch-section">`;
      html += `<div class="ch-label">Current (for comparison)</div>`;
      html += `<div class="ch-content${monoCls}">${escapeHtml(currentText)}</div>`;
      html += `</div>`;
    } else if (c.kind === 'detection-rule') {
      html += `<div class="ch-section" style="color:#6b7280;font-size:11px;">`
            + `(net-new rule — no current state to compare against)`
            + `</div>`;
    }
    html += `<div class="ch-actions">`;
    html += `<textarea data-change-note="${escapeHtml(c.id)}" `
          + `placeholder="Optional note (sent with Approve / Reject)…" `
          + `${sending ? 'disabled' : ''}>${escapeHtml(note)}</textarea>`;
    html += `<button class="approve" data-change-approve="${escapeHtml(c.id)}" ${sending ? 'disabled' : ''}>${sending ? 'Sending…' : 'Approve'}</button>`;
    html += `<button class="reject"  data-change-reject="${escapeHtml(c.id)}"  ${sending ? 'disabled' : ''}>Reject</button>`;
    html += `</div>`;
    return html;
  }

  function openChangePanel(changeId) {
    const existing = changePanels.get(changeId);
    if (existing) {
      raisePanel(existing.el);
      return existing;
    }
    const c = _findChange(changeId);
    if (!c) return null;

    const panel = document.createElement('div');
    panel.className = 'aisoc-chat-panel change-panel';
    const baseLeft = 80, baseTop = 80;
    panel.style.left = `${baseLeft + cascadeOffset}px`;
    panel.style.top  = `${baseTop + cascadeOffset}px`;
    cascadeOffset = (cascadeOffset + 30) % 240;

    const kindLabel = changeKindLabel(c.kind);
    const titleText = c.title || '(untitled change)';
    panel.innerHTML = `
      <header>
        <span class="badge">${escapeHtml(kindLabel)}</span>
        <span class="title" title="${escapeHtml(titleText)}">${escapeHtml(titleText)}</span>
        <button class="close" aria-label="Close" title="Close">&times;</button>
      </header>
      <div class="ch-body" data-change-body="${escapeHtml(changeId)}"></div>
    `;
    document.body.appendChild(panel);
    raisePanel(panel);

    const headerEl = panel.querySelector('header');
    const closeBtn = panel.querySelector('button.close');
    const bodyEl = panel.querySelector('.ch-body');

    closeBtn.addEventListener('click', () => closeChangePanel(changeId));
    panel.addEventListener('mousedown', () => raisePanel(panel), true);
    attachDrag(panel, headerEl);

    // Wire delegated handlers on the body so they survive re-renders
    // of the inner HTML (we replace innerHTML on every refresh).
    bodyEl.addEventListener('input', (ev) => {
      const ta = ev.target.closest && ev.target.closest('[data-change-note]');
      if (ta) STATE.changeNotes[ta.getAttribute('data-change-note')] = ta.value;
    });
    bodyEl.addEventListener('click', (ev) => {
      const approve = ev.target.closest && ev.target.closest('[data-change-approve]');
      const reject  = ev.target.closest && ev.target.closest('[data-change-reject]');
      if (approve) onChangeDecision(approve.getAttribute('data-change-approve'), 'approve');
      else if (reject) onChangeDecision(reject.getAttribute('data-change-reject'), 'reject');
    });

    function render(latest) {
      // Preserve focus + selection in the textarea across re-renders.
      const active = document.activeElement;
      const wasNote = active && active.getAttribute && active.getAttribute('data-change-note');
      let selStart = 0, selEnd = 0;
      if (wasNote === changeId) {
        try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
      }
      bodyEl.innerHTML = _renderChangePanelBody(latest);
      if (wasNote === changeId) {
        const ta = bodyEl.querySelector(`[data-change-note="${CSS.escape(changeId)}"]`);
        if (ta) {
          try { ta.focus(); ta.setSelectionRange(selStart, selEnd); } catch (_) {}
        }
      }
    }
    render(c);

    changePanels.set(changeId, { el: panel, render });
    return changePanels.get(changeId);
  }

  // ── Rendering ───────────────────────────────────────────────────────
  let rootEl = null;

  function ensureRoot() {
    if (rootEl) return rootEl;
    rootEl = document.createElement('div');
    rootEl.id = ROOT_ID;
    document.body.appendChild(rootEl);
    return rootEl;
  }

  // Return true if the incident with this number is currently owned by
  // a human analyst (anyone in the user roster). Used by the sidebar
  // to decide whether incident-bound HITL questions belong in
  // "Incident Input Needed" (= still agent-handled) or "Pending
  // requests" (= human is already on the case).
  function _incidentOwnedByHuman(num) {
    if (num == null) return false;
    const inc = STATE.incidents.find((i) => Number(i && i.number) === Number(num));
    if (!inc) {
      // No incident match yet — could be a stale snapshot. Be cautious
      // and treat as not-owned-by-human so the question still surfaces
      // in the "Incident Input Needed" section rather than vanishing.
      return false;
    }
    const owner = String((inc && inc.owner) || '').trim();
    if (!owner) return false;
    const ownerLower = owner.toLowerCase();
    // Agent-owned: display names always end with " Agent" (e.g.
    // "Investigator Agent", "Reporter Agent", "Investigator Agent
    // (re-review)") because that's how the orchestrator labels them.
    if (ownerLower.includes(' agent')) return false;
    // Otherwise we treat it as human-owned. Conservative — even if the
    // owner string isn't recognised in the user roster, it's clearly
    // not an agent label.
    return true;
  }

  // Look up an incident's title for the group header in "Incident Input
  // Needed". Returns null when we don't have it cached yet (sidebar
  // will fall back to "(loading title…)").
  function _incidentTitle(num) {
    const inc = STATE.incidents.find((i) => Number(i && i.number) === Number(num));
    return (inc && inc.title) ? String(inc.title) : null;
  }

  // Render a group of HITL questions bound to the same incident under
  // the "Incident Input Needed" section. The header shows incident
  // number + title and links to the dashboard; questions render with
  // the same expand-and-reply UI as the standalone HITL items.
  function renderIncidentInputGroup(num, questions) {
    const title = _incidentTitle(num) || '(loading title…)';
    let html = '';
    html += `<div class="queue-item" style="border-color:#facc15;">`;
    html += `<a href="/dashboard" title="Open #${num} on the dashboard">`;
    html += `<span class="qnum">#${num}</span>`;
    html += `<span class="qtitle">${escapeHtml(title)}</span>`;
    html += `</a>`;
    html += `</div>`;
    for (const q of questions) html += renderHitlItem(q);
    return html;
  }

  function renderHitlItem(q) {
    const id = `hitl-${q.id}`;
    const expanded = STATE.expanded.has(id);
    const draft = STATE.drafts.hitl[q.id] || '';
    const sending = STATE.sending.has(id);
    const chev = expanded ? '▾' : '▸';
    // Show the incident pill on the row head when this question is
    // bound to a Sentinel case, so analysts can scan a row of HITL
    // notifications and see at a glance which incident each maps to.
    const incPill = (q.incident_number != null)
      ? `<span class="owns-pill" title="Incident #${q.incident_number}">#${q.incident_number}</span>`
      : '';
    const head = `
      <div class="head" data-toggle="${id}">
        <span class="badge">Question</span>
        <span class="name">${escapeHtml(q.agent || 'agent')}</span>
        ${incPill}
        <span class="chev">${chev}</span>
      </div>`;
    if (!expanded) return `<div class="item notif ${sending ? '' : 'urgent'}">${head}</div>`;
    const body = `
      <div class="body-content">
        <p class="question">${escapeHtml(q.question || '')}</p>
        <div class="answer-form">
          <textarea data-hitl-textarea="${q.id}" placeholder="Type your reply for the agent — they read free text, so be specific…" ${sending ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>
          <div class="actions">
            <button class="approve" data-hitl-send="${q.id}" ${sending ? 'disabled' : ''}>${sending ? 'Sending…' : 'Send reply'}</button>
          </div>
        </div>
      </div>`;
    return `<div class="item notif">${head}${body}</div>`;
  }

  function renderChatItem(a) {
    const agent = agentName(a);
    if (!agent) return '';
    const status = agentStatus(a);

    // "owns #N" badge + highlight ring when this agent currently
    // holds the active incident.
    const ownsActive = (
      STATE.currentIncident
      && STATE.currentIncident.incident_number != null
      && activeOwnerAgent() === agent
    );
    const ownsPill = ownsActive
      ? `<span class="owns-pill" title="Currently working on incident #${STATE.currentIncident.incident_number}">#${STATE.currentIncident.incident_number}</span>`
      : '';
    const itemCls = ownsActive ? 'item owns-active' : 'item';

    // Click on the row opens a draggable in-page chat panel for this
    // agent. Inline expand was retired (cramped the sidebar); the
    // panels let analysts keep multiple chats docked side-by-side
    // without leaving the dashboard.
    return `
      <div class="${itemCls}">
        <div class="head" data-popup-agent="${escapeHtml(agent)}">
          <span class="dot ${status}"></span>
          <span class="name">${escapeHtml(capitalize(agent))}</span>
          ${ownsPill}
          <span class="preview">${escapeHtml(lastMessagePreview(agent))}</span>
        </div>
      </div>`;
  }

  // ── DM thread item (one per online human) ──────────────────────────
  function dmPreviewFor(peer) {
    const thread = STATE.dmThreads[peer] || [];
    const last = thread[thread.length - 1];
    if (!last) return 'Click to start a conversation';
    const prefix = last.from === STATE.me ? 'You: ' : '';
    return prefix + (last.text || '').replace(/\s+/g, ' ').slice(0, 80);
  }

  // Friendly short labels for role pills next to human emails. Kept
  // short so multiple roles fit on a single sidebar row.
  function roleShortLabel(role) {
    return ({
      'soc-manager':         'SOC Manager',
      'detection-engineer':  'Det. Engineer',
      'soc-analyst':         'SOC Analyst',
    })[role] || role;
  }

  function rolePillsHtml(roles) {
    if (!Array.isArray(roles) || !roles.length) return '';
    let html = '';
    for (const r of roles) {
      const cls = `role-pill role-${String(r).replace(/[^a-z0-9-]/gi, '')}`;
      html += `<span class="${cls}" title="${escapeHtml(r)}">`
            + `${escapeHtml(roleShortLabel(r))}</span>`;
    }
    return html;
  }

  function renderDmItem(userRec) {
    // Accept either a full {email, online, ...} record (preferred)
    // or a bare email string (legacy callers that just had a peer).
    const peer = (userRec && typeof userRec === 'object') ? userRec.email : userRec;
    const isOnline = !!(userRec && userRec.online);
    const isSelf = !!(userRec && userRec.is_self);
    const roles = (userRec && Array.isArray(userRec.roles)) ? userRec.roles : [];
    if (!peer) return '';
    const pills = rolePillsHtml(roles);

    // Self gets a flat, non-clickable row — no toggle, no thread,
    // no compose. The pulsing green dot makes it visually
    // consistent with the other online users; the "(you)" suffix
    // avoids any "wait, can I DM myself?" confusion.
    if (isSelf) {
      return `
        <div class="item">
          <div class="head head-stacked" style="cursor: default;">
            <span class="dot online" title="You"></span>
            <div class="hum-info">
              <span class="name email" title="${escapeHtml(peer)}">`
              + `${escapeHtml(peer)} `
              + `<em style="font-style:italic;opacity:0.6;font-weight:500;">(you)</em>`
              + `</span>
              ${pills ? `<div class="role-pills-row">${pills}</div>` : ''}
            </div>
          </div>
        </div>`;
    }

    const dotCls = isOnline ? 'dot online' : 'dot';
    const dotTitle = isOnline
      ? 'Online'
      : (userRec && userRec.ago_sec != null
          ? `Offline (last seen ${userRec.ago_sec}s ago)`
          : 'Offline');

    // Click on the row opens a draggable in-page chat panel for this human.
    // The head uses a vertical stack (.hum-info) so the email keeps
    // its own line + the role pills sit cleanly below it without
    // competing for horizontal space.
    return `
      <div class="item">
        <div class="head head-stacked" data-popup-human="${escapeHtml(peer)}">
          <span class="${dotCls}" title="${escapeHtml(dotTitle)}"></span>
          <div class="hum-info">
            <span class="name email" title="${escapeHtml(peer)}">${escapeHtml(peer)}</span>
            ${pills ? `<div class="role-pills-row">${pills}</div>` : ''}
            <span class="preview">${escapeHtml(dmPreviewFor(peer))}</span>
          </div>
        </div>
      </div>`;
  }

  function render() {
    const root = ensureRoot();

    // Defer renders while a queue-reassign <select> is focused. The
    // poll-driven innerHTML wipe would otherwise destroy the dropdown
    // mid-interaction, closing the OS-level options menu and yanking
    // the user's focus. The change/blur handlers will trigger a fresh
    // render once the user picks an option or cancels.
    const ae = document.activeElement;
    if (ae && ae.tagName === 'SELECT' && ae.hasAttribute('data-queue-reassign')) {
      return;
    }

    // ── Preserve focus + selection across re-renders ──
    const active = document.activeElement;
    let focusKind = null, focusKey = null, selStart = 0, selEnd = 0;
    if (active && active.tagName === 'TEXTAREA') {
      const hk = active.getAttribute('data-hitl-textarea');
      const ck = active.getAttribute('data-chat-textarea');
      const dk = active.getAttribute('data-dm-textarea');
      const nk = active.getAttribute('data-change-note');
      if (hk) { focusKind = 'hitl'; focusKey = hk; }
      else if (ck) { focusKind = 'chat'; focusKey = ck; }
      else if (dk) { focusKind = 'dm'; focusKey = dk; }
      else if (nk) { focusKind = 'change'; focusKey = nk; }
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
    }

    // ── Snapshot scroll positions before the innerHTML wipe ──
    // Two scroll containers matter: the sidebar's `.body` (the list of
    // items) and each open item's `.body-content` (the chat thread or
    // HITL question). Both reset to top on innerHTML replacement; we
    // restore here so streaming tokens / poll refreshes don't yank
    // the user back to the top of whatever they were reading.
    //
    // For each, we also remember whether the user was already at the
    // bottom — if so, we *re-stick* to the bottom after render so new
    // content appears as if the chat scrolled naturally with it.
    const STICK_THRESHOLD_PX = 30;
    function snapshotScroll(el) {
      if (!el) return null;
      return {
        top: el.scrollTop,
        atBottom: (el.scrollHeight - el.scrollTop - el.clientHeight) < STICK_THRESHOLD_PX,
      };
    }
    const bodyScroll = snapshotScroll(root.querySelector('.body'));
    const itemScrolls = {};
    root.querySelectorAll('.item').forEach((item) => {
      const head = item.querySelector('[data-toggle]');
      const id = head ? head.getAttribute('data-toggle') : null;
      const content = item.querySelector('.body-content');
      if (id && content) itemScrolls[id] = snapshotScroll(content);
    });

    let html = '<header>Control Panel<div class="sub">Agents, humans, and the incidents on your plate</div></header>';
    html += '<div class="body">';

    // Active incident banner — sits at the very top so the user
    // always knows what's in flight at a glance.
    const ci = STATE.currentIncident;
    if (ci && ci.incident_number != null) {
      const num = ci.incident_number;
      const title = ci.title || '(loading title…)';
      const phase = ci.phase || 'agentic';
      const ownerSlug = activeOwnerAgent();
      const ownerLabel = ownerSlug
        ? `${capitalize(ownerSlug)} agent`
        : (phase === 'human' ? 'Human analyst' : '—');
      const elapsed = ci.started_at
        ? fmtElapsed(Date.now() / 1000 - ci.started_at)
        : '—';
      html += `
        <a href="/dashboard" class="active-banner" title="Open in dashboard">
          <div class="ab-title">
            <span class="dot reading"></span>
            <span class="num">#${num}</span>
            <span class="ab-titleText" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
          </div>
          <div class="ab-meta">
            Analysis ongoing · ${escapeHtml(ownerLabel)} · ${escapeHtml(elapsed)} elapsed
          </div>
        </a>`;
    }

    // Split pending HITL questions into two groups:
    //   1. Incident-bound questions where the incident isn't owned by
    //      a human → "Incident Input Needed" (these are cases the
    //      agents are still working on but need a human steer to make
    //      progress).
    //   2. Everything else (broadcast non-incident chat asks, plus
    //      incident questions where a human already owns the case)
    //      → "Pending requests".
    const hitlByIncident = {};   // incident_number -> [questions]
    const hitlOther = [];
    for (const q of STATE.hitl) {
      const incNum = q.incident_number;
      if (incNum != null && !_incidentOwnedByHuman(incNum)) {
        const key = String(incNum);
        if (!hitlByIncident[key]) hitlByIncident[key] = [];
        hitlByIncident[key].push(q);
      } else {
        hitlOther.push(q);
      }
    }

    const incidentInputNums = Object.keys(hitlByIncident)
      .map(Number)
      .sort((a, b) => a - b);

    if (incidentInputNums.length) {
      html += '<h2 class="section">Incident input needed</h2>';
      for (const num of incidentInputNums) {
        html += renderIncidentInputGroup(num, hitlByIncident[String(num)]);
      }
    }

    if (hitlOther.length) {
      html += '<h2 class="section">Pending requests</h2>';
      for (const q of hitlOther) html += renderHitlItem(q);
    }
    html += '<h2 class="section">Agents</h2>';
    if (!STATE.agents.length) {
      html += '<div class="empty-line">No agents reporting yet.</div>';
    } else {
      for (const a of STATE.agents) html += renderChatItem(a);
    }
    // Humans — full configured roster (online sorted first, then
    // offline). Status dot reflects online/offline, same affordance
    // as the agents above.
    html += '<h2 class="section">Humans</h2>';
    if (!STATE.users.length) {
      html += '<div class="empty-line">No other humans configured.</div>';
    } else {
      for (const u of STATE.users) html += renderDmItem(u);
    }
    // My queue — incidents Sentinel-owned, filtered by owner == me.
    // Proposed changes used to live here too; they moved to their own
    // /improvements page so detection engineers + SOC managers have a
    // dedicated review surface and analysts don't see the noise.
    html += '<h2 class="section">My queue</h2>';

    html += '<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin:8px 12px 4px;font-weight:700;">My incidents</div>';
    const myInc = myQueueIncidents();
    if (!myInc.length) {
      html += '<div class="empty-line">No incidents currently assigned to you.</div>';
    } else {
      for (const inc of myInc) html += renderMyQueueItem(inc);
    }

    html += '</div>';
    root.innerHTML = html;

    // ── Restore scroll positions ──
    function restoreScroll(el, snap) {
      if (!el || !snap) return;
      // Auto-stick to bottom if the user was already there; otherwise
      // restore the exact prior offset.
      el.scrollTop = snap.atBottom ? el.scrollHeight : snap.top;
    }
    restoreScroll(root.querySelector('.body'), bodyScroll);
    root.querySelectorAll('.item').forEach((item) => {
      const head = item.querySelector('[data-toggle]');
      const id = head ? head.getAttribute('data-toggle') : null;
      const content = item.querySelector('.body-content');
      if (id && content && itemScrolls[id]) {
        restoreScroll(content, itemScrolls[id]);
      }
    });

    // ── Restore focus ──
    if (focusKind && focusKey) {
      const sel = focusKind === 'hitl'
        ? `[data-hitl-textarea="${CSS.escape(focusKey)}"]`
        : focusKind === 'dm'
          ? `[data-dm-textarea="${CSS.escape(focusKey)}"]`
          : focusKind === 'change'
            ? `[data-change-note="${CSS.escape(focusKey)}"]`
            : `[data-chat-textarea="${CSS.escape(focusKey)}"]`;
      const el = root.querySelector(sel);
      if (el) {
        try { el.focus(); el.setSelectionRange(selStart, selEnd); } catch (_) {}
      }
    }

    // Click handlers on heads (toggle).
    root.querySelectorAll('[data-toggle]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-toggle');
        if (STATE.expanded.has(id)) STATE.expanded.delete(id);
        else STATE.expanded.add(id);
        render();
      });
    });

    // HITL textarea drafts.
    root.querySelectorAll('[data-hitl-textarea]').forEach((ta) => {
      ta.addEventListener('input', () => {
        STATE.drafts.hitl[ta.getAttribute('data-hitl-textarea')] = ta.value;
      });
    });
    root.querySelectorAll('[data-hitl-send]').forEach((btn) => {
      btn.addEventListener('click', () => onHitlAnswer(btn.getAttribute('data-hitl-send')));
    });

    // Open a draggable in-page chat panel for an agent or human. The
    // panel hosts an iframe pointing at /chat-popup so we don't have
    // to re-implement streaming + history here. Re-clicking the same
    // row brings the existing panel to the front.
    root.querySelectorAll('[data-popup-agent]').forEach((el) => {
      el.addEventListener('click', () => {
        openChatPanel('agent', el.getAttribute('data-popup-agent'));
      });
    });
    root.querySelectorAll('[data-popup-human]').forEach((el) => {
      el.addEventListener('click', () => {
        openChatPanel('human', el.getAttribute('data-popup-human'));
      });
    });

    // ── My queue reassignment ─────────────────────────────────────────
    // Click "Reassign" → swap the button for a <select>; pick from
    // the dropdown → POST /api/sentinel/incidents/{n}/owner; blur
    // (or pick the cancel option) → revert without saving.
    root.querySelectorAll('[data-queue-open-reassign]').forEach((btn) => {
      btn.addEventListener('click', () => {
        STATE.editingQueueOwner = btn.getAttribute('data-queue-open-reassign');
        render();
      });
    });
    root.querySelectorAll('[data-queue-reassign]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const num = sel.getAttribute('data-queue-reassign');
        const value = sel.value;
        if (!value) {
          // "Cancel…" picked — close the dropdown without saving.
          STATE.editingQueueOwner = null;
          render();
          return;
        }
        onQueueReassign(num, value);
      });
      sel.addEventListener('blur', () => {
        STATE.editingQueueOwner = null;
        render();
      });
    });

    // Lazy-hydrate any DM thread that's currently expanded but not
    // yet loaded (e.g. user just clicked a head for the first time).
    for (const id of STATE.expanded) {
      if (!id.startsWith('dm-')) continue;
      const peer = id.slice(3);
      if (!STATE.dmThreadsLoaded.has(peer)) {
        STATE.dmThreadsLoaded.add(peer);
        hydrateDmThread(peer);
      }
    }

    // ── Pending change row → open draggable panel ─────────────────────
    // The body content (rationale, proposed/current, approve/reject)
    // now lives in the panel, not inline; the textarea + buttons are
    // wired by openChangePanel via delegated handlers on the panel
    // body, so no per-render attachment is needed here.
    root.querySelectorAll('[data-change-popup]').forEach((el) => {
      el.addEventListener('click', () => {
        openChangePanel(el.getAttribute('data-change-popup'));
      });
    });

    // Refresh any open change panels so they reflect the latest poll
    // (e.g. another analyst's approve/reject pulled the change off
    // the pending list — the panel auto-closes in that case).
    refreshChangePanels();
  }

  // POST handler for queue reassignment. Same endpoint the dashboard
  // uses, so the server-side validation (must be a roster user, or
  // "Triage Agent") applies here too.
  async function onQueueReassign(numStr, value) {
    STATE.editingQueueOwner = null;
    STATE.savingQueueOwner = numStr;
    render();
    try {
      const r = await fetch(
        `/api/sentinel/incidents/${encodeURIComponent(numStr)}/owner`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ owner: value }),
        },
      );
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
      }
      // Pull fresh incidents so the queue reflects the change. If the
      // new owner is someone else, the row drops out of "My queue"
      // entirely on the next render.
      try { await fetch('/api/sentinel/incidents', { credentials: 'same-origin' }); } catch (_) {}
    } catch (e) {
      // No notice surface in the sidebar; log to console so the
      // analyst can troubleshoot. The next poll will reflect the
      // unchanged state.
      console.error(`[queue-reassign] failed for #${numStr}:`, e);
    } finally {
      STATE.savingQueueOwner = null;
      render();
    }
  }

  // ── HITL answer ─────────────────────────────────────────────────────
  // The agents read a free-text reply and decide what to do — there's
  // no fixed approve/reject contract anymore. The textarea content is
  // sent verbatim. Empty replies are rejected client-side because an
  // empty answer carries no signal and would just waste an LLM round.
  async function onHitlAnswer(qid) {
    const id = `hitl-${qid}`;
    if (STATE.sending.has(id)) return;
    const answer = (STATE.drafts.hitl[qid] || '').trim();
    if (!answer) {
      // Soft prompt — not an alert(), keep it inline.
      STATE.chatErrors[`hitl-${qid}`] = 'Please type a reply before sending.';
      // Re-use the chat error channel for now; cheap.
      render();
      return;
    }
    STATE.sending.add(id);
    render();
    try {
      const r = await fetch(`/api/hitl/answer/${encodeURIComponent(qid)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ answer }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${text}`);
      }
      // Optimistic: remove from local pending list; the next poll will reconcile.
      STATE.hitl = STATE.hitl.filter((q) => q.id !== qid);
      STATE.expanded.delete(id);
      delete STATE.drafts.hitl[qid];
    } catch (e) {
      // Surface the error in the relevant question's draft area.
      STATE.drafts.hitl[qid] = (STATE.drafts.hitl[qid] || '') + `\n[error: ${e.message || e}]`;
    } finally {
      STATE.sending.delete(id);
      render();
    }
  }

  // ── Chat send (streaming) ───────────────────────────────────────────
  async function onChatSend(agent) {
    const id = `chat-${agent}`;
    if (STATE.sending.has(id)) return;
    const text = (STATE.drafts.chat[agent] || '').trim();
    if (!text) return;

    if (!STATE.conversations[agent]) STATE.conversations[agent] = [];
    STATE.conversations[agent].push({ role: 'user', text });
    const assistantIdx = STATE.conversations[agent].length;
    STATE.conversations[agent].push({ role: 'assistant', text: '', streaming: true });

    STATE.drafts.chat[agent] = '';
    STATE.sending.add(id);
    STATE.chatErrors[agent] = '';
    render();

    try {
      const r = await fetch(STREAM_PATH(agent), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders() },
        body: JSON.stringify({ message: text }),
      });
      if (!r.ok || !r.body) {
        const errText = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${errText}`);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() || '';
        for (const block of lines) {
          handleSseBlock(block, agent, assistantIdx);
        }
        render();
      }
      // Any tail bytes
      if (buf.trim()) handleSseBlock(buf, agent, assistantIdx);
      const m = STATE.conversations[agent][assistantIdx];
      if (m) m.streaming = false;
    } catch (e) {
      const m = STATE.conversations[agent][assistantIdx];
      if (m) { m.error = true; m.text = (m.text || '') + `\n${e.message || e}`; m.streaming = false; }
      STATE.chatErrors[agent] = String(e.message || e);
    } finally {
      STATE.sending.delete(id);
      render();
    }
  }

  function handleSseBlock(block, agent, assistantIdx) {
    let event = 'message', dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }

    const m = STATE.conversations[agent][assistantIdx];
    if (!m) return;
    if (event === 'delta' && data.text) {
      m.text = (m.text || '') + data.text;
    } else if (event === 'tool_call' && data.name) {
      if (!m.toolCalls) m.toolCalls = [];
      m.toolCalls.push({ name: data.name });
    } else if (event === 'error') {
      m.error = true;
      m.text = `Error ${data.status || ''}: ${typeof data.body === 'string' ? data.body : JSON.stringify(data.body)}`;
    }
  }

  // ── Polling ────────────────────────────────────────────────────────
  async function pollHitl() {
    try {
      const r = await fetch('/api/hitl/pending', { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      const next = (data && data.questions) || [];
      // Detect new questions for an audible hint? Skip for now.
      STATE.hitl = next;
      render();
    } catch (_) { /* ignore */ }
  }

  async function pollAgents() {
    try {
      const r = await fetch('/api/agents/state', { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      STATE.agents = (data && data.agents) || [];
      render();

      // First time we see the roster, hydrate per-agent chat history
      // from the server. Lets a navigation / refresh restore
      // conversations that happened in earlier visits.
      if (!STATE.__historyHydrated) {
        STATE.__historyHydrated = true;
        const slugs = STATE.agents.map(agentName).filter(Boolean);
        for (const slug of slugs) hydrateAgentHistory(slug);
      }
    } catch (_) { /* ignore */ }
  }

  // ── Per-agent chat history ─────────────────────────────────────────
  // The server persists each user's conversation with each agent in
  // CONVERSATIONS, so this fetch returns whatever was previously sent
  // (including responses that arrived while we were away on another
  // page). After hydration, if any message is still streaming on the
  // server, set up a 2s repoll until it lands or fails.
  function convertServerMessage(m) {
    if (!m || typeof m !== 'object') return null;
    const out = { role: m.role || 'assistant', text: m.text || '' };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.toolCalls = m.tool_calls.map((t) => ({ name: (t && t.name) || '' }));
    }
    if (m.status === 'streaming') out.streaming = true;
    if (m.status === 'failed') {
      out.error = true;
      if (!out.text) {
        let body = m.error || 'stream failed';
        // Server often packs structured errors as JSON strings — pretty
        // them up so the user sees readable text in the bubble.
        try {
          const parsed = JSON.parse(body);
          body = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        } catch (_) { /* keep raw string */ }
        out.text = `Error: ${body}`;
      }
    }
    return out;
  }

  async function hydrateAgentHistory(slug) {
    if (!slug) return;
    try {
      const r = await fetch(
        `/api/agents/${encodeURIComponent(slug)}/messages`,
        { credentials: 'same-origin', headers: authHeaders() },
      );
      if (!r.ok) return;
      const data = await r.json();
      const messages = (data && data.messages) || [];
      const converted = messages.map(convertServerMessage).filter(Boolean);

      // Don't clobber a send that's currently in flight in THIS tab —
      // the local SSE handler is the authoritative writer for it.
      const inFlightLocal = STATE.sending.has(`chat-${slug}`);
      if (!inFlightLocal) {
        STATE.conversations[slug] = converted;
        render();
      }

      STATE.historyLoaded.add(slug);

      // If anything is still streaming server-side, keep refreshing
      // until it lands. Coalesce concurrent calls per agent.
      const stillStreaming = converted.some((m) => m && m.streaming);
      if (stillStreaming) {
        if (!STATE.historyPolling.has(slug)) {
          STATE.historyPolling.add(slug);
          setTimeout(() => {
            STATE.historyPolling.delete(slug);
            hydrateAgentHistory(slug);
          }, 2000);
        }
      }
    } catch (_) { /* ignore — next render keeps showing what we have */ }
  }

  // ── Pending changes polling + decision handler ────────────────────
  async function pollChanges() {
    try {
      const r = await fetch('/api/changes/pending',
                            { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      STATE.changes = (data && data.changes) || [];
      render();
    } catch (_) { /* ignore */ }
  }

  async function onChangeDecision(changeId, decision) {
    if (STATE.sendingChange.has(changeId)) return;
    STATE.sendingChange.add(changeId);
    const note = STATE.changeNotes[changeId] || '';
    render();
    try {
      const path = decision === 'approve'
        ? `/api/changes/${encodeURIComponent(changeId)}/approve`
        : `/api/changes/${encodeURIComponent(changeId)}/reject`;
      const r = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ note }),
      });
      const text = await r.text().catch(() => '');
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const j = JSON.parse(text);
          if (j && j.detail) msg = `${msg}: ${typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)}`;
        } catch (_) { msg = `${msg}: ${text.slice(0, 300)}`; }
        throw new Error(msg);
      }
      // Drop from local pending list — server poll will reconcile.
      STATE.changes = STATE.changes.filter((c) => c.id !== changeId);
      STATE.expandedChanges.delete(changeId);
      delete STATE.changeNotes[changeId];
    } catch (e) {
      // Surface in console; the change record stays visible so the
      // user can retry. We could put an inline error too — keeping
      // it minimal for v1.
      console.error(`[changes] ${decision} failed for ${changeId}:`, e);
    } finally {
      STATE.sendingChange.delete(changeId);
      render();
    }
  }

  // ── Sentinel incidents polling ─────────────────────────────────────
  // Drives the "My queue" section. Same endpoint the dashboard
  // already polls — same 8s cadence.
  async function pollIncidents() {
    try {
      const r = await fetch('/api/sentinel/incidents',
                            { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      STATE.incidents = (data && data.incidents) || [];
      render();
    } catch (_) { /* ignore */ }
  }

  // ── Active-incident polling ────────────────────────────────────────
  // Drives the banner at the top of the sidebar and the "owns #N"
  // pill on the agent currently working it. Faster than the agent
  // poll so the elapsed-time counter ticks visibly.
  async function pollCurrentIncident() {
    try {
      const r = await fetch('/api/current_incident',
                            { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      const had = !!(STATE.currentIncident && STATE.currentIncident.incident_number != null);
      const has = !!(data && data.incident_number != null);
      STATE.currentIncident = has ? data : null;
      // Re-render only when state actually changed OR when an incident
      // is in flight (so the elapsed timer ticks). Avoids burning
      // cycles re-rendering the static "no incident" sidebar every
      // 1.5s when nothing is happening.
      if (has || had) render();
    } catch (_) { /* ignore */ }
  }

  // ── Online presence + DM polling ───────────────────────────────────
  async function pollOnline() {
    try {
      const r = await fetch('/api/sessions/online',
                            { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      // Endpoint now returns the full configured roster minus self,
      // each with an `online` boolean. Render every entry; the row's
      // dot reflects status the same way agent rows do.
      STATE.users = (data && data.users) || [];
      STATE.me = (data && data.me) || STATE.me;
      render();
    } catch (_) { /* ignore */ }
  }

  // Refresh every configured human's DM thread so the preview line
  // in the sidebar reflects messages received via in-page chat panels.
  // Inline DM expand was retired in favour of the panels, so polling
  // open threads only is no longer the right scope.
  async function pollAllDmThreads() {
    if (!STATE.users || !STATE.users.length) return;
    for (const u of STATE.users) {
      if (u && u.email && !u.is_self) hydrateDmThread(u.email);
    }
  }

  // Same idea for agent chat history — pop-up sends update server
  // state but the sidebar's STATE.conversations needs a periodic
  // re-pull so each agent row's preview line reflects recent
  // activity.
  async function pollAgentChatHistories() {
    if (!STATE.agents || !STATE.agents.length) return;
    for (const a of STATE.agents) {
      const slug = agentName(a);
      if (slug) hydrateAgentHistory(slug);
    }
  }

  async function hydrateDmThread(peer) {
    try {
      const r = await fetch(
        `/api/messages/${encodeURIComponent(peer)}`,
        { credentials: 'same-origin', headers: authHeaders() },
      );
      if (!r.ok) return;
      const data = await r.json();
      const msgs = (data && data.messages) || [];
      // Replace wholesale — server is the source of truth.
      STATE.dmThreads[peer] = msgs;
      // Clear any prior error if we successfully refreshed.
      if (STATE.dmErrors[peer]) delete STATE.dmErrors[peer];
      render();
    } catch (_) { /* ignore — next tick will retry */ }
  }

  async function onDmSend(peer) {
    const id = `dm-${peer}`;
    if (STATE.sending.has(id)) return;
    const text = (STATE.drafts.dm[peer] || '').trim();
    if (!text) return;

    // Optimistic local append so the user's own message lands
    // immediately without waiting on the round trip.
    const localMsg = {
      id: `local-${Date.now()}`,
      from: STATE.me,
      to: peer,
      text,
      ts: Date.now() / 1000,
    };
    if (!STATE.dmThreads[peer]) STATE.dmThreads[peer] = [];
    STATE.dmThreads[peer].push(localMsg);
    STATE.drafts.dm[peer] = '';
    STATE.sending.add(id);
    delete STATE.dmErrors[peer];
    render();

    try {
      const r = await fetch(
        `/api/messages/${encodeURIComponent(peer)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ text }),
        },
      );
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${errText.slice(0, 200)}`);
      }
      // Re-hydrate from server so the local-temp id is replaced with
      // the real persisted record (matters if the user sends multiple
      // in a row before a poll tick lands).
      hydrateDmThread(peer);
    } catch (e) {
      // Roll back the optimistic append.
      STATE.dmThreads[peer] = (STATE.dmThreads[peer] || []).filter(
        (m) => m.id !== localMsg.id,
      );
      // Put the draft back so the user doesn't have to retype.
      STATE.drafts.dm[peer] = text;
      STATE.dmErrors[peer] = String(e.message || e);
    } finally {
      STATE.sending.delete(id);
      render();
    }
  }

  ensureRoot();
  render();
  pollHitl(); pollAgents(); pollOnline(); pollCurrentIncident(); pollIncidents(); pollChanges();
  setInterval(pollHitl, POLL_HITL_MS);
  setInterval(pollAgents, POLL_AGENTS_MS);
  setInterval(pollOnline, POLL_ONLINE_MS);
  setInterval(pollAllDmThreads, POLL_DM_MS);
  setInterval(pollCurrentIncident, POLL_INCIDENT_MS);
  setInterval(pollIncidents, POLL_QUEUE_MS);
  setInterval(pollChanges, POLL_CHANGES_MS);
  setInterval(pollAgentChatHistories, POLL_AGENT_HIST_MS);
})();
