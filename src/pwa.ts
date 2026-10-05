// Service worker registration and the "update available" / "ready offline" notice.
// The worker itself is generated at build time by vite-plugin-pwa (vite.config.ts).

/** The subset of vite-plugin-pwa's `registerSW` this module uses. */
export type RegisterSW = (options: {
  onNeedRefresh?: () => void;
  onNeedReload?: () => void;
  onOfflineReady?: () => void;
  onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
  onRegisterError?: (error: unknown) => void;
}) => (reloadPage?: boolean) => Promise<void>;

const OFFLINE_READY_MS = 4000;

/**
 * Register the service worker and show a notice in `container`: once when the
 * app is first cached for offline use, and whenever a new version is waiting.
 * A waiting version only takes over when the user clicks Reload, so a session
 * in progress keeps its own build (and the export chunks it may still load).
 * When Reload is clicked in another tab, this tab is not reloaded under the
 * user (that would drop a loaded file or a running export); it says so instead.
 * A tab left open checks for a new version whenever it becomes visible again.
 */
export function setupServiceWorker(
  registerSW: RegisterSW,
  container: HTMLElement = document.body,
  reload: () => void = () => location.reload(),
): void {
  let notice: HTMLElement | null = null;
  let reloadRequested = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const close = () => {
    clearTimeout(hideTimer);
    notice?.remove();
    notice = null;
  };

  const show = (message: string, actions: { label: string; onClick: () => void }[]) => {
    close();
    notice = document.createElement('div');
    notice.className = 'pwa-notice';
    notice.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = message;
    notice.appendChild(text);
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      notice.appendChild(button);
    }
    container.appendChild(notice);
  };

  const updateSW = registerSW({
    onNeedRefresh() {
      show('A new version of FLA Viewer is available.', [
        { label: 'Reload', onClick: () => { reloadRequested = true; void updateSW(true); } },
        { label: 'Later', onClick: close },
      ]);
    },
    // The new version took control: this tab asked for it, or another tab did
    onNeedReload() {
      if (reloadRequested) {
        reload();
        return;
      }
      show('FLA Viewer was updated in another tab. Reload to use the new version (exporting offline may need it).', [
        { label: 'Reload', onClick: reload },
        { label: 'Later', onClick: close },
      ]);
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine) {
          registration.update().catch(() => {});
        }
      });
    },
    onOfflineReady() {
      show('FLA Viewer is ready to work offline.', [{ label: 'OK', onClick: close }]);
      hideTimer = setTimeout(close, OFFLINE_READY_MS);
    },
    onRegisterError(error) {
      console.warn('Service worker registration failed; the app will not work offline:', error);
    },
  });
}
