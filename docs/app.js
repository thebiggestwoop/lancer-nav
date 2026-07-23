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
  showCombatDrillSetting: document.getElementById("show-combat-drill-setting"),
  showDiceIconsSetting: document.getElementById("show-dice-icons-setting"),
  clearSavedRollsBtn: document.getElementById("clear-saved-rolls-btn"),
  confirmClearSavedRollsBtn: document.getElementById("confirm-clear-saved-rolls-btn"),

  rollHistory: document.getElementById("roll-history"),

  rollExpression: document.getElementById("roll-expression"),
  rollBtn: document.getElementById("roll-btn"),

  checkModifier: document.getElementById("check-modifier"),
  checkModifierMinus: document.getElementById("check-modifier-minus"),
  checkModifierPlus: document.getElementById("check-modifier-plus"),
  checkAccuracy: document.getElementById("check-accuracy"),
  checkAccuracyAdd: document.getElementById("check-accuracy-add"),
  checkAccuracyMinus: document.getElementById("check-accuracy-minus"),
  checkDifficulty: document.getElementById("check-difficulty"),
  checkDifficultyAdd: document.getElementById("check-difficulty-add"),
  checkDifficultyMinus: document.getElementById("check-difficulty-minus"),
  checkRollBtn: document.getElementById("check-roll-btn"),
  savedRollsSelect: document.getElementById("saved-rolls-select"),
  saveRollBtn: document.getElementById("save-roll-btn"),
  deleteRollBtn: document.getElementById("delete-roll-btn"),

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
  combatDrillField: document.getElementById("combat-drill-field"),
  damageCombatDrill: document.getElementById("damage-combat-drill"),
  damageOverkill: document.getElementById("damage-overkill"),
  damageD2Btn: document.getElementById("damage-d2-btn"),
  damageRollBtn: document.getElementById("damage-roll-btn"),
  damageSavedRollsSelect: document.getElementById("damage-saved-rolls-select"),
  damageSaveRollBtn: document.getElementById("damage-save-roll-btn"),
  damageDeleteRollBtn: document.getElementById("damage-delete-roll-btn"),
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
function buildDamageExpression(numD6, numD3, flat, keepMode, crit, overkill, combatDrill) {
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
  // Combat Drill implies Overkill (see lancer_logic.py), but the checkbox is
  // sent too so the expression reads the same either way.
  if (overkill) {
    expr = expr ? `${expr} overkill` : "overkill";
  }
  if (combatDrill) {
    expr = expr ? `${expr} combatdrill` : "combatdrill";
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

// Combat Drill is a specific weapon tag most players won't have -- its
// checkbox stays out of the way until a player opts in via Settings. Purely
// a per-browser display preference (not synced through the room, unlike the
// pairing code), since different players carry different gear.
const SHOW_COMBAT_DRILL_STORAGE_KEY = "lancer-companion-show-combat-drill";

function applyCombatDrillVisibility(show) {
  els.combatDrillField.classList.toggle("hidden", !show);
  if (!show) {
    els.damageCombatDrill.checked = false;
  }
}

function loadShowCombatDrillSetting() {
  const show = localStorage.getItem(SHOW_COMBAT_DRILL_STORAGE_KEY) === "true";
  els.showCombatDrillSetting.checked = show;
  applyCombatDrillVisibility(show);
}

els.showCombatDrillSetting.addEventListener("change", () => {
  const show = els.showCombatDrillSetting.checked;
  localStorage.setItem(SHOW_COMBAT_DRILL_STORAGE_KEY, String(show));
  applyCombatDrillVisibility(show);
});

loadShowCombatDrillSetting();

// Dice-face icons in Roll History are a purely visual, client-side thing --
// each player can turn them off individually without affecting what anyone
// else in the room sees. The icon rows are always built into the DOM as
// normal (see addHistoryEntry() below); a single CSS class on the list
// container hides them, so toggling the setting instantly affects every
// entry already on screen too, not just future ones -- no event cache or
// rebuild needed. Defaults to on (unlike Combat Drill) since that's the
// existing behavior this setting is opting players out of, not into.
const SHOW_DICE_ICONS_STORAGE_KEY = "lancer-companion-show-dice-icons";

function applyShowDiceIcons(show) {
  els.rollHistory.classList.toggle("hide-dice-icons", !show);
}

function loadShowDiceIconsSetting() {
  const stored = localStorage.getItem(SHOW_DICE_ICONS_STORAGE_KEY);
  const show = stored === null ? true : stored === "true";
  els.showDiceIconsSetting.checked = show;
  applyShowDiceIcons(show);
}

els.showDiceIconsSetting.addEventListener("change", () => {
  const show = els.showDiceIconsSetting.checked;
  localStorage.setItem(SHOW_DICE_ICONS_STORAGE_KEY, String(show));
  applyShowDiceIcons(show);
});

loadShowDiceIconsSetting();

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

// Mirrors lancer_logic.py's roll_emoji_chunks(): one row of {sides, value}
// per line the Discord bot would send -- a single row for a check (the d20
// plus any Accuracy/Difficulty bonus d6s), or one row of every term's dice
// for a damage roll (crit or not -- a crit just doubles each term's dice
// pool, it's still one roll). d3/d2 dice use the d6 art too, since their
// faces (1-3, 1-2) are always within d6's 1-6 range.
function rollDiceFaceRows(event) {
  if (event.mode === "check") {
    const row = [{ sides: 20, value: event.d20 }];
    (event.bonus_dice || []).forEach((value) => row.push({ sides: 6, value }));
    return [row];
  }
  if (event.mode === "damage") {
    return (event.attempts || []).map((attempt) => {
      const row = [];
      (attempt.rolls_by_term || []).forEach(([sides, rolls]) => {
        rolls.forEach((value) => row.push({ sides, value }));
      });
      return row;
    });
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
// Lines from lancer_logic.py's format_*_discord() always start with one of
// these bolded labels -- Total and Overkill get their own banner-style
// treatment (larger, colored background); Combat Drill just keeps the
// plain uppercase text (the bot already sends everything in all caps
// itself, so text-transform is only a harmless safety net here).
// Case-insensitive since the source text is already all caps by the time
// it gets here.
function getRollLineClass(line) {
  if (/^\*\*Total/i.test(line)) return "roll-total-line";
  if (/^\*\*Overkill:/i.test(line)) return "roll-overkill-line";
  if (/^\*\*Combat Drill:/i.test(line)) return "roll-uppercase-line";
  return null;
}

// Total/Overkill render as their own boxed (display: block) rows -- a block
// already starts on its own line, so an explicit <br> immediately before or
// after one just adds an extra blank line. Skip the <br> at any transition
// touching a boxed line; plain inline lines (Result, Combat Drill) still
// get one between each other as before.
const BOXED_LINE_CLASSES = new Set(["roll-total-line", "roll-overkill-line"]);

function appendLiteMarkdown(container, text) {
  const lines = text.split("\n");
  let previousLineClass = null;
  lines.forEach((line, i) => {
    const lineClass = getRollLineClass(line);
    if (i > 0 && !BOXED_LINE_CLASSES.has(lineClass) && !BOXED_LINE_CLASSES.has(previousLineClass)) {
      container.appendChild(document.createElement("br"));
    }
    // Wrap just this line's content in its own span rather than appending
    // straight into the shared container, so it can get its own styling.
    const target = lineClass ? document.createElement("span") : container;
    if (lineClass) {
      target.className = lineClass;
    }
    const re = /\*\*(.+?)\*\*|~~(.+?)~~/g;
    let lastIndex = 0;
    let match;
    while ((match = re.exec(line)) !== null) {
      if (match.index > lastIndex) {
        target.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
      }
      const el = document.createElement(match[1] !== undefined ? "strong" : "s");
      el.textContent = match[1] !== undefined ? match[1] : match[2];
      target.appendChild(el);
      lastIndex = re.lastIndex;
    }
    if (lastIndex < line.length) {
      target.appendChild(document.createTextNode(line.slice(lastIndex)));
    }
    if (lineClass) {
      container.appendChild(target);
    }
    previousLineClass = lineClass;
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
  rollDiceFaceRows(event)
    .filter((row) => row.length > 0)
    .forEach((row) => li.appendChild(buildDiceFacesRow(row)));
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

els.checkAccuracyMinus.addEventListener("click", () => {
  els.checkAccuracy.value = Math.max(0, (Number(els.checkAccuracy.value) || 0) - 1);
});

els.checkDifficultyAdd.addEventListener("click", () => {
  els.checkDifficulty.value = (Number(els.checkDifficulty.value) || 0) + 1;
});

els.checkDifficultyMinus.addEventListener("click", () => {
  els.checkDifficulty.value = Math.max(0, (Number(els.checkDifficulty.value) || 0) - 1);
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
    // Clear the saved-roll selection once it's actually been rolled, so
    // picking the same saved roll again afterward fires a fresh "change"
    // event instead of silently no-oping (browsers only fire "change" when
    // the picked value differs from before).
    els.savedRollsSelect.value = "";
  })
);

// Saved rolls -- purely a client-side convenience (kept in this browser's
// localStorage, never synced through the backend/Discord), so a player can
// re-populate the d20 check fields for an attack they use often without
// re-entering Modifier/Accuracy/Difficulty by hand every time.
const SAVED_ROLLS_STORAGE_KEY = "lancer-companion-saved-d20-rolls";

function loadSavedRolls() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_ROLLS_STORAGE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let savedRolls = loadSavedRolls();

// <option> text can't mix font-weights (no HTML/CSS support inside options),
// so "bold" is faked with the Unicode mathematical sans-serif bold
// letter/digit block -- visually bold and sans-serif in effectively every
// font, still plain text underneath.
function toBoldUnicode(text) {
  return String(text).replace(/[A-Za-z0-9]/g, (ch) => {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1d5d4 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1d5ee + (code - 97));
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1d7ec + (code - 48));
    return ch;
  });
}

// Same trick, but the Unicode mathematical sans-serif block, for the dice
// expression following the name.
function toSansSerifUnicode(text) {
  return String(text).replace(/[A-Za-z0-9]/g, (ch) => {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1d5a0 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1d5ba + (code - 97));
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1d7e2 + (code - 48));
    return ch;
  });
}

function renderSavedRolls(selectedName) {
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Saved rolls...";

  const options = savedRolls.map((roll) => {
    const option = document.createElement("option");
    option.value = roll.name;
    const expression = buildCheckExpression(roll.modifier, roll.accuracy, roll.difficulty);
    option.textContent = `${toBoldUnicode(roll.name)}  [${toSansSerifUnicode(expression)}]`;
    return option;
  });

  els.savedRollsSelect.replaceChildren(placeholder, ...options);
  els.savedRollsSelect.value = selectedName ?? "";
}

renderSavedRolls();

els.saveRollBtn.addEventListener("click", () => {
  const name = prompt("Name this roll:");
  if (name === null) return;
  const trimmed = name.trim();
  if (trimmed === "") return;

  const roll = {
    name: trimmed,
    modifier: parseModifier(els.checkModifier.value),
    accuracy: Math.max(0, Number(els.checkAccuracy.value) || 0),
    difficulty: Math.max(0, Number(els.checkDifficulty.value) || 0),
  };

  const existingIndex = savedRolls.findIndex((r) => r.name === trimmed);
  if (existingIndex === -1) {
    savedRolls.push(roll);
  } else {
    savedRolls[existingIndex] = roll;
  }
  localStorage.setItem(SAVED_ROLLS_STORAGE_KEY, JSON.stringify(savedRolls));
  renderSavedRolls(trimmed);
});

els.savedRollsSelect.addEventListener("change", () => {
  const selected = savedRolls.find(
    (r) => r.name === els.savedRollsSelect.value,
  );
  if (!selected) return;
  els.checkModifier.value = formatModifier(selected.modifier);
  els.checkAccuracy.value = String(selected.accuracy);
  els.checkDifficulty.value = String(selected.difficulty);
});

els.deleteRollBtn.addEventListener("click", () => {
  const name = els.savedRollsSelect.value;
  if (!name) return;
  savedRolls = savedRolls.filter((r) => r.name !== name);
  localStorage.setItem(SAVED_ROLLS_STORAGE_KEY, JSON.stringify(savedRolls));
  renderSavedRolls();
});

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
  els.damageCombatDrill.checked = false;
  els.damageOverkill.checked = false;
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
    const overkill = els.damageOverkill.checked;
    const combatDrill = els.damageCombatDrill.checked;
    const expression = buildDamageExpression(numD6, numD3, flat, damageKeepMode, crit, overkill, combatDrill);
    await postJson(`/api/${pairingCode}/roll`, {
      expression,
      player_name: playerName,
    });
    // Same reasoning as the d20 card's saved rolls: clear the selection only
    // once it's actually been rolled, so picking the same saved roll again
    // afterward fires a fresh "change" event.
    els.damageSavedRollsSelect.value = "";
  })
);

// Saved rolls for the XdX card -- same client-side-only convenience as the
// d20 card's, kept in its own localStorage key since a damage roll's shape
// (dice counts, Keep mode, Crit, Overkill) is entirely different from a
// check's (Modifier/Accuracy/Difficulty).
const SAVED_DAMAGE_ROLLS_STORAGE_KEY = "lancer-companion-saved-damage-rolls";

function loadSavedDamageRolls() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_DAMAGE_ROLLS_STORAGE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let savedDamageRolls = loadSavedDamageRolls();

function renderSavedDamageRolls(selectedName) {
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Saved rolls...";

  const options = savedDamageRolls.map((roll) => {
    const option = document.createElement("option");
    option.value = roll.name;
    let expression = "";
    try {
      expression = buildDamageExpression(
        roll.numD6, roll.numD3, roll.flat, roll.keepMode, roll.crit, roll.overkill, roll.combatDrill,
      );
    } catch {
      expression = "";
    }
    option.textContent = expression
      ? `${toBoldUnicode(roll.name)}  [${toSansSerifUnicode(expression)}]`
      : toBoldUnicode(roll.name);
    return option;
  });

  els.damageSavedRollsSelect.replaceChildren(placeholder, ...options);
  els.damageSavedRollsSelect.value = selectedName ?? "";
}

renderSavedDamageRolls();

els.damageSaveRollBtn.addEventListener("click", () => {
  const name = prompt("Name this roll:");
  if (name === null) return;
  const trimmed = name.trim();
  if (trimmed === "") return;

  const roll = {
    name: trimmed,
    numD6: parseDiceCount(els.damageD6.value),
    numD3: parseDiceCount(els.damageD3.value),
    flat: parseModifier(els.damageFlat.value),
    keepMode: damageKeepMode,
    crit: els.damageCrit.checked,
    overkill: els.damageOverkill.checked,
    combatDrill: els.damageCombatDrill.checked,
  };

  const existingIndex = savedDamageRolls.findIndex((r) => r.name === trimmed);
  if (existingIndex === -1) {
    savedDamageRolls.push(roll);
  } else {
    savedDamageRolls[existingIndex] = roll;
  }
  localStorage.setItem(SAVED_DAMAGE_ROLLS_STORAGE_KEY, JSON.stringify(savedDamageRolls));
  renderSavedDamageRolls(trimmed);
});

els.damageSavedRollsSelect.addEventListener("change", () => {
  const selected = savedDamageRolls.find(
    (r) => r.name === els.damageSavedRollsSelect.value,
  );
  if (!selected) return;
  els.damageD6.value = formatDiceCount(selected.numD6, 6);
  els.damageD3.value = formatDiceCount(selected.numD3, 3);
  els.damageFlat.value = formatModifier(selected.flat);
  setDamageKeepMode(selected.keepMode);
  els.damageCrit.checked = selected.crit;
  els.damageOverkill.checked = selected.overkill;
  els.damageCombatDrill.checked = Boolean(selected.combatDrill);
});

els.damageDeleteRollBtn.addEventListener("click", () => {
  const name = els.damageSavedRollsSelect.value;
  if (!name) return;
  savedDamageRolls = savedDamageRolls.filter((r) => r.name !== name);
  localStorage.setItem(SAVED_DAMAGE_ROLLS_STORAGE_KEY, JSON.stringify(savedDamageRolls));
  renderSavedDamageRolls();
});

const CLEAR_SAVED_ROLLS_LABEL = "Clear all saved rolls";
const CANCEL_CLEAR_SAVED_ROLLS_LABEL = "Nevermind";

// First click just reveals "Are you sure?" (clicking again hides it, i.e.
// cancels); only confirming actually clears anything. The button's width is
// locked (measured while it still shows the longer label) before swapping
// to "Nevermind", so it doesn't shrink to fit the shorter text.
els.clearSavedRollsBtn.addEventListener("click", () => {
  const nowHidden = els.confirmClearSavedRollsBtn.classList.toggle("hidden");
  if (nowHidden) {
    els.clearSavedRollsBtn.textContent = CLEAR_SAVED_ROLLS_LABEL;
    els.clearSavedRollsBtn.style.width = "";
  } else {
    els.clearSavedRollsBtn.style.width = `${els.clearSavedRollsBtn.offsetWidth}px`;
    els.clearSavedRollsBtn.textContent = CANCEL_CLEAR_SAVED_ROLLS_LABEL;
  }
});

els.confirmClearSavedRollsBtn.addEventListener("click", () => {
  savedRolls = [];
  localStorage.removeItem(SAVED_ROLLS_STORAGE_KEY);
  renderSavedRolls();

  savedDamageRolls = [];
  localStorage.removeItem(SAVED_DAMAGE_ROLLS_STORAGE_KEY);
  renderSavedDamageRolls();

  els.confirmClearSavedRollsBtn.classList.add("hidden");
  els.clearSavedRollsBtn.textContent = CLEAR_SAVED_ROLLS_LABEL;
  els.clearSavedRollsBtn.style.width = "";
});

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
