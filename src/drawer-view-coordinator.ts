import {
  type DrawerView,
  type DrawerViewIntentResult,
  DrawerViewProjection,
} from "./drawer-view";

interface DrawerViewRenderers {
  cancelDrag(): void;
  renderPanel(next: DrawerView, previous: DrawerView | null): void;
  renderDrawer(next: DrawerView): void;
}

interface DrawerViewPresentation {
  presentError(error: unknown): void;
  presentStale(): void;
  reportDiagnostic(context: string, error: unknown): void;
}

export class DrawerViewCoordinator {
  constructor(
    private readonly projection: DrawerViewProjection,
    private readonly presentation: DrawerViewPresentation,
  ) {}

  get currentView(): DrawerView | null {
    return this.projection.currentView;
  }

  subscribe(renderers: DrawerViewRenderers): () => void {
    return this.projection.subscribe((next, previous) => {
      this.runSafely("Failed to cancel stale Drawer drag", renderers.cancelDrag);
      this.runSafely(
        "Failed to render Panel Drawer view",
        () => renderers.renderPanel(next, previous),
      );
      this.runSafely(
        "Failed to render Drawer navigation",
        () => renderers.renderDrawer(next),
      );
    });
  }

  async toggle(): Promise<void> {
    await this.runIntent(
      "Drawer toggle committed but refresh failed",
      () => this.projection.toggle(),
    );
  }

  async setOpen(open: boolean): Promise<boolean> {
    const result = await this.runIntent(
      `Drawer ${open ? "open" : "close"} committed but refresh failed`,
      () => this.projection.setOpen(open),
    );
    return result?.status === "published" && result.view.open === open;
  }

  async select(collectionId: string | null): Promise<void> {
    await this.runIntent(
      "Drawer selection committed but refresh failed",
      () => this.projection.select(collectionId),
    );
  }

  async refreshAfterMutation(context: string): Promise<boolean> {
    try {
      await this.projection.refresh();
      return true;
    } catch (error) {
      this.presentation.reportDiagnostic(context, error);
      this.presentation.presentStale();
      return false;
    }
  }

  async retryAfterFailure(context: string): Promise<void> {
    try {
      await this.projection.refresh();
    } catch (error) {
      this.presentation.reportDiagnostic(context, error);
    }
  }

  private async runIntent(
    context: string,
    intent: () => Promise<DrawerViewIntentResult>,
  ): Promise<DrawerViewIntentResult | null> {
    try {
      const result = await intent();
      if (result.status === "committed-stale") {
        this.presentation.reportDiagnostic(context, result.error);
        this.presentation.presentStale();
      }
      return result;
    } catch (error) {
      this.presentation.presentError(error);
      return null;
    }
  }

  private runSafely(context: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.presentation.reportDiagnostic(context, error);
    }
  }
}
