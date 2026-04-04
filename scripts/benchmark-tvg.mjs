import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const PORT = 4174;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const PAGE_URL = `${SERVER_URL}/benchmark-tvg.html`;
const OUTPUT_PATH = 'test-results/benchmark-tvg.json';
const RAW_OUTPUT_PATH = 'test-results/benchmark-tvg-raw.json';

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

async function isServerReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

function evaluateThresholds(benchmark) {
  const failures = [];
  const { summary, results } = benchmark;

  if (summary.alignedVectorAverage < 96) failures.push(`Aligned vector average ${summary.alignedVectorAverage.toFixed(1)}% is below 96%`);
  if (summary.alignedBitmapAverage < 90) failures.push(`Aligned bitmap average ${summary.alignedBitmapAverage.toFixed(1)}% is below 90%`);
  if (Number.isFinite(summary.minAlignedVector) && summary.minAlignedVector < 80) failures.push(`Lowest aligned vector score ${summary.minAlignedVector.toFixed(1)}% is below 80%`);
  if (Number.isFinite(summary.minAlignedBitmap) && summary.minAlignedBitmap < 75) failures.push(`Lowest aligned bitmap score ${summary.minAlignedBitmap.toFixed(1)}% is below 75%`);
  if (summary.errorDiagnostics.length > 0) failures.push(`Drawings with error diagnostics: ${summary.errorDiagnostics.join(', ')}`);

  const resultMap = new Map(results.map((result) => [result.drawing, result]));
  for (const [drawing, minimum] of Object.entries(BASELINE_FLOORS)) {
    const result = resultMap.get(drawing);
    if (!result) {
      failures.push(`Missing benchmark anchor ${drawing}`);
      continue;
    }
    if (result.alignedScore < minimum) {
      failures.push(`${drawing} aligned ${result.alignedScore.toFixed(1)}%, below required ${minimum.toFixed(1)}%`);
    }
  }

  return failures;
}

function collectFocusedWarnings(benchmark) {
  const { results } = benchmark;
  return results
    .filter((result) => result.alignedScore >= 90 && result.normalizedScore <= 10 && result.foregroundIou <= 5)
    .map((result) => `${result.drawing} final=${result.score.toFixed(1)} aligned=${result.alignedScore.toFixed(1)} raw=${result.rawScore.toFixed(1)} focused=${result.normalizedScore.toFixed(1)} iou=${result.foregroundIou.toFixed(1)}`);
}

function collectRescueWarnings(benchmark) {
  const { results } = benchmark;
  return results
    .filter((result) => result.score - result.alignedScore >= 3)
    .sort((a, b) => (b.score - b.alignedScore) - (a.score - a.alignedScore))
    .slice(0, 20)
    .map((result) => `${result.drawing} rescued=${result.score.toFixed(1)} gate=${result.alignedScore.toFixed(1)} raw=${result.rawScore.toFixed(1)} focused=${result.normalizedScore.toFixed(1)}`);
}

function printSummary(summary) {
  console.log(`Gate averages: overall=${summary.overallAverage.toFixed(2)} vector=${summary.vectorAverage.toFixed(2)} bitmap=${summary.bitmapAverage.toFixed(2)}`);
  if (typeof summary.alignedOverallAverage === 'number') {
    console.log(`Aligned averages: overall=${summary.alignedOverallAverage.toFixed(2)} vector=${summary.alignedVectorAverage.toFixed(2)} bitmap=${summary.alignedBitmapAverage.toFixed(2)}`);
  }
  if (typeof summary.finalOverallAverage === 'number') {
    console.log(`Rescued averages: overall=${summary.finalOverallAverage.toFixed(2)} vector=${summary.finalVectorAverage.toFixed(2)} bitmap=${summary.finalBitmapAverage.toFixed(2)}`);
  }
  if (typeof summary.rawOverallAverage === 'number') {
    console.log(`Raw averages: overall=${summary.rawOverallAverage.toFixed(2)} vector=${summary.rawVectorAverage.toFixed(2)} bitmap=${summary.rawBitmapAverage.toFixed(2)}`);
  }
  if (typeof summary.normalizedOverallAverage === 'number') {
    console.log(`Focused averages: overall=${summary.normalizedOverallAverage.toFixed(2)} vector=${summary.normalizedVectorAverage.toFixed(2)} bitmap=${summary.normalizedBitmapAverage.toFixed(2)}`);
  }
  if (typeof summary.minAlignedVector === 'number') {
    console.log(`Aligned minima: vector=${summary.minAlignedVector.toFixed(2)} bitmap=${summary.minAlignedBitmap.toFixed(2)}`);
  }
  if (typeof summary.minRawVector === 'number') {
    console.log(`Raw minima: vector=${summary.minRawVector.toFixed(2)} bitmap=${summary.minRawBitmap.toFixed(2)}`);
  }
  if (typeof summary.minVector === 'number') {
    console.log(`Gate minima: vector=${summary.minVector.toFixed(2)} bitmap=${summary.minBitmap.toFixed(2)}`);
  }
  if (typeof summary.finalMinVector === 'number') {
    console.log(`Rescued minima: vector=${summary.finalMinVector.toFixed(2)} bitmap=${summary.finalMinBitmap.toFixed(2)}`);
  }
  if (typeof summary.rescuedDrawings === 'number') {
    console.log(`Rescues: ${summary.rescuedDrawings} drawings, ${summary.largeRescueDrawings ?? 0} large`);
  }
  if (typeof summary.suspiciousRescueDrawings === 'number') {
    console.log(`Suspicious rescues: ${summary.suspiciousRescueDrawings}`);
  }
}

async function main() {
  const rawMode = process.argv.includes('--raw');
  const pageUrl = rawMode ? `${PAGE_URL}?mode=raw` : PAGE_URL;
  const outputPath = rawMode ? RAW_OUTPUT_PATH : OUTPUT_PATH;
  mkdirSync('test-results', { recursive: true });

  let server = null;
  if (!(await isServerReady(PAGE_URL))) {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    server = spawn(npmCmd, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' },
      detached: true,
    });

    server.stdout.on('data', (chunk) => process.stdout.write(chunk));
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  }

  let browser;
  try {
    await waitForServer(PAGE_URL);
    browser = await puppeteer.launch({ headless: true, protocolTimeout: 600000 });
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__benchmarkDone === true, { timeout: 600000 });
    const benchmark = await page.evaluate(() => window.__benchmarkResult);
    writeFileSync(outputPath, JSON.stringify(benchmark, null, 2));

    if (benchmark?.error) {
      throw new Error(`Benchmark page failed: ${benchmark.error}`);
    }

    if (rawMode) {
      const worst = [...benchmark.results]
        .sort((a, b) => a.alignedScore - b.alignedScore || a.rawScore - b.rawScore)
        .slice(0, 20)
        .map((result) => `${result.drawing} final=${result.score.toFixed(2)} aligned=${result.alignedScore.toFixed(2)} raw=${result.rawScore.toFixed(2)}`);
      console.log(`TVG raw benchmark written to ${outputPath}`);
      printSummary(benchmark.summary);
      if (worst.length > 0) {
        console.log('Worst raw matches:');
        for (const line of worst) console.log(`- ${line}`);
      }
      return;
    }

    const failures = evaluateThresholds(benchmark);
    const focusedWarnings = collectFocusedWarnings(benchmark);
    const rescueWarnings = collectRescueWarnings(benchmark);
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
      if (rescueWarnings.length > 0) {
        console.error('Large rescue-score deltas:');
        for (const warning of rescueWarnings) {
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
    if (rescueWarnings.length > 0) {
      console.warn('TVG benchmark large rescue-score deltas:');
      for (const warning of rescueWarnings) {
        console.warn(`- ${warning}`);
      }
    }
    printSummary(benchmark.summary);
    console.log(`TVG benchmark passed using alignedScore as the gate. Results written to ${outputPath}`);
  } finally {
    if (browser) await browser.close();
    if (server?.pid) {
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
