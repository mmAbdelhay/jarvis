import type { Language } from "../lib/i18n";
import type { AnchoredComment, PlanDoc } from "./types";

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export type PlanPageColors = {
  surface: string;
  surfaceAlt: string;
  ground: string;
  text: string;
  textSecondary: string;
  accent: string;
  warning: string;
  selected: string;
  accentBorder: string;
  success: string;
  onSuccess: string;
  checkboxOff: string;
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
<style>*{box-sizing:border-box}html,body{margin:0;background:${colors.ground};color:${colors.text};font-family:Manrope,system-ui,sans-serif;font-size:14px;line-height:21px}main{padding:12px 12px 36px}h1,h2,h3{font-size:18px;font-weight:800;line-height:1.3}.row{display:flex;align-items:flex-start;min-height:44px}.gutter{width:36px;min-width:36px;display:flex;flex-direction:column;align-items:center;padding-top:5px}.pin{width:25px;height:25px;border-radius:13px;background:${colors.warning};color:${colors.ground};font-weight:700;margin-bottom:3px;text-align:center;line-height:25px}.block{flex:1;min-width:0;padding:7px 4px;border-radius:8px}.block:active{background:${colors.selected}}.block>*:first-child{margin-top:0}.block>*:last-child{margin-bottom:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:${colors.surface};padding:10px;border-radius:8px}code{font-family:monospace;color:${colors.textSecondary}}a{color:${colors.accent}}li:has(input[type=checkbox]){list-style:none;margin-inline-start:-1.2em;padding:4px 6px;border-radius:12px}input[type=checkbox]{-webkit-appearance:none;appearance:none;position:relative;width:20px;height:20px;margin:0;margin-inline-end:10px;vertical-align:-5px;border-radius:6px;border:2px solid ${colors.checkboxOff};background:transparent}input[type=checkbox]:checked{background:${colors.success};border-color:${colors.success}}input[type=checkbox]:checked::after{content:"";position:absolute;left:50%;top:45%;width:5px;height:10px;border:solid ${colors.onSuccess};border-width:0 2.5px 2.5px 0;transform:translate(-50%,-55%) rotate(45deg)}li:has(input[type=checkbox]:checked){color:${colors.textSecondary};opacity:.65;text-decoration:line-through}li.now{background:${colors.surfaceAlt};border:1px solid ${colors.accentBorder};padding:8px 10px;font-weight:700}li.now input[type=checkbox]{border-color:${colors.accent}}</style></head>
<body><main>${blocks}</main><script>const now=document.querySelector("li:has(input[type=checkbox]:not(:checked))");if(now)now.classList.add("now");document.addEventListener("click",event=>{const link=event.target.closest("a[href]");if(!link)return;event.preventDefault();window.ReactNativeWebView.postMessage(JSON.stringify({type:"link",href:link.getAttribute("href")}))},true);document.querySelectorAll(".block").forEach(block=>block.addEventListener("click",event=>{if(event.target.closest("a"))return;window.ReactNativeWebView.postMessage(JSON.stringify({type:"block",id:block.dataset.blockId}))}));</script></body></html>`;
}

export type PlanPageMessage = { kind: "block"; id: string } | { kind: "link"; url: string };

/** Final fix wave I5: the only two messages the plan page sends. A link is
 *  accepted only when it is an absolute http(s) URL — anything else
 *  (`jarvis:`, `javascript:`, `data:`, a relative path) is dropped, never
 *  handed to `Linking`. Malformed data is ignored. */
export function parsePlanPageMessage(data: string): PlanPageMessage | undefined {
  let message: { type?: unknown; id?: unknown; href?: unknown };
  try {
    message = JSON.parse(data) as typeof message;
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null) return undefined;
  if (message.type === "block" && typeof message.id === "string") {
    return { kind: "block", id: message.id };
  }
  if (message.type === "link" && typeof message.href === "string") {
    let url: URL;
    try {
      url = new URL(message.href);
    } catch {
      return undefined;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // Bug fix: hand back the parsed `url.href`, not the raw `message.href`
    // string that was only validated in shape -- otherwise onMessage's
    // Linking.openURL acts on text nobody actually parsed, defeating the
    // point of validating it here at all.
    return { kind: "link", url: url.href };
  }
  return undefined;
}
