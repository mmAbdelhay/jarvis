# Model catalog

`catalog.json` is the list of local models the installer and first-run flow
offer (shipped by `jarvis-models-catalog` at
`/usr/share/jarvis/models/catalog.json`, fetched through Ollama).

## Format (contracts section 4)

`{ "version": number, "models": CatalogModel[] }` with

| Field | Meaning |
|---|---|
| `id` | Stable catalog id |
| `ollamaTag` | Registry tag in the form `name:version` |
| `displayName` | Shown in the UI |
| `sizeBytes` | Download size: sum of config + layers of the registry manifest |
| `minRamGB` | RAM needed to run it |
| `minVramGB` | VRAM needed, or `null` for CPU-capable models |
| `tier` | `small`, `medium`, `large` or `gpu` |
| `toolCalling` | Always `"verified"`: only models that pass the probe are listed |
| `languages` | Languages it handles well |
| `recommendedFor` | One-line guidance |
| `role` | `main` (offered to the user) or `backup` (exactly one: the small built-in model jarvisd falls back to, M4 contracts §1; shipped by `jarvis-backup-model`) |
| `vision` | `true` only with passing tool-calling and vision probe evidence at the model’s context size in `vision-candidates.json` (`os-models.yml`, input `vision`); at most one entry, always a main model (v1.1 contracts §4.12). Computer use requires it; without passing evidence, v1.1 computer use is cloud-only. |

## Adding a model

1. Add the entry to `catalog.json` (`sizeBytes` may be a placeholder).
2. `python3 os/models/tools/check_registry.py --fix` rewrites `sizeBytes` from
   the registry; without `--fix` it only reports differences.
3. `gh workflow run os-models.yml` runs the tool-call probe
   (`os/models/probe/catalog-probe.test.ts`) for every model.
4. Keep only models whose probe passes.

Unit tests: `python3 -m unittest discover -s os/models/tests -v` and
`python3 -m unittest discover -s os/models/tools/tests -v`.

## Tiers and runners

Tiers group models by hardware: `small` and `medium` run on CPU/modest RAM,
`large` needs plenty of RAM, `gpu` needs VRAM (`minVramGB`). The workflow
`os-models.yml` runs weekly, on manual dispatch and on pull requests touching
`os/models/**`. Models over 12 GiB do not fit a hosted runner: they are probed
only when you dispatch with the input `large_runner` set to the label of a big
runner; otherwise the job emits a warning and skips them
(`tools/matrix.py`).
