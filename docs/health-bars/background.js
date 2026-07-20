import OBR, { buildCurve, buildText } from "https://esm.sh/@owlbear-rodeo/sdk@3.1.0";
import { getFillPortion, createRoundedRectangle, getImageCenter, getImageBounds } from "./bar-math.js";
import { BAR_KEYS, BAR_COLORS, getBar, getBarsHidden, hasAnyBar, metaKey, HIDDEN_KEY } from "./bar-data.js";

const FONT = "Roboto, sans-serif";
const BAR_HEIGHT = 18;
const BAR_GAP = 2;
const BAR_PADDING = 2;
const BAR_CORNER_RADIUS = BAR_HEIGHT / 2;
const FILL_OPACITY = 0.85;
const BACKGROUND_OPACITY = 0.7;
const DISABLE_ATTACHMENT_BEHAVIORS = ["ROTATION", "VISIBLE", "COPY", "SCALE"];
const BAR_PART_KINDS = ["bg", "fill", "text"];

const menuEmbed = { url: "/health-bars/tracker-menu.html", height: 260 };

// Feature is on hold -- flip this back to true to re-enable. Left false
// (rather than removing background_url from the manifest) so this script
// still runs once to sweep up any bar attachments a prior enabled session
// already created as local scene items -- those don't clean themselves up
// just because the script that made them stops running.
const HEALTH_BARS_ENABLED = false;

async function init() {
  if (!HEALTH_BARS_ENABLED) {
    await runCleanupWhenReady();
    return;
  }
  registerContextMenus();
  await initOnMapBars();
}

if (OBR.isReady) {
  init();
} else {
  OBR.onReady(init);
}

async function runCleanupWhenReady() {
  // Runs on every scene-ready transition (including switching scenes within
  // the same room), not just once, so a stale-bar cleanup can't be missed
  // just because a scene wasn't loaded yet when this script started.
  OBR.scene.onReadyChange(async (isReady) => {
    if (isReady) await cleanUpAllBars();
  });
  if (await OBR.scene.isReady()) await cleanUpAllBars();
}

async function cleanUpAllBars() {
  const items = await OBR.scene.items.getItems(
    (item) => (item.layer === "CHARACTER" || item.layer === "MOUNT") && item.type === "IMAGE",
  );
  const deleteIds = items.flatMap((item) => allBarPartIdsForItem(item.id));
  await OBR.scene.local.deleteItems(deleteIds);
}

function registerContextMenus() {
  const filterBase = [
    { key: "layer", value: "CHARACTER", coordinator: "||" },
    { key: "layer", value: "MOUNT" },
    { key: "type", value: "IMAGE" },
  ];

  // GM can always open the health bar editor for a token, hidden or not.
  OBR.contextMenu.create({
    id: metaKey("gm-menu"),
    icons: [
      {
        icon: "/icon.svg",
        label: "Health Bars",
        filter: { every: filterBase, roles: ["GM"], max: 1 },
      },
    ],
    embed: menuEmbed,
  });

  // Players only get the editor when the token's bars aren't hidden, and
  // only when they actually have permission to update that token.
  OBR.contextMenu.create({
    id: metaKey("player-menu"),
    icons: [
      {
        icon: "/icon.svg",
        label: "Health Bars",
        filter: {
          every: [
            ...filterBase,
            { key: ["metadata", metaKey(HIDDEN_KEY)], value: true, operator: "!=" },
          ],
          permissions: ["UPDATE"],
          roles: ["PLAYER"],
          max: 1,
        },
      },
    ],
    embed: menuEmbed,
  });
}

let currentRole = "PLAYER";

async function initOnMapBars() {
  OBR.scene.onReadyChange(async (isReady) => {
    if (isReady) await refreshAllBars();
  });

  if (await OBR.scene.isReady()) await refreshAllBars();

  OBR.player.onChange(async (player) => {
    if (player.role !== currentRole) {
      currentRole = player.role;
      await refreshAllBars();
    }
  });

  OBR.scene.items.onChange(async () => {
    await refreshAllBars();
  });
}

async function refreshAllBars() {
  currentRole = await OBR.player.getRole();
  const sceneDpi = await OBR.scene.grid.getDpi();
  const items = await OBR.scene.items.getItems(
    (item) => (item.layer === "CHARACTER" || item.layer === "MOUNT") && item.type === "IMAGE",
  );

  const addItems = [];
  const deleteIds = [];

  for (const item of items) {
    // Always clear this token's previous bar attachments first, then
    // re-add whichever bars currently apply -- simpler than diffing which
    // specific parts changed, at the cost of recreating local items on
    // every scene change. Fine for the token counts a Lancer game has.
    deleteIds.push(...allBarPartIdsForItem(item.id));

    if (!hasAnyBar(item)) continue;
    if (currentRole === "PLAYER" && getBarsHidden(item)) continue;

    const showNumbers = currentRole === "GM" || !getBarsHidden(item);
    addItems.push(...buildBarsForItem(item, sceneDpi, showNumbers));
  }

  await OBR.scene.local.deleteItems(deleteIds);
  await OBR.scene.local.addItems(addItems);
}

function allBarPartIdsForItem(itemId) {
  const ids = [];
  for (const barKey of BAR_KEYS) {
    for (const kind of BAR_PART_KINDS) {
      ids.push(getBarPartId(itemId, barKey, kind));
    }
  }
  return ids;
}

function getBarPartId(itemId, barKey, kind) {
  return `${itemId}-${barKey}-${kind}`;
}

function buildBarsForItem(item, sceneDpi, showNumbers) {
  const bounds = getImageBounds(item, sceneDpi);
  const origin = getImageCenter(item, sceneDpi);

  const activeBars = BAR_KEYS.map((barKey) => ({ barKey, bar: getBar(item, barKey) })).filter(
    ({ bar }) => bar !== null,
  );

  const parts = [];
  activeBars.forEach(({ barKey, bar }, index) => {
    const rowY = origin.y - index * (BAR_HEIGHT + BAR_GAP) + bounds.height / 2;
    parts.push(...createBarItems(item, bounds, barKey, bar, { x: origin.x, y: rowY }, showNumbers));
  });
  return parts;
}

function createBarItems(item, bounds, barKey, bar, rowOrigin, showNumber) {
  const position = {
    x: rowOrigin.x - bounds.width / 2 + BAR_PADDING,
    y: rowOrigin.y - BAR_HEIGHT,
  };
  const barWidth = bounds.width - BAR_PADDING * 2;
  const color = BAR_COLORS[barKey];

  const background = buildCurve()
    .fillColor("black")
    .fillOpacity(BACKGROUND_OPACITY)
    .strokeWidth(0)
    .position(position)
    .attachedTo(item.id)
    .layer("ATTACHMENT")
    .locked(true)
    .id(getBarPartId(item.id, barKey, "bg"))
    .visible(item.visible)
    .disableAttachmentBehavior(DISABLE_ATTACHMENT_BEHAVIORS)
    .disableHit(true)
    .tension(0)
    .closed(true)
    .points(createRoundedRectangle(barWidth, BAR_HEIGHT, BAR_CORNER_RADIUS))
    .build();

  const fillPortion = getFillPortion(bar.value, bar.max);
  const fill = buildCurve()
    .fillColor(color)
    .fillOpacity(FILL_OPACITY)
    .strokeWidth(0)
    .strokeOpacity(0)
    .position(position)
    .attachedTo(item.id)
    .layer("ATTACHMENT")
    .locked(true)
    .id(getBarPartId(item.id, barKey, "fill"))
    .visible(item.visible)
    .disableAttachmentBehavior(DISABLE_ATTACHMENT_BEHAVIORS)
    .disableHit(true)
    .tension(0)
    .closed(true)
    .points(createRoundedRectangle(barWidth, BAR_HEIGHT, BAR_CORNER_RADIUS, fillPortion))
    .build();

  const parts = [background, fill];

  if (showNumber) {
    const text = buildText()
      .position({ x: position.x, y: position.y - 5 })
      .plainText(`${bar.value}/${bar.max}`)
      .textAlign("CENTER")
      .textAlignVertical("MIDDLE")
      .fontSize(BAR_HEIGHT)
      .fontFamily(FONT)
      .textType("PLAIN")
      .height(BAR_HEIGHT + 8)
      .width(barWidth)
      .fontWeight(600)
      .attachedTo(item.id)
      .fillOpacity(1)
      .layer("TEXT")
      .locked(true)
      .id(getBarPartId(item.id, barKey, "text"))
      .visible(item.visible)
      .disableAttachmentBehavior(DISABLE_ATTACHMENT_BEHAVIORS)
      .disableHit(true)
      .build();
    parts.push(text);
  }

  return parts;
}
