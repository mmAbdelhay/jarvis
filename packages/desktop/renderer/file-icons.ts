// Material file icons (material-icon-theme, MIT) for every list of files:
// which picture a file or folder name gets, and the <img> that shows it.
// The theme and its pictures are vendored under vendor/material-icons and
// loaded from 'self'; nothing here reads a network or runs anything from them.
//
// Lookup order for a file: its whole name, then its longest compound
// extension (foo.test.ts before .ts), then the language of the extension, then
// the generic file. Every lookup is an own-property lookup, so a file called
// "constructor" or "__proto__" is a plain file.
import table from "./vendor/material-icons/table.mjs";

const DIRECTORY = "vendor/material-icons/icons/";

/** Extensions the theme does not list itself, by the language whose icon it has
 *  (VS Code resolves these by language id). */
export const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  pyi: "python",
  pyw: "python",
  pyx: "python",
  ipynb: "jupyter",
  fish: "shellscript",
  ksh: "shellscript",
  bats: "shellscript",
  command: "shellscript",
  psm1: "powershell",
  psd1: "powershell",
  mk: "makefile",
  mak: "makefile",
  rake: "ruby",
  gemspec: "ruby",
  cshtml: "razor",
  mm: "objective-cpp",
  hh: "cpp",
  hxx: "cpp",
  cxx: "cpp",
  tex: "latex",
  sty: "latex",
  bib: "bibtex",
  jsonl: "jsonl",
  tsv: "tsv",
  patch: "diff",
  gql: "graphql",
  htm: "html",
  yml: "yaml",
  adoc: "markdown",
  markdown: "markdown",
  txt: "plaintext",
};

const own = (map: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

export function fileIconFor(name: string, options: { parent?: string } = {}): string {
  const lower = name.toLowerCase();
  if (lower === "" || lower.endsWith(".")) return table.file;
  if (options.parent !== undefined) {
    const keyed = own(table.fileNames, `${options.parent.toLowerCase()}/${lower}`);
    if (keyed !== undefined) return keyed;
  }
  const whole = own(table.fileNames, lower);
  if (whole !== undefined) return whole;
  // Each dot starts a candidate extension; the longest is tried first.
  for (let at = lower.indexOf("."); at !== -1; at = lower.indexOf(".", at + 1)) {
    const hit = own(table.fileExtensions, lower.slice(at + 1));
    if (hit !== undefined) return hit;
  }
  const last = lower.slice(lower.lastIndexOf(".") + 1);
  const language = lower.includes(".") ? own(EXTENSION_LANGUAGES, last) : undefined;
  const byLanguage = language === undefined ? undefined : own(table.languageIds, language);
  return byLanguage ?? table.file;
}

export function folderIconFor(
  name: string,
  expanded: boolean,
  options: { parent?: string } = {},
): string {
  const lower = name.toLowerCase();
  const map = expanded ? table.folderNamesExpanded : table.folderNames;
  const generic = expanded ? table.folderExpanded : table.folder;
  if (lower === "") return generic;
  if (options.parent !== undefined) {
    const keyed = own(map, `${options.parent.toLowerCase()}/${lower}`);
    if (keyed !== undefined) return keyed;
  }
  return own(map, lower) ?? generic;
}

function image(file: string, generic: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "file-icon";
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.draggable = false;
  img.loading = "lazy";
  img.decoding = "async";
  img.width = 16;
  img.height = 16;
  img.src = `${DIRECTORY}${file}`;
  img.dataset["generic"] = generic;
  // A missing picture falls back to the generic one, once; if that fails too
  // the slot is left empty rather than showing a broken image.
  img.addEventListener("error", () => {
    const fallback = `${DIRECTORY}${img.dataset["generic"] ?? generic}`;
    if (img.getAttribute("src") === fallback) {
      img.hidden = true;
      return;
    }
    img.src = fallback;
  });
  return img;
}

export function fileIcon(name: string, options: { parent?: string } = {}): HTMLImageElement {
  return image(fileIconFor(name, options), table.file);
}

export function folderIcon(
  name: string,
  options: { expanded?: boolean; parent?: string } = {},
): HTMLImageElement {
  const expanded = options.expanded === true;
  return image(
    folderIconFor(name, expanded, options.parent === undefined ? {} : { parent: options.parent }),
    expanded ? table.folderExpanded : table.folder,
  );
}

/** Points a folder's image at its open or closed picture. */
export function setFolderIcon(
  img: HTMLImageElement,
  name: string,
  expanded: boolean,
  options: { parent?: string } = {},
): void {
  img.hidden = false;
  img.dataset["generic"] = expanded ? table.folderExpanded : table.folder;
  img.src = `${DIRECTORY}${folderIconFor(name, expanded, options)}`;
}

/** Points a file's image at the picture for a (new) name. */
export function setFileIcon(
  img: HTMLImageElement,
  name: string,
  options: { parent?: string } = {},
): void {
  img.hidden = false;
  img.dataset["generic"] = table.file;
  img.src = `${DIRECTORY}${fileIconFor(name, options)}`;
}
