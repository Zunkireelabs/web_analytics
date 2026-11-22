// Mock a store module for a route test without hand-listing every export it has.
//
// WHY: a route test that mocks e.g. store/users.js with a hand-written namedExports list breaks the moment the real module gains an
// export the route (or anything it imports) uses. Node then refuses to load the file at all ("does not provide an export named
// 'createUser'"), and every test in it silently stops running. Nine route test files were in exactly that state.
//
// RULE: start from the module's REAL export list.
//   - async functions (the ones that query the database) are replaced by a function that throws "not mocked in this test", so a test
//     can never reach a real database by accident, and a call nobody planned for fails loudly with its name;
//   - synchronous functions and constants stay real (they are pure: role rules, code normalisation, limits);
//   - `overrides` replace whatever the test actually drives.
export async function strictExports(moduleUrl, overrides = {}) {
  const real = await import(moduleUrl);
  const AsyncFunction = (async () => {}).constructor;
  const out = {};
  for (const [name, value] of Object.entries(real)) {
    if (name === 'default') continue;
    out[name] = value instanceof AsyncFunction
      ? async () => { throw new Error(`${name} is not mocked in this test`); }
      : value;
  }
  return { ...out, ...overrides };
}
