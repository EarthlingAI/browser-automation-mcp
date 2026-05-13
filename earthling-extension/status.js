const statusEl = /** @type {HTMLDivElement} */ (
  document.getElementById("status")
);

function render(connected) {
  statusEl.className = "status " + (connected ? "ok" : "err");
  statusEl.innerHTML = connected
    ? '<span class="dot ok"></span>Connected to Earthling daemon.'
    : '<span class="dot err"></span>Not connected. Make sure the Earthling engine is running.';
}

function probe() {
  const probeWs = new WebSocket("ws://127.0.0.1:9223");
  let resolved = false;
  const finish = (ok) => {
    if (resolved) return;
    resolved = true;
    try {
      probeWs.close();
    } catch {}
    render(ok);
  };
  probeWs.addEventListener("open", () => finish(true));
  probeWs.addEventListener("error", () => finish(false));
  probeWs.addEventListener("close", () => finish(false));
  setTimeout(() => finish(false), 1500);
}

probe();
setInterval(probe, 3000);
