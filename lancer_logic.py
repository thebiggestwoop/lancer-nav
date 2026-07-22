"""Pure game-logic core for Lancer dice mechanics: the d20 + Accuracy/
Difficulty roll, and dice-pool damage rolls (including the roll-twice-
keep-higher crit damage rule and hand-typed "kh"/"kl" keep-N-of-M dice) --
plus a small parser so a single command can accept either kind of roll
and tell them apart.

No Discord or web-framework dependency here, on purpose -- mirrors the
Ascension bot's game_logic.py so both a Discord bot and (later) an Owlbear
extension can share the exact same validated rules instead of each
reimplementing them.
"""

import random
import re

# Safety cap on Accuracy/Difficulty and dice counts so a bad/huge input
# can't cause a slow roll or spam a huge message. Not a real game rule --
# actual play never gets close to this.
MAX_ACC_DIFF = 20
MAX_DAMAGE_DICE = 50


class LancerError(Exception):
    """A user-facing validation failure. Any front end -- a Discord
    command, an Owlbear HTTP endpoint later -- can catch this and show
    str(error) to the user without knowing the internals."""


# ---------------------------------------------------------------------------
# Rolling
# ---------------------------------------------------------------------------

def _roll_kept_dice(count, sides, keep_mode=None, keep_count=None):
    """Rolls `count` dice of `sides`, optionally keeping only the highest
    ("h") or lowest ("l") `keep_count` of them (keep_mode=None keeps all,
    i.e. a normal sum). Accuracy/Difficulty's "roll N d6, keep the highest"
    and hand-typed "XdYkhN"/"XdYklN" damage dice are the same mechanic --
    this is the one implementation both roll_d20_check and roll_damage use.

    Returns (rolls, kept_indices, total) -- kept_indices is a set of
    indices into `rolls` so callers can show which dice were dropped.
    """
    rolls = [random.randint(1, sides) for _ in range(count)]
    if keep_mode is None:
        kept_indices = set(range(len(rolls)))
    else:
        order = sorted(range(len(rolls)), key=lambda i: rolls[i], reverse=(keep_mode == "h"))
        kept_indices = set(order[:keep_count])
    total = sum(rolls[i] for i in kept_indices)
    return rolls, kept_indices, total


def roll_d20_check(modifier, accuracy=0, difficulty=0):
    """Rolls d20 + modifier, plus a net Accuracy/Difficulty d6.

    Accuracy and Difficulty cancel out 1-for-1 first; whichever is left
    over rolls that many d6 and keeps only the single highest -- added to
    the total for net Accuracy, subtracted for net Difficulty. A final
    total of 20 or more is a crit (the total, not just the raw d20 face).
    """
    if accuracy < 0 or difficulty < 0:
        raise LancerError("Accuracy and Difficulty must be zero or positive.")
    if accuracy > MAX_ACC_DIFF or difficulty > MAX_ACC_DIFF:
        raise LancerError(f"Accuracy and Difficulty must be at most {MAX_ACC_DIFF}.")

    d20_roll = random.randint(1, 20)

    net = accuracy - difficulty
    bonus_dice = []
    kept_indices = set()
    bonus = 0
    if net != 0:
        bonus_dice, kept_indices, kept_sum = _roll_kept_dice(abs(net), 6, "h", 1)
        bonus = kept_sum if net > 0 else -kept_sum

    total = d20_roll + modifier + bonus

    return {
        "mode": "check",
        "d20": d20_roll,
        "modifier": modifier,
        "net_accuracy": net,  # >0 = net Accuracy, <0 = net Difficulty, 0 = neither
        "bonus_dice": bonus_dice,
        "kept_indices": kept_indices,
        "bonus": bonus,
        "total": total,
        "is_crit": total >= 20,
    }


def _roll_damage_once(dice_terms, flat):
    rolls_by_term = []  # (sides, rolls, kept_indices) per term, in order
    total = flat
    for count, sides, keep_mode, keep_count in dice_terms:
        rolls, kept_indices, kept_sum = _roll_kept_dice(count, sides, keep_mode, keep_count)
        rolls_by_term.append((sides, rolls, kept_indices))
        total += kept_sum
    return {"rolls_by_term": rolls_by_term, "flat": flat, "total": total}


def roll_damage(dice_terms, flat=0, crit=False):
    """dice_terms is a list of (count, sides, keep_mode, keep_count) tuples
    -- keep_mode/keep_count are None for a plain sum-all-the-dice term, or
    ("h"|"l", n) style values for a hand-typed "khN"/"klN" term. E.g.
    [(2, 6, None, None), (1, 3, None, None)] for 2d6 + 1d3, or
    [(4, 6, "h", 2)] for 4d6kh2.

    If crit is True, rolls the whole expression twice and keeps the higher
    total (the Lancer crit-damage rule), returning both attempts."""
    for count, sides, keep_mode, keep_count in dice_terms:
        if count < 0:
            raise LancerError("Number of dice must be zero or positive.")
        if count > MAX_DAMAGE_DICE:
            raise LancerError(f"Number of dice must be at most {MAX_DAMAGE_DICE}.")
        if keep_mode is not None and not 1 <= keep_count <= count:
            raise LancerError("Can't keep more dice than you rolled.")
    if not any(count > 0 for count, _, _, _ in dice_terms) and flat == 0:
        raise LancerError("Enter at least one die or a flat bonus.")

    attempt_1 = _roll_damage_once(dice_terms, flat)
    if not crit:
        return {"mode": "damage", "crit": False, "attempts": [attempt_1], "total": attempt_1["total"]}

    attempt_2 = _roll_damage_once(dice_terms, flat)
    kept_total = max(attempt_1["total"], attempt_2["total"])
    return {"mode": "damage", "crit": True, "attempts": [attempt_1, attempt_2], "total": kept_total}


# ---------------------------------------------------------------------------
# Parsing: one flexible expression, auto-detects check vs. damage
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"([+-]?)\s*([A-Za-z0-9]+)")
_KEEP_DICE_TOKEN_RE = re.compile(r"^(\d*)d(\d+)k([hl])(\d*)$", re.IGNORECASE)
_DICE_TOKEN_RE = re.compile(r"^(\d*)d(\d+)$", re.IGNORECASE)
_ACCURACY_TOKEN_RE = re.compile(r"^a(\d*)$", re.IGNORECASE)


def parse_roll_expression(expr):
    """Parses a roll expression like "d20 + 3 a2" (check: +3 modifier, 2
    Accuracy), "2d6 + 3 crit" (damage: 2d6+3, crit), or "4d6kh2 + 3"
    (damage: roll 4d6, keep the highest 2, +3).

    Whether "d20" appears anywhere determines the mode. In damage
    expressions, dice are always written with an explicit die type that's
    actually rolled for damage. In check expressions, a bare "d<N>" for any
    size other than 20 has no other meaning, so it doubles as Difficulty
    notation -- e.g. "d20 + 3 d2" is +3 modifier, 2 Difficulty.
    """
    tokens = _TOKEN_RE.findall(expr)
    if not tokens:
        raise LancerError("Empty roll expression.")

    dice_terms = []
    accuracy_total = 0
    flat_total = 0
    crit = False
    unrecognized = []

    for sign, word in tokens:
        signed = -1 if sign == "-" else 1

        keep_match = _KEEP_DICE_TOKEN_RE.match(word)
        if keep_match:
            count_str, sides_str, keep_mode, keep_count_str = keep_match.groups()
            count = int(count_str) if count_str else 1
            keep_count = int(keep_count_str) if keep_count_str else 1
            dice_terms.append((count, int(sides_str), keep_mode.lower(), keep_count))
            continue

        dice_match = _DICE_TOKEN_RE.match(word)
        if dice_match:
            count_str, sides_str = dice_match.groups()
            count = int(count_str) if count_str else 1
            dice_terms.append((count, int(sides_str), None, None))
            continue

        acc_match = _ACCURACY_TOKEN_RE.match(word)
        if acc_match:
            accuracy_total += int(acc_match.group(1)) if acc_match.group(1) else 1
            continue

        if word.lower() == "crit":
            crit = True
            continue

        if word.isdigit():
            flat_total += signed * int(word)
            continue

        unrecognized.append(word)

    if unrecognized:
        raise LancerError(f"Didn't understand: {', '.join(unrecognized)}")

    d20_terms = [t for t in dice_terms if t[1] == 20]
    other_dice_terms = [t for t in dice_terms if t[1] != 20]

    if d20_terms:
        # Check mode: any other bare "d<N>" is Difficulty of magnitude N.
        difficulty_total = sum(sides for _, sides, _, _ in other_dice_terms)
        return {
            "mode": "check",
            "modifier": flat_total,
            "accuracy": accuracy_total,
            "difficulty": difficulty_total,
        }

    return {
        "mode": "damage",
        "dice_terms": other_dice_terms,
        "flat": flat_total,
        "crit": crit,
    }


def perform_roll(expr):
    """Parses expr and rolls it, returning whatever roll_d20_check() or
    roll_damage() returns (each tagged with "mode"). Raises LancerError on
    anything invalid, from parsing or from the roll itself."""
    parsed = parse_roll_expression(expr)
    if parsed["mode"] == "check":
        return roll_d20_check(parsed["modifier"], parsed["accuracy"], parsed["difficulty"])
    return roll_damage(parsed["dice_terms"], parsed["flat"], parsed["crit"])


def result_to_json_safe(result):
    """roll_d20_check()/roll_damage() results contain Python sets
    (kept_indices) for fast membership testing internally -- convert them
    to sorted lists so a result can be JSON-serialized for the web API."""

    def convert(value):
        if isinstance(value, set):
            return sorted(value)
        if isinstance(value, dict):
            return {k: convert(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [convert(v) for v in value]
        return value

    return convert(result)


# ---------------------------------------------------------------------------
# Discord formatting
# ---------------------------------------------------------------------------

# Emojis for d20 rolls (mirrors the Ascension bot's game_logic.py).
d20_emojis = {
    1: '<:d20_1:1529575608642703380>',
    2: '<:d20_2:1529575610546917417>',
    3: '<:d20_3:1529575612560310406>',
    4: '<:d20_4:1529575613885841498>',
    5: '<:d20_5:1529575615169171637>',
    6: '<:d20_6:1529575616817664130>',
    7: '<:d20_7:1529575618088271973>',
    8: '<:d20_8:1529575620659380364>',
    9: '<:d20_9:1529575621947162795>',
    10: '<:d20_10:1529575623071109242>',
    11: '<:d20_11:1529575624891433021>',
    12: '<:d20_12:1529575626300985364>',
    13: '<:d20_13:1529575627576053770>',
    14: '<:d20_14:1529575628364578827>',
    15: '<:d20_15:1529575630243364915>',
    16: '<:d20_16:1529575631627485224>',
    17: '<:d20_17:1529575633108340839>',
    18: '<:d20_18:1529575634685395214>',
    19: '<:d20_19:1529575635956007073>',
    20: '<:d20_20:1529575637210108055>',
}

# Emojis for d6 rolls -- also used for d3 and d2, since their faces (1-3,
# 1-2) are always within d6's 1-6 range.
d6_emojis = {
    1: '<:d6_1:1529575918102904902>',
    2: '<:d6_2:1529575919755202630>',
    3: '<:d6_3:1529575920976003284>',
    4: '<:d6_4:1529575922469179535>',
    5: '<:d6_5:1529575923639124029>',
    6: '<:d6_6:1529575924851544094>',
}

_EMOJI_CHUNK_SIZE = 2000  # Discord's message character limit


def _die_emoji(sides, face):
    """The emoji for a single die face. d20 gets its own set; every other
    die size (d6, d3, d2, ...) uses the d6 emoji."""
    if sides == 20:
        return d20_emojis[face]
    return d6_emojis[face]


def _chunk_emoji_string(emoji_string):
    return [
        emoji_string[i:i + _EMOJI_CHUNK_SIZE]
        for i in range(0, len(emoji_string), _EMOJI_CHUNK_SIZE)
    ]


def roll_emoji_chunks(result):
    """All the dice from one roll -- the d20 AND any Accuracy/Difficulty
    bonus d6s for a check, or every term's dice for a damage roll -- as a
    single emoji string, split into Discord-message-sized chunks. Everything
    from one command lands in the same message rather than one message per
    die type. A crit rolls twice, so its two attempts get one row each,
    separated by a linebreak, so the two rerolls read as distinct rows
    instead of one long unbroken string."""
    if result["mode"] == "check":
        emojis = [d20_emojis[result["d20"]]]
        emojis.extend(d6_emojis[roll] for roll in result["bonus_dice"])
        emoji_string = "".join(emojis)
    else:
        attempt_rows = [
            "".join(
                _die_emoji(sides, roll)
                for sides, rolls, _ in attempt["rolls_by_term"]
                for roll in rolls
            )
            for attempt in result["attempts"]
        ]
        emoji_string = "\n".join(attempt_rows)
    return _chunk_emoji_string(emoji_string)


def _signed(value):
    return f"+ {value}" if value >= 0 else f"- {abs(value)}"


def _format_dice_with_kept(rolls, kept_indices):
    """Shows all the rolled dice, striking through the ones that weren't
    kept (dropped by a keep-highest/keep-lowest rule)."""
    return ", ".join(str(r) if i in kept_indices else f"~~{r}~~" for i, r in enumerate(rolls))


def format_check_discord(result):
    pieces = [f"1d20 ({result['d20']})"]

    net = result["net_accuracy"]
    if net != 0:
        sign = "+" if net > 0 else "-"
        dice_str = _format_dice_with_kept(result["bonus_dice"], result["kept_indices"])
        pieces.append(f"{sign} {abs(net)}d6kh1 ({dice_str})")

    if result["modifier"]:
        pieces.append(_signed(result["modifier"]))

    equation = " ".join(pieces)

    total_line = f"**Total:** {result['total']}"
    if result["is_crit"]:
        total_line += " -- CRIT!"

    return f"**Result:** {equation}\n{total_line}"


def _describe_damage_attempt(attempt):
    dice_pieces = []
    for sides, rolls, kept_indices in attempt["rolls_by_term"]:
        rolls_str = _format_dice_with_kept(rolls, kept_indices)
        dice_pieces.append(f"{len(rolls)}d{sides} ({rolls_str})")

    equation = " + ".join(dice_pieces)
    if attempt["flat"]:
        signed_flat = _signed(attempt["flat"])
        equation = f"{equation} {signed_flat}" if equation else signed_flat
    return equation


def format_damage_discord(result):
    if not result["crit"]:
        equation = _describe_damage_attempt(result["attempts"][0])
        return f"**Result:** {equation}\n**Total:** {result['total']}"

    attempt_1, attempt_2 = result["attempts"]
    lines = [
        f"**Roll 1:** {_describe_damage_attempt(attempt_1)} = {attempt_1['total']}",
        f"**Roll 2:** {_describe_damage_attempt(attempt_2)} = {attempt_2['total']}",
        f"**Total (kept higher):** {result['total']}",
    ]
    return "\n".join(lines)


def format_roll_discord(result):
    if result["mode"] == "check":
        return format_check_discord(result)
    return format_damage_discord(result)
