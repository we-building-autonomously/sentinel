import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Frame,
  type Locator,
} from "playwright";
import fs from "node:fs";
import path from "node:path";
import { snapshot, type FrameSnapshot } from "./indexer.js";
import { DiagnosticsCollector, type Diagnostic } from "./diagnostics.js";
import { fulfillmentFor, methodMatches, describeMock, type NetworkMock } from "./mock.js";
import { pickUploadFiles, describeUpload } from "./upload.js";
import { looksLoading } from "./loading.js";
import { totp } from "../totp.js";
import type { StateSnapshot } from "./expect-state.js";
import type { RequestRecord } from "./expect-requests.js";
import type { DialogRecord, DownloadRecord } from "../types.js";

export interface SessionOptions {
  headed: boolean;
  actionTimeoutMs: number;
  /** Directory to write screenshots/trace into. */
  artifactsDir: string;
  viewport?: { width: number; height: number };
  /** Mobile/touch emulation, paired with viewport (from resolveViewport). */
  userAgent?: string;
  isMobile?: boolean;
  hasTouch?: boolean;
  deviceScaleFactor?: number;
  /**
   * Path to a Playwright storageState JSON to seed cookies + localStorage,
   * so a session starts already authenticated. Missing files are ignored.
   */
  storageState?: string;
  /** Record a video of the run into the artifacts dir. */
  video?: boolean;
  /** Extra HTTP headers applied to every request. */
  extraHTTPHeaders?: Record<string, string>;
  /** HTTP basic-auth credentials. */
  httpCredentials?: { username: string; password: string };
  /** Cookies to seed before navigating. */
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string; url?: string }>;
  /** Emulation: dark mode, reduced motion, locale, timezone (for theme/i18n/a11y tests). */
  colorScheme?: "light" | "dark" | "no-preference";
  reducedMotion?: "reduce" | "no-preference";
  locale?: string;
  timezoneId?: string;
  /** Network stubs (URL glob → canned response). */
  mocks?: NetworkMock[];
  /** Files available for upload (fed to native file choosers, in order). */
  uploads?: string[];
  /** Base32 TOTP secret; when set, the `get_totp` tool returns the live code. */
  totpSecret?: string;
  /** Freeze the page clock to this epoch-ms instant (deterministic date/time UI). */
  clockNow?: number;
  /**
   * CDP/websocket endpoint of a remote browser to connect to instead of
   * launching a local Chromium (hosted execution via Browserbase/Browserless).
   */
  cdpEndpoint?: string;
}

/**
 * Wraps a Playwright browser/context/page and exposes the small set of
 * operations the agent's tools need, addressed by snapshot index.
 */
export class BrowserSession {
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page;
  private shotCounter = 0;
  /** Index -> owning frame, from the most recent snapshot. */
  private owner: Map<number, Frame> = new Map();
  /** Console/network/runtime health signals captured during the run. */
  readonly diagnostics = new DiagnosticsCollector();
  /** All pages opened in this context, in creation order (incl. popups). */
  private pages: Page[] = [];
  /** Auto-handled dialogs not yet surfaced to the agent. */
  private dialogBuffer: string[] = [];
  /** Every auto-handled dialog, persisted for the report. */
  private allDialogs: DialogRecord[] = [];
  /** Per-mock request counts, parallel to opts.mocks. */
  private mockHitCounts: number[] = [];
  /** Files fed to native file choosers during the run. */
  private uploadLog: string[] = [];
  private uploadIndex = 0;
  /** Flat log of every HTTP response (for request expectations). */
  private requestLogArr: RequestRecord[] = [];
  /** Main-document response headers from the initial navigation (security audit). */
  private mainHeaders: Record<string, string> = {};
  /** Downloads triggered by the app, not yet surfaced to the agent. */
  private downloadBuffer: string[] = [];
  /** Every download captured during the run, persisted for the report. */
  private allDownloads: DownloadRecord[] = [];
  private downloadCounter = 0;

  constructor(private opts: SessionOptions) {}

  async start(): Promise<void> {
    // Connect to a remote browser (hosted execution) when an endpoint is given;
    // otherwise launch a local Chromium. newContext + our options apply the same
    // either way, so the rest of the run is identical.
    this.browser = this.opts.cdpEndpoint
      ? await chromium.connectOverCDP(this.opts.cdpEndpoint)
      : await chromium.launch({
          headless: !this.opts.headed,
          args: ["--disable-blink-features=AutomationControlled"],
        });
    const seed =
      this.opts.storageState && fs.existsSync(this.opts.storageState)
        ? this.opts.storageState
        : undefined;
    const viewport = this.opts.viewport ?? { width: 1280, height: 800 };
    this.context = await this.browser.newContext({
      viewport,
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      storageState: seed,
      ...(this.opts.userAgent ? { userAgent: this.opts.userAgent } : {}),
      ...(this.opts.isMobile ? { isMobile: this.opts.isMobile } : {}),
      ...(this.opts.hasTouch ? { hasTouch: this.opts.hasTouch } : {}),
      ...(this.opts.deviceScaleFactor ? { deviceScaleFactor: this.opts.deviceScaleFactor } : {}),
      ...(this.opts.extraHTTPHeaders ? { extraHTTPHeaders: this.opts.extraHTTPHeaders } : {}),
      ...(this.opts.httpCredentials ? { httpCredentials: this.opts.httpCredentials } : {}),
      ...(this.opts.colorScheme ? { colorScheme: this.opts.colorScheme } : {}),
      ...(this.opts.reducedMotion ? { reducedMotion: this.opts.reducedMotion } : {}),
      ...(this.opts.locale ? { locale: this.opts.locale } : {}),
      ...(this.opts.timezoneId ? { timezoneId: this.opts.timezoneId } : {}),
      ...(this.opts.video ? { recordVideo: { dir: this.opts.artifactsDir, size: viewport } } : {}),
    });
    if (this.opts.cookies?.length) {
      await this.context.addCookies(this.opts.cookies as Parameters<BrowserContext["addCookies"]>[0]);
    }
    // Capture ARIA live-region announcements (toasts, status/alert messages) as
    // they happen — they often vanish before the agent or judge re-observes, so
    // "Saved successfully" would otherwise be unverifiable.
    await this.context
      .addInitScript(() => {
        const w = window as unknown as { __snLive?: string[] };
        w.__snLive = w.__snLive || [];
        const isLive = (el: Element): boolean => {
          const live = el.getAttribute("aria-live");
          const role = el.getAttribute("role");
          return (!!live && live !== "off") || role === "status" || role === "alert";
        };
        const record = (el: Element) => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.length <= 300 && w.__snLive![w.__snLive!.length - 1] !== t) w.__snLive!.push(t);
        };
        const obs = new MutationObserver((muts) => {
          for (const m of muts) {
            let el: Element | null = m.target instanceof Element ? m.target : null;
            while (el) {
              if (isLive(el)) {
                record(el);
                break;
              }
              el = el.parentElement;
            }
            m.addedNodes.forEach((n) => {
              if (n instanceof Element && isLive(n)) record(n);
            });
          }
        });
        const start = () =>
          document.documentElement &&
          obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
        if (document.documentElement) start();
        else document.addEventListener("DOMContentLoaded", start);
      })
      .catch(() => {});
    // Capture what the app copies to the clipboard so a spec can assert on it
    // (copy-an-API-key / copy-a-link buttons). Wrapping writeText is more
    // reliable than reading the OS clipboard, which needs focus + permissions.
    await this.context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await this.context
      .addInitScript(() => {
        const w = window as unknown as { __snClip?: string[] };
        w.__snClip = w.__snClip || [];
        const nav = navigator as Navigator & { clipboard?: Clipboard };
        if (nav.clipboard?.writeText) {
          const orig = nav.clipboard.writeText.bind(nav.clipboard);
          nav.clipboard.writeText = (text: string) => {
            try {
              w.__snClip!.push(String(text));
            } catch {
              /* ignore */
            }
            return orig(text);
          };
        }
      })
      .catch(() => {});
    const mocks = this.opts.mocks ?? [];
    this.mockHitCounts = new Array(mocks.length).fill(0);
    for (let i = 0; i < mocks.length; i++) {
      const mock = mocks[i];
      await this.context.route(mock.url, async (route) => {
        if (!methodMatches(mock, route.request().method())) return route.fallback();
        this.mockHitCounts[i]++;
        if (mock.delayMs) await new Promise((r) => setTimeout(r, mock.delayMs));
        await route.fulfill(fulfillmentFor(mock));
      });
    }
    this.context.setDefaultTimeout(this.opts.actionTimeoutMs);
    await this.context.tracing.start({ screenshots: true, snapshots: true });

    // Capture runtime health signals across every page in the context. The
    // "page" event also fires for the initial page below, so wiring is guarded
    // against double-attachment (which would double-count every diagnostic).
    this.context.on("page", (p) => this.wireDiagnostics(p));

    // Freeze the clock (context-wide, before any page exists) so date/time-
    // dependent UI is deterministic — "today's date", relative timestamps,
    // countdowns, trial-expiry banners. Date.now()/new Date() return this
    // instant on every page; timers still tick so apps don't stall.
    if (this.opts.clockNow != null) {
      await this.context.clock.setFixedTime(new Date(this.opts.clockNow)).catch(() => {});
    }

    this.page = await this.context.newPage();
    this.wireDiagnostics(this.page);
  }

  private wiredPages = new WeakSet<Page>();

  private wireDiagnostics(page: Page): void {
    if (this.wiredPages.has(page)) return;
    this.wiredPages.add(page);
    if (!this.pages.includes(page)) this.pages.push(page);
    page.on("close", () => {
      this.pages = this.pages.filter((p) => p !== page);
    });
    page.on("pageerror", (err) => this.diagnostics.pageError(err.message));
    page.on("console", (msg) => {
      this.diagnostics.consoleMessage(msg.type(), msg.text(), msg.location()?.url);
    });
    page.on("response", (res) => {
      this.diagnostics.response(res.status(), res.url(), res.request().method());
      // Keep a capped flat log of ALL responses (not just failures) so a spec
      // can assert which requests the app actually made. The post body is kept
      // (capped) for body assertions but stays IN-MEMORY ONLY — it can hold a
      // login password and is never written to any artifact.
      if (this.requestLogArr.length < 500) {
        const body = res.request().postData();
        this.requestLogArr.push({
          method: res.request().method(),
          url: res.url(),
          status: res.status(),
          ...(body ? { body: body.slice(0, 4000) } : {}),
        });
      }
    });
    // Auto-handle JS dialogs so the agent never hangs; record what was shown.
    // confirm/prompt are accepted (the common "Yes/OK" path); beforeunload is
    // accepted so navigation isn't blocked. Each is surfaced to the agent AND
    // persisted into the report — silently bypassing a destructive confirm is
    // exactly the kind of thing a QA report must make visible.
    page.on("dialog", async (dialog) => {
      const type = dialog.type();
      const message = dialog.message().slice(0, 300);
      this.dialogBuffer.push(`${type} dialog: "${message.slice(0, 200)}"`);
      let action: "accepted" | "dismissed" = "accepted";
      try {
        await dialog.accept();
      } catch {
        action = "dismissed";
        await dialog.dismiss().catch(() => {});
      }
      this.allDialogs.push({ type, message, action });
    });
    // Auto-handle native file choosers so an upload flow never hangs; feed the
    // configured files (or cancel with an empty selection if none).
    page.on("filechooser", async (chooser) => {
      const { files, nextIndex } = pickUploadFiles(
        this.opts.uploads ?? [],
        chooser.isMultiple(),
        this.uploadIndex
      );
      this.uploadIndex = nextIndex;
      try {
        await chooser.setFiles(files);
        this.uploadLog.push(describeUpload(files));
      } catch (err) {
        await chooser.setFiles([]).catch(() => {});
        this.uploadLog.push(`upload failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    });
    // Capture file downloads (CSV/PDF exports, generated reports). Without this
    // a download leaves no trace, so the agent can't verify "the export
    // downloaded" and the report can't show it. We save the file into the
    // artifacts dir and surface a note to the agent + a record to the report.
    page.on("download", async (download) => {
      const filename = download.suggestedFilename() || `download-${this.downloadCounter}`;
      const url = download.url();
      const safe = `download-${this.downloadCounter++}-${filename.replace(/[^A-Za-z0-9._-]/g, "_")}`;
      const dest = path.join(this.opts.artifactsDir, safe);
      try {
        await download.saveAs(dest);
        const bytes = fs.existsSync(dest) ? fs.statSync(dest).size : undefined;
        this.allDownloads.push({ filename, url, path: safe, bytes });
        this.downloadBuffer.push(`downloaded file "${filename}"${bytes != null ? ` (${bytes} bytes)` : ""}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
        this.allDownloads.push({ filename, url, error: msg });
        this.downloadBuffer.push(`download of "${filename}" failed: ${msg}`);
      }
    });
  }

  /**
   * Make the most recently opened, still-open page the active one. Returns the
   * note to surface if focus moved (e.g. a click opened a new tab), else null.
   */
  syncActivePage(): string | null {
    const live = this.pages.filter((p) => !p.isClosed());
    const newest = live[live.length - 1];
    if (newest && newest !== this.page) {
      this.page = newest;
      return `Focus moved to a newly opened tab: ${newest.url()}`;
    }
    return null;
  }

  /** Drain auto-handled dialog notes accumulated since the last call. */
  drainDialogs(): string[] {
    const out = this.dialogBuffer;
    this.dialogBuffer = [];
    return out;
  }

  /** Every dialog auto-handled during the run, for the report. */
  dialogRecords(): DialogRecord[] {
    return this.allDialogs;
  }

  /** Files fed to native file choosers during the run, for the report. */
  uploads(): string[] {
    return this.uploadLog;
  }

  /** Drain download notes accumulated since the last call (for the agent). */
  drainDownloads(): string[] {
    const out = this.downloadBuffer;
    this.downloadBuffer = [];
    return out;
  }

  /** Every download captured during the run, for the report. */
  downloadRecords(): DownloadRecord[] {
    return this.allDownloads;
  }

  /** Declared network stubs paired with how many requests each actually served. */
  mockActivity(): Array<{ description: string; hits: number }> {
    return (this.opts.mocks ?? []).map((m, i) => ({
      description: describeMock(m),
      hits: this.mockHitCounts[i] ?? 0,
    }));
  }

  /** Diagnostics gathered so far (deduped, capped). */
  diags(): Diagnostic[] {
    return this.diagnostics.list();
  }

  /** Main-document response headers from the initial navigation. */
  mainResponseHeaders(): Record<string, string> {
    return this.mainHeaders;
  }

  /** ARIA live-region announcements (toasts/status) seen during the run, deduped. */
  async liveAnnouncements(): Promise<string[]> {
    const list = await this.page
      .evaluate(() => (window as unknown as { __snLive?: string[] }).__snLive ?? [])
      .catch(() => []);
    return Array.from(new Set(list)).slice(-20);
  }

  /** Text the app copied to the clipboard during the run (newest last). */
  async clipboardWrites(): Promise<string[]> {
    return this.page
      .evaluate(() => (window as unknown as { __snClip?: string[] }).__snClip ?? [])
      .catch(() => []);
  }

  /** Take the whole context offline / back online (for offline-behavior tests). */
  async setOffline(offline: boolean): Promise<void> {
    await this.context.setOffline(offline);
  }

  /** Whether a TOTP secret is configured for 2FA login. */
  hasTotp(): boolean {
    return !!this.opts.totpSecret;
  }

  /** The current 6-digit TOTP code, computed fresh from the configured secret. */
  currentTotp(): string | undefined {
    return this.opts.totpSecret ? totp(this.opts.totpSecret) : undefined;
  }

  /** Next configured upload file for a drag-drop (rotates, shared with the file chooser). */
  nextUploadFile(): string | undefined {
    const list = this.opts.uploads ?? [];
    if (!list.length) return undefined;
    const f = list[this.uploadIndex % list.length];
    this.uploadIndex++;
    this.uploadLog.push(describeUpload([f]));
    return f;
  }

  /** Current cookies with their security flags (for the security audit). */
  async cookies(): Promise<Array<{ name: string; httpOnly?: boolean; secure?: boolean; sameSite?: string }>> {
    const ck = await this.context.cookies().catch(() => []);
    return ck.map((c) => ({ name: c.name, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite }));
  }

  /** Flat log of every HTTP response observed (for request expectations). */
  requestLog(): RequestRecord[] {
    return this.requestLogArr;
  }

  /**
   * Snapshot the persisted browser state (cookies + local/session storage) for
   * state assertions. Storage is read from the active page's origin; cookies
   * span the context. Failures degrade to empty maps rather than throwing.
   */
  async stateSnapshot(): Promise<StateSnapshot> {
    const cookies: Record<string, string> = {};
    for (const c of await this.context.cookies().catch(() => [])) cookies[c.name] = c.value;
    const read = (which: "localStorage" | "sessionStorage") =>
      this.page
        .evaluate((w) => {
          const store = (window as unknown as Record<string, Storage>)[w];
          const out: Record<string, string> = {};
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k != null) out[k] = store.getItem(k) ?? "";
          }
          return out;
        }, which)
        .catch(() => ({}) as Record<string, string>);
    const [localStorage, sessionStorage] = await Promise.all([read("localStorage"), read("sessionStorage")]);
    return { cookies, localStorage, sessionStorage };
  }

  /**
   * Navigate, reporting outcome. A thrown navigation (DNS failure, connection
   * refused, timeout) is retried once before being returned as `ok:false`.
   * A loaded page with a 4xx/5xx main document is `ok:true` with the status so
   * the caller can decide (some apps render content under an error status).
   */
  async goto(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await this.page.goto(url, { waitUntil: "domcontentloaded" });
        // Capture the main-document response headers for the security audit.
        if (resp) this.mainHeaders = await resp.allHeaders().catch(() => ({}));
        await this.settle();
        return { ok: true, status: resp?.status() };
      } catch (err) {
        if (attempt === 0) {
          await this.page.waitForTimeout(1000);
          continue;
        }
        return { ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
      }
    }
    return { ok: false, error: "navigation failed" };
  }

  /** Best-effort wait for the page to stop changing AND finish rendering. */
  async settle(): Promise<void> {
    try {
      await this.page.waitForLoadState("networkidle", { timeout: 4000 });
    } catch {
      /* networkidle is best-effort; many apps poll forever */
    }
    await this.waitForContent();
  }

  /**
   * Network-idle fires before an SPA finishes client-side rendering, so the
   * first observation can be an empty "Loading…" shell. Poll briefly until the
   * page has real content (or the cap elapses) so the agent sees the app, not
   * a spinner. Best-effort — never throws.
   */
  async waitForContent(maxMs = 4000): Promise<void> {
    for (let waited = 0; waited < maxMs; waited += 400) {
      let sig;
      try {
        sig = await this.page.evaluate(() => ({
          ariaBusy: !!document.querySelector('[aria-busy="true"],[role="progressbar"]'),
          interactive: document.querySelectorAll("a[href],button,input,select,textarea,[role=button]").length,
          text: (document.body?.innerText ?? "").trim().slice(0, 200),
        }));
      } catch {
        return;
      }
      if (!looksLoading(sig)) return;
      await this.page.waitForTimeout(400);
    }
  }

  async snapshot(): Promise<FrameSnapshot> {
    const snap = await snapshot(this.page, { hasTotp: !!this.opts.totpSecret });
    this.owner = snap.owner;
    return snap;
  }

  /**
   * Resolve a snapshot index to a live locator inside the frame that owns it.
   * Falls back to the main frame if the index predates the latest snapshot.
   */
  locator(index: number): Locator {
    const frame = this.owner.get(index) ?? this.page.mainFrame();
    return frame.locator(`[data-sn-idx="${index}"]`);
  }

  /** Capture a PNG buffer of the page (full page by default) for visual diffing. */
  async screenshotBuffer(fullPage = true): Promise<Buffer> {
    return this.page.screenshot({ type: "png", fullPage });
  }

  /** Capture the viewport as a base64 PNG for vision-mode observations. */
  async screenshotBase64(): Promise<{ data: string; mediaType: "image/png"; width: number; height: number }> {
    const buf = await this.page.screenshot({ type: "png", fullPage: false });
    const vp = this.page.viewportSize() ?? this.opts.viewport ?? { width: 1280, height: 800 };
    return { data: buf.toString("base64"), mediaType: "image/png", width: vp.width, height: vp.height };
  }

  /** Delete a previously-saved artifact (e.g. a screenshot that showed a secret). */
  removeArtifact(name: string): void {
    try {
      fs.rmSync(path.join(this.opts.artifactsDir, name), { force: true });
    } catch {
      /* best-effort */
    }
  }

  async screenshot(label = "step"): Promise<string> {
    const name = `${String(this.shotCounter++).padStart(3, "0")}-${label}.png`;
    const full = path.join(this.opts.artifactsDir, name);
    try {
      await this.page.screenshot({ path: full, fullPage: false });
    } catch {
      return "";
    }
    return name;
  }

  url(): string {
    return this.page.url();
  }

  /** Persist cookies + localStorage so a later session can resume authenticated. */
  async saveStorageState(file: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await this.context.storageState({ path: file });
  }

  /** Filename (relative to the artifacts dir) of the recorded video, if any. */
  videoFile: string | null = null;

  async close(): Promise<void> {
    try {
      await this.context.tracing.stop({
        path: path.join(this.opts.artifactsDir, "trace.zip"),
      });
    } catch {
      /* ignore */
    }
    // Capture the video handle, then close the CONTEXT (not just the browser) —
    // that's what finalizes and flushes the recording to disk. Guard with `?.`
    // so that if start() threw before the context existed (e.g. the browser
    // binary is missing), close() — run from the caller's finally — stays silent
    // and the ORIGINAL launch error surfaces instead of a masking TypeError.
    const video = this.opts.video ? this.page?.video() ?? null : null;
    await this.context?.close().catch(() => {});
    if (video) {
      try {
        this.videoFile = path.basename(await video.path());
      } catch {
        this.videoFile = null;
      }
    }
    await this.browser?.close().catch(() => {});
  }
}
