/**
 * 把现行 parser 的语义森林写成 *.expected.json，冻结契约。
 * 用法：bun packages/core/src/__tests__/markdown-corpus/dump-expected.ts
 *
 * 仅在有意更新现行行为时重跑；不要为「对齐 remark」改成功样本。
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMarkdownToBlocksLegacy } from '../../markdown'
import { toSemanticForest } from '../../markdown/semantics'
import { readFixtureFile } from './loadFixture'

const ROOT = join(import.meta.dir, 'fixtures')

function dumpDir(kind: 'success' | 'failure'): void {
  const dir = join(ROOT, kind)
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const id = name.slice(0, -3)
    const markdown = readFixtureFile(kind, `${id}.md`)
    const forest = toSemanticForest(parseMarkdownToBlocksLegacy(markdown, 'corpus'))
    const out = join(dir, `${id}.expected.json`)
    writeFileSync(out, `${JSON.stringify(forest, null, 2)}\n`)
    console.log(`wrote ${kind}/${id}.expected.json`)
  }
}

dumpDir('success')
dumpDir('failure')
