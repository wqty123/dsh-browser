// Exits 1 immediately with no output on purpose: this is exactly what Electron
// does when it cannot load the app entry script, and reproducing it here is what
// lets the host log be asserted against that signature without a real Electron
// binary or a display.
process.exit(1)
