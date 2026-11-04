import { format, resolveConfig } from 'prettier';

/** Generated Markdown is written in repository Prettier style, so `pnpm format` leaves it unchanged. */
export async function formatMarkdown(text, file) {
  const config = await resolveConfig(file);
  return format(text, { ...config, filepath: file });
}
