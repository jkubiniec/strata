// A seed makes a published walk repeatable. Without one, each visit draws a fresh route.
export function shuffledAtlas(entries, seed) {
  let state = 2166136261;
  for (const ch of String(seed)) state = Math.imul(state ^ ch.charCodeAt(0), 16777619);
  const deck = entries.slice();
  for (let i = deck.length - 1; i > 0; --i) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const j = Math.floor(state / 4294967296 * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export async function loadHistory(seed) {
  const collections = await Promise.all(['a', 'b'].map(async name => {
    const response = await fetch('./assets/history/collection-' + name + '.json');
    if (!response.ok) throw new Error('Could not load the historical atlas.');
    return response.json();
  }));
  return shuffledAtlas(collections.flat(), seed);
}
