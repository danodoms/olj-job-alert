export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
