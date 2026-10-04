import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupServiceWorker, type RegisterSW } from '../pwa';

type Callbacks = Parameters<RegisterSW>[0];

function fakeRegister() {
  let callbacks: Callbacks = {};
  const updateSW = vi.fn(async (_reload?: boolean) => {});
  const register: RegisterSW = (options) => {
    callbacks = options;
    return updateSW;
  };
  return { register, updateSW, callbacks: () => callbacks };
}

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.pwa-notice button')];
}

describe('setupServiceWorker', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows nothing until the worker reports something', () => {
    const sw = fakeRegister();
    setupServiceWorker(sw.register, container);
    expect(container.querySelector('.pwa-notice')).toBeNull();
  });

  it('says once when the app is ready offline, then hides by itself', () => {
    vi.useFakeTimers();
    const sw = fakeRegister();
    setupServiceWorker(sw.register, container);

    sw.callbacks().onOfflineReady!();
    const notice = container.querySelector('.pwa-notice')!;
    expect(notice.textContent).toContain('ready to work offline');
    expect(notice.getAttribute('role')).toBe('status');

    vi.advanceTimersByTime(4000);
    expect(container.querySelector('.pwa-notice')).toBeNull();
  });

  it('closes the offline notice on OK', () => {
    const sw = fakeRegister();
    setupServiceWorker(sw.register, container);
    sw.callbacks().onOfflineReady!();
    buttons(container)[0].click();
    expect(container.querySelector('.pwa-notice')).toBeNull();
  });

  it('activates a waiting update only when the user clicks Reload', () => {
    const sw = fakeRegister();
    setupServiceWorker(sw.register, container);

    sw.callbacks().onNeedRefresh!();
    expect(container.querySelector('.pwa-notice')!.textContent).toContain('new version');
    expect(sw.updateSW).not.toHaveBeenCalled();

    const [reload] = buttons(container);
    expect(reload.textContent).toBe('Reload');
    reload.click();
    expect(sw.updateSW).toHaveBeenCalledWith(true);
  });

  it('keeps the current version on Later', () => {
    const sw = fakeRegister();
    setupServiceWorker(sw.register, container);
    sw.callbacks().onNeedRefresh!();
    const later = buttons(container)[1];
    expect(later.textContent).toBe('Later');
    later.click();
    expect(container.querySelector('.pwa-notice')).toBeNull();
    expect(sw.updateSW).not.toHaveBeenCalled();
  });

  it('shows one notice at a time, and an update notice is not auto-hidden', () => {
    vi.useFakeTimers();
    const sw = fakeRegister();
    setupServiceWorker(sw.register, container);

    sw.callbacks().onOfflineReady!();
    sw.callbacks().onNeedRefresh!();
    expect(container.querySelectorAll('.pwa-notice').length).toBe(1);

    vi.advanceTimersByTime(10000);
    expect(container.querySelector('.pwa-notice')!.textContent).toContain('new version');
  });

  it('warns, without a notice, when registration fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sw = fakeRegister();
    setupServiceWorker(sw.register, container);
    sw.callbacks().onRegisterError!(new Error('blocked'));
    expect(warn).toHaveBeenCalled();
    expect(container.querySelector('.pwa-notice')).toBeNull();
  });
});
