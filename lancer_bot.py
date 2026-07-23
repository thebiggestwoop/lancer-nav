"""Lancer companion Discord bot: a single flexible `!r` command that rolls
either a d20 check (Accuracy/Difficulty) or a damage expression, auto-
detecting which based on the expression -- see lancer_logic.py for the
parsing/rolling rules themselves.

Separate bot application/token from the Ascension bot, and a distinct
command prefix ("l!") so the two can coexist in the same Discord server
without their commands colliding.

Also hosts a small web API (web_api.py) in the same asyncio event loop, so
an Owlbear extension can trigger rolls too -- see !link below.
"""

import asyncio
import logging
import os
import secrets

import discord
from discord.ext import commands

import event_bus
import lancer_logic as ll
import web_api

logging.basicConfig(level=logging.INFO)

intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="l!", intents=intents)

# Maps a pairing code -> {"guild_id": int, "channel_id": int}, created by
# !link and consumed by web_api.py. In-memory only -- codes are lost on
# restart, same as the roll history in event_bus.py.
pairing_codes = {}


def generate_pairing_code():
    return secrets.token_urlsafe(6)


@bot.command(name="r")
@commands.guild_only()
async def roll(ctx, *, expression: str):
    try:
        result = ll.perform_roll(expression)
    except ll.LancerError as e:
        await ctx.send(f"{ctx.author.mention}\n**Error:** {e}")
        return

    # Sent emoji-only (no text) so Discord renders the dice faces at large size
    for chunk in ll.roll_emoji_chunks(result):
        await ctx.send(chunk)

    text = ll.format_roll_discord(result)
    await ctx.send(f"{ctx.author.mention}\n{text}")

    event_bus.publish(ctx.guild.id, {
        "type": "roll",
        "source": "discord",
        "actor": ctx.author.display_name,
        "expression": expression,
        "text": text,
        **ll.result_to_json_safe(result),
    })


@bot.command(name="link")
@commands.guild_only()
async def link(ctx):
    code = generate_pairing_code()
    pairing_codes[code] = {"guild_id": ctx.guild.id, "channel_id": ctx.channel.id}
    await ctx.send(f"{ctx.author.mention}\n**Owlbear pairing code:** {code}")


@bot.command(name="h")
async def help_command(ctx):
    help_text = (
        "**Bot Commands:**\n\n"
        "**l!r <expression>** - Rolls a d20 check or a damage roll, auto-detecting which:\n"
        "- Check: `l!r d20 + 3 a2` -- d20 + modifier, `aN` for Accuracy, `dN` for Difficulty (they cancel 1-for-1). Total of 20+ is a crit.\n"
        "- Damage: `l!r 2d6 + 3` or `l!r 2d6 + 1d3 + 3 crit` -- dice + flat bonus; `crit` doubles each damage term's dice and keeps the top results (e.g. 2d6 becomes 4d6, keep highest 2). Also accepts hand-typed `XdYkhN`/`XdYklN` (keep highest/lowest N of X).\n"
        "- `overkill` -- e.g. `l!r 2d6 overkill` -- any die that lands on a 1 costs 1 Heat and is rerolled (further 1s keep triggering it); the total Heat taken is reported.\n"
        "- `combatdrill` -- e.g. `l!r 2d6 combatdrill` -- implies `overkill`, and also deals an extra +1d6 bonus damage each time Overkill activates (chains further if that bonus die is also a 1).\n"
        "**l!link** - Generates a code to link this channel to the Owlbear extension.\n"
    )
    await ctx.send(help_text)


@bot.event
async def on_ready():
    logging.info(f'Logged in as {bot.user} (ID: {bot.user.id})')
    logging.info('------')


@bot.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.NoPrivateMessage):
        await ctx.send(f"{ctx.author.mention}\n**Error:** This command can't be used in DMs.")
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.send(f"{ctx.author.mention}\n**Error:** Missing argument: `{error.param.name}`. Try `l!h` for usage.")
    elif isinstance(error, commands.CommandNotFound):
        pass
    else:
        logging.error(f"Unhandled error in command '{ctx.command}': {error}")
        await ctx.send(f"{ctx.author.mention}\n**Error:** Something went wrong running that command.")


def load_token():
    """Load the bot token from the LANCER_BOT_TOKEN env var, falling back
    to a token.txt file kept next to this script (not committed to source)."""
    token = os.environ.get("LANCER_BOT_TOKEN")
    if token:
        return token

    token_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "token.txt")
    if os.path.isfile(token_path):
        with open(token_path, "r", encoding="utf-8") as f:
            token = f.read().strip()
        if token:
            return token

    raise RuntimeError(
        "No Discord bot token found. Set the LANCER_BOT_TOKEN environment variable, "
        "or create a token.txt file next to this script containing just the token."
    )


async def main():
    async with bot:
        asyncio.create_task(web_api.start_web_server(bot, pairing_codes))
        await bot.start(load_token())


if __name__ == "__main__":
    asyncio.run(main())
