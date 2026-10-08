# Recipes

Reviewed multi-step setups ("Set up this machine for Python and Docker"),
M4 contracts §4. jarvisd shows a recipe as one card with every step as its
own item; unticked steps are skipped, steps run in order and stop at the
first failure. Shipped by `jarvis-recipes` to `/usr/share/jarvis/recipes/`.

Format: `{id, title: {en, ar}, description: {en, ar}, steps: [{tool, input,
title: {en, ar}}], requires: {os: "rafiq", minRamGB?}}`; the file is
`<id>.json`.

Rules (enforced by `tools/recipes.py validate`, run by the package build and CI):

- Steps may only call `pkg.install`, `svc.restart` (system allowlist) and `apps.set_default`,
  plus the non-executing `note` step `{text: {en, ar}}` (shown on the card, always after
  the executing steps; contracts §6 #2). `jarvis-workspace` is `available: false` (§6 #15). Widening
  `RECIPE_TOOLS` is a security change: it needs owner review and the same change
  in jarvisd's runtime check.
- No `jarvis-*` package except `jarvis-workspace`.
- Every title and description in natural English and Modern Standard Arabic.

`tools/check_sources.py` (CI, inside Debian trixie) checks every package exists.
Tests: `python3 -m unittest discover -s os/recipes/tests -v`.
