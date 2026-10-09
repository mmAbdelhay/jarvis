import type { Card, CardItem, CardSource } from "@jarvis/wire";

export function cardItem(
  itemId: string,
  title: string,
  source: CardSource = "debian",
  secretFields: { name: string; label: string }[] = [],
  detail = "",
): CardItem {
  return {
    itemId,
    tool: secretFields.length > 0 ? "net.wifi_connect" : "pkg.install",
    title,
    detail,
    source,
    risk: "confirm",
    secretFields,
  };
}

export function makeCard(
  cardId: string,
  turnId: string | null,
  items: CardItem[] = [cardItem("i1", "Install GIMP", "flathub")],
): Card {
  return { cardId, turnId, expiresAt: Date.now() + 300_000, items };
}
