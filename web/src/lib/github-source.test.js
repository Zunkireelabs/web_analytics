import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { githubSourceFor } from './github-source.js';

describe('githubSourceFor', () => {
  test('a client always signs in as themselves, whatever else is true', () => {
    assert.equal(githubSourceFor({ restricted: true, canConnect: false }), 'mine');
    assert.equal(githubSourceFor({ restricted: true, canConnect: true, staffChoice: 'app' }), 'mine');
  });
  test('staff by default: their own sign-in where it is set up, the app\'s list where it is not (unchanged)', () => {
    assert.equal(githubSourceFor({ canConnect: true }), 'mine');
    assert.equal(githubSourceFor({ canConnect: false }), 'app');
    assert.equal(githubSourceFor({ canConnect: false, returnedFromGithub: true }), 'mine');
  });
  test('staff can choose the app\'s list even when GitHub sign-in is set up: no sign-in needed to change a repository', () => {
    assert.equal(githubSourceFor({ canConnect: true, staffChoice: 'app' }), 'app');
  });
  test('and can go back to signing in as themselves, even where the app list would be the default', () => {
    assert.equal(githubSourceFor({ canConnect: false, staffChoice: 'mine' }), 'mine');
    assert.equal(githubSourceFor({ canConnect: true, staffChoice: 'mine' }), 'mine');
  });
  test('no argument at all is the safe staff default', () => assert.equal(githubSourceFor(), 'app'));
});
