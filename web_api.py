"""aiohttp web layer that lets the Owlbear extension post its own dice
rolls into whichever Discord channel a pairing code is linked to.

The extension rolls locally now (see docs/diceLogic.js, a JS port of
lancer_logic.py's rolling rules) so it works without any Discord pairing
at all; this server's only remaining job for a roll is /announce --
formatting and posting an *already-computed* result to Discord when a
room happens to be linked, reusing lancer_logic.py's own (unmodified)
Discord formatters on the structured result the client sends over.

Runs in the same asyncio event loop as the bot (see lancer_bot.main()), so
handlers can call channel.send(...) directly using the bot's existing
Discord connection -- no separate webhook or bot token needed.
"""

import logging

from aiohttp import web

import event_bus
import lancer_logic as ll

WEB_PORT = 8421


def _attribution(actor):
    return f"**{actor}** (via Owlbear)"


async def _get_channel(bot, channel_id):
    channel = bot.get_channel(channel_id)
    if channel is None:
        channel = await bot.fetch_channel(channel_id)
    return channel


def create_app(bot, pairing_codes):
    """pairing_codes is the same dict mutated by the bot's !link command --
    code -> {"guild_id": int, "channel_id": int}."""

    def resolve_pairing(request):
        return pairing_codes.get(request.match_info["code"])

    async def read_json(request):
        try:
            return await request.json()
        except Exception:
            return None

    async def handle_updates(request):
        """Polled by the extension every few seconds: any roll events
        published since the `since` sequence number it last saw (0 the
        first time, which returns full history)."""
        pairing = resolve_pairing(request)
        if pairing is None:
            return web.json_response({"error": "Unknown or expired pairing code."}, status=404)

        try:
            since = int(request.query.get("since", 0))
        except ValueError:
            since = 0

        guild_id = pairing["guild_id"]
        return web.json_response({
            "events": event_bus.get_since(guild_id, since),
            "seq": event_bus.latest_seq(guild_id),
        })

    async def handle_announce(request):
        """Called by the Owlbear extension after it's already rolled
        locally (see docs/diceLogic.js) -- posts that already-computed
        result to the linked Discord channel. Does NOT publish to
        event_bus: Owlbear-to-Owlbear distribution is OBR.broadcast's job
        now (see docs/app.js), not this server's. event_bus stays
        exclusively for rolls made directly in Discord via l!r, which
        reach Owlbear through the /updates polling below -- broadcast has
        no way to reach *from* Discord, only between Owlbear clients."""
        pairing = resolve_pairing(request)
        if pairing is None:
            return web.json_response({"error": "Unknown or expired pairing code."}, status=404)

        data = await read_json(request)
        if data is None:
            return web.json_response({"error": "Invalid JSON body."}, status=400)

        result = data.get("result")
        if not isinstance(result, dict) or result.get("mode") not in ("check", "damage"):
            return web.json_response({"error": "result is required."}, status=400)

        actor = data.get("player_name") or "Someone"
        text = ll.format_roll_discord_shouted(result)

        channel = await _get_channel(bot, pairing["channel_id"])

        # Sent emoji-only (no text) so Discord renders the dice faces at
        # large size -- matches the l!r Discord command's own behavior.
        for chunk in ll.roll_emoji_chunks(result):
            await channel.send(chunk)

        # _attribution() is the one exception left un-uppercased -- it's
        # just the "(via Owlbear)" note next to the player's name, not the
        # bot speaking.
        await channel.send(f"{_attribution(actor)}\n{text}")

        return web.json_response({"ok": True})

    @web.middleware
    async def cors_middleware(request, handler):
        if request.method == "OPTIONS":
            response = web.Response()
        else:
            try:
                response = await handler(request)
            except web.HTTPException as exc:
                response = exc
            except Exception:
                logging.exception("Unhandled error in Lancer web API request")
                response = web.json_response({"error": "Internal server error."}, status=500)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get('/api/{code}/updates', handle_updates)
    app.router.add_post('/api/{code}/announce', handle_announce)
    app.router.add_route('OPTIONS', '/{tail:.*}', lambda request: web.Response())
    return app


async def start_web_server(bot, pairing_codes, port=WEB_PORT):
    app = create_app(bot, pairing_codes)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    logging.info(f"Lancer web API listening on http://0.0.0.0:{port}")
