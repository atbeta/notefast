import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FixtureMeta } from './contract'
import type { SemanticNode } from '../../markdown/semantics'

const ROOT = join(import.meta.dir, 'fixtures')

export function fixturePath(kind: 'success' | 'failure' | 'extension', fileName: string): string {
  return join(ROOT, kind, fileName)
}

export function readFixtureFile(kind: 'success' | 'failure' | 'extension', fileName: string): string {
  return readFileSync(fixturePath(kind, fileName), 'utf8')
}

export function readExpected(kind: 'success' | 'failure', id: string): SemanticNode[] {
  const raw = readFixtureFile(kind, `${id}.expected.json`)
  return JSON.parse(raw) as SemanticNode[]
}

export function readMeta(kind: 'success' | 'failure', id: string): FixtureMeta {
  const path = fixturePath(kind, `${id}.meta.json`)
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureMeta
}
