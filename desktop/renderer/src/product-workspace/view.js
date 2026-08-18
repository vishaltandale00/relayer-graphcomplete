export function productWorkspaceMarkup() {
  return `
    <header class="thread-header">
      <div class="turn-navigation"><button id="previousTurn" disabled title="Previous turn">←</button><button id="nextTurn" disabled title="Next turn">→</button></div>
      <div><h2 id="threadTitle">New thread</h2><p id="threadScope">No folder</p></div>
      <div class="run-state" id="runState"><i></i><span>Ready</span></div>
    </header>
    <div class="thread-workspace">
      <div class="graph-column">
        <div class="interaction-banner" id="interactionBanner"><span class="interaction-icon">›_</span><div><small>Your interaction</small><p id="interactionText"></p></div></div>
        <div class="graph-empty" id="graphEmpty"><div class="thinking-dots" id="thinkingDots" role="status" aria-label="Waiting for graph"><i></i><i></i><i></i></div><p id="graphEmptyMessage">This interaction has no accepted graph yet.</p></div>
        <div class="graph-stage hidden" id="graphStage">
          <svg id="edgeCanvas" aria-hidden="true"></svg>
          <div id="nodeLayer"></div>
          <div class="graph-hint">Drag canvas to pan · Drag nodes to arrange</div>
          <button class="graph-recenter" id="recenterGraph" title="Recenter graph" aria-label="Recenter graph">⌾</button>
        </div>
        <div class="thread-composer" id="threadComposer"><textarea id="threadPrompt" rows="2" placeholder="Follow up…"></textarea><button class="send-button" id="sendInteraction" title="Send" disabled>↑</button></div>
      </div>
      <aside class="inspector hidden" id="inspector">
        <div class="inspector-header"><span>Node details</span><button class="icon-button" id="closeInspector">×</button></div>
        <div class="node-heading"><div class="node-icon" id="detailIcon">N</div><div><small id="detailKind">CONCEPT</small><h2 id="detailTitle"></h2></div></div>
        <div class="node-content" id="detailContent"></div>
        <div class="inline-actions hidden" id="detailActions"></div>
      </aside>
    </div>
  `;
}
