/**
 * O git do anfitrião assina cada commit (SSH) e liga o fsmonitor. Com a suite em paralelo
 * isso passa dos 10 s do hook. Os testes não precisam dessa configuração: o valor da linha
 * de comando do ambiente ganha ao ficheiro do utilizador. O git sombra tira estas variáveis.
 */
const base = Number(process.env.GIT_CONFIG_COUNT ?? '0');
const extra: readonly (readonly [string, string])[] = [
  ['commit.gpgsign', 'false'],
  ['core.fsmonitor', 'false'],
];
extra.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${base + index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${base + index}`] = value;
});
process.env.GIT_CONFIG_COUNT = String(base + extra.length);
