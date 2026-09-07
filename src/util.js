/**
 * util.js — utilitaires partagés, sans dépendance au reste du pipeline.
 */
const fs = require('fs/promises');

/** Attente passive. Résout immédiatement pour une durée nulle ou négative. */
function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Crée un dossier (et ses parents) s'il n'existe pas déjà. */
function ensureDir(dir) {
  return fs.mkdir(dir, { recursive: true });
}

/**
 * Normalise une chaîne en identifiant de fichier : sans accent, minuscule,
 * séparée par des tirets. Retombe sur 'accueil' pour une entrée vide ou
 * uniquement composée de séparateurs — cas courant du chemin racine '/'.
 */
function slugify(str) {
  return (
    String(str)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'accueil'
  );
}

/**
 * Parseur d'option commander pour les valeurs numériques entières.
 * Échoue explicitement plutôt que de laisser un NaN se propager jusqu'à
 * Sharp/Playwright, où l'erreur serait incompréhensible.
 */
function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`valeur numérique attendue, reçu "${value}"`);
  }
  return Math.round(n);
}

/** Découpe une liste passée en ligne de commande ("a,b , c" → ['a','b','c']). */
function splitList(value) {
  if (!value) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { sleep, ensureDir, slugify, toInt, splitList };
