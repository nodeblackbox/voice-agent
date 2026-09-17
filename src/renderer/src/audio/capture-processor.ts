// The processor itself lives in public/capture-processor.js (a static file: worklet modules are
// fetched by URL under script-src 'self'). This is the name it registers.
export const CAPTURE_PROCESSOR_NAME = 'va-capture'

export function captureProcessorUrl(): string {
  return new URL('capture-processor.js', document.baseURI).href
}
