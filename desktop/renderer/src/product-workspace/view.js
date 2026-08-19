export function productWorkspaceMarkup() {
  return `
    <header class="thread-header">
      <div class="turn-navigation"><button id="previousTurn" data-review-ref="previous-turn" data-review-kind="turn" disabled title="Previous turn">←</button><button id="nextTurn" data-review-ref="next-turn" data-review-kind="turn" disabled title="Next turn">→</button></div>
      <div><h2 id="threadTitle">New thread</h2><p id="threadScope">No folder</p></div>
      <div class="run-state" id="runState"><i></i><span>Ready</span></div>
    </header>
    <div class="thread-workspace" data-review-capture="workspace" role="region" aria-label="Thread workspace">
      <div class="graph-column">
        <div class="interaction-banner" id="interactionBanner"><span class="interaction-icon">›_</span><div><small>Your interaction</small><p id="interactionText"></p></div></div>
        <div class="graph-empty" id="graphEmpty"><div class="thinking-dots" id="thinkingDots" role="status" aria-label="Waiting for graph"><i></i><i></i><i></i></div><p id="graphEmptyMessage">This interaction has no accepted graph yet.</p></div>
        <div class="graph-stage hidden" id="graphStage" tabindex="-1" data-review-capture="layer-viewport" role="region" aria-label="Visible graph layer">
          <svg id="edgeCanvas" aria-hidden="true"></svg>
          <div id="nodeLayer"></div>
          <div class="graph-hint">Scroll or pinch to zoom · Drag canvas to pan · Drag nodes to arrange</div>
          <div class="graph-controls" role="toolbar" aria-label="Graph view controls">
            <button id="zoomOutGraph" title="Zoom out" aria-label="Zoom out">−</button>
            <output id="graphZoomLevel" aria-label="Graph zoom level">100%</output>
            <button id="zoomInGraph" title="Zoom in" aria-label="Zoom in">+</button>
            <button class="graph-fit" id="fitGraph" title="Fit graph" aria-label="Fit graph">Fit</button>
            <button id="recenterGraph" data-review-ref="recenter-graph" title="Recenter graph" aria-label="Recenter graph">⌾</button>
          </div>
        </div>
        <div class="thread-composer" id="threadComposer"><textarea id="threadPrompt" rows="1" placeholder="Follow up…"></textarea><button class="send-button" id="sendInteraction" title="Send" disabled>↑</button></div>
      </div>
      <aside class="inspector hidden" id="inspector" data-review-capture="node-detail" aria-label="Selected node detail">
        <div class="inspector-header"><span>Node details</span><button class="icon-button" id="closeInspector" data-review-ref="close-node-detail" aria-label="Close node details">×</button></div>
        <div class="node-heading"><div class="node-icon" id="detailIcon">N</div><div><small id="detailKind">CONCEPT</small><h2 id="detailTitle"></h2></div></div>
        <div class="node-content" id="detailContent"></div>
        <div class="inline-actions hidden" id="detailActions"></div>
      </aside>
    </div>
  `;
}
