#!/usr/bin/env node
// Fixture for the stdin-handling test. Prints a valid judge-shaped JSON
// response only if stdin closes promptly (EOF received). Exits non-zero if
// stdin stays open past a short window, which is what happens when execa's
// default stdin: 'pipe' is used and the parent never writes anything.
process.stdin.on('end', () => {
  console.log(JSON.stringify({ score: 4, rationale: 'stdin-eof-received' }));
  process.exit(0);
});
process.stdin.resume();
setTimeout(() => {
  console.error('stdin still open after 500ms — pipe was not ignored');
  process.exit(2);
}, 500);
