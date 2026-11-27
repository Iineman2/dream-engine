// Tiny, transparent text normalisation used by the dream compiler and the
// lexical cross-check scorer. Deliberately simple: both the target lexicon and
// the dream report pass through the same functions, so consistency matters
// more than linguistic accuracy.

const STOP = new Set(`
a an and are as at be been being but by can could did do does doing for from had has have having
he her hers him his how if in into is it its just me my myself no nor not of off on once only or
other our out over own same she should so some such than that the their them then there these they
this those through to too under until up very was we were what when where which while who whom why
will with would you your yours about above after again against all am any because before below
between both down during each few further here more most also yet get got going went come came
remember think thinking thought like felt feel feeling something thing things kind sort really maybe
around know just okay yeah well said say saying tell telling still back one two let lets
`.split(/\s+/).filter(Boolean));

export function stem(word) {
  let w = word.toLowerCase().replace(/[’']/g, '');
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  // Plural first, then verb endings, so "speeds" and "speed" land on the same stem.
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  // swimm -> swim, stopp -> stop (but keep fall, glass, buzz)
  const m = w.match(/([bcdfgkmnprtv])\1$/);
  if (m && w.length > 3) w = w.slice(0, -1);
  return w;
}

export function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .split(/[^\p{L}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

export function stems(text) {
  return words(text).map(stem);
}

export function isStopword(w) {
  return STOP.has(String(w).toLowerCase());
}
