import { StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

export interface GhostTextValue {
  text: string
  hint: string
}

export const setGhostText = StateEffect.define<GhostTextValue>()
export const clearGhostText = StateEffect.define<null>()

/** 当前 ghost 文本（供 keymap 判断是否有待接受的续写） */
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

const ghostDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setGhostText)) {
        const pos = tr.state.selection.main.head
        deco = Decoration.set([
          Decoration.widget({
            widget: new GhostWidget(e.value.text, e.value.hint),
            side: 1,
          }).range(pos),
        ])
      } else if (e.is(clearGhostText)) {
        deco = Decoration.none
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

export const ghostTextExtension: Extension = [ghostTextState, ghostDecorations]
