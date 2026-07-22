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
  resetAllBtn: document.getElementById("reset-all-btn"),

  rollHistory: document.getElementById("roll-history"),

  rollExpression: document.getElementById("roll-expression"),
  rollBtn: document.getElementById("roll-btn"),

  checkModifier: document.getElementById("check-modifier"),
  checkModifierMinus: document.getElementById("check-modifier-minus"),
  checkModifierPlus: document.getElementById("check-modifier-plus"),
  checkAccuracy: document.getElementById("check-accuracy"),
  checkAccuracyAdd: document.getElementById("check-accuracy-add"),
  checkDifficulty: document.getElementById("check-difficulty"),
  checkDifficultyAdd: document.getElementById("check-difficulty-add"),
  checkRollBtn: document.getElementById("check-roll-btn"),

  damageD6: document.getElementById("damage-d6"),
  damageD6Minus: document.getElementById("damage-d6-minus"),
  damageD6Add: document.getElementById("damage-d6-add"),
  damageD3: document.getElementById("damage-d3"),
  damageD3Minus: document.getElementById("damage-d3-minus"),
  damageD3Add: document.getElementById("damage-d3-add"),
  damageFlat: document.getElementById("damage-flat"),
  damageFlatMinus: document.getElementById("damage-flat-minus"),
  damageFlatPlus: document.getElementById("damage-flat-plus"),
  damageKeepAll: document.getElementById("damage-keep-all"),
  damageKeepHigh: document.getElementById("damage-keep-high"),
  damageKeepLow: document.getElementById("damage-keep-low"),
  damageCrit: document.getElementById("damage-crit"),
  damageD2Btn: document.getElementById("damage-d2-btn"),
  damageRollBtn: document.getElementById("damage-roll-btn"),
};

// The structured Check/Damage forms don't talk to the backend directly --
// they build the same expression string the Discord `l!r` command and the
// Advanced text box produce, then send it through the one /roll endpoint.
// That keeps the parsing/validation logic in exactly one place (lancer_logic.py).
// The Modifier field always shows an explicit sign ("+0", "+3", "-2"), so it
// has to be a plain text input -- a type="number" input silently rejects a
// leading "+" as an invalid value.
function parseModifier(raw) {
  const n = parseInt(String(raw).replace(/^\+/, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

function formatModifier(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

// The d6/d3 count fields show "" at zero and "Nd6"/"Nd3" otherwise, so the
// field itself reads as dice notation instead of a bare count.
function parseDiceCount(raw) {
  const match = String(raw).match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

function formatDiceCount(n, sides) {
  return n > 0 ? `${n}d${sides}` : "";
}

function buildCheckExpression(modifier, accuracy, difficulty) {
  const parts = ["d20"];
  if (modifier) {
    parts.push(modifier > 0 ? `+ ${modifier}` : `- ${Math.abs(modifier)}`);
  }
  if (accuracy > 0) parts.push(`a${accuracy}`);
  if (difficulty > 0) parts.push(`d${difficulty}`);
  return parts.join(" ");
}

// Keep (highest/lowest 1) applies independently to whichever die pools have
// dice in them -- e.g. 2d6 + 1d3 with Keep: High keeps the highest of the
// 2d6 *and* the highest of the 1d3 (trivially itself), not a single winner
// picked across the combined pool.
function buildDamageExpression(numD6, numD3, flat, keepMode, crit) {
  const diceParts = [];
  if (numD6 > 0) {
    diceParts.push(keepMode ? `${numD6}d6k${keepMode}1` : `${numD6}d6`);
  }
  if (numD3 > 0) {
    diceParts.push(keepMode ? `${numD3}d3k${keepMode}1` : `${numD3}d3`);
  }
  if (diceParts.length === 0 && !flat) {
    throw new Error("Enter at least one die or a flat bonus.");
  }
  let expr = diceParts.join(" + ");
  if (flat) {
    const sign = flat > 0 ? "+" : "-";
    expr = expr ? `${expr} ${sign} ${Math.abs(flat)}` : `${flat}`;
  }
  if (crit) {
    expr = expr ? `${expr} crit` : "crit";
  }
  return expr;
}

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

// Same face art the Discord bot posts as custom emoji, reused here as icons.
const D20_ICONS = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [i + 1, `icons/d20_${i + 1}.png`])
);
const D6_ICONS = Object.fromEntries(
  Array.from({ length: 6 }, (_, i) => [i + 1, `icons/d6_${i + 1}.png`])
);

// Mirrors lancer_logic.py's roll_emoji_chunks(): every die rolled by one
// command -- the d20 plus any Accuracy/Difficulty bonus d6s for a check, or
// every term's dice (both attempts, if a crit rolled twice) for a damage
// roll -- as a flat list of {sides, value}. d3/d2 dice use the d6 art too,
// since their faces (1-3, 1-2) are always within d6's 1-6 range.
function rollDiceFaces(event) {
  if (event.mode === "check") {
    const faces = [{ sides: 20, value: event.d20 }];
    (event.bonus_dice || []).forEach((value) => faces.push({ sides: 6, value }));
    return faces;
  }
  if (event.mode === "damage") {
    const faces = [];
    (event.attempts || []).forEach((attempt) => {
      (attempt.rolls_by_term || []).forEach(([sides, rolls]) => {
        rolls.forEach((value) => faces.push({ sides, value }));
      });
    });
    return faces;
  }
  return [];
}

function buildDiceFacesRow(faces) {
  const row = document.createElement("div");
  row.className = "dice-faces";
  faces.forEach(({ sides, value }) => {
    const src = (sides === 20 ? D20_ICONS : D6_ICONS)[value];
    if (!src) {
      return;
    }
    const img = document.createElement("img");
    img.src = src;
    img.alt = String(value);
    img.className = "dice-face-icon";
    row.appendChild(img);
  });
  return row;
}

// event.text is the Discord-formatted string the bot posts, which only ever
// uses **bold** and ~~strikethrough~~. Rendered by building real DOM nodes
// (never innerHTML) so nothing in the text can be parsed as HTML.
function appendLiteMarkdown(container, text) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (i > 0) {
      container.appendChild(document.createElement("br"));
    }
    const re = /\*\*(.+?)\*\*|~~(.+?)~~/g;
    let lastIndex = 0;
    let match;
    while ((match = re.exec(line)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
      }
      const el = document.createElement(match[1] !== undefined ? "strong" : "s");
      el.textContent = match[1] !== undefined ? match[1] : match[2];
      container.appendChild(el);
      lastIndex = re.lastIndex;
    }
    if (lastIndex < line.length) {
      container.appendChild(document.createTextNode(line.slice(lastIndex)));
    }
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

  const line2 = document.createElement("div");
  line2.className = "roll-text";
  appendLiteMarkdown(line2, event.text);

  li.appendChild(line1);
  const faces = rollDiceFaces(event);
  if (faces.length) {
    li.appendChild(buildDiceFacesRow(faces));
  }
  li.appendChild(line2);

  els.rollHistory.appendChild(li);
  while (els.rollHistory.children.length > MAX_HISTORY_ENTRIES) {
    els.rollHistory.removeChild(els.rollHistory.firstChild);
  }
  els.rollHistory.scrollTop = els.rollHistory.scrollHeight;
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

els.checkModifierMinus.addEventListener("click", () => {
  els.checkModifier.value = formatModifier(parseModifier(els.checkModifier.value) - 1);
});

els.checkModifierPlus.addEventListener("click", () => {
  els.checkModifier.value = formatModifier(parseModifier(els.checkModifier.value) + 1);
});

els.checkModifier.addEventListener("blur", () => {
  els.checkModifier.value = formatModifier(parseModifier(els.checkModifier.value));
});

els.checkAccuracyAdd.addEventListener("click", () => {
  els.checkAccuracy.value = (Number(els.checkAccuracy.value) || 0) + 1;
});

els.checkDifficultyAdd.addEventListener("click", () => {
  els.checkDifficulty.value = (Number(els.checkDifficulty.value) || 0) + 1;
});

els.checkRollBtn.addEventListener(
  "click",
  withBusy(els.checkRollBtn, async () => {
    const modifier = parseModifier(els.checkModifier.value);
    const accuracy = Math.max(0, Number(els.checkAccuracy.value) || 0);
    const difficulty = Math.max(0, Number(els.checkDifficulty.value) || 0);
    const expression = buildCheckExpression(modifier, accuracy, difficulty);
    await postJson(`/api/${pairingCode}/roll`, {
      expression,
      player_name: playerName,
    });
  })
);

els.damageD6Minus.addEventListener("click", () => {
  els.damageD6.value = formatDiceCount(Math.max(0, parseDiceCount(els.damageD6.value) - 1), 6);
});

els.damageD6Add.addEventListener("click", () => {
  els.damageD6.value = formatDiceCount(parseDiceCount(els.damageD6.value) + 1, 6);
});

els.damageD6.addEventListener("blur", () => {
  els.damageD6.value = formatDiceCount(parseDiceCount(els.damageD6.value), 6);
});

els.damageD3Minus.addEventListener("click", () => {
  els.damageD3.value = formatDiceCount(Math.max(0, parseDiceCount(els.damageD3.value) - 1), 3);
});

els.damageD3Add.addEventListener("click", () => {
  els.damageD3.value = formatDiceCount(parseDiceCount(els.damageD3.value) + 1, 3);
});

els.damageD3.addEventListener("blur", () => {
  els.damageD3.value = formatDiceCount(parseDiceCount(els.damageD3.value), 3);
});

els.damageFlatMinus.addEventListener("click", () => {
  els.damageFlat.value = formatModifier(parseModifier(els.damageFlat.value) - 1);
});

els.damageFlatPlus.addEventListener("click", () => {
  els.damageFlat.value = formatModifier(parseModifier(els.damageFlat.value) + 1);
});

els.damageFlat.addEventListener("blur", () => {
  els.damageFlat.value = formatModifier(parseModifier(els.damageFlat.value));
});

let damageKeepMode = "";
const keepButtons = [els.damageKeepAll, els.damageKeepHigh, els.damageKeepLow];

function setDamageKeepMode(mode) {
  damageKeepMode = mode;
  keepButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.keep === mode));
}

els.damageKeepAll.addEventListener("click", () => setDamageKeepMode(""));
els.damageKeepHigh.addEventListener("click", () => setDamageKeepMode("h"));
els.damageKeepLow.addEventListener("click", () => setDamageKeepMode("l"));

els.resetAllBtn.addEventListener("click", () => {
  els.checkModifier.value = "+0";
  els.checkAccuracy.value = "0";
  els.checkDifficulty.value = "0";
  els.damageD6.value = "";
  els.damageD3.value = "";
  els.damageFlat.value = "+0";
  setDamageKeepMode("");
  els.damageCrit.checked = false;
  els.rollExpression.value = "";
  setStatus(els.globalStatus, "", false);
});

els.damageD2Btn.addEventListener(
  "click",
  withBusy(els.damageD2Btn, async () => {
    await postJson(`/api/${pairingCode}/roll`, {
      expression: "1d2",
      player_name: playerName,
    });
  })
);

els.damageRollBtn.addEventListener(
  "click",
  withBusy(els.damageRollBtn, async () => {
    const numD6 = parseDiceCount(els.damageD6.value);
    const numD3 = parseDiceCount(els.damageD3.value);
    const flat = parseModifier(els.damageFlat.value);
    const crit = els.damageCrit.checked;
    const expression = buildDamageExpression(numD6, numD3, flat, damageKeepMode, crit);
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
