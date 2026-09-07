/**
 * util.js — petits utilitaires partagés.
 */
function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { sleep };
