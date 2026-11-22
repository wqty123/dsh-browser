/** Keep package-manager children in plain-filesystem mode, including after this bundle is unloaded. */
export function enableElectronPackageRemoval(environment: NodeJS.ProcessEnv = process.env, electron = process.versions.electron): void {
  if (electron !== undefined && environment.ELECTRON_RUN_AS_NODE === '1') environment.ELECTRON_NO_ASAR = '1'
}
