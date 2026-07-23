// JS port of lancer_logic.py's pure dice-rolling/parsing logic, so the
// Owlbear extension can roll on its own without needing the Discord bot.
//
// Deliberately kept as close to lancer_logic.py's structure and names as
// possible (snake_case Python -> camelCase JS function/variable names, but
// object *keys* on result/event data stay snake_case to match) so the two
// are easy to compare side by side. There is no automatic sync between
// them -- any future rule change (a new weapon tag, a crit-rule tweak,
// etc.) has to be applied by hand to both this file and lancer_logic.py.
//
// Discord-bound text formatting is NOT the source of truth from here --
// when paired, the bot re-derives the Discord message from the structured
// `result` this module produces, using lancer_logic.py's own (unmodified)
// format_roll_discord_shouted()/roll_emoji_chunks(). The formatting
// functions here exist only to render the extension's own Roll History
// entry instantly, without waiting on a round trip, so they only need to
// look reasonable locally -- any cosmetic drift from the Python formatter
// can never cause a numeric mismatch, since the actual rolled numbers are
// decided once, client-side, before either formatter ever runs.

const MAX_ACC_DIFF = 20;
const MAX_DAMAGE_DICE = 50;

export class LancerError extends Error {}

// Inclusive both ends, mirrors Python's random.randint(a, b).
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// Rolling
// ---------------------------------------------------------------------------

// Mirrors _roll_die_with_overkill(). Returns [finalFace, discardedOnes, heat,
// bonusDice] -- bonusDice is a flat list of [finalFace, discardedOnes, heat]
// for every Combat Drill bonus d6 spawned (including nested ones).
function rollDieWithOverkill(sides, combatDrill = false) {
  const discardedOnes = [];
  const bonusDice = [];
  let heat = 0;
  let face = randInt(1, sides);
  while (face === 1) {
    discardedOnes.push(face);
    heat += 1;
    if (combatDrill) {
      const [bonusFace, bonusDiscarded, bonusHeat, nestedBonus] = rollDieWithOverkill(6, true);
      bonusDice.push([bonusFace, bonusDiscarded, bonusHeat]);
      bonusDice.push(...nestedBonus);
      heat += bonusHeat;
    }
    face = randInt(1, sides);
  }
  return [face, discardedOnes, heat, bonusDice];
}

// Mirrors _roll_kept_dice(). Returns [rolls, keptIndices, total, heat,
// discarded, bonusDice] -- keptIndices is a Set (mirrors Python's set());
// convert with toJsonSafe() before sending anywhere.
function rollKeptDice(count, sides, keepMode = null, keepCount = null, overkill = false, combatDrill = false) {
  overkill = overkill || combatDrill;
  let bonusDice = [];
  let rolls;
  let discarded;
  let heat = 0;
  if (overkill) {
    rolls = [];
    discarded = [];
    for (let i = 0; i < count; i++) {
      const [face, discardedOnes, dieHeat, dieBonus] = rollDieWithOverkill(sides, combatDrill);
      rolls.push(face);
      discarded.push(discardedOnes);
      heat += dieHeat;
      bonusDice.push(...dieBonus);
    }
  } else {
    rolls = Array.from({ length: count }, () => randInt(1, sides));
    discarded = rolls.map(() => []);
  }

  let keptIndices;
  if (keepMode === null) {
    keptIndices = new Set(rolls.map((_, i) => i));
  } else {
    const order = rolls
      .map((_, i) => i)
      .sort((a, b) => (keepMode === "h" ? rolls[b] - rolls[a] : rolls[a] - rolls[b]));
    keptIndices = new Set(order.slice(0, keepCount));
  }

  let total = 0;
  rolls.forEach((r, i) => {
    if (keptIndices.has(i)) total += r;
  });
  bonusDice.forEach(([face]) => {
    total += face;
  });

  return [rolls, keptIndices, total, heat, discarded, bonusDice];
}

// Mirrors roll_d20_check().
function rollD20Check(modifier, accuracy = 0, difficulty = 0) {
  if (accuracy < 0 || difficulty < 0) {
    throw new LancerError("Accuracy and Difficulty must be zero or positive.");
  }
  if (accuracy > MAX_ACC_DIFF || difficulty > MAX_ACC_DIFF) {
    throw new LancerError(`Accuracy and Difficulty must be at most ${MAX_ACC_DIFF}.`);
  }

  const d20 = randInt(1, 20);
  const net = accuracy - difficulty;
  let bonus_dice = [];
  let kept_indices = new Set();
  let bonus = 0;
  if (net !== 0) {
    const [rolls, kept, keptSum] = rollKeptDice(Math.abs(net), 6, "h", 1);
    bonus_dice = rolls;
    kept_indices = kept;
    bonus = net > 0 ? keptSum : -keptSum;
  }

  const total = d20 + modifier + bonus;

  return {
    mode: "check",
    d20,
    modifier,
    net_accuracy: net,
    bonus_dice,
    kept_indices,
    bonus,
    total,
    is_crit: total >= 20,
  };
}

// Mirrors _roll_damage_once().
function rollDamageOnce(diceTerms, flat, overkill = false, combatDrill = false) {
  const rolls_by_term = [];
  let total = flat;
  let heat = 0;
  for (const [count, sides, keepMode, keepCount] of diceTerms) {
    const [rolls, kept_indices, keptSum, dieHeat, discarded, bonus_dice] = rollKeptDice(
      count, sides, keepMode, keepCount, overkill, combatDrill
    );
    rolls_by_term.push([sides, rolls, kept_indices, discarded, bonus_dice]);
    total += keptSum;
    heat += dieHeat;
  }
  return { rolls_by_term, flat, total, heat };
}

// Mirrors _crit_term().
function critTerm(term) {
  const [count, sides, keepMode, keepCount] = term;
  if (keepMode === null) {
    return [count * 2, sides, "h", count];
  }
  return [count * 2, sides, keepMode, keepCount];
}

// Mirrors roll_damage().
function rollDamage(diceTerms, flat = 0, crit = false, overkill = false, combatDrill = false) {
  for (const [count, , keepMode, keepCount] of diceTerms) {
    if (count < 0) {
      throw new LancerError("Number of dice must be zero or positive.");
    }
    if (count > MAX_DAMAGE_DICE) {
      throw new LancerError(`Number of dice must be at most ${MAX_DAMAGE_DICE}.`);
    }
    if (keepMode !== null && !(keepCount >= 1 && keepCount <= count)) {
      throw new LancerError("Can't keep more dice than you rolled.");
    }
  }
  if (!diceTerms.some(([count]) => count > 0) && flat === 0) {
    throw new LancerError("Enter at least one die or a flat bonus.");
  }

  const effectiveTerms = crit ? diceTerms.map(critTerm) : diceTerms;
  for (const [count] of effectiveTerms) {
    if (count > MAX_DAMAGE_DICE) {
      throw new LancerError(`Number of dice must be at most ${MAX_DAMAGE_DICE}, even doubled for a crit.`);
    }
  }

  const attempt = rollDamageOnce(effectiveTerms, flat, overkill, combatDrill);
  return {
    mode: "damage",
    crit,
    overkill: overkill || combatDrill,
    combat_drill: combatDrill,
    attempts: [attempt],
    total: attempt.total,
    heat: attempt.heat,
  };
}

// ---------------------------------------------------------------------------
// Parsing: one flexible expression, auto-detects check vs. damage
// ---------------------------------------------------------------------------

const TOKEN_RE = /([+-]?)\s*([A-Za-z0-9]+)/g;
const KEEP_DICE_TOKEN_RE = /^(\d*)d(\d+)k([hl])(\d*)$/i;
const DICE_TOKEN_RE = /^(\d*)d(\d+)$/i;
const ACCURACY_TOKEN_RE = /^a(\d*)$/i;

// Mirrors parse_roll_expression().
function parseRollExpression(expr) {
  const tokens = [...expr.matchAll(TOKEN_RE)].map((m) => [m[1], m[2]]);
  if (tokens.length === 0) {
    throw new LancerError("Empty roll expression.");
  }

  const diceTerms = [];
  let accuracyTotal = 0;
  let flatTotal = 0;
  let crit = false;
  let overkill = false;
  let combatDrill = false;
  const unrecognized = [];

  for (const [sign, word] of tokens) {
    const signedValue = sign === "-" ? -1 : 1;

    const keepMatch = KEEP_DICE_TOKEN_RE.exec(word);
    if (keepMatch) {
      const [, countStr, sidesStr, keepMode, keepCountStr] = keepMatch;
      const count = countStr ? parseInt(countStr, 10) : 1;
      const keepCount = keepCountStr ? parseInt(keepCountStr, 10) : 1;
      diceTerms.push([count, parseInt(sidesStr, 10), keepMode.toLowerCase(), keepCount]);
      continue;
    }

    const diceMatch = DICE_TOKEN_RE.exec(word);
    if (diceMatch) {
      const [, countStr, sidesStr] = diceMatch;
      const count = countStr ? parseInt(countStr, 10) : 1;
      diceTerms.push([count, parseInt(sidesStr, 10), null, null]);
      continue;
    }

    const accMatch = ACCURACY_TOKEN_RE.exec(word);
    if (accMatch) {
      accuracyTotal += accMatch[1] ? parseInt(accMatch[1], 10) : 1;
      continue;
    }

    if (word.toLowerCase() === "crit") {
      crit = true;
      continue;
    }

    if (word.toLowerCase() === "overkill") {
      overkill = true;
      continue;
    }

    if (word.toLowerCase() === "combatdrill") {
      combatDrill = true;
      continue;
    }

    if (/^\d+$/.test(word)) {
      flatTotal += signedValue * parseInt(word, 10);
      continue;
    }

    unrecognized.push(word);
  }

  if (unrecognized.length > 0) {
    throw new LancerError(`Didn't understand: ${unrecognized.join(", ")}`);
  }

  const d20Terms = diceTerms.filter((t) => t[1] === 20);
  const otherDiceTerms = diceTerms.filter((t) => t[1] !== 20);

  if (d20Terms.length > 0) {
    const difficultyTotal = otherDiceTerms.reduce((sum, t) => sum + t[1], 0);
    return {
      mode: "check",
      modifier: flatTotal,
      accuracy: accuracyTotal,
      difficulty: difficultyTotal,
    };
  }

  return {
    mode: "damage",
    diceTerms: otherDiceTerms,
    flat: flatTotal,
    crit,
    overkill,
    combatDrill,
  };
}

// Mirrors perform_roll().
export function performRoll(expr) {
  const parsed = parseRollExpression(expr);
  if (parsed.mode === "check") {
    return rollD20Check(parsed.modifier, parsed.accuracy, parsed.difficulty);
  }
  return rollDamage(parsed.diceTerms, parsed.flat, parsed.crit, parsed.overkill, parsed.combatDrill);
}

// Mirrors result_to_json_safe() -- converts Sets (kept_indices) to sorted
// arrays so a result can be JSON.stringify'd (to broadcast, or to send to
// the bot's /announce endpoint) without losing anything.
export function toJsonSafe(value) {
  if (value instanceof Set) {
    return [...value].sort((a, b) => a - b);
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toJsonSafe(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Local-display formatting (see file header -- not relied on for Discord)
// ---------------------------------------------------------------------------

function signed(value) {
  return value >= 0 ? `+ ${value}` : `- ${Math.abs(value)}`;
}

// Mirrors _format_dice_with_kept(). kept_indices must be a Set here (the
// pre-toJsonSafe form), not the serialized array.
function formatDiceWithKept(rolls, kept_indices, discarded = null) {
  const pieces = [];
  rolls.forEach((r, i) => {
    if (discarded) {
      for (const one of discarded[i]) {
        pieces.push(`~~${one}~~`);
      }
    }
    pieces.push(kept_indices.has(i) ? String(r) : `~~${r}~~`);
  });
  return pieces.join(", ");
}

function formatCheckDiscord(result) {
  const pieces = [`1d20 (${result.d20})`];
  const net = result.net_accuracy;
  if (net !== 0) {
    const sign = net > 0 ? "+" : "-";
    const diceStr = formatDiceWithKept(result.bonus_dice, result.kept_indices);
    pieces.push(`${sign} ${Math.abs(net)}d6kh1 (${diceStr})`);
  }
  if (result.modifier) {
    pieces.push(signed(result.modifier));
  }
  const equation = pieces.join(" ");

  let totalLine = `**Total:** ${result.total}`;
  if (result.is_crit) {
    totalLine += " -- CRIT!";
  }
  return `**Result:** ${equation}\n${totalLine}`;
}

function describeDamageAttempt(attempt) {
  const dicePieces = [];
  for (const [sides, rolls, kept_indices, discarded, bonus_dice] of attempt.rolls_by_term) {
    const rollsStr = formatDiceWithKept(rolls, kept_indices, discarded);
    dicePieces.push(`${rolls.length}d${sides} (${rollsStr})`);
    for (const [bonusFace, bonusDiscarded] of bonus_dice) {
      const bonusStr = formatDiceWithKept([bonusFace], new Set([0]), [bonusDiscarded]);
      dicePieces.push(`1d6 (bonus, ${bonusStr})`);
    }
  }

  let equation = dicePieces.join(" + ");
  if (attempt.flat) {
    const signedFlat = signed(attempt.flat);
    equation = equation ? `${equation} ${signedFlat}` : signedFlat;
  }
  return equation;
}

function formatDamageDiscord(result) {
  const equation = describeDamageAttempt(result.attempts[0]);
  const lines = [`**Result:** ${equation}`];
  if (result.combat_drill) {
    let bonusCount = 0;
    for (const [, , , , bonus_dice] of result.attempts[0].rolls_by_term) {
      bonusCount += bonus_dice.length;
    }
    lines.push(`**Combat Drill:** ${bonusCount} bonus 1d6`);
  }
  lines.push(`**Total:** ${result.total}`);
  if (result.overkill) {
    lines.push(`**Overkill:** ${result.heat} Heat`);
  }
  return lines.join("\n");
}

function formatRollDiscord(result) {
  return result.mode === "check" ? formatCheckDiscord(result) : formatDamageDiscord(result);
}

const DICE_NOTATION_RE = /\d+D\d+(?:K[HL]\d+)?/g;

// Mirrors format_roll_discord_shouted().
export function formatRollDiscordShouted(result) {
  const shouted = formatRollDiscord(result).toUpperCase();
  return shouted.replace(DICE_NOTATION_RE, (m) => m.toLowerCase());
}
