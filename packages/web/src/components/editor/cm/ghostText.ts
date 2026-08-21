import { StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

export interface GhostTextValue {
  text: string
  hint: string
  /** 改写：钉在选区 [from, to)；缺省则插在光标处（续写） */
  from?: number
  to?: number
}

export const setGhostText = StateEffect.define<GhostTextValue>()
export const clearGhostText = StateEffect.define<null>()

/** 当前 ghost 文本（供 keymap 判断是否有待接受的续写/改写） */
export const ghostTextState = StateField.define<string>({
  create: () => '',
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhostText)) value = e.value.text
      else if (e.is(clearGhostText)) value = ''
    }
    return value
  },
})

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly hint: string,
  ) {
    super()
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text && other.hint === this.hint
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-ai-ghost'
    const body = document.createElement('span')
    body.className = 'cm-ai-ghost-body'
    // 终端式块光标随呼吸动画一起闪烁，暗示「输出进行中」
    body.textContent = this.text + '▌'
    span.append(body)
    if (this.hint) {
      const hint = document.createElement('span')
      hint.className = 'cm-ai-ghost-hint'
      hint.textContent = this.hint
      span.append(hint)
    }
    return span
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildGhostDeco(stateLen: number, value: GhostTextValue): DecorationSet {
  const widget = new GhostWidget(value.text, value.hint)
  const from = value.from
  const to = value.to
  if (from != null && to != null && from < to) {
    const f = Math.max(0, Math.min(from, stateLen))
    const t = Math.max(f, Math.min(to, stateLen))
    if (f < t) {
      return Decoration.set([
        Decoration.mark({ class: 'cm-ai-refine-orig' }).range(f, t),
        Decoration.widget({ widget, side: 1 }).range(t),
      ])
    }
  }
  const pos = Math.max(0, Math.min(from ?? to ?? 0, stateLen))
  return Decoration.set([
    Decoration.widget({ widget, side: 1 }).range(pos),
  ])
}

export const ghostDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setGhostText)) {
        const value = e.value
        // 续写未带 from/to 时钉在当前光标
        if (value.from == null || value.to == null) {
          deco = buildGhostDeco(tr.state.doc.length, {
            ...value,
            from: tr.state.selection.main.head,
            to: tr.state.selection.main.head,
          })
        } else {
          deco = buildGhostDeco(tr.state.doc.length, value)
        }
      } else if (e.is(clearGhostText)) {
        deco = Decoration.none
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

export const ghostTextExtension: Extension = [ghostTextState, ghostDecorations]
