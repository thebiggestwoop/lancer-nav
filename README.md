# Lancer Companion

A dice-rolling companion for the *Lancer* tabletop RPG. Lancer Companion is two independent tools, sharing the exact same roll rules: a Discord bot, and an Owlbear Rodeo extension. Each works completely on its own — pair them together and every roll made in one also appears in the other.

**Add the bot to Discord:** [Add to Discord](https://discord.com/oauth2/authorize?client_id=1528810293663371464&scope=bot&permissions=330752) — then run `l!h` in any channel for the command list, or `l!link` to pair the Owlbear extension.

The link requests View Channels, Send Messages, Read Message History, and Use External Emojis. Without these, the bot can join a server but stay silent in channels where `@everyone` doesn't already have them — in particular, the dice-face emoji won't render without Use External Emojis, since they live on a different application than whichever server you invite the bot to.

**Install the Owlbear extension:** in Owlbear Rodeo, open the Extensions panel → **Add custom extension** → paste `https://lancer-owlbear.heruv.uk/manifest.json`.

Legal: [Terms of Service](https://lancer-owlbear.heruv.uk/terms.html) · [Privacy Policy](https://lancer-owlbear.heruv.uk/privacy.html)

## Contents

- [The Discord bot](#the-discord-bot)
- [The Owlbear extension](#the-owlbear-extension)
- [Architecture](#architecture)
- [Repo layout](#repo-layout)
- [Known limitations](#known-limitations)

---

## The Discord bot

Uses its own bot application and a distinct command prefix (`l!`), so it can coexist with other bots in the same server without command collisions.

### Commands

| Command | What it does |
|---|---|
| `l!r <expression>` | Rolls a d20 check or a damage roll, auto-detecting which from the expression. |
| `l!link` | Generates a pairing code that links the current channel to the Owlbear extension. |
| `l!h` | Prints the command list. |

**Check rolls** — `l!r d20 + 3 a2`: d20 + modifier, `aN` for Accuracy, `dN` for Difficulty (they cancel 1-for-1 first; whichever's left over rolls that many d6 and keeps only the highest). A final total of 20+ is a crit.

**Damage rolls** — `l!r 2d6 + 3` or `l!r 2d6 + 1d3 + 3 crit`: dice + flat bonus.

- `crit` doubles each damage term's dice and keeps only the top results (e.g. `2d6` becomes `4d6`, keep the highest 2) — the actual Lancer crit rule, not a "roll twice, keep the higher total" shortcut.
- `overkill` — any die that lands on a 1 costs 1 Heat and is rerolled; further 1s keep triggering it.
- `combatdrill` — implies `overkill`, and also deals an extra +1d6 bonus damage each time Overkill activates, chaining indefinitely if that bonus die is also a 1.
- Hand-typed `XdYkhN` / `XdYklN` (keep highest/lowest N of X) is also accepted.

Dice results are sent as **emoji-only messages** — Discord renders a message as large emoji only when it contains nothing else — followed by a separate text summary, shouted in **ALL CAPS** except the dice notation itself (`2d6`, not `2D6`), so it still reads correctly.

### Game logic (`lancer_logic.py`)

All dice math and expression parsing lives here, with zero Discord or web-framework dependency, so the Discord bot (`lancer_bot.py`) and the web API for the extension (`web_api.py`) call the exact same functions instead of each re-implementing the rules.

### Activity log (`event_bus.py`)

A small in-memory, per-guild log of recent rolls made directly in Discord via `l!r`. The Owlbear extension polls this so it can show those rolls too, not just ones it triggered itself.

---

## The Owlbear extension

A static site (`docs/`) — plain HTML/CSS/JS, no build step.

### Rolling

- **d20 check** — Modifier, Accuracy, and Difficulty fields, a saved-rolls slot for checks you use often, and a Roll d20 button.
- **XdX damage** — d6/d3 counts, a Flat bonus, a Keep toggle (All/High/Low), Crit/Overkill checkboxes (Combat Drill is available too, opt in via Settings), a one-tap d2 button, saved rolls, and a Roll button.
- **Advanced** — a free-form text box accepting the same expression syntax as `l!r`.

All of this rolls locally in the browser, via `docs/diceLogic.js` — a JS port of `lancer_logic.py`'s rules.

### Roll History, shared live with the room

Every roll — from any player's copy of the extension, in the same Owlbear room — is broadcast live to everyone else in that room via Owlbear's own broadcast channel (`OBR.broadcast`).

### Pairing with Discord

To also post rolls into a Discord channel:

1. Run `l!link` in the target channel; the bot replies with a short pairing code.
2. Paste that code into the extension's Settings and save. Owlbear automatically syncs it to everyone in the room via room metadata, so only one person ever needs to enter it.
3. Every roll now also gets posted into that Discord channel, in addition to being shared live in Owlbear.

The **Pair with Discord** toggle in Settings turns this off entirely — grays out the pairing code field, and skips both posting to Discord and polling it — for anyone who'd rather keep their own rolls local-only even in an otherwise-linked room. When paired, the bot only re-formats and posts whatever the extension already rolled; it never rolls a second, potentially different, result of its own for Discord.

### Settings

- **Pair with Discord** / pairing code — see above.
- **Show Combat Drill** — reveals the Combat Drill checkbox on the XdX card (hidden by default, since it's a specific weapon tag most characters won't have).
- **Show Dice Icons** — toggles the dice-face icon art in Roll History.
- **Clear all saved rolls** — wipes saved d20/XdX presets, with an "Are you sure?" confirmation.

---

## Architecture

```
Owlbear extension (docs/, static files, rolls locally)
        |  OBR.broadcast (peer-to-peer, no server)  -->  everyone else in the room
        |
        |  HTTPS fetch(), only if paired
        v
Discord bot process (roll logic + Discord commands + a small web API)
        |  channel.send(...)
        v
     Discord channel
```

Both front ends share the same roll rules: the bot's copy lives in `lancer_logic.py` (Python), the extension's in `docs/diceLogic.js` (a hand-maintained JS port, since a static site can't run Python). When paired, the extension sends its already-computed result to the bot's `/announce` endpoint, which reuses `lancer_logic.py`'s own formatting to post a matching message to Discord — the bot only relays and formats, it never re-rolls.

---

## Repo layout

```
lancer_bot.py       Discord-facing bot: the l!r/l!link/l!h commands, entry point
lancer_logic.py     Pure roll/expression logic shared by both front ends -- no Discord/web dependency
event_bus.py        In-memory per-guild activity log for rolls made directly in Discord
web_api.py          aiohttp HTTP API for the extension (/announce, /updates)
serve_extension.py  Small local static server (with CORS headers) for testing docs/ locally
requirements.txt    Python dependencies
docs/               The Owlbear extension (static site, hosted via GitHub Pages)
  manifest.json       Owlbear extension manifest
  index.html          Popover markup
  app.js              Popover logic (OBR SDK, local rolling, broadcast, pairing, roll controls)
  diceLogic.js        JS port of lancer_logic.py's rolling/parsing rules
  style.css           Popover styling
  icon.svg            Toolbar/action icon
  lancer-companion-logo.png  Main extension logo
  icons/              d20_1.png..d20_20.png, d6_1.png..d6_6.png -- dice-face art for Roll History
  terms.html          Terms of Service
  privacy.html        Privacy Policy
```

## Known limitations

- **State is in-memory only, server-side.** Pairing codes and the Discord-side activity log reset if the bot process restarts.
- **No cross-platform identity.** Discord and Owlbear have entirely separate identity systems; attribution from the extension (player name) is self-reported by the client, not cryptographically verified.
- **The transport isn't authenticated beyond the pairing code.** Anyone who obtains a valid pairing code can post rolls to the linked channel through the bot — treat the code like a lightweight shared secret.
