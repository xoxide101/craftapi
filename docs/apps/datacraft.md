# datacraft

Browser database maker: tables, TXT/CSV import, invoices/sheets, MySQL `.sql` export, PHP site generator. Source: reviewer reading of GitHub `xoxide101/datacraft`; not run (sql.js from `file://` unverified).

## What exists (reported)

- `app/js/`: `db.js` (sql.js SQLite), `dataio.js` (parse, type inference), `mysql.js`, `php.js`, `pages.js`, `store.js`, `main.js`, `tables.js`. Scripts at `app/index.html:22-37`.
- Globals: `window.DC`; UI state `DC.state`; project `DC.project = {name, db, settings, schema, dirty}` (`db.js:34-40`).
- Data is in-memory SQLite. Metadata tables `_dc_tables`, `_dc_fields`, `_dc_lists`, `_dc_list_items`, `_dc_pages` (`db.js:10-17`). Serialisable via `db.export()` bytes, **not** plain JSON.
- Mutations already centralised in `DC.db` (`db.js:313-318`); query `rows()` (`db.js:217-239`).
- Pure-ish: `parse`, `detect`, `guessType`, `convert` (`dataio.js:7-111`); `buildMysql` (`mysql.js:67-181`); `buildSite` returns `{files, sql}` (`php.js:69-104`).
- Persistence: IndexedDB or File System Access API (`store.js:5-58`). No undo.

## Changes needed (priority)

1. **S** `DC.craftapi`: `describe`, `state` (schema + records JSON), `summary`, versioned.
2. **S** `snapshot/restore` via `db.export()` and open-from-bytes; keep name/settings; mind async sql.js.
3. **M** `apply(ops[])` dispatching `DC.db` mutations inside a SQL transaction (`BEGIN`/`ROLLBACK`). Easiest app to make atomic.
4. **S** Expose pure `exportSql`, `buildPhp`, import parsing returning strings/bytes.
5. **M** `diff`, deterministic summaries, scoring hooks.
6. **M** Headless init skipping storage/folder dialogs and pickers.
7. **L** Real undo only if rollback is insufficient.

## Headless blockers

Folder-mode storage UI, file pickers (`main.js:137-157`, `dataio.js:168-185`), downloads and FS writes (`store.js:105-115`), sql.js asset loading (`lib/sql-asm.js` suggests an asm build, avoiding WASM: verify).

## Score candidates (strong external checks)

- Generated `.sql` imports into real MySQL/MariaDB or a SQL parser; schema and data round-trip.
- Generated PHP passes `php -l`.
- Type-inference accuracy on labelled CSV.
- No data loss on import, export, re-import.
- Link and formula validity.

## Issues

- `buildMysql` embeds current time (~`mysql.js:86`): identical states export differently. Allow a fixed clock.
- Date values written as `'${v}'` (`mysql.js:61-62`) bypass `myStr`. **Checked: not exploitable**, guarded by `/^\d{4}-\d{2}-\d{2}$/`. Style only.
- Reviewer saw `htmlspecialchars` (`php.js:284`) and PDO prepared statements (`php.js:701-746`); no obvious injection in paths read. Not exhaustive.
