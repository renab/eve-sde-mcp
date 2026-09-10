/** Preserve JSON integer tokens outside JavaScript's exact range as decimal strings. */
export function parseEsiJson(text: string): any {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token.startsWith('"') || !/^-?\d+$/.test(token)) return token;
    return Number.isSafeInteger(Number(token)) ? token : JSON.stringify(token);
  }));
}
