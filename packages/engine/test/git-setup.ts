/**
 * O git do anfitrião assina cada commit (SSH) e liga o fsmonitor. Com a suite em paralelo
 * isso passa dos 10 s do hook. Os testes não precisam dessa configuração: o valor da linha
 * de comando do ambiente ganha ao ficheiro do utilizador. O git sombra tira estas variáveis.
 */
const base = Number(process.env.GIT_CONFIG_COUNT ?? '0');
const extra: readonly (readonly [string, string])[] = [
  ['commit.gpgsign', 'false'],
  ['core.fsmonitor', 'false'],
  // O autocrlf global (Git for Windows) avisava "LF will be replaced by CRLF"
  // e sujava o diff das pistas. A linha de comando ganha ao ficheiro do utilizador.
  ['core.autocrlf', 'false'],
  ['core.safecrlf', 'false'],
  ['core.eol', 'lf'],
];
extra.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${base + index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${base + index}`] = value;
});
process.env.GIT_CONFIG_COUNT = String(base + extra.length);
