/**
 * The fixture rule, asserted rather than assumed.
 *
 * Two properties this suite exists for: no fixture may be created under the real
 * user profile, and the working directory a case hands a simulated platform must
 * be shaped for *that* platform rather than for this host. Both are rules a
 * future edit could quietly break, and both are what a reviewer's machine
 * outside this author's platform depends on.
 */

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { localPlatform } from '../src/catalog.js'
import {
  TEST_TMP_ENV,
  assertApprovedFixtureRoot,
  canonicalize,
  makeFixture,
  projectRoot,
  profileRoots,
  removeFixture,
  testTmpRoot,
  workdirFor,
} from './helpers.mjs'

const HOST = localPlatform()

/** Run a body with the approved-root variable set, restoring it afterwards. */
function withTestTmpRoot(value, body) {
  const previous = process.env[TEST_TMP_ENV]
  process.env[TEST_TMP_ENV] = value
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env[TEST_TMP_ENV]
    else process.env[TEST_TMP_ENV] = previous
  }
}

describe('fixtures stay out of the user profile', () => {
  it('knows the profile roots as canonical paths', () => {
    const roots = profileRoots()
    assert.ok(roots.length > 0, 'this machine has a profile')
    for (const root of roots) {
      assert.equal(root, canonicalize(root), 'a profile root must be canonical, or a symlink defeats the check')
      assert.ok(root.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(root), root)
    }
  })

  it('refuses a fixture root inside the profile', () => {
    for (const inside of [homedir(), join(homedir(), 'dsh-shell-select'), join(homedir(), '.dsh', 'profiles', 'web')]) {
      assert.throws(
        () => assertApprovedFixtureRoot(inside),
        /refusing to create fixtures in the user profile/u,
        `${inside} must be refused`,
      )
    }
  })

  it('refuses a profile root named through the environment too', () => {
    // The rule is about the location, not about who asked for it: a reviewer who
    // points the variable at their checkout gets the same refusal.
    assert.throws(
      () => withTestTmpRoot(join(homedir(), 'somewhere'), () => testTmpRoot()),
      /refusing to create fixtures in the user profile/u,
    )
  })

  it('refuses a root that is not an absolute path', () => {
    assert.throws(
      () => withTestTmpRoot('relative/place', () => testTmpRoot()),
      /must be an absolute path/u,
    )
  })

  it('uses an approved root outside the profile when one is named', () => {
    // Approved here means this project's own scratch directory: inside the
    // workspace, outside the profile. The point is that the variable is honored
    // and the result is validated, not that a test scribbles elsewhere.
    const approved = join(projectRoot(), '.test-tmp', 'approved-root')
    const root = withTestTmpRoot(approved, () => testTmpRoot())
    assert.equal(root, approved)
    rmSync(approved, { recursive: true, force: true })
  })

  it('creates and removes a fixture inside the root it validated', () => {
    const fixture = makeFixture('guard')
    try {
      assert.ok(fixture.startsWith(canonicalize(testTmpRoot())), 'the fixture is inside the approved root')
      assert.ok(existsSync(fixture))
    } finally {
      removeFixture(fixture)
    }
    assert.equal(existsSync(fixture), false, 'removal is exact')
  })

  it('refuses to remove anything outside the approved root', () => {
    assert.throws(() => removeFixture(homedir()), /refusing to remove/u)
    assert.throws(() => removeFixture(join(homedir(), 'Documents')), /refusing to remove/u)
  })
})

describe('a simulated platform gets a path shaped for it', () => {
  const hostWorkdir = join(projectRoot(), 'fixtures-are-real')

  it('hands this host its own real directory', () => {
    assert.equal(workdirFor(HOST, hostWorkdir), hostWorkdir)
  })

  it('hands the other platform a path that platform can accept', () => {
    const foreign = HOST === 'windows' ? 'posix' : 'windows'
    const shaped = workdirFor(foreign, hostWorkdir)
    assert.notEqual(shaped, hostWorkdir)
    // The shape rule each platform applies, on the value the other platform gets.
    if (foreign === 'windows') assert.match(shaped, /^[A-Za-z]:\\/u)
    else assert.ok(shaped.startsWith('/'))
  })
})

after(() => {
  // Nothing outside the approved root is ever created by these cases; this is a
  // last check that the suite left no trace where it must not.
  assert.equal(existsSync(join(homedir(), '.test-tmp')), false, 'no fixture root may appear in the profile')
})
