/**
 * The verification boundary, stated as a test rather than only as prose.
 *
 * The catalog, the dialect builders, the resolution walk, and the decision are
 * pure functions of `(platform, environment)`, so both platforms' logic is
 * verified on any host. What differs is *execution*: `integration.spec.mjs`
 * writes both lanes and each one runs on its own platform, so this file asserts
 * that the lanes still name real catalog entries and that a required shell
 * cannot quietly become optional.
 *
 * It deliberately makes no claim about which lanes have run. That is what the
 * integration results say, and the README repeats them.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PLATFORMS, VERIFIED_CONFINEMENT_PLATFORMS, catalogFor, checkConfinement } from '../src/catalog.js'
import { buildInvocation } from '../src/dialects.js'
import { LANES, laneFor, unknownLaneShells } from './lanes.mjs'

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

describe('the execution lanes name real shells', () => {
  for (const platform of PLATFORMS) {
    it(`${platform} declares a lane this catalog can satisfy`, () => {
      const lane = laneFor(platform)
      // A rename that emptied a lane would make its cases skip, or worse, pass
      // vacuously; this is the assertion that stops that.
      assert.deepEqual(unknownLaneShells(platform), [], `${platform} lane names a shell the catalog does not have`)
      assert.ok(lane.required.length > 0, `${platform} needs a required baseline`)
      assert.ok(lane.required.includes(lane.driver) || lane.required.includes(lane.command),
        `${platform} must derive its shared cases from a required shell`)
    })

    it(`${platform} keeps every required shell out of the optional set`, () => {
      const lane = laneFor(platform)
      for (const id of lane.required) assert.ok(!lane.optional.includes(id), `${platform}/${id}`)
    })
  }

  it('takes the host lane from the host platform', () => {
    assert.equal(laneFor(HOST_PLATFORM).required.length > 0, true)
    assert.equal(Object.keys(LANES).includes(HOST_PLATFORM), true)
  })

  it('requires the shell each platform ships with', () => {
    // The baseline a lane may not skip: Windows always has cmd.exe and Windows
    // PowerShell 5.1; a POSIX host always has bash.
    assert.deepEqual([...LANES.windows.required].sort(), ['cmd', 'powershell'])
    assert.deepEqual([...LANES.posix.required], ['bash'])
  })
})

describe('what remains unverified', () => {
  it('names the platform whose confinement facts were measured', () => {
    // Windows is measured; the POSIX rows are the harness's documented behavior
    // for a wrapper-based sandbox, which this plugin has not exercised.
    assert.deepEqual([...VERIFIED_CONFINEMENT_PLATFORMS], ['windows'])
  })

  it('reports the POSIX backend as unmeasured rather than as measured-safe', () => {
    // The catalog marks POSIX entries confineable because the harness's POSIX
    // backends wrap argv and are indifferent to the shell inside. That is a
    // claim about the harness, and the status payload says so.
    for (const entry of catalogFor('posix')) {
      assert.equal(checkConfinement(entry, 'workspace-write').ok, true, entry.id)
    }
    assert.ok(!VERIFIED_CONFINEMENT_PLATFORMS.includes('posix'))
  })
})
