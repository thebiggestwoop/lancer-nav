# Lancer Companion Bot & Owlbear Extension

A Discord bot for rolling *Lancer* dice, paired with an Owlbear Rodeo extension that acts as a remote control for it — roll a check or a damage expression from inside Owlbear, and the result posts to Discord automatically, dice faces and all.

**Just want to use it?** Invite the live bot to your Discord server: **[Add to Discord](https://discord.com/oauth2/authorize?client_id=1528810293663371464&scope=bot&permissions=330752)** — then run `l!h` in any channel for the command list, or `l!link` to pair the Owlbear extension.

The link requests View Channels, Send Messages, Read Message History, and Use External Emojis — without these, the bot can join a server but stay silent in channels where `@everyone` doesn't already have those permissions (in particular, the dice-face emoji won't render without Use External Emojis, since they live on a different application than whichever server you invite the bot to). If the bot's already in your server from an older link, re-clicking this one will prompt Discord to update its permissions rather than add a duplicate.

Uses its own bot application and a distinct command prefix (`l!`) from the separate Ascension bot, so the two can coexist in the same Discord server without their commands colliding.

## Contents

- [Architecture at a glance](#architecture-at-a-glance)
- [The Discord bot](#the-discord-bot)
- [The Owlbear extension](#the-owlbear-extension)
- [How this deployment is hosted](#how-this-deployment-is-hosted)
- [Setting it up yourself](#setting-it-up-yourself)
- [Repo layout](#repo-layout)
- [Known limitations](#known-limitations)

---

## Architecture at a glance

```
Owlbear extension (docs/, static files)
        |  HTTPS fetch()
        v
Discord bot process (roll logic + Discord commands + a small web API)
        |  channel.send(...)
        v
     Discord channel
```

Two front ends — Discord chat commands and the Owlbear extension — both call into the *same* underlying roll logic (`lancer_logic.py`), so a check or damage roll comes out identical no matter which one triggered it. The bot process itself hosts both the Discord connection and a small HTTP API in the same asyncio event loop, so the web API can post to Discord directly (`channel.send(...)`) without a separate webhook or second bot token.

---

## The Discord bot

### Commands

| Command | What it does |
|---|---|
| `l!r <expression>` | Rolls a d20 check or a damage roll, auto-detecting which from the expression. **Check:** `l!r d20 + 3 a2` — d20 + modifier, `aN` for Accuracy, `dN` for Difficulty (they cancel 1-for-1 first; whichever is left rolls that many d6 and keeps only the highest). A total of 20+ is a crit. **Damage:** `l!r 2d6 + 3` or `l!r 2d6 + 1d3 + 3 crit` — dice + flat bonus; `crit` rolls the whole expression twice and keeps the higher total. Also accepts hand-typed `XdYkhN`/`XdYklN` (keep highest/lowest N of X). |
| `l!link` | Generates a pairing code that links the current channel to the Owlbear extension (see below). |
| `l!h` | Prints the command list. |

Dice results are always sent as **emoji-only messages** with no accompanying text — Discord renders a message as large emoji only when it contains nothing else, which is why roll results are split into an emoji message followed by a separate text summary message, rather than combined into one. A d20 rolled alongside bonus Accuracy/Difficulty d6s (or every die across both attempts of a crit damage roll) all land in that same single emoji message rather than one message per die type. `d3`/`d2` dice reuse the d6 emoji, since their faces (1-3, 1-2) are always within d6's 1-6 range.

### Game logic module (`lancer_logic.py`)

All dice math and expression parsing lives here, with zero Discord or web-framework dependency, so both front ends (`lancer_bot.py` for Discord, `web_api.py` for the extension) call the exact same functions instead of each re-implementing the rules. Key pieces:

- `roll_d20_check` / `roll_damage` — the actual dice rolls (validating dice counts and Accuracy/Difficulty against sane caps, raising `LancerError` with a human-readable message on bad input).
- `parse_roll_expression` / `perform_roll` — turn a typed expression like `d20 + 3 a2` or `2d6 + 1d3 + 3 crit` into a check or damage roll and perform it.
- `format_roll_discord` / `roll_emoji_chunks` — turn a raw roll result into the markdown text and emoji string Discord messages are built from.

### Live activity log (`event_bus.py`)

A small in-memory, per-guild log of recent rolls, each with an incrementing sequence number. Every roll — whether it came from a Discord command or the Owlbear extension — gets published here. The Owlbear extension polls this (see below) so it can show rolls that happened in Discord, not just ones it triggered itself. Uses short polling rather than a persistent push connection, since Cloudflare's free tunnels don't reliably relay long-lived streaming responses.

---

## The Owlbear extension

A static site (`docs/`) — plain HTML/CSS/JS, no build step, imports the `@owlbear-rodeo/sdk` straight from a CDN. It's a popover in Owlbear's toolbar with:

- **d20 check controls** — Modifier (with +/- stepper), Accuracy, and Difficulty fields, feeding a "Roll d20" button.
- **XdX damage controls** — d6 count, d3 count, Flat bonus, a Keep toggle (All/High/Low), a Crit checkbox, and a one-tap d2 button, feeding a "Roll" button. These don't talk to the backend directly — they build the same expression string the `l!r` command and the Advanced box produce, then send it through the one `/roll` endpoint, so the parsing/validation logic lives in exactly one place (`lancer_logic.py`).
- **Advanced: type an expression** — a free-form text box for anything the structured controls don't cover directly.
- **Roll History** — a scrolling log of recent rolls (from either platform), each rendered with the same dice-face icon art the Discord bot posts as custom emoji (`docs/icons/`), fed by polling `/api/<code>/updates`.
- **Reset All** — clears every control back to its default in one click.

### Pairing

Since the extension has no way to know which Discord channel should receive its rolls, a **pairing code** links the two:

1. Someone runs `l!link` in the target Discord channel; the bot replies with a short code (mapping `code → (guild, channel)`, kept in memory).
2. Whoever's running the game pastes that code into the extension's Settings once.
3. The extension stores it in `OBR.room.metadata` — Owlbear automatically replicates room metadata to every client connected to that Owlbear room, so **only one person ever has to enter the code**; everyone else's extension picks it up automatically.

Pairing codes (and the roll history) live only in the bot process's memory — they reset if the bot restarts. In practice this rarely matters, since the bot runs as an always-on service (see below), but a `l!link` re-run is the fix if it ever does.

### Why not client-side dice rolling?

Unlike some Owlbear dice extensions, rolls aren't computed in the browser — the extension sends the *expression* to the bot, and the bot (server-side, in Python) does the actual `random` roll, validates it, formats it, and posts it. This keeps one single implementation of the roll rules (reused by both Discord and Owlbear) instead of maintaining the same logic in two languages, and means a browser client can't just fabricate a favorable roll.

---

## How this deployment is hosted

This section documents the actual setup for this instance of the bot — useful background, but see [Setting it up yourself](#setting-it-up-yourself) below if you're deploying your own copy.

- **Bot process**: the same Oracle Cloud "Always Free" VM (Ubuntu 24.04) that hosts the Ascension bot, running as its own separate `systemd` service (`lancer-bot.service`) so it survives reboots and restarts automatically if it crashes. The two bots run as independent processes with independent tokens; they just happen to share a VM.
- **Public access to the bot's web API**: a **named Cloudflare Tunnel** (`cloudflared`) routes a stable hostname to the bot's local port 8421, without opening any inbound firewall ports on the VM — the tunnel only makes outbound connections to Cloudflare's edge.
- **Extension frontend**: hosted on **GitHub Pages** (`docs/` folder of this repo), with its own custom domain rather than the default `username.github.io/reponame/` project-site URL. This matters for a subtle reason: Owlbear resolves the manifest's `icon`/`popover` paths as root-relative to whatever *origin* serves the manifest, not relative to the manifest's own folder — so a project-site subpath breaks it. A custom domain (via a Cloudflare DNS CNAME, set to **DNS only**, not proxied, so GitHub can provision its own certificate) makes the extension serve from a true domain root, where root-relative paths resolve correctly.

**Important:** this deployment is a plain file copy on the VM, not a git clone — pushing to GitHub does not, by itself, update the running bot process. Updated `.py` files need to be copied over (e.g. via `scp`) and the service restarted (`sudo systemctl restart lancer-bot.service`) before changes take effect. The Owlbear extension's `docs/` folder is the exception: GitHub Pages rebuilds straight from the repo, so pushing is enough for extension changes to go live.

---

## Setting it up yourself

You'll need: a Discord bot application (and its token), somewhere to run Python continuously, a way to expose that process's port 8421 over HTTPS at a stable address, and somewhere to host the `docs/` folder as a static site.

### 1. Discord bot application

Create an application + bot user at the [Discord Developer Portal](https://discord.com/developers/applications), enable the **Message Content** intent (Bot → Privileged Gateway Intents), and invite it to your server with permission to send messages. Copy the bot token — you'll need it in step 3.

### 2. Get the code and install dependencies

```bash
git clone <this-repo-url>
cd <repo-folder>
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

### 3. Provide the bot token

Either set an environment variable:

```bash
export LANCER_BOT_TOKEN=your-token-here
```

or drop a `token.txt` file (just the token, nothing else) next to `lancer_bot.py`. It's git-ignored, so it won't accidentally get committed.

### 4. Run it

```bash
./venv/bin/python lancer_bot.py
```

This starts both the Discord bot and the web API (port 8421) in one process. For anything beyond quick local testing, run this under a process supervisor so it restarts on crash/reboot — a `systemd` unit is the simplest option on Linux:

```ini
[Unit]
Description=Lancer Companion Discord bot + Owlbear web API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/path/to/repo
ExecStart=/path/to/repo/venv/bin/python /path/to/repo/lancer_bot.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 5. Expose the web API over HTTPS at a stable address

The Owlbear extension needs to reach port 8421 from players' own browsers, over HTTPS (mixed content rules block an HTTPS page from calling an HTTP backend). A **Cloudflare named tunnel** is a solid free option:

1. Add a domain to a free Cloudflare account.
2. Zero Trust dashboard → Networks → Tunnels → create a tunnel, connector type Cloudflared.
3. Run the install command it gives you on your server (`sudo cloudflared service install <token>` on Debian/Ubuntu — installs `cloudflared` as its own systemd service).
4. In the tunnel's **Public Hostname** tab, route your chosen subdomain (e.g. `lancer-bot.yourdomain.com`) to `http://localhost:8421`.

Any other way of getting a stable HTTPS reverse proxy in front of port 8421 works too (a reverse proxy you manage yourself with a Let's Encrypt cert, another tunneling provider, etc.) — the bot doesn't care how requests arrive, only that they do.

### 6. Point the extension at your backend and host it

Open `docs/app.js` and change the `BACKEND_URL` constant near the top to your own stable URL from step 5:

```js
const BACKEND_URL = "https://lancer-bot.yourdomain.com";
```

Then host the `docs/` folder as a static site. A few free options:

- **GitHub Pages with a custom domain** (what this deployment uses) — Settings → Pages → source = `main` branch, `/docs` folder, then set a custom domain and point a DNS CNAME at `<username>.github.io` (**DNS only**, not proxied, so GitHub's certificate provisioning can complete).
- **GitHub Pages without a custom domain** — works too, but you'll need to switch `manifest.json`'s `icon`/`action.icon` fields from root-relative (`/icon.svg`) to plain relative (`icon.svg`), since the site will be served from a `/reponame/` subpath rather than a domain root.
- **Cloudflare Pages / Netlify / Vercel** — any static host works; same root-vs-subpath consideration applies depending on whether you attach a custom domain.

### 7. Install the extension in Owlbear

In Owlbear Rodeo, open the Extensions panel → **Add custom extension** → paste the URL to your hosted `manifest.json`.

### 8. Link a channel and go

In the Discord channel you want rolls posted to, run `l!link` and copy the code it replies with. Open the extension's popover in Owlbear, paste the code into Settings, save, and you're set — every player in that Owlbear room will pick up the same pairing automatically via Owlbear's room metadata sync.

---

## Repo layout

```
lancer_bot.py          Discord-facing bot: the l!r/l!link/l!h commands, entry point
lancer_logic.py         Pure roll/expression logic shared by both front ends -- no Discord/web dependency
event_bus.py            In-memory per-guild activity log the extension polls for updates
web_api.py              aiohttp HTTP API for the extension (the /roll endpoint, polling endpoint)
serve_extension.py      Small local static server (with CORS headers) for testing docs/ locally
requirements.txt        Python dependencies
lancer dice art/        Source art (Affinity Photo files + exported PNGs) for the dice-face icons
docs/                   The Owlbear extension itself (static site, hosted via GitHub Pages)
  manifest.json           Owlbear extension manifest
  index.html              Popover markup
  app.js                  Popover logic (OBR SDK, polling, pairing, roll controls)
  style.css               Popover styling
  icon.svg                Toolbar/action icon
  lancer-companion-logo.png  Main extension logo
  icons/                  d20_1.png..d20_20.png, d6_1.png..d6_6.png -- dice-face art for Roll History
```

## Known limitations

- **State is in-memory only.** Pairing codes and roll history reset if the bot process restarts. Fine for an always-on service; something to know if you ever see history unexpectedly empty.
- **No cross-platform identity.** Discord and Owlbear have entirely separate identity systems with no linking between them. Attribution from the extension (`player_name`) is self-reported by the client, not cryptographically verified — adequate for a private game with people you trust, not a public/adversarial deployment.
- **Rolls are server-authoritative but the transport isn't authenticated beyond the pairing code.** Anyone who obtains a valid pairing code can post rolls to the linked channel through the bot. Treat the code like a lightweight shared secret.
