import type { Language } from "../lib/i18n";
import type { AnchoredComment, PlanDoc } from "./types";

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export type PlanPageColors = {
  surface: string;
  ground: string;
  text: string;
  textSecondary: string;
  accent: string;
  warning: string;
  selected: string;
};

export function buildPlanPage(
  doc: PlanDoc,
  comments: AnchoredComment[],
  lang: Language,
  colors: PlanPageColors,
): string {
  const anchored = comments.filter(
    (comment): comment is AnchoredComment & { anchor: { kind: "block"; blockId: string } } =>
      comment.anchor.kind === "block",
  );
  const pins = new Map<string, number[]>();
  for (const comment of anchored) {
    const numbers = pins.get(comment.anchor.blockId) ?? [];
    numbers.push(comment.number);
    pins.set(comment.anchor.blockId, numbers);
  }
  const blocks = doc.blocks
    .map((block) => {
      const blockPins = pins.get(block.id) ?? [];
      return `<section class="row"><aside class="gutter">${blockPins
        .map((number) => `<span class="pin">${number}</span>`)
        .join(
          "",
        )}</aside><div class="block" data-block-id="${attribute(block.id)}">${block.html}</div></section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>*{box-sizing:border-box}html,body{margin:0;background:${colors.surface};color:${colors.text};font-family:system-ui,sans-serif;font-size:16px;line-height:1.55}main{padding:12px 12px 36px}.row{display:flex;align-items:flex-start;min-height:44px}.gutter{width:36px;min-width:36px;display:flex;flex-direction:column;align-items:center;padding-top:5px}.pin{width:25px;height:25px;border-radius:13px;background:${colors.warning};color:${colors.ground};font-weight:700;margin-bottom:3px;text-align:center;line-height:25px}.block{flex:1;min-width:0;padding:7px 4px;border-radius:8px}.block:active{background:${colors.selected}}.block>*:first-child{margin-top:0}.block>*:last-child{margin-bottom:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:${colors.ground};padding:10px;border-radius:8px}code{font-family:monospace;color:${colors.textSecondary}}a{color:${colors.accent}}</style></head>
<body><main>${blocks}</main><script>document.querySelectorAll(".block").forEach(block=>block.addEventListener("click",event=>{if(event.target.closest("a"))return;window.ReactNativeWebView.postMessage(JSON.stringify({type:"block",id:block.dataset.blockId}))}));</script></body></html>`;
}
