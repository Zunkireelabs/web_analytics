// Which way a person picks the GitHub repository in the project wizard.
//   'mine'  they sign in to GitHub as themselves and choose from what their own account allowed the SuperRank app on.
//   'app'   (SuperRank staff only) they choose from every repository the SuperRank GitHub app can already reach. No GitHub sign-in at all, which is what
//           changing the repository of a project whose organisation already has the app installed needs.
// Clients always use 'mine' (the server refuses 'app' to anyone who is not staff). Staff used to be sent to 'mine' whenever GitHub sign-in was set up on the server,
// with no way to pick 'app', so changing a repository meant a new GitHub sign-in every time, and a sign-in that failed blocked the change completely.
export function githubSourceFor({ restricted = false, canConnect = false, returnedFromGithub = false, staffChoice = null } = {}) {
  if (restricted) return 'mine';
  if (staffChoice === 'app' || staffChoice === 'mine') return staffChoice;
  return canConnect || returnedFromGithub ? 'mine' : 'app';
}
