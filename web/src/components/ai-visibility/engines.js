// What a provider id is called on screen. An engine the server knows about but this map does
// not still shows (under its id), so a new provider needs no change here to appear.
export const ENGINE_LABEL = { openai: 'ChatGPT', anthropic: 'Claude', perplexity: 'Perplexity' };
export const engineLabel = (id) => ENGINE_LABEL[id] || id;
