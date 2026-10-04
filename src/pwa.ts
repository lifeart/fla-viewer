// Service worker registration and the "update available" / "ready offline" notice.
// The worker itself is generated at build time by vite-plugin-pwa (vite.config.ts).

/** The subset of vite-plugin-pwa's `registerSW` this module uses. */
export type RegisterSW = (options: {
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisterError?: (error: unknown) => void;
}) => (reloadPage?: boolean) => Promise<void>;

const OFFLINE_READY_MS = 4000;

/**
 * Register the service worker and show a notice in `container`: once when the
 * app is first cached for offline use, and whenever a new version is waiting.
 * A waiting version only takes over when the user clicks Reload, so a session
 * in progress keeps its own build (and the export chunks it may still load).
 */
export function setupServiceWorker(registerSW: RegisterSW, container: HTMLElement = document.body): void {
  let notice: HTMLElement | null = null;
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
        { label: 'Reload', onClick: () => { void updateSW(true); } },
        { label: 'Later', onClick: close },
      ]);
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
