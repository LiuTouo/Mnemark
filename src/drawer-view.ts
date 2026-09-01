import type { CollectionSummary, FavoriteItem } from "./types";

export interface DrawerView {
  readonly generation: number;
  readonly open: boolean;
  readonly selectedCollection: string | null;
  readonly collections: readonly CollectionSummary[];
  readonly activeSnapshots: readonly FavoriteItem[];
}

export interface DrawerViewSource {
  listenInvalidated(listener: (generation: number) => void): Promise<void>;
  read(): Promise<DrawerView>;
  toggle(): Promise<void>;
  setOpen(open: boolean): Promise<void>;
  select(collectionId: string | null): Promise<void>;
}

export type DrawerViewDiagnosticReporter = (error: unknown) => void;
export type DrawerViewSubscriber = (next: DrawerView, previous: DrawerView | null) => void;
export type DrawerViewIntentResult =
  | { readonly status: "published"; readonly view: DrawerView }
  | {
      readonly status: "committed-stale";
      readonly view: DrawerView;
      readonly error: unknown;
    };

interface ReadBarrier {
  readonly requiredRead: number;
  readonly resolve: (view: DrawerView) => void;
  readonly reject: (error: unknown) => void;
}

export class DrawerViewProjection {
  private view: DrawerView | null = null;
  private listenerRegistered = false;
  private listenerAttempt: Promise<void> | null = null;
  private startupRequest: Promise<DrawerView> | null = null;
  private pumping = false;
  private readonly barriers: ReadBarrier[] = [];
  private readSequence = 0;
  private backgroundPending = false;
  private wantedGeneration = 0;
  private stale = true;
  private readonly subscribers = new Set<DrawerViewSubscriber>();
  private intentQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly source: DrawerViewSource,
    private readonly reportDiagnostic: DrawerViewDiagnosticReporter,
  ) {}

  get currentView(): DrawerView | null {
    return this.view;
  }

  startup(): Promise<DrawerView> {
    if (this.view) return Promise.resolve(this.view);
    if (this.startupRequest) return this.startupRequest;

    const request = this.enqueueBarrier();
    this.startupRequest = request;
    void request.catch(() => {
      if (this.startupRequest === request) this.startupRequest = null;
    });
    return request;
  }

  refresh(): Promise<DrawerView> {
    return this.enqueueBarrier();
  }

  retryIfStale(): Promise<DrawerView> {
    if (this.view && !this.stale) return Promise.resolve(this.view);
    return this.refresh();
  }

  toggle(): Promise<DrawerViewIntentResult> {
    return this.enqueueIntent(() => this.source.toggle());
  }

  setOpen(open: boolean): Promise<DrawerViewIntentResult> {
    return this.enqueueIntent(() => this.source.setOpen(open));
  }

  select(collectionId: string | null): Promise<DrawerViewIntentResult> {
    return this.enqueueIntent(() => this.source.select(collectionId));
  }

  subscribe(subscriber: DrawerViewSubscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.view) this.notify(subscriber, this.view, null);
    return () => this.subscribers.delete(subscriber);
  }

  private notify(
    subscriber: DrawerViewSubscriber,
    next: DrawerView,
    previous: DrawerView | null,
  ): void {
    try {
      subscriber(next, previous);
    } catch {
      // One renderer must not prevent the others from receiving the view.
    }
  }

  private enqueueIntent(command: () => Promise<void>): Promise<DrawerViewIntentResult> {
    const request = this.intentQueue.then(async () => {
      await this.startup();
      await command();

      try {
        return {
          status: "published" as const,
          view: await this.refresh(),
        };
      } catch (error) {
        const view = this.view;
        if (!view) throw error;
        return { status: "committed-stale" as const, view, error };
      }
    });
    this.intentQueue = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }

  private accept(next: DrawerView): DrawerView {
    if (this.view && next.generation <= this.view.generation) return this.view;

    const previous = this.view;
    const owned: DrawerView = {
      ...next,
      collections: [...next.collections],
      activeSnapshots: [...next.activeSnapshots],
    };
    this.view = owned;
    for (const subscriber of this.subscribers) {
      this.notify(subscriber, owned, previous);
    }
    return owned;
  }

  private onInvalidated(generation: number): void {
    if (generation <= (this.view?.generation ?? -1) && !this.stale) return;
    this.wantedGeneration = Math.max(this.wantedGeneration, generation);
    this.stale = true;
    this.backgroundPending = true;
    if (this.listenerRegistered) this.startPump();
  }

  private enqueueBarrier(): Promise<DrawerView> {
    let resolveBarrier!: (view: DrawerView) => void;
    let rejectBarrier!: (error: unknown) => void;
    const promise = new Promise<DrawerView>((resolve, reject) => {
      resolveBarrier = resolve;
      rejectBarrier = reject;
    });
    const barrier: ReadBarrier = {
      requiredRead: this.readSequence + 1,
      resolve: resolveBarrier,
      reject: rejectBarrier,
    };
    this.barriers.push(barrier);
    void this.ensureListener().then(
      () => this.startPump(),
      (error: unknown) => this.rejectBarrier(barrier, error),
    );
    return promise;
  }

  private ensureListener(): Promise<void> {
    if (this.listenerRegistered) return Promise.resolve();
    if (this.listenerAttempt) return this.listenerAttempt;

    const attempt = this.registerListener();
    this.listenerAttempt = attempt;
    void attempt.catch(() => {
      if (this.listenerAttempt === attempt) this.listenerAttempt = null;
    });
    return attempt;
  }

  private async registerListener(): Promise<void> {
    await this.source.listenInvalidated((generation) => {
      this.onInvalidated(generation);
    });
    this.listenerRegistered = true;
  }

  private startPump(): void {
    if (!this.listenerRegistered || this.pumping || !this.needsRead()) return;

    this.pumping = true;
    void this.pump().finally(() => {
      this.pumping = false;
      if (this.needsRead()) this.startPump();
    });
  }

  private needsRead(): boolean {
    return this.backgroundPending || this.barriers.length > 0;
  }

  private async pump(): Promise<void> {
    while (this.needsRead()) {
      const sequence = ++this.readSequence;
      const explicit = this.barriers.some((barrier) => barrier.requiredRead <= sequence);
      this.backgroundPending = false;

      try {
        const current = this.accept(await this.source.read());
        this.stale = current.generation < this.wantedGeneration;
        this.backgroundPending = this.stale;
        this.resolveBarriers(sequence, current);
      } catch (error) {
        this.stale = true;
        this.rejectBarriers(sequence, error);
        if (!explicit) this.safeReport(error);
      }
    }
  }

  private resolveBarriers(sequence: number, current: DrawerView): void {
    const completed = this.barriers.filter((barrier) => barrier.requiredRead <= sequence);
    this.removeBarriers(completed);
    for (const barrier of completed) barrier.resolve(current);
  }

  private rejectBarriers(sequence: number, error: unknown): void {
    const failed = this.barriers.filter((barrier) => barrier.requiredRead <= sequence);
    this.removeBarriers(failed);
    for (const barrier of failed) barrier.reject(error);
  }

  private rejectBarrier(barrier: ReadBarrier, error: unknown): void {
    this.removeBarriers([barrier]);
    barrier.reject(error);
  }

  private removeBarriers(completed: readonly ReadBarrier[]): void {
    for (const barrier of completed) {
      const index = this.barriers.indexOf(barrier);
      if (index >= 0) this.barriers.splice(index, 1);
    }
  }

  private safeReport(error: unknown): void {
    try {
      this.reportDiagnostic(error);
    } catch {
      // Diagnostic reporting cannot break the freshness engine.
    }
  }
}
