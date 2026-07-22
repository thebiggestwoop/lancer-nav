"""aiohttp web layer that lets the Owlbear extension trigger the same
Lancer roll logic used by the Discord bot (via lancer_logic.py), and post
the results into whichever Discord channel a pairing code is linked to.

Runs in the same asyncio event loop as the bot (see lancer_bot.main()), so
handlers can call channel.send(...) directly using the bot's existing
Discord connection -- no separate webhook or bot token needed.

Structurally this mirrors the Ascension project's web_api.py, but with a
single /roll endpoint (matching the bot's one flexible !r command) instead
of separate d20/Challenge Dice/Momentum/Threat endpoints -- Lancer has no
per-guild pool state, just the roll itself.
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

    async def handle_roll(request):
        pairing = resolve_pairing(request)
        if pairing is None:
            return web.json_response({"error": "Unknown or expired pairing code."}, status=404)

        data = await read_json(request)
        if data is None:
            return web.json_response({"error": "Invalid JSON body."}, status=400)

        expression = data.get("expression")
        if not expression or not isinstance(expression, str):
            return web.json_response({"error": "expression is required."}, status=400)

        try:
            result = ll.perform_roll(expression)
        except ll.LancerError as e:
            return web.json_response({"error": str(e)}, status=400)

        safe_result = ll.result_to_json_safe(result)
        actor = data.get("player_name") or "Someone"
        text = ll.format_roll_discord(result)

        channel = await _get_channel(bot, pairing["channel_id"])

        # Sent emoji-only (no text) so Discord renders the dice faces at
        # large size -- matches the l!r Discord command's own behavior.
        for chunk in ll.roll_emoji_chunks(result):
            await channel.send(chunk)

        await channel.send(f"{_attribution(actor)}\n{text}")

        event_bus.publish(pairing["guild_id"], {
            "type": "roll",
            "source": "owlbear",
            "actor": actor,
            "expression": expression,
            "text": text,
            **safe_result,
        })

        return web.json_response(safe_result)

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
    app.router.add_post('/api/{code}/roll', handle_roll)
    app.router.add_route('OPTIONS', '/{tail:.*}', lambda request: web.Response())
    return app


async def start_web_server(bot, pairing_codes, port=WEB_PORT):
    app = create_app(bot, pairing_codes)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    logging.info(f"Lancer web API listening on http://0.0.0.0:{port}")
