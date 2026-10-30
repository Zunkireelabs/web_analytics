export default function llmsTxt({ llmsTxt, robotsTxt }) {
  const hasLlmsTxt = llmsTxt?.present === true && (llmsTxt.content || "").trim().length > 0;
  const robotsAllowsAi = robotsTxt?.present !== true || robotsTxt?.blocksAll !== true;

  const hasBoth = hasLlmsTxt && robotsAllowsAi;
  const hasOne = hasLlmsTxt || robotsAllowsAi;

  let score;
  if (hasBoth) score = 10;
  else if (hasOne) score = 5;
  else score = 0;

  const found = hasLlmsTxt || robotsAllowsAi;

  return {
    id: "llms-txt",
    title: "llms.txt & AI Crawler Access",
    category: "geo",
    passed: found,
    score,
    maxScore: 10,
    message: hasBoth
      ? "llms.txt present and robots.txt allows AI crawlers — generative engines can discover and cite your content."
      : hasLlmsTxt
      ? "llms.txt found but robots.txt may block AI crawlers — check your robots.txt disallow rules."
      : robotsAllowsAi
      ? "robots.txt allows AI crawlers but no llms.txt found — add llms.txt to help AI models navigate your site."
      : "No llms.txt found and robots.txt may block AI crawlers.",
    recommendation: hasBoth
      ? "No action needed."
      : "Add an llms.txt file and ensure robots.txt does not disallow AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended).",
  };
};
