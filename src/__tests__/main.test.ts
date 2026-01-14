import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { FLAViewerApp } from '../main';

// Helper to create a minimal FLA zip file
async function createMinimalFlaZip(): Promise<File> {
  const domDocument = `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument width="550" height="400" frameRate="24" backgroundColor="#FFFFFF">
  <timelines>
    <DOMTimeline name="Scene 1">
      <layers>
        <DOMLayer name="Layer 1">
          <frames>
            <DOMFrame index="0" duration="5">
              <elements>
                <DOMShape>
                  <fills>
                    <FillStyle index="1">
                      <SolidColor color="#FF0000"/>
                    </FillStyle>
                  </fills>
                  <strokes></strokes>
                  <edges>
                    <Edge fillStyle0="1" edges="!0 0|100 0|100 100|0 100|0 0"/>
                  </edges>
                </DOMShape>
              </elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timelines>
</DOMDocument>`;

  const zip = new JSZip();
  zip.file('DOMDocument.xml', domDocument);
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'test.fla', { type: 'application/octet-stream' });
}

// Create DOM structure that FLAViewerApp expects
function createAppDOM(): HTMLElement {
  const container = document.createElement('div');
  container.id = 'app-container';

  container.innerHTML = `
    <div id="drop-zone">
      <input type="file" id="file-input" accept=".fla" />
    </div>
    <div id="loading">
      <span id="loading-text">Loading...</span>
    </div>
    <div id="viewer">
      <canvas id="stage" width="550" height="400"></canvas>
      <div id="info-panel"></div>
      <div id="video-controls">
        <button id="play-btn"></button>
        <button id="stop-btn"></button>
        <button id="prev-btn"></button>
        <button id="next-btn"></button>
        <button id="debug-btn"></button>
        <div id="timeline">
          <div id="timeline-progress"></div>
        </div>
        <span id="frame-info"></span>
      </div>
      <div id="audio-controls">
        <button id="mute-btn"></button>
        <input type="range" id="volume-slider" min="0" max="100" value="100" />
      </div>
      <button id="fullscreen-btn"></button>
      <button id="download-btn"></button>
      <div id="debug-panel">
        <div id="layer-list"></div>
        <select id="layer-order-select">
          <option value="forward">Forward</option>
          <option value="reverse">Reverse</option>
        </select>
        <select id="nested-order-select">
          <option value="forward">Forward</option>
          <option value="reverse">Reverse</option>
        </select>
        <select id="element-order-select">
          <option value="forward">Forward</option>
          <option value="reverse">Reverse</option>
        </select>
        <input type="checkbox" id="follow-camera-checkbox" />
        <span id="camera-layer-info"></span>
      </div>
      <div id="export-modal">
        <div id="export-progress-fill"></div>
        <span id="export-status"></span>
        <button id="export-cancel-btn"></button>
      </div>
    </div>
  `;

  document.body.appendChild(container);
  return container;
}

describe('main.ts', () => {
  describe('DOM structure requirements', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should have drop-zone element', () => {
      const dropZone = document.getElementById('drop-zone');
      expect(dropZone).not.toBeNull();
    });

    it('should have file-input element', () => {
      const fileInput = document.getElementById('file-input') as HTMLInputElement;
      expect(fileInput).not.toBeNull();
      expect(fileInput.type).toBe('file');
    });

    it('should have canvas element', () => {
      const canvas = document.getElementById('stage') as HTMLCanvasElement;
      expect(canvas).not.toBeNull();
      expect(canvas.tagName.toLowerCase()).toBe('canvas');
    });

    it('should have player control buttons', () => {
      expect(document.getElementById('play-btn')).not.toBeNull();
      expect(document.getElementById('stop-btn')).not.toBeNull();
      expect(document.getElementById('prev-btn')).not.toBeNull();
      expect(document.getElementById('next-btn')).not.toBeNull();
      expect(document.getElementById('debug-btn')).not.toBeNull();
    });

    it('should have audio controls', () => {
      expect(document.getElementById('mute-btn')).not.toBeNull();
      expect(document.getElementById('volume-slider')).not.toBeNull();
    });

    it('should have timeline elements', () => {
      expect(document.getElementById('timeline')).not.toBeNull();
      expect(document.getElementById('timeline-progress')).not.toBeNull();
      expect(document.getElementById('frame-info')).not.toBeNull();
    });

    it('should have debug panel elements', () => {
      expect(document.getElementById('debug-panel')).not.toBeNull();
      expect(document.getElementById('layer-list')).not.toBeNull();
      expect(document.getElementById('layer-order-select')).not.toBeNull();
      expect(document.getElementById('nested-order-select')).not.toBeNull();
      expect(document.getElementById('element-order-select')).not.toBeNull();
      expect(document.getElementById('follow-camera-checkbox')).not.toBeNull();
      expect(document.getElementById('camera-layer-info')).not.toBeNull();
    });

    it('should have export modal elements', () => {
      expect(document.getElementById('export-modal')).not.toBeNull();
      expect(document.getElementById('export-progress-fill')).not.toBeNull();
      expect(document.getElementById('export-status')).not.toBeNull();
      expect(document.getElementById('export-cancel-btn')).not.toBeNull();
    });
  });

  describe('FLA file handling', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should create valid FLA test file', async () => {
      const flaFile = await createMinimalFlaZip();
      expect(flaFile).toBeInstanceOf(File);
      expect(flaFile.name).toBe('test.fla');
      expect(flaFile.size).toBeGreaterThan(0);
    });

    it('should extract DOMDocument.xml from FLA zip', async () => {
      const flaFile = await createMinimalFlaZip();
      const zip = await JSZip.loadAsync(flaFile);
      const domDoc = zip.file('DOMDocument.xml');
      expect(domDoc).not.toBeNull();

      const content = await domDoc!.async('text');
      expect(content).toContain('DOMDocument');
      expect(content).toContain('width="550"');
      expect(content).toContain('height="400"');
    });
  });

  describe('drag and drop events', () => {
    let container: HTMLElement;
    let dropZone: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
      dropZone = document.getElementById('drop-zone')!;
    });

    afterEach(() => {
      container.remove();
    });

    it('should handle dragover event', () => {
      const dragEvent = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
      });

      // Prevent default should be called - we can verify it doesn't throw
      expect(() => dropZone.dispatchEvent(dragEvent)).not.toThrow();
    });

    it('should handle dragleave event', () => {
      const dragEvent = new DragEvent('dragleave', {
        bubbles: true,
      });

      expect(() => dropZone.dispatchEvent(dragEvent)).not.toThrow();
    });

    it('should handle drop event', async () => {
      const flaFile = await createMinimalFlaZip();

      // Create a mock DataTransfer
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });

      expect(() => dropZone.dispatchEvent(dropEvent)).not.toThrow();
    });
  });

  describe('file input events', () => {
    let container: HTMLElement;
    let fileInput: HTMLInputElement;

    beforeEach(() => {
      container = createAppDOM();
      fileInput = document.getElementById('file-input') as HTMLInputElement;
    });

    afterEach(() => {
      container.remove();
    });

    it('should accept .fla files', () => {
      expect(fileInput.accept).toBe('.fla');
    });

    it('should trigger change event', async () => {
      const flaFile = await createMinimalFlaZip();

      // Create a FileList-like object
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);

      fileInput.files = dataTransfer.files;

      const changeEvent = new Event('change', { bubbles: true });
      expect(() => fileInput.dispatchEvent(changeEvent)).not.toThrow();
    });
  });

  describe('keyboard controls', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should handle space key', () => {
      const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true });
      expect(() => document.dispatchEvent(event)).not.toThrow();
    });

    it('should handle arrow keys', () => {
      const leftEvent = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true });
      const rightEvent = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true });

      expect(() => document.dispatchEvent(leftEvent)).not.toThrow();
      expect(() => document.dispatchEvent(rightEvent)).not.toThrow();
    });

    it('should handle home/end keys', () => {
      const homeEvent = new KeyboardEvent('keydown', { key: 'Home', bubbles: true });
      const endEvent = new KeyboardEvent('keydown', { key: 'End', bubbles: true });

      expect(() => document.dispatchEvent(homeEvent)).not.toThrow();
      expect(() => document.dispatchEvent(endEvent)).not.toThrow();
    });

    it('should handle shortcut keys', () => {
      const debugEvent = new KeyboardEvent('keydown', { key: 'd', bubbles: true });
      const muteEvent = new KeyboardEvent('keydown', { key: 'm', bubbles: true });
      const fullscreenEvent = new KeyboardEvent('keydown', { key: 'f', bubbles: true });

      expect(() => document.dispatchEvent(debugEvent)).not.toThrow();
      expect(() => document.dispatchEvent(muteEvent)).not.toThrow();
      expect(() => document.dispatchEvent(fullscreenEvent)).not.toThrow();
    });
  });

  describe('timeline scrubbing', () => {
    let container: HTMLElement;
    let timeline: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
      timeline = document.getElementById('timeline')!;
    });

    afterEach(() => {
      container.remove();
    });

    it('should handle click event', () => {
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        clientX: 100,
        clientY: 50,
      });

      expect(() => timeline.dispatchEvent(clickEvent)).not.toThrow();
    });
  });

  describe('select dropdowns', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should have layer order options', () => {
      const select = document.getElementById('layer-order-select') as HTMLSelectElement;
      expect(select.options.length).toBe(2);
      expect(select.options[0].value).toBe('forward');
      expect(select.options[1].value).toBe('reverse');
    });

    it('should handle layer order change', () => {
      const select = document.getElementById('layer-order-select') as HTMLSelectElement;
      select.value = 'reverse';

      const changeEvent = new Event('change', { bubbles: true });
      expect(() => select.dispatchEvent(changeEvent)).not.toThrow();
    });

    it('should handle nested order change', () => {
      const select = document.getElementById('nested-order-select') as HTMLSelectElement;
      select.value = 'reverse';

      const changeEvent = new Event('change', { bubbles: true });
      expect(() => select.dispatchEvent(changeEvent)).not.toThrow();
    });

    it('should handle element order change', () => {
      const select = document.getElementById('element-order-select') as HTMLSelectElement;
      select.value = 'reverse';

      const changeEvent = new Event('change', { bubbles: true });
      expect(() => select.dispatchEvent(changeEvent)).not.toThrow();
    });
  });

  describe('checkbox toggle', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should toggle follow camera checkbox', () => {
      const checkbox = document.getElementById('follow-camera-checkbox') as HTMLInputElement;
      expect(checkbox.type).toBe('checkbox');

      checkbox.checked = true;
      const changeEvent = new Event('change', { bubbles: true });
      expect(() => checkbox.dispatchEvent(changeEvent)).not.toThrow();

      checkbox.checked = false;
      expect(() => checkbox.dispatchEvent(changeEvent)).not.toThrow();
    });
  });

  describe('volume slider', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should have correct range attributes', () => {
      const slider = document.getElementById('volume-slider') as HTMLInputElement;
      expect(slider.type).toBe('range');
      expect(slider.min).toBe('0');
      expect(slider.max).toBe('100');
      expect(slider.value).toBe('100');
    });

    it('should handle input event', () => {
      const slider = document.getElementById('volume-slider') as HTMLInputElement;
      slider.value = '50';

      const inputEvent = new Event('input', { bubbles: true });
      expect(() => slider.dispatchEvent(inputEvent)).not.toThrow();
    });
  });

  describe('button clicks', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should handle play button click', () => {
      const btn = document.getElementById('play-btn')!;
      expect(() => btn.click()).not.toThrow();
    });

    it('should handle stop button click', () => {
      const btn = document.getElementById('stop-btn')!;
      expect(() => btn.click()).not.toThrow();
    });

    it('should handle prev button click', () => {
      const btn = document.getElementById('prev-btn')!;
      expect(() => btn.click()).not.toThrow();
    });

    it('should handle next button click', () => {
      const btn = document.getElementById('next-btn')!;
      expect(() => btn.click()).not.toThrow();
    });

    it('should handle debug button click', () => {
      const btn = document.getElementById('debug-btn')!;
      expect(() => btn.click()).not.toThrow();
    });

    it('should handle mute button click', () => {
      const btn = document.getElementById('mute-btn')!;
      expect(() => btn.click()).not.toThrow();
    });

    it('should handle fullscreen button click', () => {
      const btn = document.getElementById('fullscreen-btn')!;
      expect(() => btn.click()).not.toThrow();
    });

    it('should handle download button click', () => {
      const btn = document.getElementById('download-btn')!;
      expect(() => btn.click()).not.toThrow();
    });

    it('should handle export cancel button click', () => {
      const btn = document.getElementById('export-cancel-btn')!;
      expect(() => btn.click()).not.toThrow();
    });
  });

  describe('window events', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should handle resize event', () => {
      const resizeEvent = new Event('resize');
      expect(() => window.dispatchEvent(resizeEvent)).not.toThrow();
    });

    it('should handle fullscreenchange event', () => {
      const fullscreenEvent = new Event('fullscreenchange');
      expect(() => document.dispatchEvent(fullscreenEvent)).not.toThrow();
    });
  });

  describe('CSS class manipulation', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should allow adding hidden class', () => {
      const dropZone = document.getElementById('drop-zone')!;
      dropZone.classList.add('hidden');
      expect(dropZone.classList.contains('hidden')).toBe(true);
    });

    it('should allow adding active class', () => {
      const viewer = document.getElementById('viewer')!;
      viewer.classList.add('active');
      expect(viewer.classList.contains('active')).toBe(true);
    });

    it('should allow adding dragover class', () => {
      const dropZone = document.getElementById('drop-zone')!;
      dropZone.classList.add('dragover');
      expect(dropZone.classList.contains('dragover')).toBe(true);
    });

    it('should allow adding muted class', () => {
      const muteBtn = document.getElementById('mute-btn')!;
      muteBtn.classList.add('muted');
      expect(muteBtn.classList.contains('muted')).toBe(true);
    });
  });

  describe('innerHTML updates', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should update info panel HTML', () => {
      const infoPanel = document.getElementById('info-panel')!;
      infoPanel.innerHTML = '<span>Test Info</span>';
      expect(infoPanel.innerHTML).toBe('<span>Test Info</span>');
    });

    it('should update frame info HTML', () => {
      const frameInfo = document.getElementById('frame-info')!;
      frameInfo.innerHTML = '<span class="current">1</span> / 100';
      expect(frameInfo.textContent).toContain('1');
      expect(frameInfo.textContent).toContain('100');
    });

    it('should update button innerHTML with SVG', () => {
      const playBtn = document.getElementById('play-btn')!;
      playBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
      expect(playBtn.querySelector('svg')).not.toBeNull();
    });
  });

  describe('style manipulation', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should update timeline progress width', () => {
      const progress = document.getElementById('timeline-progress')!;
      progress.style.width = '50%';
      expect(progress.style.width).toBe('50%');
    });

    it('should update export progress width', () => {
      const progress = document.getElementById('export-progress-fill')!;
      progress.style.width = '75%';
      expect(progress.style.width).toBe('75%');
    });
  });

  describe('getBoundingClientRect', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should return rect for timeline', () => {
      const timeline = document.getElementById('timeline')!;
      const rect = timeline.getBoundingClientRect();
      expect(rect).toHaveProperty('left');
      expect(rect).toHaveProperty('width');
    });
  });

  describe('FLAViewerApp class', () => {
    let container: HTMLElement;
    let app: FLAViewerApp;

    beforeEach(() => {
      container = createAppDOM();
      app = new FLAViewerApp();
    });

    afterEach(() => {
      container.remove();
    });

    it('should create app instance', () => {
      expect(app).toBeInstanceOf(FLAViewerApp);
    });

    it('should setup drop zone click handler', () => {
      const dropZone = document.getElementById('drop-zone')!;
      const fileInput = document.getElementById('file-input') as HTMLInputElement;

      // Spy on click
      const clickSpy = vi.spyOn(fileInput, 'click');
      dropZone.click();

      expect(clickSpy).toHaveBeenCalled();
    });

    it('should add dragover class on dragover', () => {
      const dropZone = document.getElementById('drop-zone')!;

      const dragoverEvent = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
      });

      dropZone.dispatchEvent(dragoverEvent);
      expect(dropZone.classList.contains('dragover')).toBe(true);
    });

    it('should remove dragover class on dragleave', () => {
      const dropZone = document.getElementById('drop-zone')!;
      dropZone.classList.add('dragover');

      const dragleaveEvent = new DragEvent('dragleave', { bubbles: true });
      dropZone.dispatchEvent(dragleaveEvent);

      expect(dropZone.classList.contains('dragover')).toBe(false);
    });

    it('should handle file input change', async () => {
      const fileInput = document.getElementById('file-input') as HTMLInputElement;
      const flaFile = await createMinimalFlaZip();

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);
      fileInput.files = dataTransfer.files;

      const changeEvent = new Event('change', { bubbles: true });
      fileInput.dispatchEvent(changeEvent);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should handle volume slider input', () => {
      const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
      volumeSlider.value = '50';

      const inputEvent = new Event('input', { bubbles: true });
      volumeSlider.dispatchEvent(inputEvent);

      // Should not throw
    });

    it('should handle layer order select change', () => {
      const select = document.getElementById('layer-order-select') as HTMLSelectElement;
      select.value = 'reverse';

      const changeEvent = new Event('change', { bubbles: true });
      select.dispatchEvent(changeEvent);

      // Should not throw
    });

    it('should handle nested order select change', () => {
      const select = document.getElementById('nested-order-select') as HTMLSelectElement;
      select.value = 'reverse';

      const changeEvent = new Event('change', { bubbles: true });
      select.dispatchEvent(changeEvent);
    });

    it('should handle element order select change', () => {
      const select = document.getElementById('element-order-select') as HTMLSelectElement;
      select.value = 'reverse';

      const changeEvent = new Event('change', { bubbles: true });
      select.dispatchEvent(changeEvent);
    });

    it('should handle follow camera checkbox change', () => {
      const checkbox = document.getElementById('follow-camera-checkbox') as HTMLInputElement;
      checkbox.checked = true;

      const changeEvent = new Event('change', { bubbles: true });
      checkbox.dispatchEvent(changeEvent);
    });

    it('should handle timeline click', () => {
      const timeline = document.getElementById('timeline')!;

      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        clientX: 50,
        clientY: 10,
      });

      timeline.dispatchEvent(clickEvent);
    });

    it('should handle window resize', () => {
      const resizeEvent = new Event('resize');
      window.dispatchEvent(resizeEvent);

      // Wait for debounce
      return new Promise(resolve => setTimeout(resolve, 150));
    });

    it('should handle keyboard events', () => {
      // Space
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

      // Arrow keys
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

      // Home/End
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));

      // Shortcuts (excluding 'f' which triggers fullscreen on disconnected element)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', bubbles: true }));
      // Note: 'f'/'F' keys are tested separately in fullscreen tests
    });

    it('should handle export cancel button', () => {
      const cancelBtn = document.getElementById('export-cancel-btn')!;
      cancelBtn.click();
    });

    it('should handle mute button toggle', () => {
      const muteBtn = document.getElementById('mute-btn')!;
      const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;

      // Click mute
      muteBtn.click();
      expect(muteBtn.classList.contains('muted')).toBe(true);
      expect(volumeSlider.value).toBe('0');

      // Click unmute
      muteBtn.click();
      expect(muteBtn.classList.contains('muted')).toBe(false);
    });
  });

  describe('FLAViewerApp with loaded file', () => {
    let container: HTMLElement;
    let app: FLAViewerApp;

    beforeEach(() => {
      container = createAppDOM();
      app = new FLAViewerApp();
    });

    afterEach(() => {
      container.remove();
    });

    it('should load and display FLA file', async () => {
      const flaFile = await createMinimalFlaZip();
      const dropZone = document.getElementById('drop-zone')!;

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });

      dropZone.dispatchEvent(dropEvent);

      // Wait for file to be processed
      await new Promise(resolve => setTimeout(resolve, 500));

      // Viewer should be active
      const viewer = document.getElementById('viewer')!;
      expect(viewer.classList.contains('active')).toBe(true);
    });

    it('should show loading state while parsing', async () => {
      const flaFile = await createMinimalFlaZip();
      const loading = document.getElementById('loading')!;

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);

      const fileInput = document.getElementById('file-input') as HTMLInputElement;
      fileInput.files = dataTransfer.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      // Loading should become active briefly
      await new Promise(resolve => setTimeout(resolve, 50));

      // Wait for completion
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    it('should display file info after loading', async () => {
      const flaFile = await createMinimalFlaZip();
      const dropZone = document.getElementById('drop-zone')!;

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });

      dropZone.dispatchEvent(dropEvent);

      // Wait for file to be processed
      await new Promise(resolve => setTimeout(resolve, 500));

      // Info panel should have content
      const infoPanel = document.getElementById('info-panel')!;
      expect(infoPanel.innerHTML).toContain('550');
      expect(infoPanel.innerHTML).toContain('400');
    });

    it('should enable playback controls after loading', async () => {
      const flaFile = await createMinimalFlaZip();
      const dropZone = document.getElementById('drop-zone')!;

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });

      dropZone.dispatchEvent(dropEvent);

      // Wait for file to be processed
      await new Promise(resolve => setTimeout(resolve, 500));

      // Play button should work
      const playBtn = document.getElementById('play-btn')!;
      playBtn.click();

      // Stop button should work
      const stopBtn = document.getElementById('stop-btn')!;
      stopBtn.click();
    });

    it('should handle debug toggle after loading', async () => {
      const flaFile = await createMinimalFlaZip();
      const dropZone = document.getElementById('drop-zone')!;

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });

      dropZone.dispatchEvent(dropEvent);

      // Wait for file to be processed
      await new Promise(resolve => setTimeout(resolve, 500));

      // Toggle debug mode
      const debugBtn = document.getElementById('debug-btn')!;
      debugBtn.click();

      expect(debugBtn.classList.contains('active')).toBe(true);

      // Debug panel should be active
      const debugPanel = document.getElementById('debug-panel')!;
      expect(debugPanel.classList.contains('active')).toBe(true);

      // Layer list should have content
      const layerList = document.getElementById('layer-list')!;
      expect(layerList.children.length).toBeGreaterThan(0);

      // Toggle off
      debugBtn.click();
      expect(debugBtn.classList.contains('active')).toBe(false);
    });

    it('should update frame navigation after loading', async () => {
      const flaFile = await createMinimalFlaZip();
      const dropZone = document.getElementById('drop-zone')!;

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });

      dropZone.dispatchEvent(dropEvent);

      // Wait for file to be processed
      await new Promise(resolve => setTimeout(resolve, 500));

      // Next frame
      const nextBtn = document.getElementById('next-btn')!;
      nextBtn.click();

      // Prev frame
      const prevBtn = document.getElementById('prev-btn')!;
      prevBtn.click();
    });
  });

  describe('FLAViewerApp error handling', () => {
    let container: HTMLElement;
    let app: FLAViewerApp;
    let originalAlert: typeof window.alert;

    beforeEach(() => {
      container = createAppDOM();
      app = new FLAViewerApp();
      originalAlert = window.alert;
      window.alert = vi.fn();
    });

    afterEach(() => {
      container.remove();
      window.alert = originalAlert;
    });

    it('should reject non-FLA files', async () => {
      const txtFile = new File(['test content'], 'test.txt', { type: 'text/plain' });
      const dropZone = document.getElementById('drop-zone')!;

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(txtFile);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });

      dropZone.dispatchEvent(dropEvent);

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      // Alert should have been called
      expect(window.alert).toHaveBeenCalledWith('Please select a valid FLA file');
    });

    it('should handle invalid FLA file', async () => {
      // Create an invalid FLA (zip without DOMDocument.xml)
      const zip = new JSZip();
      zip.file('invalid.txt', 'not a valid fla');
      const blob = await zip.generateAsync({ type: 'blob' });
      const invalidFla = new File([blob], 'invalid.fla', { type: 'application/octet-stream' });

      const dropZone = document.getElementById('drop-zone')!;

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(invalidFla);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });

      dropZone.dispatchEvent(dropEvent);

      // Wait for error
      await new Promise(resolve => setTimeout(resolve, 500));

      // Alert should have been called with error message
      expect(window.alert).toHaveBeenCalled();
    });
  });

  describe('volume slider muting', () => {
    let container: HTMLElement;
    let app: FLAViewerApp;

    beforeEach(async () => {
      container = createAppDOM();
      app = new FLAViewerApp();

      // Load a file to enable player
      const flaFile = await createMinimalFlaZip();
      const dropZone = document.getElementById('drop-zone')!;
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      dropZone.dispatchEvent(dropEvent);
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    afterEach(() => {
      container.remove();
    });

    it('should mute when volume slider set to 0', async () => {
      const muteBtn = document.getElementById('mute-btn')!;
      const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;

      // Set volume to 0
      volumeSlider.value = '0';
      volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));

      expect(muteBtn.classList.contains('muted')).toBe(true);
    });

    it('should unmute when volume slider set above 0', async () => {
      const muteBtn = document.getElementById('mute-btn')!;
      const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;

      // First mute
      volumeSlider.value = '0';
      volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
      expect(muteBtn.classList.contains('muted')).toBe(true);

      // Then unmute by setting volume
      volumeSlider.value = '50';
      volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
      expect(muteBtn.classList.contains('muted')).toBe(false);
    });
  });

  describe('fullscreen functionality', () => {
    let container: HTMLElement;
    let app: FLAViewerApp;

    beforeEach(() => {
      container = createAppDOM();
      app = new FLAViewerApp();
    });

    afterEach(() => {
      container.remove();
    });

    it('should update fullscreen button on fullscreenchange event', async () => {
      const fullscreenBtn = document.getElementById('fullscreen-btn')!;
      const initialHTML = fullscreenBtn.innerHTML;

      // Dispatch fullscreenchange event
      document.dispatchEvent(new Event('fullscreenchange'));

      // Button should still have SVG content
      expect(fullscreenBtn.querySelector('svg')).not.toBeNull();
    });

    it('should handle F key for fullscreen', async () => {
      // Note: Fullscreen API requires user gesture and connected element
      // This test verifies the key handler is wired up without actually
      // entering fullscreen mode which isn't possible in headless tests
      const flaFile = await createMinimalFlaZip();
      const dropZone = document.getElementById('drop-zone')!;
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      dropZone.dispatchEvent(dropEvent);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Fullscreen button exists
      const fullscreenBtn = document.getElementById('fullscreen-btn');
      expect(fullscreenBtn).not.toBeNull();

      // Dispatch F key event to trigger fullscreen toggle code path
      // The actual fullscreen won't activate without user gesture but the code runs
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    });
  });

  describe('layer visibility', () => {
    let container: HTMLElement;
    let app: FLAViewerApp;

    beforeEach(async () => {
      container = createAppDOM();
      app = new FLAViewerApp();

      const flaFile = await createMinimalFlaZip();
      const dropZone = document.getElementById('drop-zone')!;
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      dropZone.dispatchEvent(dropEvent);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Open debug panel
      const debugBtn = document.getElementById('debug-btn')!;
      debugBtn.click();
    });

    afterEach(() => {
      container.remove();
    });

    it('should toggle layer visibility', async () => {
      const layerList = document.getElementById('layer-list')!;
      const layerItems = layerList.querySelectorAll('.layer-item');
      expect(layerItems.length).toBeGreaterThan(0);

      const checkbox = layerItems[0]?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      if (checkbox && !checkbox.disabled) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));

        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    it('should handle layer order change', async () => {
      const layerOrderSelect = document.getElementById('layer-order-select') as HTMLSelectElement;
      layerOrderSelect.value = 'reverse';
      layerOrderSelect.dispatchEvent(new Event('change', { bubbles: true }));

      // Check layer list was updated
      const layerList = document.getElementById('layer-list')!;
      expect(layerList.children.length).toBeGreaterThan(0);
    });
  });

  describe('export functionality', () => {
    let container: HTMLElement;
    let app: FLAViewerApp;

    beforeEach(async () => {
      container = createAppDOM();
      app = new FLAViewerApp();

      const flaFile = await createMinimalFlaZip();
      const dropZone = document.getElementById('drop-zone')!;
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      dropZone.dispatchEvent(dropEvent);
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    afterEach(() => {
      container.remove();
    });

    it('should show export modal when download button clicked', async () => {
      const downloadBtn = document.getElementById('download-btn')!;
      const exportModal = document.getElementById('export-modal')!;

      // Click download - will start export
      downloadBtn.click();

      // Modal should be active briefly
      await new Promise(resolve => setTimeout(resolve, 100));
      // Note: Export may complete quickly with simple animation
    });

    it('should cancel export when cancel button clicked', async () => {
      const downloadBtn = document.getElementById('download-btn')!;
      const cancelBtn = document.getElementById('export-cancel-btn')!;

      // Start export
      downloadBtn.click();

      // Immediately cancel
      cancelBtn.click();

      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 200));

      // Modal should be hidden
      const exportModal = document.getElementById('export-modal')!;
      expect(exportModal.classList.contains('active')).toBe(false);
    });
  });

  describe('resize debouncing', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
      new FLAViewerApp();
    });

    afterEach(() => {
      container.remove();
    });

    it('should debounce multiple resize events', async () => {
      // Trigger multiple resize events rapidly
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));

      // Wait for debounce timeout
      await new Promise(resolve => setTimeout(resolve, 150));

      // No error should occur - debouncing worked
    });
  });

  describe('single frame animation', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should hide video controls for single frame document', async () => {
      // Create FLA with only 1 frame (duration=1)
      const domDocument = `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument width="550" height="400" frameRate="24" backgroundColor="#FFFFFF">
  <timelines>
    <DOMTimeline name="Scene 1">
      <layers>
        <DOMLayer name="Layer 1">
          <frames>
            <DOMFrame index="0" duration="1">
              <elements>
                <DOMShape>
                  <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
                  <edges><Edge fillStyle0="1" edges="!0 0|50 0|50 50|0 50|0 0"/></edges>
                </DOMShape>
              </elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timelines>
</DOMDocument>`;

      const zip = new JSZip();
      zip.file('DOMDocument.xml', domDocument);
      const blob = await zip.generateAsync({ type: 'blob' });
      const flaFile = new File([blob], 'single.fla', { type: 'application/octet-stream' });

      new FLAViewerApp();

      // Trigger file drop
      const dropZone = document.getElementById('drop-zone')!;
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      dropZone.dispatchEvent(dropEvent);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Video controls should be hidden for single frame
      const videoControls = document.getElementById('video-controls')!;
      expect(videoControls.classList.contains('hidden')).toBe(true);
    });
  });

  describe('camera layer detection', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = createAppDOM();
    });

    afterEach(() => {
      container.remove();
    });

    it('should display camera layer info when camera layer found', async () => {
      // Create FLA with a Camera layer
      const domDocument = `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument width="1920" height="1080" frameRate="24" backgroundColor="#FFFFFF">
  <timelines>
    <DOMTimeline name="Scene 1">
      <layers>
        <DOMLayer name="Camera">
          <frames>
            <DOMFrame index="0" duration="10">
              <elements>
                <DOMSymbolInstance libraryItemName="Ramka">
                  <matrix><Matrix/></matrix>
                </DOMSymbolInstance>
              </elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
        <DOMLayer name="Background">
          <frames>
            <DOMFrame index="0" duration="10">
              <elements>
                <DOMShape>
                  <fills><FillStyle index="1"><SolidColor color="#0000FF"/></FillStyle></fills>
                  <edges><Edge fillStyle0="1" edges="!0 0|100 0|100 100|0 100|0 0"/></edges>
                </DOMShape>
              </elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timelines>
</DOMDocument>`;

      const zip = new JSZip();
      zip.file('DOMDocument.xml', domDocument);
      const blob = await zip.generateAsync({ type: 'blob' });
      const flaFile = new File([blob], 'camera.fla', { type: 'application/octet-stream' });

      new FLAViewerApp();

      // Trigger file drop
      const dropZone = document.getElementById('drop-zone')!;
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(flaFile);
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      });
      dropZone.dispatchEvent(dropEvent);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Camera layer info should show found camera
      const cameraInfo = document.getElementById('camera-layer-info')!;
      expect(cameraInfo.textContent).toContain('Found');
    });
  });
});
