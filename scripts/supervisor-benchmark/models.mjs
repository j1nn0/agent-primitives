// These are two genuinely different FOUNDATION families (DeepSeek and OpenAI), both already authenticated on this machine and non-free, non-rate-limited contributor models.
const DEEPSEEK_MODEL_FAMILY = Object.freeze({
  modelFamily: 'deepseek',
  modelId: 'opencode-go/deepseek-v4-flash',
  provider: 'opencode-go',
  modelName: 'deepseek-v4-flash',
  thinkingLevel: 'max',
});

const OPENAI_MODEL_FAMILY = Object.freeze({
  modelFamily: 'openai',
  modelId: 'openai-codex/gpt-5.6-luna',
  provider: 'openai-codex',
  modelName: 'gpt-5.6-luna',
  thinkingLevel: 'max',
});

export const BENCHMARK_MODEL_FAMILIES = Object.freeze([
  DEEPSEEK_MODEL_FAMILY,
  OPENAI_MODEL_FAMILY,
]);
