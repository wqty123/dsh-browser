/** Shared start-page face injected into every Browser tab seat. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { OmniboxPreferences } from '../browser/omnibox.ts'
import type { BrowserShortcut } from '../../startpage-settings.ts'
import type { StartPageController, StartPageSnapshot, StartPageWriteResult } from './controller.ts'
import type { SearchEngineDraft, ShortcutDraft, StartPageEngineView } from './model.ts'

/** Stable unavailable state used before settings are served or after teardown. */
const UNAVAILABLE: StartPageSnapshot = {
  status: 'unavailable', writable: false, revision: undefined,
  defaultSearchEngineId: '', engines: [], shortcuts: [],
}

const unavailable = (): Promise<StartPageWriteResult> => Promise.resolve({ ok: false, reason: 'unavailable' })

/** Start-page state, actions, and the resolver preferences read at submission time. */
export interface BrowserStartPageInjected {
  readonly hooks: { readonly startPage: HostObservable<StartPageSnapshot> }
  /** @returns current engines and selection for manual address-bar input. */
  omniboxPreferences(): OmniboxPreferences
  /** @returns the selected engine when it can search. */
  selectedEngine(): StartPageEngineView | undefined
  readonly shortcuts: {
    add(draft: ShortcutDraft): Promise<StartPageWriteResult>
    update(id: string, draft: ShortcutDraft): Promise<StartPageWriteResult>
    remove(id: string): Promise<StartPageWriteResult>
    restore(shortcut: BrowserShortcut, index: number): Promise<StartPageWriteResult>
    move(id: string, offset: -1 | 1): Promise<StartPageWriteResult>
    reorder(ids: readonly string[]): Promise<StartPageWriteResult>
  }
  readonly engines: {
    setDefault(id: string): Promise<StartPageWriteResult>
    add(draft: SearchEngineDraft): Promise<StartPageWriteResult>
    update(id: string, draft: SearchEngineDraft): Promise<StartPageWriteResult>
    remove(id: string, replacementId?: string): Promise<StartPageWriteResult>
  }
}

/**
 * Plugin-wide facade over the settings-backed controller. The Host section is
 * shared by every session, so the facade outlives individual tab seats and
 * keeps its observable identity while the controller attaches or detaches.
 */
export class StartPageBinding implements BrowserStartPageInjected, HostObservable<StartPageSnapshot> {
  private readonly store: SnapshotStore<StartPageSnapshot> = createSnapshotStore(UNAVAILABLE)
  private controller: StartPageController | undefined
  private unsubscribe: (() => void) | undefined
  readonly hooks = {
    startPage: {
      getSnapshot: () => this.getSnapshot(),
      subscribe: (listener: () => void) => this.subscribe(listener),
    },
  }
  readonly shortcuts: BrowserStartPageInjected['shortcuts'] = {
    add: draft => this.controller?.addShortcut(draft) ?? unavailable(),
    update: (id, draft) => this.controller?.updateShortcut(id, draft) ?? unavailable(),
    remove: id => this.controller?.removeShortcut(id) ?? unavailable(),
    restore: (shortcut, index) => this.controller?.restoreShortcut(shortcut, index) ?? unavailable(),
    move: (id, offset) => this.controller?.moveShortcut(id, offset) ?? unavailable(),
    reorder: ids => this.controller?.reorderShortcuts(ids) ?? unavailable(),
  }
  readonly engines: BrowserStartPageInjected['engines'] = {
    setDefault: id => this.controller?.setDefaultSearchEngine(id) ?? unavailable(),
    add: draft => this.controller?.addSearchEngine(draft) ?? unavailable(),
    update: (id, draft) => this.controller?.updateSearchEngine(id, draft) ?? unavailable(),
    remove: (id, replacementId) => this.controller?.removeSearchEngine(id, replacementId) ?? unavailable(),
  }

  getSnapshot = (): StartPageSnapshot => this.store.getSnapshot()
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  omniboxPreferences(): OmniboxPreferences {
    return this.controller?.preferences() ?? { defaultSearchEngineId: '', searchEngines: [] }
  }

  selectedEngine(): StartPageEngineView | undefined {
    return this.controller?.selectedEngine()
  }

  /**
   * Follow one controller and publish its snapshots through the stable facade.
   * @param controller - settings-backed controller to attach.
   * @returns detaches this controller without disposing it.
   */
  attach(controller: StartPageController): () => void {
    this.unsubscribe?.()
    this.controller = controller
    this.unsubscribe = controller.subscribe(() => { this.store.set(controller.getSnapshot()) })
    this.store.set(controller.getSnapshot())
    return () => {
      if (this.controller !== controller) return
      this.unsubscribe?.()
      this.unsubscribe = undefined
      this.controller = undefined
      this.store.set(UNAVAILABLE)
    }
  }
}
