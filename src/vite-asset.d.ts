// Vite asset imports: `import url from './file.fla?url'` resolves to the
// served URL string at runtime.
declare module '*.fla?url' {
  const url: string;
  export default url;
}
