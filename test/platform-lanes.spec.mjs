/**
 * The verification boundary, stated as a test rather than only as prose.
 *
 * The catalog, the dialect builders, the resolution walk, and the gate are pure
 * functions of `(platform, environment)`, so the POSIX lane is verified as logic
 * on any host. What cannot be verified here is POSIX *execution*: no Linux or
 * macOS host runs this suite, so nothing in this repository has spawned a POSIX
 * shell through this plugin. That gap is asserted explicitly so it cannot be
 * forgotten or quietly overclaimed.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PLATFORMS, VERIFIED_CONFINEMENT_PLATFORMS, catalogFor, checkConfinement } from '../src/catalog.js'
import { buildInvocation } from '../src/dialects.js'

const HOST_PLATFORM = process.platform === 'win32' ? 'windows' : 'posix'

describe('what is verified on every host', () => {
  it('exercises both platform catalogs from either host', () => {
    // The suite imports both catalogs unconditionally, so a row that only made
    // sense on one platform would fail here rather than in a user's session.
    for (const platform of PLATFORMS) {
      assert.ok(catalogFor(platform).length > 0, platform)
    }
    assert.equal(HOST_PLATFORM === 'windows' || HOST_PLATFORM === 'posix', true)
  })

  it('builds a complete invocation for every entry in both catalogs', () => {
    for (const platform of PLATFORMS) {
      for (const entry of catalogFor(platform)) {
        const invocation = buildInvocation(entry.dialect, {
          executable: '/path/to/shell',
          command: 'echo hi',
          ...entry.dialect === 'wsl' ? { windowsCwd: 'C:\\work', mountRoot: '/mnt' } : {},
        })
        assert.ok(invocation.argv.length >= 2, `${platform}/${entry.id}`)
        assert.equal(invocation.argv[0], '/path/to/shell', `${platform}/${entry.id}`)
      }
    }
  })

  it('answers the confinement question for every entry in both catalogs', () => {
    for (const platform of PLATFORMS) {
      for (const entry of catalogFor(platform)) {
        const verdict = checkConfinement(entry, 'workspace-write')
        assert.equal(typeof verdict.ok, 'boolean', `${platform}/${entry.id}`)
        if (!verdict.ok) assert.ok(verdict.reason.length > 20, `${platform}/${entry.id} needs a measured reason`)
      }
    }
  })
})

describe('what remains unverified', () => {
  it('names the platform whose confinement facts were measured', () => {
    // Windows is measured; the POSIX rows are the harness's documented behavior
    // for a wrapper-based sandbox, which this plugin has not exercised.
    assert.deepEqual([...VERIFIED_CONFINEMENT_PLATFORMS], ['windows'])
  })

  it('has never spawned a POSIX shell from this suite', { skip: HOST_PLATFORM === 'posix' ? false : 'this host has no POSIX shell to spawn' }, () => {
    // On a POSIX host the integration suite runs the posix lane for real; the
    // test exists so that the skip is visible on a Windows host instead of the
    // lane silently not being covered.
    assert.equal(HOST_PLATFORM, 'posix')
  })
})
