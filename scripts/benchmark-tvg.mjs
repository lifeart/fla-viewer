import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const PORT = 4174;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const PAGE_URL = `${SERVER_URL}/benchmark-tvg.html`;
const OUTPUT_PATH = 'test-results/benchmark-tvg.json';

const BASELINE_FLOORS = {
  'Number_Body-1': 98,
  'F_3_symbol-1': 79,
  'F_3_symbol-2': 80,
  'F-Hand_OL_1_F-14': 80,
  'Lipsync_MC_HNDL_1-3': 72.4,
  'color-13': 47.3,
};

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function evaluateThresholds(benchmark) {
  const failures = [];
  const { summary, results } = benchmark;

  if (summary.vectorAverage < 96) failures.push(`Vector average ${summary.vectorAverage.toFixed(1)}% is below 96%`);
  if (summary.bitmapAverage < 90) failures.push(`Bitmap average ${summary.bitmapAverage.toFixed(1)}% is below 90%`);
  if (Number.isFinite(summary.minVector) && summary.minVector < 80) failures.push(`Lowest vector score ${summary.minVector.toFixed(1)}% is below 80%`);
  if (Number.isFinite(summary.minBitmap) && summary.minBitmap < 75) failures.push(`Lowest bitmap score ${summary.minBitmap.toFixed(1)}% is below 75%`);
  if (summary.errorDiagnostics.length > 0) failures.push(`Drawings with error diagnostics: ${summary.errorDiagnostics.join(', ')}`);

  const resultMap = new Map(results.map((result) => [result.drawing, result]));
  for (const [drawing, minimum] of Object.entries(BASELINE_FLOORS)) {
    const result = resultMap.get(drawing);
    if (!result) {
      failures.push(`Missing benchmark anchor ${drawing}`);
      continue;
    }
    if (result.score < minimum) {
      failures.push(`${drawing} scored ${result.score.toFixed(1)}%, below required ${minimum.toFixed(1)}%`);
    }
  }

  return failures;
}

function collectFocusedWarnings(benchmark) {
  const { results } = benchmark;
  return results
    .filter((result) => result.score >= 90 && result.normalizedScore <= 10 && result.foregroundIou <= 5)
    .map((result) => `${result.drawing} aligned=${result.score.toFixed(1)} focused=${result.normalizedScore.toFixed(1)} iou=${result.foregroundIou.toFixed(1)}`);
}

async function main() {
  mkdirSync('test-results', { recursive: true });

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const server = spawn(npmCmd, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
    detached: true,
  });

  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  let browser;
  try {
    await waitForServer(PAGE_URL);
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.waitForFunction(() => window.__benchmarkDone === true, { timeout: 120000 });
    const benchmark = await page.evaluate(() => window.__benchmarkResult);
    writeFileSync(OUTPUT_PATH, JSON.stringify(benchmark, null, 2));

    if (benchmark?.error) {
      throw new Error(`Benchmark page failed: ${benchmark.error}`);
    }

    const failures = evaluateThresholds(benchmark);
    const focusedWarnings = collectFocusedWarnings(benchmark);
    if (failures.length > 0) {
      console.error('TVG benchmark failed:');
      for (const failure of failures) {
        console.error(`- ${failure}`);
      }
      if (focusedWarnings.length > 0) {
        console.error('Focused-score warnings:');
        for (const warning of focusedWarnings) {
          console.error(`- ${warning}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    if (focusedWarnings.length > 0) {
      console.warn('TVG benchmark focused-score warnings:');
      for (const warning of focusedWarnings) {
        console.warn(`- ${warning}`);
      }
    }
    console.log(`TVG benchmark passed. Results written to ${OUTPUT_PATH}`);
  } finally {
    if (browser) await browser.close();
    if (server.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
