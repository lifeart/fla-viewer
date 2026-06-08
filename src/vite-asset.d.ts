// Vite asset imports: `import url from './file.fla?url'` resolves to the
// served URL string at runtime.
declare module '*.fla?url' {
  const url: string;
  export default url;
}

// Gzipped fixture (e.g. the large DIFAT CFB committed compressed; inflated in
// the test with DecompressionStream).
declare module '*.fla.gz?url' {
  const url: string;
  export default url;
}

// MP3 fixture (e.g. a real sound stream used to test audio decoding).
declare module '*.mp3?url' {
  const url: string;
  export default url;
}
