/**
 * Texto que vem de um agente: dado não confiável. Aqui só se limpa e se limita (nunca se
 * interpreta): sem caracteres de controlo nem invisíveis que escondam o que lá está.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** Várias linhas permitidas; sem controlo nem invisíveis e com `\r\n` a valer `\n`. */
export function cleanBlock(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(INVISIBLE, '').trim();
}

/** Uma só linha, limpa. */
export function cleanLine(text: string): string {
  return cleanBlock(text).replace(/\s+/g, ' ').trim();
}

/** Corta com reticências quando passa do limite. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
