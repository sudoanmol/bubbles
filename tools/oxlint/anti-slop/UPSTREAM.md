# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13), copied from `src/` with the bundled skill's `install.mjs`.

This copy is ours: edit the rules to fit the project. Keep `vendor/eslint-stylistic/LICENSE` and its `UPSTREAM.md` with the code.

## What is installed

- `index.ts` and `rules/`: the generic plugin, registered in `.oxlintrc.json` as `anti-slop` with every rule at `error`, plus `oxc/no-accumulating-spread`.
- `effect/`: the Effect plugin, copied but not registered, since nothing here depends on Effect directly.
- `shared/` and `vendor/eslint-stylistic/`: helpers and the spacing engine the rules import.
- Dev dependencies at the root: `oxlint` and `@oxlint/plugins`, both pinned to `1.89.0`.

## Local deviations

- Upstream's `*.test.ts` files are left out (the installer skips them). Only the rules ship here.
- `.oxlintrc.json` and `.oxfmtrc.json` ignore this directory. The lint ignores also cover agent tool directories, `.factory/**` included.

The files match upstream `src/` at that commit, apart from the tests. To update, stage the new upstream revision separately, diff it against this commit, and port the changes, then update this file.
