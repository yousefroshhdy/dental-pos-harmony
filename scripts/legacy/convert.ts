/**
 * The converter lives in src/modules/imports/legacy/convert.ts, shared by this CLI and the browser
 * import on /admin/setup/legacy-import. Re-exported here so `pnpm legacy:convert` and older
 * references keep working.
 */
export * from "../../src/modules/imports/legacy/convert";
