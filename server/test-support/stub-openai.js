// Node 20 compatibility for route tests that import the REAL action-center module under `mock.module`.
//
// On Node 20 (CI's version), once a test has registered any mock.module(), importing the `openai` SDK fails at load time:
// formdata-node does `import { ReadableStream } from "web-streams-polyfill"` and the mock loader cannot see that export
// ("does not provide an export named 'ReadableStream'"). The same import works on Node 20 without module mocks and on Node 24 with
// them. Route tests never call a model, so the SDK is replaced by a stub that fails loudly if anything does try.
// Call this BEFORE the first import that reaches server/llm.js.
export function stubOpenAI(mock) {
  class OpenAI {
    constructor() {
      const refuse = async () => { throw new Error('No model calls in tests (openai is stubbed).'); };
      this.chat = { completions: { create: refuse } };
      this.responses = { create: refuse };
      this.embeddings = { create: refuse };
      this.images = { generate: refuse };
    }
  }
  mock.module('openai', { defaultExport: OpenAI, namedExports: { OpenAI } });
}
