// Generates a tiny synthetic .fla fixture for the issue #11 easing integration
// test. It carries one motion-tween frame per distinct CreateJS-style ease
// method token observed in the reporter's real file (28-21 p0tatomango.fla),
// WITHOUT redistributing that third-party copyrighted artwork. Re-run with:
//   node scripts/gen-easing-fixture.mjs
import JSZip from 'jszip';
import { writeFileSync, mkdirSync } from 'node:fs';

// The 16 distinct <Ease method="..."> tokens extracted from the real file.
const TOKENS = [
  'quadIn', 'quadOut', 'quadInOut',
  'cubicIn', 'cubicOut', 'cubicInOut',
  'quartIn', 'quartOut',
  'quintIn', 'quintOut',
  'sineInOut',
  'circIn', 'circOut',
  'backOut', 'backInOut',
  'elasticOut',
];

// One layer per token: a single motion-tween frame whose <Ease> carries the
// token. Empty <elements> keeps the fixture minimal (the parser still records
// the tween; the test drives calculateTweenProgress directly).
const layers = TOKENS.map(
  (m) => `<DOMLayer name="ease_${m}"><frames>` +
    `<DOMFrame index="0" duration="10" tweenType="motion" easeMethodName="${m}">` +
    `<tweens><Ease target="all" method="${m}"/></tweens><elements></elements>` +
    `</DOMFrame></frames></DOMLayer>`
).join('');

const dom =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<DOMDocument width="100" height="100" frameRate="24" backgroundColor="#FFFFFF">` +
  `<timelines><DOMTimeline name="Scene 1"><layers>${layers}</layers></DOMTimeline></timelines>` +
  `</DOMDocument>`;

const zip = new JSZip();
// Fixed date => deterministic bytes, so the committed fixture is stable.
zip.file('DOMDocument.xml', dom, { date: new Date('2021-01-05T00:00:00Z') });
const buf = await zip.generateAsync({ type: 'nodebuffer' });

mkdirSync('src/__tests__/fixtures', { recursive: true });
writeFileSync('src/__tests__/fixtures/easing-tokens.fla', buf);
console.log(`wrote src/__tests__/fixtures/easing-tokens.fla (${buf.length} bytes, ${TOKENS.length} tokens)`);
