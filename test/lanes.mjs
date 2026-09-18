/**
 * Which shells a platform's execution lane must cover, and which it may skip.
 *
 * The distinction matters for what the suite is allowed to claim. A *required*
 * shell is one every host of that platform has, so its absence is a failure of
 * the lane rather than a fact about the machine: a required case never skips,
 * which is what stops "the POSIX lane is covered by CI" from being true only in
 * prose. An *optional* shell may be missing on a real host, so its case skips
 * with the reason printed.
 *
 * This table is the single home for those sets: the integration suite runs them
 * and `platform-lanes.spec.mjs` asserts that they name real catalog entries, so
 * a rename cannot silently empty a lane.
 *
 * @module dsh-shell-select/test/lanes
 */

import { findEntry } from '../src/catalog.js'

/**
 * The required and optional shells of one platform's execution lane.
 *
 * `driver` names the shell the platform's shared behavior cases use — the
 * confinable one with a scriptable sleep, so timeout, cancellation, and
 * background cases can be asserted on both platforms without a branch.
 */
export const LANES = Object.freeze({
  windows: Object.freeze({
    required: Object.freeze(['powershell', 'cmd']),
    optional: Object.freeze(['pwsh', 'gitbash', 'wsl']),
    driver: 'powershell',
    command: 'cmd',
  }),
  posix: Object.freeze({
    // Every supported POSIX host has bash, and it is the shell the harness's own
    // executor runs, so it is the lane's baseline.
    required: Object.freeze(['bash']),
    // `sh` is here rather than appended by the suite: it is a POSIX row, so a
    // Windows host has no such shell to skip for.
    optional: Object.freeze(['zsh', 'fish', 'sh', 'pwsh']),
    driver: 'bash',
    command: 'bash',
  }),
})

/**
 * The lane for one platform.
 * @param platform - `'windows'` or `'posix'`.
 * @returns the lane definition.
 * @throws {Error} for a platform no lane describes.
 */
export function laneFor(platform) {
  const lane = LANES[platform]
  if (lane === undefined) throw new Error(`dsh-shell-select tests: no lane for platform ${JSON.stringify(platform)}`)
  return lane
}

/**
 * Whether a lane's shells all name catalog entries on that platform.
 * @param platform - `'windows'` or `'posix'`.
 * @returns the ids that name nothing, in lane order.
 */
export function unknownLaneShells(platform) {
  const lane = laneFor(platform)
  return [...lane.required, ...lane.optional, lane.driver, lane.command]
    .filter(id => findEntry(platform, id) === undefined)
}
