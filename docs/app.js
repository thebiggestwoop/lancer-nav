import OBR from "https://esm.sh/@owlbear-rodeo/sdk@3.1.0";

// The bot now lives at a stable address, so this is baked in rather than
// something each player has to paste into Settings.
const BACKEND_URL = "https://lancer-bot.heruv.uk";

// Everyone in the same Owlbear room shares this key via OBR.room metadata,
// so only one player has to paste the pairing code -- Owlbear replicates
// room metadata to every connected client automatically.
const METADATA_KEY = "com.lancer-companion.owlbear-extension/pairing-code";
const MAX_HISTORY_ENTRIES = 20;
const POLL_INTERVAL_MS = 2500;

const els = {
  pairingCode: document.getElementById("pairing-code"),
  saveSettings: document.getElementById("save-settings"),
  settingsStatus: document.getElementById("settings-status"),
  globalStatus: document.getElementById("global-status"),

  rollHistory: document.getElementById("roll-history"),

  rollExpression: document.getElementById("roll-expression"),
  rollBtn: document.getElementById("roll-btn"),
};

let pairingCode = "";
let playerName = "Someone";
let lastSeq = 0;
let pollTimer = null;

function setStatus(el, message, isError) {
  el.textContent = message;
  el.classList.toggle("error", Boolean(isError));
}

function applyConfigToInputs() {
  els.pairingCode.value = pairingCode || "";
  const linked = Boolean(pairingCode);
  setStatus(els.settingsStatus, linked ? "Linked." : "Not linked yet.", !linked);
}

// event.timestamp is Unix epoch seconds (set server-side by event_bus.py).
// Rendering it here, client-side, means each viewer sees it in their own
// local timezone -- the same approach Discord itself uses for messages.
function formatRollTime(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function addHistoryEntry(event) {
  const li = document.createElement("li");

  const line1 = document.createElement("div");
  const actorEl = document.createElement("strong");
  actorEl.textContent = event.actor;
  line1.appendChild(actorEl);
  const sourceTag = event.source === "discord" ? "Discord" : "Owlbear";
  line1.appendChild(document.createTextNode(` (${sourceTag})`));
  if (typeof event.timestamp === "number") {
    const timeEl = document.createElement("span");
    timeEl.className = "roll-time";
    timeEl.textContent = ` ${formatRollTime(event.timestamp)}`;
    line1.appendChild(timeEl);
  }

  // event.text is the same Discord-formatted string the bot posts (with
  // **bold**/~~strikethrough~~ markup); shown as plain text for now rather
  // than rendered, via textContent so nothing in it is ever parsed as HTML.
  const line2 = document.createElement("div");
  line2.className = "roll-text";
  line2.textContent = event.text;

  li.appendChild(line1);
  li.appendChild(line2);

  els.rollHistory.prepend(li);
  while (els.rollHistory.children.length > MAX_HISTORY_ENTRIES) {
    els.rollHistory.removeChild(els.rollHistory.lastChild);
  }
}

async function pollUpdates() {
  if (!pairingCode) {
    return;
  }
  try {
    const data = await requestJson(`/api/${pairingCode}/updates?since=${lastSeq}`);
    for (const event of data.events) {
      addHistoryEntry(event);
    }
    lastSeq = data.seq;
  } catch (err) {
    // Non-fatal -- just try again on the next tick.
  }
}

function startPolling() {
  stopPolling();
  lastSeq = 0;
  if (!pairingCode) {
    return;
  }
  pollUpdates();
  pollTimer = setInterval(pollUpdates, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function loadPairingCodeFromRoom() {
  const metadata = await OBR.room.getMetadata();
  const stored = metadata[METADATA_KEY];
  if (stored) {
    pairingCode = stored;
  }
  applyConfigToInputs();
}

async function savePairingCode() {
  pairingCode = els.pairingCode.value.trim();
  await OBR.room.setMetadata({ [METADATA_KEY]: pairingCode });
  applyConfigToInputs();
  startPolling();
}

function apiUrl(path) {
  return `${BACKEND_URL}${path}`;
}

async function requestJson(path, options) {
  if (!pairingCode) {
    throw new Error("Not linked yet -- enter the pairing code first.");
  }
  const response = await fetch(apiUrl(path), options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
}

function postJson(path, body) {
  return requestJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function withBusy(button, fn) {
  return async () => {
    button.disabled = true;
    try {
      await fn();
      setStatus(els.globalStatus, "", false);
    } catch (err) {
      setStatus(els.globalStatus, err.message, true);
    } finally {
      button.disabled = false;
    }
  };
}

els.saveSettings.addEventListener("click", withBusy(els.saveSettings, savePairingCode));

els.rollBtn.addEventListener(
  "click",
  withBusy(els.rollBtn, async () => {
    const expression = els.rollExpression.value.trim();
    if (!expression) {
      throw new Error("Enter a roll expression first.");
    }
    await postJson(`/api/${pairingCode}/roll`, {
      expression,
      player_name: playerName,
    });
  })
);

async function init() {
  playerName = (await OBR.player.getName()) || "Someone";

  await loadPairingCodeFromRoom();
  startPolling();

  OBR.room.onMetadataChange((metadata) => {
    const stored = metadata[METADATA_KEY];
    if (stored) {
      pairingCode = stored;
      applyConfigToInputs();
      startPolling();
    }
  });
}

if (OBR.isReady) {
  init();
} else {
  OBR.onReady(init);
}
