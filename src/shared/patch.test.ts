// The parser the changes panel reads a patch through.
//
// Every fixture below is real `git diff` output, pasted rather than written: a
// hand-made patch is a patch that agrees with the parser, and the shapes that
// break diff renderers are exactly the ones nobody writes by hand — the rename
// that carries no hunks, the binary file that carries no content, the file that
// ends without a newline and says so in a line of its own, and `---`/`+++`,
// which begin with the same characters as a removal and an addition and are
// neither.
//
// The line numbers are the point of the whole exercise. "It broke around line
// 212" is what a review sounds like, and a number that is off by one because a
// removal advanced the wrong side is worse than no number at all.

import { describe, expect, it } from 'vitest'
import { parsePatch } from './patch'

// One `git diff --cached` over four files: an edit with context on both sides
// of it, a rename with no content change, a binary file, and a file with no
// newline at the end. Note the `\` line, which is a remark about the line above
// rather than a line of the file.
const FOUR_FILES = `diff --git a/blob.bin b/blob.bin
index c94be36..7447b84 100644
Binary files a/blob.bin and b/blob.bin differ
diff --git a/oldname.txt b/newname.txt
similarity index 100%
rename from oldname.txt
rename to newname.txt
diff --git a/src.ts b/src.ts
index c9e9e05..ada8efd 100644
--- a/src.ts
+++ b/src.ts
@@ -1,10 +1,10 @@
 one
 two
-three
+THREE
 four
 five
 six
 seven
+extra
 eight
 nine
-ten
diff --git a/tail.txt b/tail.txt
index 1045c4a..f5069c1 100644
--- a/tail.txt
+++ b/tail.txt
@@ -1 +1 @@
-no newline here
\\ No newline at end of file
+no newline here, longer
\\ No newline at end of file
`

// Two hunks in one file, the second with the section heading git puts after
// the closing `@@` and starting on a blank context line — which is written as a
// single space, and is the one line in a patch that looks like nothing.
const TWO_HUNKS = `diff --git a/deep.ts b/deep.ts
index ddc3f08..aec2746 100644
--- a/deep.ts
+++ b/deep.ts
@@ -1,6 +1,6 @@
 export function alpha(): number {
   const a = 1
-  const b = 2
+  const b = 22
   const c = 3
   const d = 4
   return a + b + c + d
@@ -8,7 +8,7 @@ export function alpha(): number {
 
 export function beta(): string {
   const x = 'one'
-  const y = 'two'
+  const y = 'TWO'
   const z = 'three'
   return x + y + z
 }
`

describe('parsePatch', () => {
  it('finds every file in the patch, in the order git wrote them', () => {
    expect(parsePatch(FOUR_FILES).map((file) => file.path)).toEqual(['blob.bin', 'newname.txt', 'src.ts', 'tail.txt'])
  })

  it('has nothing to say about an empty patch', () => {
    expect(parsePatch('')).toEqual([])
  })

  // The arithmetic the two gutters are made of. A removal moves the old side
  // on and leaves the new one where it was; an addition does the opposite.
  it('numbers both sides of a hunk with context, additions and removals', () => {
    const [file] = parsePatch(FOUR_FILES).filter((each) => each.path === 'src.ts')
    const hunk = file?.hunks[0]
    expect(hunk?.oldStart).toBe(1)
    expect(hunk?.oldCount).toBe(10)
    expect(hunk?.newStart).toBe(1)
    expect(hunk?.newCount).toBe(10)

    const numbered = hunk?.lines.map((line) => [line.oldNumber, line.newNumber, line.kind, line.text])
    expect(numbered).toEqual([
      [1, 1, 'context', 'one'],
      [2, 2, 'context', 'two'],
      [3, null, 'removed', 'three'],
      [null, 3, 'added', 'THREE'],
      [4, 4, 'context', 'four'],
      [5, 5, 'context', 'five'],
      [6, 6, 'context', 'six'],
      [7, 7, 'context', 'seven'],
      [null, 8, 'added', 'extra'],
      // The line the whole exercise is for: eight lines into the old file and
      // nine into the new one, because one line was added above it.
      [8, 9, 'context', 'eight'],
      [9, 10, 'context', 'nine'],
      [10, null, 'removed', 'ten']
    ])
  })

  // The trap: `--- a/src.ts` and `+++ b/src.ts` start with the same characters
  // as a removal and an addition, and a renderer that reads them positionally
  // puts two lines of filename at the top of every file in red and green.
  it('reads the file headers as headers rather than as a removal and an addition', () => {
    const [file] = parsePatch(FOUR_FILES).filter((each) => each.path === 'src.ts')
    expect(file?.hunks[0]?.lines).toHaveLength(12)
    expect(file?.hunks[0]?.lines.some((line) => line.text.includes('src.ts'))).toBe(false)
  })

  it('keeps each hunk header as git wrote it, section heading and all', () => {
    const headers = parsePatch(TWO_HUNKS)[0]?.hunks.map((hunk) => hunk.header)
    expect(headers).toEqual(['@@ -1,6 +1,6 @@', '@@ -8,7 +8,7 @@ export function alpha(): number {'])
  })

  // A blank context line is a line with a single space on it, which is not the
  // same as an empty one and is the easiest line in a patch to drop.
  it('counts a blank context line, and everything below it', () => {
    // Asserted about the fixture itself, because that space is one editor away
    // from being stripped and the test above it would go on passing without it.
    expect(TWO_HUNKS).toContain('number {\n \n export function beta')

    const second = parsePatch(TWO_HUNKS)[0]?.hunks[1]
    expect(second?.lines[0]).toEqual({ kind: 'context', text: '', oldNumber: 8, newNumber: 8, noNewline: false })
    expect(second?.lines.at(-1)).toMatchObject({ text: '}', oldNumber: 14, newNumber: 14 })
  })

  it('starts the second hunk at its own line numbers rather than continuing the first', () => {
    const [first, second] = parsePatch(TWO_HUNKS)[0]?.hunks ?? []
    expect(first?.lines.at(-1)?.newNumber).toBe(6)
    expect(second?.lines[1]?.newNumber).toBe(9)
  })

  // A rename with no content change carries no `---`/`+++` and no hunks at all:
  // the two `rename` lines are the entire record that the file moved.
  it('reads a rename that has no content in it', () => {
    const [file] = parsePatch(FOUR_FILES).filter((each) => each.path === 'newname.txt')
    expect(file?.from).toBe('oldname.txt')
    expect(file?.status).toBe('renamed')
    expect(file?.hunks).toEqual([])
    expect(file?.binary).toBe(false)
  })

  // Nothing to show, and the panel has to be able to say so rather than draw an
  // empty file and let somebody conclude the change was reverted.
  it('marks a binary file as one, with no hunks', () => {
    const [file] = parsePatch(FOUR_FILES).filter((each) => each.path === 'blob.bin')
    expect(file?.binary).toBe(true)
    expect(file?.hunks).toEqual([])
  })

  // `\ No newline at end of file` is a fact about the line above it. Read as a
  // line of its own it would be a thirteenth line in a twelve-line hunk, with a
  // number, in a gutter.
  it('attaches the missing final newline to the line it is about', () => {
    const [file] = parsePatch(FOUR_FILES).filter((each) => each.path === 'tail.txt')
    const lines = file?.hunks[0]?.lines ?? []
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
      kind: 'removed',
      text: 'no newline here',
      oldNumber: 1,
      newNumber: null,
      noNewline: true
    })
    expect(lines[1]).toMatchObject({ kind: 'added', text: 'no newline here, longer', noNewline: true })
  })

  it('reads a new file, and a deleted one, off the side git points at /dev/null', () => {
    const added = parsePatch(
      `diff --git a/fresh.ts b/fresh.ts
new file mode 100644
index 0000000..c9267f1
--- /dev/null
+++ b/fresh.ts
@@ -0,0 +1,2 @@
+brand new
+second
`
    )
    expect(added[0]).toMatchObject({ path: 'fresh.ts', status: 'added' })
    expect(added[0]?.hunks[0]?.lines.map((line) => line.newNumber)).toEqual([1, 2])

    const gone = parsePatch(
      `diff --git a/tail.txt b/tail.txt
deleted file mode 100644
index 1045c4a..0000000
--- a/tail.txt
+++ /dev/null
@@ -1 +0,0 @@
-no newline here
\\ No newline at end of file
`
    )
    expect(gone[0]).toMatchObject({ path: 'tail.txt', status: 'deleted' })
    expect(gone[0]?.hunks[0]?.lines[0]?.oldNumber).toBe(1)
  })

  // What a patch cut short at a byte ceiling looks like: a hunk that claims ten
  // lines and stops after three. Rendering what arrived is the whole job; the
  // note about the cut belongs to the panel.
  it('renders what arrived when the patch stops mid-hunk', () => {
    const cut = parsePatch(
      `diff --git a/src.ts b/src.ts
--- a/src.ts
+++ b/src.ts
@@ -1,10 +1,10 @@
 one
 two
-three`
    )
    expect(cut[0]?.hunks[0]?.oldCount).toBe(10)
    expect(cut[0]?.hunks[0]?.lines).toHaveLength(3)
  })
})
