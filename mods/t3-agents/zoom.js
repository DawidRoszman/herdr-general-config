import { panes, run } from "herdr";

function zoomTo(found) {
  const ps = panes(), p = ps.find(found);
  if (p && !p.zoomed && ps.some(q => q.tab === p.tab && q.zoomed)) run("pane.zoom", { pane: p.pane });
}
export function focusPane(pane) {
  zoomTo(p => p.pane === pane);
  run("pane.focus", { pane });
}
export function focusAgent(terminal) {

  const ps = panes(), own = ps.find(p => p.terminal === terminal), chat = own && ps.find(p => p.tab === own.tab && (p.mod === "t3-chat" || p.mod === "agent-chat"));
  zoomTo(chat ? (p => p.pane === chat.pane) : (p => p.terminal === terminal));
  run("agent.focus", { terminal });
  if (chat) run("pane.focus", { pane: chat.pane });
}
