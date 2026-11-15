// Loaded ONLY by scripts/smoke.mjs in its child process. Never used by the normal server.
globalThis.fetch = async () => {
  throw new Error('Offline MCP smoke: network access is forbidden');
};
