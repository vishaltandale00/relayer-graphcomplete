import { modelPickerMarkup } from "../model-picker.js";

export function productWorkspaceMarkup() {
  return `
    <div class="workspace-layout" data-review-capture="workspace" role="region" aria-label="Thread workspace">
    <header class="thread-header">
      <nav class="history-navigation" aria-label="Workspace history">
        <button id="historyBack" data-review-ref="history-back" data-review-kind="history" disabled title="Back" aria-label="Back"><span aria-hidden="true">←</span><i class="history-spinner hidden" aria-hidden="true"></i></button>
        <button id="historyForward" data-review-ref="history-forward" data-review-kind="history" disabled title="Forward" aria-label="Forward"><span aria-hidden="true">→</span><i class="history-spinner hidden" aria-hidden="true"></i></button>
      </nav>
      <div class="thread-title-group">
        <div class="thread-title-copy"><div class="thread-title-row"><h2 id="threadTitle">New thread</h2><button class="annotation-count-badge hidden" id="threadAnnotationBadge" type="button" aria-label="Open thread comments"></button></div><span class="sr-only" id="threadScope">No folder</span></div>
        <div class="conversation-settings hidden" id="conversationSettings">
          <button class="conversation-settings-button" id="conversationSettingsButton" type="button" title="Conversation settings" aria-label="Conversation settings" aria-expanded="false" aria-controls="conversationSettingsMenu">•••</button>
          <div class="conversation-settings-menu hidden" id="conversationSettingsMenu" role="menu" aria-label="Conversation settings">
            <button class="conversation-export" id="exportConversation" type="button" role="menuitem" data-review-ref="export-conversation" data-review-kind="conversation-export">Export conversation…</button>
          </div>
        </div>
      </div>
    </header>
    <div class="interaction-banner" id="interactionBanner">
          <span class="interaction-icon">›_</span>
          <div class="interaction-copy">
            <div class="interaction-copy-header">
              <small>Your interaction<span class="interaction-model-identity hidden" id="interactionModelIdentity"></span></small>
              <div class="turn-picker" id="turnPicker">
                <button class="annotation-count-badge hidden" id="turnAnnotationBadge" type="button" aria-label="Open turn comments"></button>
                <div class="turn-stepper" role="group" aria-label="Turn navigation">
                  <button id="previousTurn" data-review-ref="previous-turn" data-review-kind="turn" disabled title="Previous turn" aria-label="Previous turn">←</button>
                  <button id="turnPickerButton" class="turn-picker-button" type="button" aria-expanded="false" aria-controls="turnPopover" disabled>Turn 0 of 0</button>
                  <button id="nextTurn" data-review-ref="next-turn" data-review-kind="turn" disabled title="Next turn" aria-label="Next turn">→</button>
                </div>
                <div class="turn-popover hidden" id="turnPopover" role="group" aria-label="Choose a turn"></div>
              </div>
            </div>
            <p id="interactionText"></p>
          </div>
          <span class="interaction-status" id="interactionStatus" role="status"></span>
    </div>
    <aside class="environment-panel" id="environmentPanel" aria-labelledby="environmentTitle">
      <div class="environment-header"><h2 id="environmentTitle">Environment</h2><span class="environment-observed" id="environmentObserved"></span></div>
      <div class="environment-body" id="environmentBody" aria-busy="false">
        <div class="environment-loading" id="environmentLoading"><span class="environment-spinner" aria-hidden="true"></span><span>Loading project context…</span></div>
        <dl class="environment-facts hidden" id="environmentFacts">
          <div><dt>Worktree</dt><dd id="environmentWorktree"></dd></div>
          <div id="environmentBranchRow"><dt id="environmentBranchLabel">Branch</dt><dd id="environmentBranch"></dd></div>
          <div id="environmentChangesRow"><dt>Changes</dt><dd><span class="environment-additions" id="environmentAdditions"></span><span class="environment-deletions" id="environmentDeletions"></span><span class="environment-tracked hidden" id="environmentTracked"></span></dd></div>
          <div id="environmentUntrackedRow"><dt>Untracked</dt><dd id="environmentUntracked"></dd></div>
        </dl>
        <p class="environment-message hidden" id="environmentMessage"></p>
      </div>
    </aside>
    <div class="thread-workspace">
      <div class="graph-column">
        <nav class="workspace-breadcrumb" id="workspaceBreadcrumb" data-review-capture="breadcrumb" aria-label="Graph layer path"></nav>
        <div class="graph-empty" id="graphEmpty"><div class="thinking-dots" id="thinkingDots" role="status" aria-label="Waiting for graph"><i></i><i></i><i></i></div><p id="graphEmptyMessage">This interaction has no accepted graph yet.</p></div>
        <div class="graph-stage hidden" id="graphStage" tabindex="-1" data-review-capture="layer-viewport" role="region" aria-label="Visible graph layer">
          <svg id="edgeCanvas" aria-label="Graph relationships"></svg>
          <div id="nodeLayer"></div>
          <div class="graph-hint">Scroll or pinch to zoom · Drag canvas to pan · Drag nodes for this view</div>
          <div class="graph-controls" role="toolbar" aria-label="Graph view controls">
            <button id="zoomOutGraph" title="Zoom out" aria-label="Zoom out">−</button>
            <output id="graphZoomLevel" aria-label="Graph zoom level">100%</output>
            <button id="zoomInGraph" title="Zoom in" aria-label="Zoom in">+</button>
            <button class="graph-fit" id="fitGraph" title="Fit graph" aria-label="Fit graph">Fit</button>
            <button id="recenterGraph" data-review-ref="recenter-graph" title="Recenter graph" aria-label="Recenter graph">⌾</button>
          </div>
        </div>
        <section class="approval-dock hidden" id="approvalDock" tabindex="-1" aria-labelledby="approvalTitle" aria-describedby="approvalReason approvalActionValue approvalScopeDescription" data-review-capture="approval-dock">
          <div class="approval-dock-inner">
            <div class="approval-dock-header">
              <div class="approval-heading"><span class="approval-status-icon" id="approvalStatusIcon" aria-hidden="true">!</span><div><small id="approvalEyebrow">Needs approval</small><h3 id="approvalTitle">Approval required</h3></div></div>
              <div class="approval-queue-controls" id="approvalQueueControls" role="group" aria-label="Pending approval requests">
                <button id="previousApproval" type="button" aria-label="Previous approval request">←</button>
                <span id="approvalQueuePosition" aria-live="polite">1 of 1</span>
                <button id="nextApproval" type="button" aria-label="Next approval request">→</button>
              </div>
            </div>
            <p class="approval-reason" id="approvalReason"></p>
            <div class="approval-action-summary">
              <span id="approvalActionLabel">Action</span>
              <code id="approvalActionValue"></code>
            </div>
            <dl class="approval-metadata">
              <div id="approvalWorkingDirectoryRow"><dt>Working folder</dt><dd id="approvalWorkingDirectory"></dd></div>
              <div id="approvalAffectedFilesRow"><dt>Affected files</dt><dd id="approvalAffectedFiles"></dd></div>
              <div><dt>Approval scope</dt><dd id="approvalScopeDescription"></dd></div>
            </dl>
            <details class="approval-history hidden" id="approvalHistory"><summary id="approvalHistorySummary">Approval history</summary><ol id="approvalHistoryList"></ol></details>
            <p class="approval-error hidden" id="approvalError" role="alert"></p>
            <div class="approval-actions" role="group" aria-label="Resolve approval request">
              <button class="approval-deny" id="denyApproval" type="button">Deny</button>
              <button class="approval-once" id="approveOnce" type="button">Approve once</button>
              <button class="approval-always" id="approveAlways" type="button"><span>Approve always</span><small>this session</small></button>
            </div>
          </div>
        </section>
        <div class="thread-composer" id="threadComposer"><textarea id="threadPrompt" rows="1" placeholder="Follow up…"></textarea><div class="thread-composer-actions">${modelPickerMarkup({ mode: "ongoing" })}<button class="send-button" id="sendInteraction" title="Send" disabled>↑</button></div></div>
      </div>
      <aside class="inspector hidden" id="inspector" data-review-capture="node-detail" aria-label="Selected node detail">
        <div class="inspector-header"><span>Node details</span><button class="icon-button" id="closeInspector" data-review-ref="close-node-detail" aria-label="Close node details">×</button></div>
        <div class="inspector-content" id="inspectorContent">
          <div class="node-heading"><div class="node-icon" id="detailIcon">N</div><div><small id="detailKind">CONCEPT</small><h2 id="detailTitle"></h2></div></div>
          <div class="node-content" id="detailContent"></div>
          <div class="inline-actions hidden" id="detailActions"></div>
        </div>
        <section class="annotation-panel hidden" id="annotationPanel" aria-labelledby="annotationHeading">
          <div class="annotation-heading"><span id="annotationHeading">Comments</span><span id="annotationCount">0</span></div>
          <div class="annotation-list" id="annotationList"></div>
          <form class="annotation-composer" id="annotationComposer">
            <textarea id="annotationComment" rows="2" maxlength="8000" placeholder="Leave a comment…" aria-label="Comment"></textarea>
            <div class="annotation-composer-footer">
              <div class="annotation-rating" id="annotationRating">
                <div class="annotation-rating-labels">
                  <button type="button" data-rating="1">Bad</button><button type="button" data-rating="2">Needs work</button><button type="button" data-rating="3">Good</button><button type="button" data-rating="4">Great</button>
                </div>
                <input id="annotationRatingInput" type="range" min="1" max="4" step="1" value="2" aria-label="Comment rating" aria-valuetext="No rating selected">
                <output id="annotationRatingOutput" aria-live="polite"></output>
              </div>
              <button class="annotation-submit" id="submitAnnotation" type="submit" aria-label="Post comment" title="Post comment" disabled>↑</button>
            </div>
            <p class="annotation-error hidden" id="annotationError" role="alert"></p>
          </form>
        </section>
      </aside>
    </div>
    </div>
  `;
}
