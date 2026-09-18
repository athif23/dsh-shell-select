/**
 * The published documents' links and anchors.
 *
 * `README.md` ships in the npm package and links the two documents beside it, so
 * a renamed heading or a moved file is a dead link for anyone reading the package
 * or the repository. This suite resolves each relative link against the file that
 * carries it, and matches each fragment against the target's heading slugs the
 * way GitHub computes them.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { projectRoot } from './helpers.mjs'

/** Documents a reader is expected to be able to navigate. */
const DOCUMENTS = ['README.md', 'docs/architecture.md', 'docs/testing.md']

/**
 * The GitHub heading slug for one heading line.
 * @param heading - the heading text, without its marks.
 * @returns the fragment GitHub generates for it.
 */
function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\w\s-]/gu, '').replace(/\s+/gu, '-')
}

/** Every heading slug in one document. */
function slugs(text) {
  return new Set(text.split('\n')
    .filter(line => line.startsWith('#'))
    .map(line => slug(line.replace(/^#+\s*/u, ''))))
}

describe('the documents a reader navigates', () => {
  for (const document of DOCUMENTS) {
    it(`resolves every link in ${document}`, () => {
      const text = readFileSync(join(projectRoot(), document), 'utf8')
      const links = [...text.matchAll(/\]\(([^)\s]+)\)/gu)].map(match => match[1])
      assert.ok(links.length > 0, `${document} links nothing`)
      for (const link of links) {
        // External targets are the reader's browser's problem, not this suite's.
        if (/^[a-z]+:/iu.test(link)) continue
        const [path, fragment] = link.split('#')
        const target = path.length === 0 ? join(projectRoot(), document) : resolve(projectRoot(), dirname(document), path)
        const relative = target.slice(projectRoot().length + 1).replace(/\\/gu, '/')
        assert.ok(existsSync(target), `${document} links a missing path: ${link}`)
        assert.ok(statSync(target).isFile(), `${document} links a directory: ${link}`)
        if (fragment !== undefined) {
          assert.ok(
            slugs(readFileSync(target, 'utf8')).has(fragment),
            `${document} links "#${fragment}", which ${relative} does not define`,
          )
        }
      }
    })
  }
})
