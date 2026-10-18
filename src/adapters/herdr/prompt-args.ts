/** Protocol 22 CLI consumes prompt text as the next positional argument, including dash-prefixed text. */
export function herdrPromptArgs(name: string, text: string): string[] {
  return ['agent', 'prompt', name, text];
}
