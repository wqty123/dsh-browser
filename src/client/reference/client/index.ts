/**
 * Client entry of the browser-reference plugin.
 *
 * The loader needs exactly `apply` and `inject`; everything else stays internal
 * and is reached by same-package tests through relative imports.
 */
export { apply, inject } from "./plugin.ts";
