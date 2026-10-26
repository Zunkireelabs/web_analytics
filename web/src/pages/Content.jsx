import ActionCenter from './ActionCenter.jsx';

// Content: the blog posts, landing pages and translations the agent drafts, with the same
// review-then-approve flow as the Action Center, which now keeps the issues and fixes. One board,
// two pages: ActionCenter takes a `scope` (see lib/draft-scope.js) so nothing shows on both.
export default function Content() {
  return <ActionCenter scope="content" />;
}
