// The questions a client sees as one-tap suggestions in the Agent chat, and the plain-English answers that need no data.
// The top 15 are in four groups. Eleven can be answered from the client's own records (handled in assistant.js by intent);
// the four "In plain English" ones and a few "how it works" ones have fixed answers here, the same for every client.
// Answers never name a client, a URL, or any figure: anything specific to a site comes from its own data, not from here.

const norm = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export const STATIC_ANSWERS = {
  'what is aeo': 'AEO means answer engine optimisation: making your pages easy for AI tools like ChatGPT to quote when buyers ask a question.',
  'what is geo': 'GEO is making sure AI engines describe your business correctly: who you are, who you serve and where.',
  'what is seo': 'SEO is making your pages easy for Google to find and show, so buyers searching for what you sell reach you.',
  'what does on stage mean': 'Stage is a private copy of your site. A change goes there first so it can be checked before it reaches your real site.',
  'what is a pr': 'A PR (pull request) is a package of changes waiting for a person to check it. Nothing reaches your live site until it is merged.',
  'what is a commit': 'A commit is one saved bundle of changes. Everything you approve in a day goes into one commit, so it is easy to review or undo.',
  'what happens when i approve': 'Approving does not change your live site. I group what you approved into one commit and ask before opening a pull request. A person always reviews the change to your main site.',
  'can i undo a change': 'Yes. Before it is live, press Undo on the card. After it is live I can prepare a rollback, and you approve that the same way.',
  'why did you pick these fixes': 'I order fixes by how many buyers they can reach and how sure I am they are right. Safe, high-reach fixes come first, and anything risky waits for your review.',
  'how do you decide what to write': 'I write what AI engines are asked and your site does not answer yet, and what buyers search for that your pages do not cover. Each draft says which gap it closes.',
};

// What a plain "what is X?" / "what does X mean?" resolves to. Several wordings per term.
const TERMS = [
  [/\baeo\b|answer engine/, 'what is aeo'], [/\bgeo\b|generative engine/, 'what is geo'], [/\bseo\b/, 'what is seo'],
  [/\bstage\b|staging/, 'what does on stage mean'], [/\bpr\b|pull request/, 'what is a pr'], [/\bcommit\b/, 'what is a commit'],
];

// A fixed answer for a message, or null when it needs the client's own data. Exact question first, then "what is/does X".
export function staticAnswer(message) {
  const q = norm(message);
  if (STATIC_ANSWERS[q]) return STATIC_ANSWERS[q];
  if (/^(what|whats|what s|explain|tell me about|define)\b/.test(q) || /\bmean(s)?\b/.test(q)) {
    const hit = TERMS.find(([re]) => re.test(q));
    if (hit) return STATIC_ANSWERS[hit[1]];
  }
  return null;
}

// The 15, grouped. `ask` is the exact text sent when tapped. A site with no AI-visibility data still gets the three
// "Your results" questions: the assistant answers honestly that there is nothing to report yet.
export const QUESTION_GROUPS = [
  { id: 'today', label: 'Today', questions: ['What did the agents do today?', 'What is waiting for me?', 'What changed on my site this week?', 'Is anything broken?'] },
  { id: 'work', label: 'Fixes and content', questions: ['Why did you pick these fixes?', 'What happens when I approve?', 'Can I undo a change?', 'How do you decide what to write?'] },
  { id: 'results', label: 'Your results', questions: ['Is my AI visibility improving?', 'Why does a competitor show up instead of me?', 'Which pages gained traffic this month?'] },
  { id: 'plain', label: 'In plain English', questions: ['What is AEO?', 'What is GEO?', 'What does "on stage" mean?', 'What is a PR?'] },
];

// The five shown above the input before "More questions": what a client asks first.
export const QUICK_QUESTIONS = ['What is waiting for me?', 'What did the agents do today?', 'Is my AI visibility improving?', 'What is AEO?', 'What happens when I approve?'];

export const suggestedQuestions = () => ({ quick: QUICK_QUESTIONS, groups: QUESTION_GROUPS, total: QUESTION_GROUPS.reduce((n, g) => n + g.questions.length, 0) });
