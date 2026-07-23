"""Pure game-logic core for Lancer dice mechanics: the d20 + Accuracy/
Difficulty roll, and dice-pool damage rolls (including the crit rule --
double each damage term's dice and keep the top results -- and hand-typed
"kh"/"kl" keep-N-of-M dice) -- plus a small parser so a single command can
accept either kind of roll and tell them apart.

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

def _roll_die_with_overkill(sides, combat_drill=False):
    """Rolls one die, rerolling on a 1 (each 1 rolled -- including the ones
    that trigger further rerolls -- costs 1 Heat).

    combat_drill=True applies the Combat Drill tag: every individual 1
    rolled (on this die, or on any bonus die Combat Drill spawns) also
    spawns an extra +1d6 bonus damage die -- itself independently subject
    to the same Overkill + Combat Drill rules, so it chains indefinitely
    if a spawned bonus die is also a 1.

    Returns (final_face, discarded_ones, heat, bonus_dice) --
    discarded_ones is the list of 1s rerolled away for THIS die, in the
    order they came up; bonus_dice is a flat list of (final_face,
    discarded_ones, heat) for every Combat Drill bonus d6 spawned
    (including nested ones), in trigger order."""
    discarded_ones = []
    bonus_dice = []
    heat = 0
    face = random.randint(1, sides)
    while face == 1:
        discarded_ones.append(face)
        heat += 1
        if combat_drill:
            bonus_face, bonus_discarded, bonus_heat, nested_bonus = _roll_die_with_overkill(6, combat_drill=True)
            bonus_dice.append((bonus_face, bonus_discarded, bonus_heat))
            bonus_dice.extend(nested_bonus)
            heat += bonus_heat
        face = random.randint(1, sides)
    return face, discarded_ones, heat, bonus_dice


def _roll_kept_dice(count, sides, keep_mode=None, keep_count=None, overkill=False, combat_drill=False):
    """Rolls `count` dice of `sides`, optionally keeping only the highest
    ("h") or lowest ("l") `keep_count` of them (keep_mode=None keeps all,
    i.e. a normal sum). Accuracy/Difficulty's "roll N d6, keep the highest"
    and hand-typed "XdYkhN"/"XdYklN" damage dice are the same mechanic --
    this is the one implementation both roll_d20_check and roll_damage use.

    overkill=True applies the Overkill weapon tag: any die that lands on a
    1 costs 1 Heat and is rerolled (additional 1s keep triggering it).
    combat_drill=True implies overkill, and additionally spawns +1d6 bonus
    damage each time Overkill triggers (see _roll_die_with_overkill) --
    those bonus dice always count toward the total in full, never subject
    to the keep-highest/lowest filter (they aren't part of the `count`-sized
    pool being filtered).

    Returns (rolls, kept_indices, total, heat, discarded, bonus_dice) --
    kept_indices is a set of indices into `rolls` so callers can show which
    dice were dropped; discarded is a list parallel to `rolls`, each entry
    the (empty, unless overkill) list of 1s rerolled away for that die;
    bonus_dice is every Combat Drill bonus d6 spawned across all `count`
    dice (see _roll_die_with_overkill)."""
    overkill = overkill or combat_drill
    bonus_dice = []
    if overkill:
        rolls = []
        discarded = []
        heat = 0
        for _ in range(count):
            face, discarded_ones, die_heat, die_bonus = _roll_die_with_overkill(sides, combat_drill)
            rolls.append(face)
            discarded.append(discarded_ones)
            heat += die_heat
            bonus_dice.extend(die_bonus)
    else:
        rolls = [random.randint(1, sides) for _ in range(count)]
        discarded = [[] for _ in rolls]
        heat = 0
    if keep_mode is None:
        kept_indices = set(range(len(rolls)))
    else:
        order = sorted(range(len(rolls)), key=lambda i: rolls[i], reverse=(keep_mode == "h"))
        kept_indices = set(order[:keep_count])
    total = sum(rolls[i] for i in kept_indices) + sum(face for face, _, _ in bonus_dice)
    return rolls, kept_indices, total, heat, discarded, bonus_dice


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
        bonus_dice, kept_indices, kept_sum, _, _, _ = _roll_kept_dice(abs(net), 6, "h", 1)
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


def _roll_damage_once(dice_terms, flat, overkill=False, combat_drill=False):
    rolls_by_term = []  # (sides, rolls, kept_indices, discarded, bonus_dice) per term, in order
    total = flat
    heat = 0
    for count, sides, keep_mode, keep_count in dice_terms:
        rolls, kept_indices, kept_sum, die_heat, discarded, bonus_dice = _roll_kept_dice(
            count, sides, keep_mode, keep_count, overkill, combat_drill
        )
        rolls_by_term.append((sides, rolls, kept_indices, discarded, bonus_dice))
        total += kept_sum
        heat += die_heat
    return {"rolls_by_term": rolls_by_term, "flat": flat, "total": total, "heat": heat}


def _crit_term(term):
    """Transforms one (count, sides, keep_mode, keep_count) damage term for
    a critical hit: "all damage dice are rolled twice ... and the highest
    result from each source of damage is used" -- e.g. a plain 2d6 term
    becomes "roll 4d6, keep the highest 2", not two independent 2d6 rolls
    summed and compared. A term that already has an explicit hand-typed
    keep (khN/klN) doubles the same way, keeping that same explicit N of
    the doubled pool."""
    count, sides, keep_mode, keep_count = term
    if keep_mode is None:
        return (count * 2, sides, "h", count)
    return (count * 2, sides, keep_mode, keep_count)


def roll_damage(dice_terms, flat=0, crit=False, overkill=False, combat_drill=False):
    """dice_terms is a list of (count, sides, keep_mode, keep_count) tuples
    -- keep_mode/keep_count are None for a plain sum-all-the-dice term, or
    ("h"|"l", n) style values for a hand-typed "khN"/"klN" term. E.g.
    [(2, 6, None, None), (1, 3, None, None)] for 2d6 + 1d3, or
    [(4, 6, "h", 2)] for 4d6kh2.

    If crit is True, doubles each term's dice and keeps only the top
    results (see _crit_term) -- the Lancer crit-damage rule -- as a single
    roll, rather than rolling the whole expression twice.

    If overkill is True, applies the Overkill weapon tag to every damage
    die actually rolled (including the doubled crit pool, and any of its
    dropped dice): each 1 rolled costs 1 Heat and is rerolled, with further
    1s continuing to trigger it.

    If combat_drill is True, the weapon automatically counts as having
    Overkill, and additionally deals an extra +1d6 bonus damage each time
    Overkill activates -- chaining indefinitely if that bonus die is also
    a 1 (see _roll_die_with_overkill)."""
    for count, sides, keep_mode, keep_count in dice_terms:
        if count < 0:
            raise LancerError("Number of dice must be zero or positive.")
        if count > MAX_DAMAGE_DICE:
            raise LancerError(f"Number of dice must be at most {MAX_DAMAGE_DICE}.")
        if keep_mode is not None and not 1 <= keep_count <= count:
            raise LancerError("Can't keep more dice than you rolled.")
    if not any(count > 0 for count, _, _, _ in dice_terms) and flat == 0:
        raise LancerError("Enter at least one die or a flat bonus.")

    effective_terms = [_crit_term(t) for t in dice_terms] if crit else dice_terms
    for count, sides, keep_mode, keep_count in effective_terms:
        if count > MAX_DAMAGE_DICE:
            raise LancerError(f"Number of dice must be at most {MAX_DAMAGE_DICE}, even doubled for a crit.")

    attempt = _roll_damage_once(effective_terms, flat, overkill, combat_drill)
    return {
        "mode": "damage",
        "crit": crit,
        "overkill": overkill or combat_drill,
        "combat_drill": combat_drill,
        "attempts": [attempt],
        "total": attempt["total"],
        "heat": attempt["heat"],
    }


# ---------------------------------------------------------------------------
# Parsing: one flexible expression, auto-detects check vs. damage
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"([+-]?)\s*([A-Za-z0-9]+)")
_KEEP_DICE_TOKEN_RE = re.compile(r"^(\d*)d(\d+)k([hl])(\d*)$", re.IGNORECASE)
_DICE_TOKEN_RE = re.compile(r"^(\d*)d(\d+)$", re.IGNORECASE)
_ACCURACY_TOKEN_RE = re.compile(r"^a(\d*)$", re.IGNORECASE)


def parse_roll_expression(expr):
    """Parses a roll expression like "d20 + 3 a2" (check: +3 modifier, 2
    Accuracy), "2d6 + 3 crit" (damage: 2d6+3, crit), "4d6kh2 + 3"
    (damage: roll 4d6, keep the highest 2, +3), "2d6 overkill" (damage:
    2d6, Overkill weapon tag), or "2d6 combatdrill" (damage: 2d6, Combat
    Drill -- implies Overkill, plus a chaining +1d6 bonus each time it
    activates).

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
    overkill = False
    combat_drill = False
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

        if word.lower() == "overkill":
            overkill = True
            continue

        if word.lower() == "combatdrill":
            combat_drill = True
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
        "overkill": overkill,
        "combat_drill": combat_drill,
    }


def perform_roll(expr):
    """Parses expr and rolls it, returning whatever roll_d20_check() or
    roll_damage() returns (each tagged with "mode"). Raises LancerError on
    anything invalid, from parsing or from the roll itself."""
    parsed = parse_roll_expression(expr)
    if parsed["mode"] == "check":
        return roll_d20_check(parsed["modifier"], parsed["accuracy"], parsed["difficulty"])
    return roll_damage(
        parsed["dice_terms"], parsed["flat"], parsed["crit"], parsed["overkill"], parsed["combat_drill"]
    )


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
# Previous emoji batch -- kept here in case we revert:
# d20_emojis = {
#     1: '<:d20_1:1529575608642703380>',
#     2: '<:d20_2:1529575610546917417>',
#     3: '<:d20_3:1529575612560310406>',
#     4: '<:d20_4:1529575613885841498>',
#     5: '<:d20_5:1529575615169171637>',
#     6: '<:d20_6:1529575616817664130>',
#     7: '<:d20_7:1529575618088271973>',
#     8: '<:d20_8:1529575620659380364>',
#     9: '<:d20_9:1529575621947162795>',
#     10: '<:d20_10:1529575623071109242>',
#     11: '<:d20_11:1529575624891433021>',
#     12: '<:d20_12:1529575626300985364>',
#     13: '<:d20_13:1529575627576053770>',
#     14: '<:d20_14:1529575628364578827>',
#     15: '<:d20_15:1529575630243364915>',
#     16: '<:d20_16:1529575631627485224>',
#     17: '<:d20_17:1529575633108340839>',
#     18: '<:d20_18:1529575634685395214>',
#     19: '<:d20_19:1529575635956007073>',
#     20: '<:d20_20:1529575637210108055>',
# }
d20_emojis = {
    1: '<:d201:1529785781348991147>',
    2: '<:d202:1529786206639100005>',
    3: '<:d203:1529786207914037339>',
    4: '<:d204:1529786209600016494>',
    5: '<:d205:1529786210954772580>',
    6: '<:d206:1529786212276240434>',
    7: '<:d207:1529786214230786128>',
    8: '<:d208:1529786215518310490>',
    9: '<:d209:1529786216902299749>',
    10: '<:d2010:1529786218223501443>',
    11: '<:d2011:1529786219662278707>',
    12: '<:d2012:1529786220811522128>',
    13: '<:d2013:1529786222061424640>',
    14: '<:d2014:1529786223403470968>',
    15: '<:d2015:1529786224741453966>',
    16: '<:d2016:1529786225932632074>',
    17: '<:d2017:1529786227304431646>',
    18: '<:d2018:1529786228029788212>',
    19: '<:d2019:1529786229816557719>',
    20: '<:d2020:1529786231246819368>',
}

# Emojis for d6 rolls -- also used for d3 and d2, since their faces (1-3,
# 1-2) are always within d6's 1-6 range.
# Previous emoji batch -- kept here in case we revert:
# d6_emojis = {
#     1: '<:d6_1:1529575918102904902>',
#     2: '<:d6_2:1529575919755202630>',
#     3: '<:d6_3:1529575920976003284>',
#     4: '<:d6_4:1529575922469179535>',
#     5: '<:d6_5:1529575923639124029>',
#     6: '<:d6_6:1529575924851544094>',
# }
d6_emojis = {
    1: '<:d61:1529787097009885244>',
    2: '<:d62:1529787098830475314>',
    3: '<:d63:1529787100092694568>',
    4: '<:d64:1529787101477081149>',
    5: '<:d65:1529787102596956260>',
    6: '<:d66:1529787104161300490>',
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
    bonus d6s for a check, or every term's dice (plus any Combat Drill
    bonus d6s spawned) for a damage roll (crit or not -- a crit just means
    each term's dice pool was doubled) -- as a single emoji string, split
    into Discord-message-sized chunks. Everything from one command lands
    in the same message rather than one message per die type."""
    if result["mode"] == "check":
        emojis = [d20_emojis[result["d20"]]]
        emojis.extend(d6_emojis[roll] for roll in result["bonus_dice"])
        emoji_string = "".join(emojis)
    else:
        attempt_rows = []
        for attempt in result["attempts"]:
            faces = []
            for sides, rolls, _, _, bonus_dice in attempt["rolls_by_term"]:
                faces.extend((sides, roll) for roll in rolls)
                faces.extend((6, bonus_face) for bonus_face, _, _ in bonus_dice)
            attempt_rows.append("".join(_die_emoji(s, f) for s, f in faces))
        emoji_string = "\n".join(attempt_rows)
    return _chunk_emoji_string(emoji_string)


def _signed(value):
    return f"+ {value}" if value >= 0 else f"- {abs(value)}"


def _format_dice_with_kept(rolls, kept_indices, discarded=None):
    """Shows all the rolled dice, striking through the ones that weren't
    kept (dropped by a keep-highest/keep-lowest rule). If `discarded` is
    given (one list of rerolled-away 1s per die, from Overkill), each die's
    reroll chain is shown too, every rerolled 1 struck through, ahead of
    its final result."""
    pieces = []
    for i, r in enumerate(rolls):
        for one in (discarded[i] if discarded else []):
            pieces.append(f"~~{one}~~")
        pieces.append(str(r) if i in kept_indices else f"~~{r}~~")
    return ", ".join(pieces)


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
    for sides, rolls, kept_indices, discarded, bonus_dice in attempt["rolls_by_term"]:
        rolls_str = _format_dice_with_kept(rolls, kept_indices, discarded)
        dice_pieces.append(f"{len(rolls)}d{sides} ({rolls_str})")
        # Combat Drill bonus dice always count in full -- shown as their own
        # "1d6 (bonus, ...)" piece each, with their own reroll chain if the
        # bonus die itself triggered further Overkill/Combat Drill rerolls.
        for bonus_face, bonus_discarded, _ in bonus_dice:
            bonus_str = _format_dice_with_kept([bonus_face], {0}, [bonus_discarded])
            dice_pieces.append(f"1d6 (bonus, {bonus_str})")

    equation = " + ".join(dice_pieces)
    if attempt["flat"]:
        signed_flat = _signed(attempt["flat"])
        equation = f"{equation} {signed_flat}" if equation else signed_flat
    return equation


def format_damage_discord(result):
    # "CRIT" is reserved for the d20 attack roll that actually triggers one
    # (format_check_discord's is_crit) -- a damage roll's own "crit" flag
    # just means its dice mechanic doubled, so it isn't re-announced here.
    equation = _describe_damage_attempt(result["attempts"][0])
    lines = [f"**Result:** {equation}"]
    # Combat Drill's bonus dice count toward the total, so it's reported
    # before Total (explaining where the extra damage came from); Overkill's
    # Heat is a cost, not damage, so it's reported after, as a side effect.
    if result.get("combat_drill"):
        bonus_count = sum(
            len(bonus_dice) for _, _, _, _, bonus_dice in result["attempts"][0]["rolls_by_term"]
        )
        lines.append(f"**Combat Drill:** {bonus_count} bonus 1d6")
    lines.append(f"**Total:** {result['total']}")
    if result.get("overkill"):
        lines.append(f"**Overkill:** {result['heat']} Heat")
    return "\n".join(lines)


def format_roll_discord(result):
    if result["mode"] == "check":
        return format_check_discord(result)
    return format_damage_discord(result)


_DICE_NOTATION_RE = re.compile(r"\d+D\d+(?:K[HL]\d+)?")


def format_roll_discord_shouted(result):
    """format_roll_discord(), but in all caps -- the bot speaks its roll
    results in all caps (same text either way, Discord command or Owlbear
    extension), except dice notation ("2d6", "1d20", "6d6kh1", ...) stays
    lowercase so it still reads as dice notation rather than "2D6"/"6D6KH1"."""
    shouted = format_roll_discord(result).upper()
    return _DICE_NOTATION_RE.sub(lambda m: m.group(0).lower(), shouted)
