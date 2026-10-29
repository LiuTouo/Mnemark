import type { WorkspaceLayout } from "./workspace-state";

export interface WorkspaceViewport {
  cssWidth: number;
  cssHeight: number;
}

export interface WorkspaceLayoutHost {
  stage(layout: WorkspaceLayout): void;
  resize(layout: WorkspaceLayout): Promise<WorkspaceViewport>;
  waitForViewport(viewport: WorkspaceViewport): Promise<void>;
  commit(layout: WorkspaceLayout): void;
  finish(layout: WorkspaceLayout): Promise<void>;
  report(error: unknown): void;
}

interface LayoutRequest {
  layout: WorkspaceLayout;
  environment: string;
}

const LAYOUT_RETRY_DELAY_MS = 400;
const MAX_LAYOUT_FAILURES = 2;

function sameRequest(a: LayoutRequest | null, b: LayoutRequest): boolean {
  return a !== null && a.environment === b.environment
    && a.layout.mode === b.layout.mode
    && a.layout.leftExtent === b.layout.leftExtent
    && a.layout.rightExtent === b.layout.rightExtent
    && a.layout.drawerVisible === b.layout.drawerVisible
    && a.layout.previewVisible === b.layout.previewVisible
    && a.layout.activeTab === b.layout.activeTab;
}

/** Serialize native region updates; only the latest intent may reveal panes. */
export class WorkspaceLayoutCoordinator {
  private requested: LayoutRequest | null = null;
  private committed: LayoutRequest | null = null;
  private native: LayoutRequest | null = null;
  private running: Promise<void> | null = null;
  private attempted: LayoutRequest | null = null;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: WorkspaceLayoutHost) {}

  invalidate(): void {
    // Called before monitor lookup: even that lookup may outlive the user's
    // next click, so an older resize must stop being publishable immediately.
    this.requested = null;
    // The caller may already have hidden a closing pane. A quick reopen must
    // republish it even when its geometry equals the last committed layout.
    this.committed = null;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.failures = 0;
  }

  request(layout: WorkspaceLayout, environment: string): Promise<void> {
    const next = { layout, environment };
    if (!sameRequest(this.requested, next)) this.requested = next;
    if (!this.running) {
      // Coalesce render/preview requests made in the same turn.
      this.running = Promise.resolve().then(() => this.drain()).finally(() => {
        this.running = null;
        if (this.requested && this.requested !== this.attempted) {
          void this.request(this.requested.layout, this.requested.environment);
        }
      });
    }
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.requested) {
      const request = this.requested;
      this.attempted = request;
      if (sameRequest(this.committed, request)) {
        this.failures = 0;
        return;
      }
      const { layout, environment } = request;
      try {
        const needsResize = !this.native || this.native.environment !== environment
          || this.native.layout.leftExtent !== layout.leftExtent
          || this.native.layout.rightExtent !== layout.rightExtent;
        if (needsResize) {
          this.committed = null;
          this.host.stage(layout);
          const viewport = await this.host.resize(layout);
          await this.host.waitForViewport(viewport);
          this.native = request;
        }
        if (request !== this.requested) continue;
        this.host.commit(layout);
        // Only shrink the native region after the DOM has painted. Expanding
        // it before commit and shrinking after avoids clipping the old frame
        // when History must move inside a narrow fixed host.
        await this.host.finish(layout);
        if (request !== this.requested) continue;
        this.committed = request;
        this.failures = 0;
        return;
      } catch (error) {
        // Native bounds may have changed even if the viewport acknowledgement
        // failed. Retry through the native adapter on the next request.
        this.native = null;
        this.committed = null;
        this.host.report(error);
        // A cross-DPI monitor move rescales WebView2 asynchronously; one
        // abandoned attempt must not leave the panes hidden forever, so give
        // the same intent a bounded number of retries.
        if (request === this.requested && this.failures < MAX_LAYOUT_FAILURES) {
          this.failures += 1;
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.requested === request) void this.request(layout, environment);
          }, LAYOUT_RETRY_DELAY_MS);
        }
        if (request === this.requested) return;
      }
    }
  }
}

/** Let the DOM commit paint before removing the old input/drawing region. */
export function waitForWorkspacePaint(): Promise<void> {
  if (document.visibilityState === "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    let frame = 0;
    const done = () => {
      cancelAnimationFrame(frame);
      clearTimeout(backstop);
      resolve();
    };
    // Hidden WebViews may stop rAF without updating document.visibilityState.
    const backstop = setTimeout(done, 250);
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(done); });
  });
}

/** A native IPC reply does not imply that WebView2 has resized its viewport. */
export function waitForWorkspaceViewport(viewport: WorkspaceViewport): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    const cleanup = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      window.removeEventListener("resize", check);
    };
    const check = () => {
      if (Math.abs(window.innerWidth - viewport.cssWidth) > 1
        || Math.abs(window.innerHeight - viewport.cssHeight) > 1) return;
      cleanup();
      resolve();
    };
    // This is a failure deadline, never a presentation delay. Resize events
    // also work while a hidden webview has animation frames throttled.
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(
        `viewport did not reach ${viewport.cssWidth}x${viewport.cssHeight}`
          + ` (inner ${window.innerWidth}x${window.innerHeight}`
          + ` dpr ${window.devicePixelRatio})`,
      ));
    }, 1000);
    window.addEventListener("resize", check);
    frame = requestAnimationFrame(check);
  });
}
